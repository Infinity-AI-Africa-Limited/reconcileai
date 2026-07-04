/**
 * Mobile Money Reconciliation — Unit Tests
 *
 * Tests the REAL engine (mobileMoney-engine.ts) — not local copies — across
 * both jurisdictions:
 *   Nigeria — NIBSS NIP, OPay, Palmpay (NGN)
 *   Uganda  — MTN MoMo, Airtel Money  (UGX)
 *
 * Covers:
 *   1. Exception taxonomy completeness (12 categories, refs, diagnosis info)
 *   2. Operator metadata (5 operators, jurisdiction, currency)
 *   3. Currency-aware priority classification and money formatting
 *   4. Uganda 0.5% withdrawal-tax variance detection
 *   5. runMmLayer2 behavioral tests (match, mismatch, duplicates, jurisdiction
 *      classification defaults)
 *   6. detectSettlementShortfall (fixes the previously-dead shortfall categories)
 *   7. runMmLayer3 diagnosis output (regulatory refs, currency-aware priority)
 *   8. summarizeResolutionHistory (per-institution learning aggregation)
 *   9. Mobile money KPI benchmarks + statusFor()
 */

import { describe, it, expect } from "vitest";
import {
  OPERATOR_META,
  REG_REFS,
  CATEGORY_INFO,
  fmtMoney,
  priorityFor,
  isWithdrawalTaxVariance,
  runMmLayer2,
  runMmLayer3,
  detectSettlementShortfall,
  summarizeResolutionHistory,
} from "./mobileMoney-engine";
import { MM_EXCEPTION_CATEGORIES, MM_OPERATORS } from "../drizzle/mobile_money_schema";
import { classifyResolutionAction } from "./exceptionIntelligence";
import { runLayer1, type CanonicalRow } from "./poc-engine";
import { BENCHMARKS, statusFor } from "./routers/pocKpi";

// ─── Test row helpers ─────────────────────────────────────────────────────────

function row(overrides: Partial<CanonicalRow> & { amount: number }): CanonicalRow {
  return {
    date: "2026-06-01",
    description: "",
    direction: "credit",
    ...overrides,
  };
}

// ─── 1. Taxonomy ──────────────────────────────────────────────────────────────

describe("Mobile Money Exception Taxonomy", () => {
  it("defines exactly 12 exception categories (8 Nigeria + 4 Uganda)", () => {
    expect(MM_EXCEPTION_CATEGORIES).toHaveLength(12);
  });

  it("includes the four Uganda-specific categories", () => {
    expect(MM_EXCEPTION_CATEGORIES).toContain("mm_wallet_to_bank_failed");
    expect(MM_EXCEPTION_CATEGORIES).toContain("mm_bank_to_wallet_failed");
    expect(MM_EXCEPTION_CATEGORIES).toContain("mm_withdrawal_tax_variance");
    expect(MM_EXCEPTION_CATEGORIES).toContain("mm_momo_settlement_shortfall");
  });

  it("every category has a regulatory rule reference in the engine", () => {
    for (const cat of MM_EXCEPTION_CATEGORIES) {
      expect(REG_REFS[cat], `missing REG_REFS for ${cat}`).toBeDefined();
      expect(REG_REFS[cat].length).toBeGreaterThan(10);
    }
  });

  it("every category has diagnosis info (explanation + action + confidence)", () => {
    for (const cat of MM_EXCEPTION_CATEGORIES) {
      const info = CATEGORY_INFO[cat];
      expect(info, `missing CATEGORY_INFO for ${cat}`).toBeDefined();
      expect(info.confidence).toBeGreaterThanOrEqual(75);
      expect(info.confidence).toBeLessThanOrEqual(100);
      expect(info.action.length).toBeGreaterThan(20);
      const explained = info.explain(
        { category: cat, side: "settlement", amount: 1000, txnDate: "2026-06-01", reference: "R1", sessionId: "R1", description: null },
        "NGN",
      );
      expect(explained.length).toBeGreaterThan(20);
    }
  });

  it("Uganda categories cite Ugandan regulation, not CBN", () => {
    expect(REG_REFS.mm_wallet_to_bank_failed).toContain("Uganda");
    expect(REG_REFS.mm_withdrawal_tax_variance).toContain("Excise Duty");
    expect(REG_REFS.mm_momo_settlement_shortfall).toContain("BoU");
    expect(REG_REFS.mm_wallet_to_bank_failed).not.toContain("CBN");
  });
});

