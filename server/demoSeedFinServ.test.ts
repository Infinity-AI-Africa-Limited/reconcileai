import { describe, expect, it } from "vitest";
import { buildFinServDemoPlan, FINSERV_OPERATIONAL_CASES } from "./demoSeedFinServ";

describe("financial-services operational demo plan", () => {
  it("keeps displayed transaction, match and exception counts internally consistent", () => {
    const plan = buildFinServDemoPlan();

    expect(plan.settlementItems).toBe(320);
    expect(plan.transactionLegs).toBe(640);
    expect(plan.matchedPairs).toBe(304);
    expect(plan.exceptionCases).toBe(16);
    expect(plan.matchRate).toBe("95.00");
    expect(plan.matchedPairs + plan.exceptionCases).toBe(plan.settlementItems);
    // The Transactions view shows both settlement and core-ledger legs. The
    // 16 control cases therefore produce 16 `exception` records and 16
    // `unmatched` counterpart legs alongside 608 matched transaction legs.
    expect(plan.matchedPairs * 2 + plan.exceptionCases * 2).toBe(plan.transactionLegs);
  });

  it("provides current open records for Review Queue and aged work for the Age Tracker", () => {
    const plan = buildFinServDemoPlan();

    expect(plan.reviewQueueOpenToday).toBe(7);
    expect(plan.exceptionStatusCounts).toEqual({
      open: 10,
      in_review: 3,
      resolved: 2,
      escalated: 1,
    });
    expect(FINSERV_OPERATIONAL_CASES.some((item) => item.ageDays >= 3)).toBe(true);
  });

  it("covers the payment rails and control cases a financial-services operator needs to review", () => {
    const plan = buildFinServDemoPlan();
    const categories = new Set(plan.cases.map((item) => item.category));

    expect(plan.rails).toHaveLength(8);
    for (const category of [
      "duplicate_transaction",
      "reversal_unmatched",
      "unmatched",
      "amount_mismatch",
      "timing_difference",
      "missing_counterparty",
      "fx_rate_variance",
    ]) {
      expect(categories.has(category)).toBe(true);
    }
  });
});
