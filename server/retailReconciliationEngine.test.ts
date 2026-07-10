import { describe, it, expect } from "vitest";
import {
  classifyRetailException,
  runRetailReconciliation,
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
});