// ─── 2. Operator metadata ─────────────────────────────────────────────────────

describe("Mobile Money Operator Metadata", () => {
  it("defines exactly 5 operators (3 Nigeria + 2 Uganda)", () => {
    expect(MM_OPERATORS).toHaveLength(5);
    expect(Object.keys(OPERATOR_META)).toHaveLength(5);
  });

  it("Nigerian operators use NGN; Ugandan operators use UGX", () => {
    expect(OPERATOR_META.nip.currency).toBe("NGN");
    expect(OPERATOR_META.opay.currency).toBe("NGN");
    expect(OPERATOR_META.palmpay.currency).toBe("NGN");
    expect(OPERATOR_META.mtn_momo_ug.currency).toBe("UGX");
    expect(OPERATOR_META.airtel_money_ug.currency).toBe("UGX");
  });

  it("jurisdiction and regulator are set per operator", () => {
    expect(OPERATOR_META.nip.country).toBe("NG");
    expect(OPERATOR_META.mtn_momo_ug.country).toBe("UG");
    expect(OPERATOR_META.mtn_momo_ug.regulator).toContain("Bank of Uganda");
    expect(OPERATOR_META.airtel_money_ug.regulator).toContain("Bank of Uganda");
  });
});

// ─── 3. Currency-aware priority and formatting ────────────────────────────────

describe("Currency-aware priority and formatting", () => {
  it("NGN thresholds: 500k critical / 100k high / 10k medium", () => {
    expect(priorityFor(600_000, "NGN")).toBe("CRITICAL");
    expect(priorityFor(150_000, "NGN")).toBe("HIGH");
    expect(priorityFor(20_000, "NGN")).toBe("MEDIUM");
    expect(priorityFor(5_000, "NGN")).toBe("LOW");
  });

  it("UGX thresholds are scaled — ₦-level numbers are not misclassified", () => {
    // 500,000 UGX ≈ ₦170k — must NOT be CRITICAL under UGX thresholds
    expect(priorityFor(500_000, "UGX")).toBe("HIGH");
    expect(priorityFor(2_500_000, "UGX")).toBe("CRITICAL");
    expect(priorityFor(100_000, "UGX")).toBe("MEDIUM");
    expect(priorityFor(10_000, "UGX")).toBe("LOW");
  });

  it("fmtMoney uses ₦ for NGN and USh (no decimals) for UGX", () => {
    expect(fmtMoney(5000.5, "NGN")).toContain("₦");
    expect(fmtMoney(5000.5, "NGN")).toContain("5,000.50");
    const ugx = fmtMoney(1_250_000, "UGX");
    expect(ugx).toContain("USh");
    expect(ugx).toContain("1,250,000");
    expect(ugx).not.toContain(".");
  });
});

// ─── 4. Uganda withdrawal tax detection ───────────────────────────────────────

describe("Uganda 0.5% withdrawal tax variance detection", () => {
  it("detects an exact 0.5% difference", () => {
    expect(isWithdrawalTaxVariance(500, 100_000)).toBe(true); // 0.5% of 100k
  });

  it("detects a 0.5% difference within tolerance", () => {
    expect(isWithdrawalTaxVariance(501, 100_000)).toBe(true);
  });

  it("rejects differences that are not the statutory rate", () => {
    expect(isWithdrawalTaxVariance(2_000, 100_000)).toBe(false); // 2%
    expect(isWithdrawalTaxVariance(100, 100_000)).toBe(false);   // 0.1%
  });

  it("rejects zero and negative bases", () => {
    expect(isWithdrawalTaxVariance(500, 0)).toBe(false);
    expect(isWithdrawalTaxVariance(0, 100_000)).toBe(false);
  });
});

// ─── 5. runMmLayer2 behavior ─────────────────────────────────────────────────

