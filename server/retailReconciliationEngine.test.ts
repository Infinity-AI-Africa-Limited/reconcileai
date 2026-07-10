import { describe, it, expect } from "vitest";
import {
  classifyRetailException,
  runRetailReconciliation,
  buildRetailDupIndex,
  isSettlementBatchOverdue,
  type RetailReconciliationConfig,
} from "./retailReconciliationEngine";
import type { Transaction } from "../drizzle/schema";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTxn(overrides: Partial<Transaction> & { rawData?: Record<string, unknown> }): Transaction {
  return {
    id: 1,
    organizationId: 1,
    channelId: 1,
    transactionRef: "TXN-001",
    amount: "1000.00",
    currency: "USD",
    transactionDate: new Date("2025-06-01"),
    description: "Test transaction",
    transactionType: "credit",
    counterparty: "SHOPLINE Merchant",
    rawData: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    reconciliationRunId: null,
    sourceFile: null,
    status: "pending",
    ...overrides,
  } as unknown as Transaction;
}

const baseConfig: RetailReconciliationConfig = {
  amountTolerance: 0.005,
  dateWindowDays: 3,
  settlementCycleDays: 2,
  settlementCurrency: "USD",
  fxMarkupTolerance: 0.03,
  chargebackDetection: true,
};

// ─── Exception Classification Tests ─────────────────────────────────────────

