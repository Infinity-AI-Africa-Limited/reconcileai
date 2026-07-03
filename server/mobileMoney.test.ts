/**
 * Mobile Money Reconciliation — Unit Tests
 *
 * Covers:
 *   1. Exception category taxonomy completeness
 *   2. Priority level classification
 *   3. CBN rule reference mapping
 *   4. Amount mismatch detection logic
 *   5. Duplicate session detection
 *   6. Operator metadata completeness
 *   7. KPI benchmark keys for mobile money
 *   8. statusFor() with mobile money benchmarks
 */

import { describe, it, expect } from "vitest";

// ─── Exception taxonomy ───────────────────────────────────────────────────────

const MM_EXCEPTION_CATEGORIES = [
  "mm_failed_ussd_debit",
  "mm_reversal_not_credited",
  "mm_nip_settlement_shortfall",
  "mm_duplicate_credit",
  "mm_expired_session_debit",
  "mm_amount_mismatch",
  "mm_unmatched_nip_inflow",
  "mm_operator_fee_variance",
] as const;

type MmCategory = typeof MM_EXCEPTION_CATEGORIES[number];

const PRIORITY_MAP: Record<MmCategory, "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"> = {
  mm_failed_ussd_debit:       "CRITICAL",
  mm_reversal_not_credited:   "CRITICAL",
  mm_nip_settlement_shortfall:"HIGH",
  mm_duplicate_credit:        "CRITICAL",
  mm_expired_session_debit:   "HIGH",
  mm_amount_mismatch:         "HIGH",
  mm_unmatched_nip_inflow:    "MEDIUM",
  mm_operator_fee_variance:   "LOW",
};

const CBN_RULE_MAP: Record<MmCategory, string> = {
  mm_failed_ussd_debit:        "CBN Mobile Money Policy 2021 §4.2 — Failed debit reversal within T+1",
  mm_reversal_not_credited:    "CBN Mobile Money Policy 2021 §4.3 — Reversal credit within 24 hours",
  mm_nip_settlement_shortfall: "NIBSS NIP Operating Rules §7.1 — Net settlement reconciliation",
  mm_duplicate_credit:         "CBN Mobile Money Policy 2021 §4.5 — Duplicate transaction prevention",
  mm_expired_session_debit:    "CBN Mobile Money Policy 2021 §4.2 — Session timeout reversal",
  mm_amount_mismatch:          "NIBSS NIP Operating Rules §6.3 — Amount integrity validation",
  mm_unmatched_nip_inflow:     "NIBSS NIP Operating Rules §7.2 — Inflow reconciliation",
  mm_operator_fee_variance:    "CBN Mobile Money Policy 2021 §5.1 — Fee schedule compliance",
};

// ─── Operator metadata ────────────────────────────────────────────────────────

const OPERATORS = ["NIP", "OPAY", "PALMPAY"] as const;
type MmOperator = typeof OPERATORS[number];

const OPERATOR_META: Record<MmOperator, { label: string; color: string; description: string }> = {
  NIP:     { label: "NIP / NIBSS",  color: "#1B4F72", description: "Interbank settlement via NIBSS NIP" },
  OPAY:    { label: "OPay",         color: "#FF6B35", description: "OPay mobile money settlement" },
  PALMPAY: { label: "PalmPay",      color: "#00B894", description: "PalmPay mobile money settlement" },
};

// ─── KPI benchmark keys ───────────────────────────────────────────────────────