describe("runMmLayer2 — Nigeria (NIP)", () => {
  it("clean matched files produce no exceptions", () => {
    const settlement = [row({ amount: 5000, reference: "SID001" }), row({ amount: 3000, reference: "SID002" })];
    const ledger = [row({ amount: 5000, reference: "SID001" }), row({ amount: 3000, reference: "SID002" })];
    expect(runMmLayer2(ledger, settlement, "nip")).toHaveLength(0);
  });

  it("unmatched settlement row defaults to mm_unmatched_nip_inflow", () => {
    const settlement = [row({ amount: 5000, reference: "SID001" })];
    const exceptions = runMmLayer2([], settlement, "nip");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].category).toBe("mm_unmatched_nip_inflow");
    expect(exceptions[0].side).toBe("settlement");
  });

  it("unmatched ledger row defaults to mm_failed_ussd_debit", () => {
    const ledger = [row({ amount: 5000, reference: "SID001" })];
    const exceptions = runMmLayer2(ledger, [], "nip");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].category).toBe("mm_failed_ussd_debit");
    expect(exceptions[0].side).toBe("ledger");
  });

  it("reversal descriptions classify as mm_reversal_not_credited", () => {
    const settlement = [row({ amount: 5000, reference: "SID001", description: "Reversal of failed transfer" })];
    const exceptions = runMmLayer2([], settlement, "nip");
    expect(exceptions[0].category).toBe("mm_reversal_not_credited");
  });

  it("duplicate session IDs in the settlement are flagged", () => {
    const settlement = [row({ amount: 5000, reference: "SID001" }), row({ amount: 5000, reference: "SID001" })];
    const ledger = [row({ amount: 5000, reference: "SID001" })];
    const exceptions = runMmLayer2(ledger, settlement, "nip");
    const dup = exceptions.filter((e) => e.category === "mm_duplicate_credit");
    expect(dup).toHaveLength(1);
    expect(dup[0].description).toContain("2 times");
  });
});

describe("runMmLayer2 — Uganda (MTN MoMo / Airtel Money)", () => {
  it("unmatched settlement row classifies as mm_wallet_to_bank_failed", () => {
    const settlement = [row({ amount: 250_000, reference: "FT12345678" })];
    const exceptions = runMmLayer2([], settlement, "mtn_momo_ug");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].category).toBe("mm_wallet_to_bank_failed");
  });

  it("unmatched ledger row classifies as mm_bank_to_wallet_failed", () => {
    const ledger = [row({ amount: 250_000, reference: "FT12345678" })];
    const exceptions = runMmLayer2(ledger, [], "airtel_money_ug");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].category).toBe("mm_bank_to_wallet_failed");
  });

  it("tax/levy descriptions classify as mm_withdrawal_tax_variance", () => {
    const settlement = [row({ amount: 1_250, reference: "TX900", description: "Excise levy on withdrawal" })];
    const exceptions = runMmLayer2([], settlement, "mtn_momo_ug");
    expect(exceptions[0].category).toBe("mm_withdrawal_tax_variance");
  });

  it("a matched-ref ~0.5% amount difference classifies as withdrawal tax, not generic mismatch", () => {
    // Ledger books gross 1,000,000 UGX; operator settles net of 0.5% levy = 995,000
    const ledger = [row({ amount: 1_000_000, reference: "FT555" })];
    const settlement = [row({ amount: 995_000, reference: "FT555" })];
    const exceptions = runMmLayer2(ledger, settlement, "mtn_momo_ug");
    const tax = exceptions.filter((e) => e.category === "mm_withdrawal_tax_variance");
    expect(tax).toHaveLength(1);
    expect(tax[0].amount).toBeCloseTo(5_000, 0);
  });

  it("the same difference on a Nigerian operator stays mm_amount_mismatch", () => {
    const ledger = [row({ amount: 1_000_000, reference: "FT555" })];
    const settlement = [row({ amount: 995_000, reference: "FT555" })];
    const exceptions = runMmLayer2(ledger, settlement, "opay");
    expect(exceptions[0].category).toBe("mm_amount_mismatch");
  });
});

// ─── 6. Settlement shortfall detection (previously a dead category) ──────────

