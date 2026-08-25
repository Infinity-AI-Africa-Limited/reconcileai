/**
 * Many-to-many allocation — the Corporate B2B pilot's headline capability.
 *
 * The go-live plan cites `runM2MMatching` as evidence that the platform can do
 * "complex allocation reasoning ... one-to-many, many-to-one and many-to-many
 * allocation suggestions", and the Control Fit Brief's default corporate_b2b
 * workflow is literally "Distributor receipt to invoice allocation". It had NO
 * call sites and NO tests.
 *
 * These are the tests. The one that matters most is the ambiguity case: three
 * invoices of 100 against a receipt of 200 admits three equally valid splits,
 * and the previous greedy implementation returned whichever the sort order
 * happened to reach first, at a confidence score around 85. On a receivables
 * ledger that is not a match — it is a fabricated allocation, discovered later
 * as two wrong distributor statements.
 */
import { describe, it, expect } from "vitest";
import { runM2MMatching, determinateCandidates, type SATransaction } from "./superAgentEngine";

let nextId = 1;
function txn(amount: number, ref?: string, description?: string): SATransaction {
  return {
    id: nextId++,
    transactionRef: ref ?? null,
    description: description ?? null,
    counterparty: "Kampala Distributors Ltd",
    amount: amount.toFixed(2),
    currency: "UGX",
    transactionDate: new Date("2026-08-14T09:00:00Z"),
    channelId: 1,
    debitCredit: "credit",
  } as SATransaction;
}

describe("when one receipt settles several invoices", () => {
  it("should propose the split when exactly one combination fits", () => {
    const receipt = txn(300);
    const invoices = [txn(100), txn(200), txn(999)];
    const result = runM2MMatching([receipt], invoices);

    expect(result.m2mMatches).toHaveLength(1);
    const match = result.m2mMatches[0];
    expect(match.matchType).toBe("one_to_many");
    expect(match.targetIds).toHaveLength(2);
    // The allocation must account for the whole receipt, or it is not an
    // allocation — a controller posts these numbers.
    const allocated = match.splitAllocation.reduce((sum, a) => sum + a.allocatedAmount, 0);
    expect(allocated).toBeCloseTo(300, 2);
    expect(result.unresolvedAmbiguities).toHaveLength(0);
  });

  it("should propose NOTHING when several different combinations fit equally well", () => {
    // 100 + 100 = 200, and there are three such invoices: any two of them
    // "match". Picking one is arbitrary, and an arbitrary allocation presented
    // with a confidence score is worse than an open item.
    const receipt = txn(200);
    const invoices = [txn(100), txn(100), txn(100)];
    const result = runM2MMatching([receipt], invoices);

    expect(result.m2mMatches).toHaveLength(0);
    expect(result.unresolvedAmbiguities).toHaveLength(1);
    expect(result.unresolvedAmbiguities[0].reason).toBe("ambiguous");
    expect(result.unresolvedAmbiguities[0].detail).toMatch(/more than one combination/i);
    // And the items stay open rather than disappearing.
    expect(result.remainingSourceIds).toContain(receipt.id);
    expect(result.remainingTargetIds).toHaveLength(3);
  });

  it("should not dress a plain 1:1 near-match as a split allocation", () => {
    // A single invoice within tolerance is the 3-pass engine's job. Reporting
    // it here as "one-to-many" overstated what had been worked out.
    const receipt = txn(500);
    const result = runM2MMatching([receipt], [txn(500), txn(9999)]);
    expect(result.m2mMatches).toHaveLength(0);
    expect(result.remainingSourceIds).toContain(receipt.id);
  });
});

describe("when several receipts settle one invoice", () => {
  it("should propose the aggregation when exactly one combination fits", () => {
    const invoice = txn(750);
    const receipts = [txn(500), txn(250), txn(31)];
    const result = runM2MMatching(receipts, [invoice]);

    const match = result.m2mMatches.find((m) => m.matchType === "many_to_one");
    expect(match).toBeDefined();
    expect(match!.sourceIds).toHaveLength(2);
    expect(match!.totalSourceAmount).toBeCloseTo(750, 2);
  });

  it("should refuse an ambiguous aggregation rather than choosing one", () => {
    const invoice = txn(200);
    const result = runM2MMatching([txn(100), txn(100), txn(100)], [invoice]);
    expect(result.m2mMatches.filter((m) => m.matchType === "many_to_one")).toHaveLength(0);
    expect(result.unresolvedAmbiguities.some((a) => a.targetIds.includes(invoice.id))).toBe(true);
  });
});