describe("Retail Exception Classification", () => {
  describe("Chargeback detection", () => {
    it("classifies a chargeback not posted to merchant ledger", () => {
      const txn = makeTxn({
        rawData: {
          gatewayEventType: "chargeback",
          chargebackArn: "ARN-12345678",
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_chargeback_not_posted");
      expect(result.severity).toBe("critical");
      expect(result.hasRetailTaxonomy).toBe(true);
      expect(result.slaHours).toBeLessThanOrEqual(24);
    });

    it("detects duplicate chargebacks with same ARN", () => {
      const txn = makeTxn({
        rawData: {
          gatewayEventType: "chargeback",
          chargebackArn: "ARN-DUPE-001",
        },
      });
      const targets = [
        makeTxn({
          id: 2,
          rawData: {
            gatewayEventType: "chargeback",
            chargebackArn: "ARN-DUPE-001",
          },
        }),
        makeTxn({
          id: 3,
          rawData: {
            gatewayEventType: "chargeback",
            chargebackArn: "ARN-DUPE-001",
          },
        }),
      ];
      const result = classifyRetailException(txn, targets, baseConfig);
      expect(result.category).toBe("retail_chargeback_duplicate");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Refund detection", () => {
    it("classifies a refund not settled", () => {
      const txn = makeTxn({
        rawData: {
          gatewayEventType: "refund",
          refundId: "REF-001",
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_refund_not_settled");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Void detection", () => {
    it("classifies a voided transaction not reversed in settlement", () => {
      const txn = makeTxn({
        rawData: {
          voidStatus: "voided",
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_void_not_reversed");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Gateway fee variance", () => {
    it("detects fee variance above tolerance", () => {
      const configWithFees: RetailReconciliationConfig = {
        ...baseConfig,
        feeSchedule: {
          rates: { visa_credit_domestic: 0.029 },
          tolerance: 0.05,
        },
      };
      const txn = makeTxn({
        amount: "35.00", // fee charged
        rawData: {
          gatewayEventType: "fee",
          cardScheme: "visa",
          cardType: "credit",
          cardRegion: "domestic",
          originalAmount: 1000, // original txn amount
        },
      });
      // Expected fee: 1000 * 0.029 = 29.00
      // Actual fee: 35.00 → variance = 6/29 ≈ 20.7% > 5% tolerance
      const result = classifyRetailException(txn, [], configWithFees);
      expect(result.category).toBe("retail_gateway_fee_variance");
      expect(result.hasRetailTaxonomy).toBe(true);
    });

    it("does not flag fee within tolerance", () => {
      const configWithFees: RetailReconciliationConfig = {
        ...baseConfig,
        feeSchedule: {
          rates: { visa_credit_domestic: 0.029 },
          tolerance: 0.05,
        },
      };
      const txn = makeTxn({
        amount: "29.50", // fee charged — within 5% of 29.00
        rawData: {
          gatewayEventType: "fee",
          cardScheme: "visa",
          cardType: "credit",
          cardRegion: "domestic",
          originalAmount: 1000,
        },
      });
      const result = classifyRetailException(txn, [], configWithFees);
      // 29.50 vs 29.00 = 1.7% variance, below 5% tolerance
      expect(result.category).not.toBe("retail_gateway_fee_variance");
    });
  });

  describe("Partial capture mismatch", () => {
    it("detects partial capture that does not match settlement", () => {
      const txn = makeTxn({
        amount: "800.00",
        rawData: {
          gatewayEventType: "payment",
          authorisedAmount: 1000,
          capturedAmount: 750,
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_partial_capture_mismatch");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Duplicate authorisation", () => {
    it("detects multiple charges for the same order", () => {
      const txn = makeTxn({
        rawData: {
          gatewayEventType: "payment",
          originalOrderRef: "ORDER-123",
        },
      });
      const targets = [
        makeTxn({
          id: 2,
          rawData: { originalOrderRef: "ORDER-123" },
        }),
        makeTxn({
          id: 3,
          rawData: { originalOrderRef: "ORDER-123" },
        }),
      ];
      const result = classifyRetailException(txn, targets, baseConfig);
      expect(result.category).toBe("retail_duplicate_authorisation");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("FX rate mismatch", () => {
    it("detects FX variance above tolerance", () => {
      const txn = makeTxn({
        currency: "GBP",
        rawData: {
          gatewayEventType: "payment",
          expectedFxRate: 1.27,
          appliedFxRate: 1.35, // 6.3% variance > 3% tolerance
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_fx_rate_mismatch");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Settlement shortfall", () => {
    it("detects payout amount less than expected", () => {
      const txn = makeTxn({
        amount: "9500.00",
        rawData: {
          gatewayEventType: "payout",
          expectedPayoutAmount: 10000,
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_settlement_shortfall");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Reserve hold", () => {
    it("detects unexplained reserve deduction", () => {
      const txn = makeTxn({
        amount: "600.00",
        rawData: {
          gatewayEventType: "reserve",
          expectedReserveAmount: 500,
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_reserve_hold_unexplained");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Settlement delay", () => {
    it("detects settlement beyond SLA", () => {
      const txn = makeTxn({
        transactionDate: new Date("2025-06-10"), // settled on June 10
        rawData: {
          gatewayEventType: "payment",
          captureDate: "2025-06-01", // captured on June 1 → 9 days > T+2+2
        },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_settlement_delay");
      expect(result.hasRetailTaxonomy).toBe(true);
    });
  });

  describe("Fallback to core engine", () => {
    it("falls back to core categorisation for non-retail exceptions", () => {
      const txn = makeTxn({
        rawData: {}, // No retail-specific metadata
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.hasRetailTaxonomy).toBe(false);
      expect(result.slaHours).toBe(72); // Default SLA
    });
  });

  describe("Data-quality guards (hardening)", () => {
    it("flags a non-numeric amount instead of emitting NaN", () => {
      const txn = makeTxn({ amount: "N/A", rawData: { gatewayEventType: "payout", expectedPayoutAmount: 100 } });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("format_error");
      expect(result.description).not.toContain("NaN");
    });

    it("does not report a settlement 'delay' when settlement precedes capture", () => {
      const txn = makeTxn({
        transactionDate: new Date("2025-06-01"),
        rawData: { gatewayEventType: "payment", captureDate: "2025-06-10" }, // capture AFTER settlement
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).not.toBe("retail_settlement_delay");
    });
  });

  describe("Same-side duplicate detection (O(1) index)", () => {
    it("buildRetailDupIndex counts ARNs and order refs on a feed", () => {
      const feed = [
        makeTxn({ id: 1, rawData: { chargebackArn: "ARN-1" } }),
        makeTxn({ id: 2, rawData: { chargebackArn: "ARN-1" } }),
        makeTxn({ id: 3, rawData: { originalOrderRef: "ORD-9" } }),
      ];
      const idx = buildRetailDupIndex(feed);
      expect(idx.byArn.get("ARN-1")).toBe(2);
      expect(idx.byOrderRef.get("ORD-9")).toBe(1);
    });

    it("uses the same-side index to flag a duplicate chargeback (not the opposite side)", () => {
      const txn = makeTxn({ id: 1, rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-1" } });
      const sameSide = [txn, makeTxn({ id: 2, rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-1" } })];
      const idx = buildRetailDupIndex(sameSide);
      // Opposite side is empty — the OLD code would have missed this.
      const result = classifyRetailException(txn, [], baseConfig, idx);
      expect(result.category).toBe("retail_chargeback_duplicate");
    });

    it("a lone chargeback (count 1 on its feed) is 'not posted', not 'duplicate'", () => {
      const txn = makeTxn({ id: 1, rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-SOLO" } });
      const idx = buildRetailDupIndex([txn]);
      const result = classifyRetailException(txn, [], baseConfig, idx);
      expect(result.category).toBe("retail_chargeback_not_posted");
    });
  });

  // ─── Research round 2: new exception surfaces ──────────────────────────────
  describe("Refund duplicate (same refundId on one feed)", () => {
    it("flags a duplicated refundId as retail_refund_duplicate", () => {
      const txn = makeTxn({ id: 1, rawData: { gatewayEventType: "refund", refundId: "REF-DUP" } });
      const idx = buildRetailDupIndex([txn, makeTxn({ id: 2, rawData: { gatewayEventType: "refund", refundId: "REF-DUP" } })]);
      const result = classifyRetailException(txn, [], baseConfig, idx);
      expect(result.category).toBe("retail_refund_duplicate");
      expect(result.hasRetailTaxonomy).toBe(true);
    });

    it("a lone refund stays retail_refund_not_settled", () => {
      const txn = makeTxn({ id: 1, rawData: { gatewayEventType: "refund", refundId: "REF-SOLO" } });
      const idx = buildRetailDupIndex([txn]);
      expect(classifyRetailException(txn, [], baseConfig, idx).category).toBe("retail_refund_not_settled");
    });
  });

  describe("Dispute lifecycle", () => {
    it("unmatched chargeback reversal → retail_dispute_won_not_credited", () => {
      const txn = makeTxn({ rawData: { gatewayEventType: "chargeback_reversal", disputeCaseId: "CASE-42" } });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_dispute_won_not_credited");
      expect(result.description).toContain("CASE-42");
    });

    it("dispute fee off-schedule → retail_dispute_fee_error", () => {
      const txn = makeTxn({ amount: "25.00", rawData: { gatewayEventType: "dispute_fee", expectedDisputeFee: 15 } });
      expect(classifyRetailException(txn, [], baseConfig).category).toBe("retail_dispute_fee_error");
    });

    it("dispute fee on-schedule does not alert", () => {
      const txn = makeTxn({ amount: "15.00", rawData: { gatewayEventType: "dispute_fee", expectedDisputeFee: 15 } });
      expect(classifyRetailException(txn, [], baseConfig).category).not.toBe("retail_dispute_fee_error");
    });
  });

  describe("COD courier remittance", () => {
    it("remittance shortfall → retail_cod_remittance_variance (critical)", () => {
      const txn = makeTxn({
        amount: "8500.00",
        rawData: { gatewayEventType: "cod_remittance", expectedRemittanceAmount: 10000, courierId: "GHN-EXPRESS" },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_cod_remittance_variance");
      expect(result.severity).toBe("critical");
      expect(result.description).toContain("GHN-EXPRESS");
    });

    it("full remittance does not alert", () => {
      const txn = makeTxn({ amount: "10000.00", rawData: { gatewayEventType: "cod_remittance", expectedRemittanceAmount: 10000 } });
      expect(classifyRetailException(txn, [], baseConfig).category).not.toBe("retail_cod_remittance_variance");
    });
  });

  describe("Payout ↔ bank third leg", () => {
    it("bank credit differing from payout report → retail_payout_bank_variance", () => {
      const txn = makeTxn({
        amount: "10000.00",
        rawData: { gatewayEventType: "payout", bankCreditedAmount: 9950, expectedPayoutAmount: 10000 },
      });
      const result = classifyRetailException(txn, [], baseConfig);
      expect(result.category).toBe("retail_payout_bank_variance");
      expect(result.severity).toBe("critical");
    });

    it("bank leg intact falls through to gateway-report shortfall check", () => {
      const txn = makeTxn({
        amount: "9500.00",
        rawData: { gatewayEventType: "payout", bankCreditedAmount: 9500, expectedPayoutAmount: 10000 },
      });
      expect(classifyRetailException(txn, [], baseConfig).category).toBe("retail_settlement_shortfall");
    });
  });

  describe("Platform economics", () => {
    it("tax withheld off-expectation → retail_tax_deduction_variance", () => {
      const txn = makeTxn({ amount: "750.00", rawData: { gatewayEventType: "tax_deduction", expectedTaxAmount: 500, taxType: "VAT" } });
      expect(classifyRetailException(txn, [], baseConfig).category).toBe("retail_tax_deduction_variance");
    });

    it("commission off rate-card → retail_platform_commission_variance", () => {
      const txn = makeTxn({ amount: "320.00", rawData: { gatewayEventType: "commission", expectedCommissionAmount: 250 } });
      expect(classifyRetailException(txn, [], baseConfig).category).toBe("retail_platform_commission_variance");
    });
  });

  describe("Settlement batch integrity", () => {
    it("same gatewayRef twice on one feed → retail_settlement_duplicate", () => {
      const txn = makeTxn({ id: 1, rawData: { gatewayEventType: "payment", gatewayRef: "GW-1" } });
      const idx = buildRetailDupIndex([txn, makeTxn({ id: 2, rawData: { gatewayEventType: "payment", gatewayRef: "GW-1" } })]);
      expect(classifyRetailException(txn, [], baseConfig, idx).category).toBe("retail_settlement_duplicate");
    });

    it("order total vs settled amount beyond tolerance → retail_order_payment_amount_mismatch", () => {
      const txn = makeTxn({ amount: "90.00", rawData: { gatewayEventType: "payment", orderTotal: 100 } });
      expect(classifyRetailException(txn, [], baseConfig).category).toBe("retail_order_payment_amount_mismatch");
    });

    it("order total within tolerance does not alert", () => {
      const txn = makeTxn({ amount: "99.90", rawData: { gatewayEventType: "payment", orderTotal: 100 } }); // 0.1% < 0.5%
      expect(classifyRetailException(txn, [], baseConfig).category).not.toBe("retail_order_payment_amount_mismatch");
    });
  });

  describe("isSettlementBatchOverdue (batch-missing watchdog)", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    it("never-received is always overdue", () => {
      expect(isSettlementBatchOverdue(null, 1, 1, now)).toBe(true);
    });
    it("fresh batch is not overdue", () => {
      expect(isSettlementBatchOverdue(new Date("2026-07-10T02:00:00Z"), 1, 1, now)).toBe(false);
    });
    it("batch older than cycle+grace is overdue", () => {
      expect(isSettlementBatchOverdue(new Date("2026-07-07T02:00:00Z"), 1, 1, now)).toBe(true);
    });
    it("weekly cycle respects its window", () => {
      expect(isSettlementBatchOverdue(new Date("2026-07-05T02:00:00Z"), 7, 1, now)).toBe(false);
    });
  });
});

// ─── Integration Test: Full Retail Reconciliation Run ────────────────────────

describe("runRetailReconciliation", () => {
  it("runs core matching + retail exception classification", () => {
    const sourceTxns: Transaction[] = [
      makeTxn({ id: 1, transactionRef: "ORD-001", amount: "100.00" }),
      makeTxn({ id: 2, transactionRef: "ORD-002", amount: "200.00" }),
      makeTxn({
        id: 3,
        transactionRef: "ORD-003",
        amount: "300.00",
        rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-999" },
      }),
    ];
    const targetTxns: Transaction[] = [
      makeTxn({ id: 101, transactionRef: "ORD-001", amount: "100.00" }),
      // ORD-002 missing from target → unmatched
      // ORD-003 is a chargeback → retail exception
    ];

    const result = runRetailReconciliation(sourceTxns, targetTxns, baseConfig);

    // Core engine should match ORD-001
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    // Retail stats should be populated
    expect(result.retailStats.totalRetailExceptions).toBeGreaterThanOrEqual(0);
    expect(result.retailStats).toHaveProperty("chargebackCount");
    expect(result.retailStats).toHaveProperty("taxonomyCoverage");
  });

  it("detects a same-feed duplicate chargeback end-to-end (integration, not just unit)", () => {
    // Two unmatched chargebacks with the SAME ARN on the SOURCE feed. Before the
    // fix, runRetailReconciliation passed the opposite (target) side to the
    // classifier, so it could never see these siblings.
    const sourceTxns: Transaction[] = [
      makeTxn({ id: 1, transactionRef: "CB-1", amount: "50.00", rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-DUP" } }),
      makeTxn({ id: 2, transactionRef: "CB-2", amount: "50.00", rawData: { gatewayEventType: "chargeback", chargebackArn: "ARN-DUP" } }),
    ];
    const targetTxns: Transaction[] = []; // opposite side empty on purpose

    const result = runRetailReconciliation(sourceTxns, targetTxns, baseConfig);
    const dupes = result.retailExceptions.filter((e) => e.category === "retail_chargeback_duplicate");
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    expect(result.retailStats.chargebackCount).toBeGreaterThanOrEqual(1);
    // Zero-data-loss: every unmatched txn is accounted for as an exception.
    expect(result.retailExceptions).toHaveLength(
      result.unmatchedSource.length + result.unmatchedTarget.length,
    );
  });
});