describe("detectSettlementShortfall", () => {
  it("emits mm_nip_settlement_shortfall when NIP settlement is short", () => {
    const ledger = [row({ amount: 100_000 })];
    const settlement = [row({ amount: 90_000 })];
    const layer1 = runLayer1(ledger, settlement, "NGN");
    const shortfall = detectSettlementShortfall(layer1, "nip");
    expect(shortfall).not.toBeNull();
    expect(shortfall!.category).toBe("mm_nip_settlement_shortfall");
    expect(shortfall!.amount).toBe(10_000);
  });

  it("emits mm_momo_settlement_shortfall for non-NIP operators", () => {
    const ledger = [row({ amount: 100_000 })];
    const settlement = [row({ amount: 90_000 })];
    const layer1 = runLayer1(ledger, settlement, "NGN");
    expect(detectSettlementShortfall(layer1, "opay")!.category).toBe("mm_momo_settlement_shortfall");
  });

  it("classifies a 0.5%-profile Uganda shortfall as withdrawal tax", () => {
    const ledger = [row({ amount: 1_000_000 })];
    const settlement = [row({ amount: 995_000 })];
    const layer1 = runLayer1(ledger, settlement, "UGX");
    const shortfall = detectSettlementShortfall(layer1, "mtn_momo_ug");
    expect(shortfall!.category).toBe("mm_withdrawal_tax_variance");
  });

  it("returns null when balanced", () => {
    const rows = [row({ amount: 100_000 })];
    const layer1 = runLayer1(rows, rows, "NGN");
    expect(detectSettlementShortfall(layer1, "nip")).toBeNull();
  });

  it("returns null on settlement surplus (not a shortfall)", () => {
    const ledger = [row({ amount: 90_000 })];
    const settlement = [row({ amount: 100_000 })];
    const layer1 = runLayer1(ledger, settlement, "NGN");
    expect(detectSettlementShortfall(layer1, "nip")).toBeNull();
  });
});

// ─── 7. runMmLayer3 diagnosis ─────────────────────────────────────────────────

describe("runMmLayer3 — AI diagnosis output", () => {
  it("attaches regulatory reference, priority, and confidence per exception", () => {
    const drafts = runMmLayer2([], [row({ amount: 600_000, reference: "SID1" })], "nip");
    const [item] = runMmLayer3(drafts, "nip");
    expect(item.cbnRuleReference).toBe(REG_REFS.mm_unmatched_nip_inflow);
    expect(item.priorityLevel).toBe("CRITICAL"); // 600k NGN
    expect(item.agentConfidence).toBeGreaterThanOrEqual(75);
    expect(item.agentExplanation).toContain("₦");
  });

  it("Uganda diagnoses use UGX priorities and USh formatting", () => {
    // 600,000 UGX is HIGH under UGX thresholds (would be CRITICAL under NGN)
    const drafts = runMmLayer2([], [row({ amount: 600_000, reference: "FT1" })], "mtn_momo_ug");
    const [item] = runMmLayer3(drafts, "mtn_momo_ug");
    expect(item.category).toBe("mm_wallet_to_bank_failed");
    expect(item.priorityLevel).toBe("HIGH");
    expect(item.agentExplanation).toContain("USh");
    expect(item.cbnRuleReference).toContain("Uganda");
  });
});

// ─── 8. Per-institution learning aggregation ──────────────────────────────────