describe("amounts that would corrupt the arithmetic", () => {
  it("should ignore a zero-value receipt instead of dividing by it", () => {
    // `diffPct = diff / srcAmt` and `allocationPercent = amount / srcAmt` both
    // divide by the receipt value; a zero receipt produced Infinity/NaN inside
    // a confidence score and an allocation percentage.
    const result = runM2MMatching([txn(0)], [txn(100), txn(200)]);
    expect(result.m2mMatches).toHaveLength(0);
    for (const match of result.m2mMatches) {
      expect(Number.isFinite(match.confidenceScore)).toBe(true);
    }
  });

  it("should ignore non-positive invoice values when summing", () => {
    // A credit note carried as a negative row would otherwise let the search
    // reach a target by subtracting, defeating the ascending-sum pruning and
    // producing sets that do not mean what they claim.
    const receipt = txn(300);
    const result = runM2MMatching([receipt], [txn(100), txn(200), txn(-50)]);
    const match = result.m2mMatches[0];
    expect(match).toBeDefined();
    for (const allocation of match.splitAllocation) {
      expect(allocation.allocatedAmount).toBeGreaterThan(0);
    }
  });

  it("should produce finite, sane confidence scores on every proposal", () => {
    const result = runM2MMatching([txn(300), txn(750)], [txn(100), txn(200), txn(500), txn(250)]);
    for (const match of result.m2mMatches) {
      expect(Number.isFinite(match.confidenceScore)).toBe(true);
      expect(match.confidenceScore).toBeGreaterThan(0);
      expect(match.confidenceScore).toBeLessThanOrEqual(100);
    }
  });
});

describe("invoice-reference grouping", () => {
  it("should group a receipt and an invoice that share an invoice number", () => {
    const receipt = txn(1000, "INV-2847", "payment for INV-2847");
    const invoice = txn(1000, "INV-2847", "INV-2847 goods");
    const result = runM2MMatching([receipt], [invoice]);
    const grouped = result.m2mMatches.find((m) => m.matchType === "many_to_many");
    expect(grouped).toBeDefined();
    expect(grouped!.matchReason).toMatch(/INV-2847/);
  });
});

describe("nothing to match", () => {
  it("should return every id as remaining and claim no allocations", () => {
    const receipts = [txn(17), txn(23)];
    const invoices = [txn(1_000_000)];
    const result = runM2MMatching(receipts, invoices);
    expect(result.m2mMatches).toHaveLength(0);
    expect(result.remainingSourceIds).toHaveLength(2);
    expect(result.remainingTargetIds).toHaveLength(1);
    expect(result.unresolvedAmbiguities).toHaveLength(0);
  });
});

describe("choosing what a diagnosis may compare a receipt against", () => {
  /**
   * `findNearestTarget` picks by numeric proximity. Among several of ONE
   * distributor's open invoices that is a guess dressed as a finding — the
   * receipt lands on whichever invoice is nearest by amount rather than the one
   * it settles, and the shortfall is persisted onto a credit-note draft.
   */
  it("should use the invoice the payment reference names", () => {
    const receipt = txn(950_000, "INV-2847 less promo", "MOMO COLLECTION less promo allowance");
    const named = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const decoy = txn(955_000, "INV-3100", "Invoice INV-3100");
    // The decoy is NEARER by amount, which is exactly the trap.
    const chosen = determinateCandidates(receipt, [named, decoy]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(named.id);
  });

  it("should propose no comparison when several invoices are open and nothing names one", () => {
    const receipt = txn(950_000, null, "MOMO COLLECTION KAMPALA DIST");
    const chosen = determinateCandidates(receipt, [txn(1_000_000), txn(955_000), txn(900_000)]);
    expect(chosen).toEqual([]);
  });

  it("should use a single candidate, which is unambiguous by definition", () => {
    const receipt = txn(950_000, null, "MOMO COLLECTION");
    const only = txn(1_000_000);
    expect(determinateCandidates(receipt, [only])).toEqual([only]);
  });

  it("should refuse when the reference names several invoices that are all present", () => {
    // A split remittance is an allocation question, not a shortfall one.
    const receipt = txn(1_500_000, "INV-2847 INV-2848", "part settlement");
    const chosen = determinateCandidates(receipt, [
      txn(1_000_000, "INV-2847"),
      txn(500_000, "INV-2848"),
    ]);
    expect(chosen).toEqual([]);
  });

  it("should refuse when the named invoice is not among the candidates", () => {
    const receipt = txn(950_000, "INV-9999", "payment for INV-9999");
    const chosen = determinateCandidates(receipt, [txn(1_000_000, "INV-2847"), txn(955_000, "INV-3100")]);
    expect(chosen).toEqual([]);
  });
});