import { BENCHMARKS, statusFor } from "./routers/pocKpi";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Mobile Money Exception Taxonomy", () => {
  it("defines exactly 8 exception categories", () => {
    expect(MM_EXCEPTION_CATEGORIES).toHaveLength(8);
  });

  it("all categories have a priority level assigned", () => {
    for (const cat of MM_EXCEPTION_CATEGORIES) {
      expect(PRIORITY_MAP[cat]).toBeDefined();
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(PRIORITY_MAP[cat]);
    }
  });

  it("all categories have a CBN rule reference", () => {
    for (const cat of MM_EXCEPTION_CATEGORIES) {
      const rule = CBN_RULE_MAP[cat];
      expect(rule).toBeDefined();
      expect(rule.length).toBeGreaterThan(10);
    }
  });

  it("CRITICAL categories are the most financially damaging ones", () => {
    const criticals = MM_EXCEPTION_CATEGORIES.filter((c) => PRIORITY_MAP[c] === "CRITICAL");
    expect(criticals).toContain("mm_failed_ussd_debit");
    expect(criticals).toContain("mm_duplicate_credit");
    expect(criticals).toContain("mm_reversal_not_credited");
  });

  it("operator fee variance is LOW priority (non-urgent)", () => {
    expect(PRIORITY_MAP["mm_operator_fee_variance"]).toBe("LOW");
  });
});

describe("Mobile Money Operator Metadata", () => {
  it("defines exactly 3 operators", () => {
    expect(OPERATORS).toHaveLength(3);
  });

  it("all operators have label, color, and description", () => {
    for (const op of OPERATORS) {
      const meta = OPERATOR_META[op];
      expect(meta.label).toBeTruthy();
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.description).toBeTruthy();
    }
  });

  it("NIP operator references NIBSS", () => {
    expect(OPERATOR_META.NIP.description).toContain("NIBSS");
  });
});

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

  it("mmFalsePositiveRate: 3.5% is between", () => {
    const b = BENCHMARKS.mmFalsePositiveRate;
    expect(statusFor(3.5, b.target, b.floor, b.higherIsBetter)).toBe("between");
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

describe("Amount mismatch detection logic", () => {
  // Simulates the core matching logic used in the mobile money engine
  function detectAmountMismatch(settlementAmt: number, ledgerAmt: number, toleranceNgn = 0.01): boolean {
    return Math.abs(settlementAmt - ledgerAmt) > toleranceNgn;
  }

  it("identical amounts are not a mismatch", () => {
    expect(detectAmountMismatch(5000, 5000)).toBe(false);
  });

  it("amounts within ₦0.01 tolerance are not a mismatch", () => {
    expect(detectAmountMismatch(5000.005, 5000)).toBe(false);
  });

  it("amounts differing by ₦1 are a mismatch", () => {
    expect(detectAmountMismatch(5001, 5000)).toBe(true);
  });

  it("large amount differences are detected", () => {
    expect(detectAmountMismatch(50000, 45000)).toBe(true);
  });
});

describe("Duplicate session detection logic", () => {
  // Simulates the dedup logic in the mobile money engine
  function findDuplicates(sessions: Array<{ sessionId: string; amount: number; txnDate: string }>) {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const txn of sessions) {
      const key = `${txn.sessionId}:${txn.amount}:${txn.txnDate}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen.entries()) {
      if (count > 1) duplicates.push(key);
    }
    return duplicates;
  }

  it("no duplicates in clean dataset", () => {
    const sessions = [
      { sessionId: "SID001", amount: 5000, txnDate: "2025-01-15" },
      { sessionId: "SID002", amount: 3000, txnDate: "2025-01-15" },
    ];
    expect(findDuplicates(sessions)).toHaveLength(0);
  });

  it("detects exact duplicate session", () => {
    const sessions = [
      { sessionId: "SID001", amount: 5000, txnDate: "2025-01-15" },
      { sessionId: "SID001", amount: 5000, txnDate: "2025-01-15" },
    ];
    expect(findDuplicates(sessions)).toHaveLength(1);
  });

  it("same session ID with different amounts is not a duplicate", () => {
    const sessions = [
      { sessionId: "SID001", amount: 5000, txnDate: "2025-01-15" },
      { sessionId: "SID001", amount: 4999, txnDate: "2025-01-15" },
    ];
    expect(findDuplicates(sessions)).toHaveLength(0);
  });
});