describe("summarizeResolutionHistory — learning flywheel aggregation", () => {
  it("ignores OPEN exceptions and aggregates terminal statuses per category", () => {
    const history = [
      { category: "mm_failed_ussd_debit", reviewStatus: "RESOLVED", reviewNote: "Reversal posted to customer account" },
      { category: "mm_failed_ussd_debit", reviewStatus: "RESOLVED", reviewNote: "Reversal initiated via operator portal" },
      { category: "mm_failed_ussd_debit", reviewStatus: "ESCALATED", reviewNote: "Escalated to NIBSS dispute desk" },
      { category: "mm_failed_ussd_debit", reviewStatus: "OPEN", reviewNote: null },
      { category: "mm_duplicate_credit", reviewStatus: "RESOLVED", reviewNote: "Duplicate credit reversed" },
    ];
    const stats = summarizeResolutionHistory(history, classifyResolutionAction);
    const ussd = stats.get("mm_failed_ussd_debit")!;
    expect(ussd.actioned).toBe(3);
    expect(ussd.resolved).toBe(2);
    expect(ussd.escalated).toBe(1);
    expect(stats.get("mm_duplicate_credit")!.actioned).toBe(1);
    expect(stats.has("mm_amount_mismatch")).toBe(false);
  });

  it("identifies the dominant resolution action class", () => {
    const history = [
      { category: "mm_failed_ussd_debit", reviewStatus: "RESOLVED", reviewNote: "Reversal posted" },
      { category: "mm_failed_ussd_debit", reviewStatus: "RESOLVED", reviewNote: "Reversed the debit" },
      { category: "mm_failed_ussd_debit", reviewStatus: "ESCALATED", reviewNote: "Escalated to operator" },
    ];
    const stats = summarizeResolutionHistory(history, classifyResolutionAction);
    const top = stats.get("mm_failed_ussd_debit")!.topActionClass;
    expect(top).toBe(classifyResolutionAction("Reversal posted"));
  });
});

// ─── 9. KPI benchmarks ────────────────────────────────────────────────────────

describe("Mobile Money KPI Benchmarks", () => {
  it("all 5 mobile money benchmark keys are defined in BENCHMARKS", () => {
    const mmKeys = [
      "mmAutoMatchRate",
      "mmFalsePositiveRate",
      "mmResolutionRate",
      "mmAiConfidence",
      "mmFailedUssdDetection",
    ] as const;
    for (const key of mmKeys) {
      expect(BENCHMARKS[key]).toBeDefined();
      expect(BENCHMARKS[key].unit).toBe("%");
    }
  });

  it("mmAutoMatchRate target is 95% (same as card settlement)", () => {
    expect(BENCHMARKS.mmAutoMatchRate.target).toBe(95);
    expect(BENCHMARKS.mmAutoMatchRate.higherIsBetter).toBe(true);
  });

  it("mmFalsePositiveRate target is 2% (lower is better)", () => {
    expect(BENCHMARKS.mmFalsePositiveRate.target).toBe(2);
    expect(BENCHMARKS.mmFalsePositiveRate.higherIsBetter).toBe(false);
  });

  it("mmFailedUssdDetection target is 100% (zero tolerance)", () => {
    expect(BENCHMARKS.mmFailedUssdDetection.target).toBe(100);
    expect(BENCHMARKS.mmFailedUssdDetection.floor).toBe(95);
  });
});

describe("statusFor() with mobile money benchmarks", () => {
  it("mmAutoMatchRate: 97% is above_target", () => {
    const b = BENCHMARKS.mmAutoMatchRate;
    expect(statusFor(97, b.target, b.floor, b.higherIsBetter)).toBe("above_target");
  });

  it("mmAutoMatchRate: 88% is between (above floor, below target)", () => {
    const b = BENCHMARKS.mmAutoMatchRate;
    expect(statusFor(88, b.target, b.floor, b.higherIsBetter)).toBe("between");
  });

  it("mmAutoMatchRate: 70% is below_floor", () => {
    const b = BENCHMARKS.mmAutoMatchRate;
    expect(statusFor(70, b.target, b.floor, b.higherIsBetter)).toBe("below_floor");
  });

  it("mmFalsePositiveRate: 1% is above_target (lower is better)", () => {
    const b = BENCHMARKS.mmFalsePositiveRate;
    expect(statusFor(1, b.target, b.floor, b.higherIsBetter)).toBe("above_target");
  });

  it("mmFalsePositiveRate: 8% is below_floor", () => {
    const b = BENCHMARKS.mmFalsePositiveRate;
    expect(statusFor(8, b.target, b.floor, b.higherIsBetter)).toBe("below_floor");
  });

  it("null value returns no_data", () => {
    const b = BENCHMARKS.mmAutoMatchRate;
    expect(statusFor(null, b.target, b.floor, b.higherIsBetter)).toBe("no_data");
  });
});
