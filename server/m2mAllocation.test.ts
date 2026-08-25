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
import {
  runM2MMatching,
  determinateCandidates,
  isComparableCandidate,
  selectCounterpartLegs,
  type SATransaction,
} from "./superAgentEngine";

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

/** A counterpart leg: opposite direction, same payer and currency. */
function invoice(amount: number, overrides: Partial<SATransaction> = {}): SATransaction {
  return { ...txn(amount), debitCredit: "debit", ...overrides } as SATransaction;
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

  it("should refuse a split remittance even when only one candidate exists at all", () => {
    // The pool-size short-circuit used to sit ABOVE the split guard, so a
    // two-invoice reference against a one-invoice pool returned that invoice —
    // the same hole, one line above the code closing it.
    const receipt = txn(1_500_000, "INV-2847 INV-2848", "part settlement");
    expect(determinateCandidates(receipt, [txn(1_000_000, "INV-2847")])).toEqual([]);
  });

  it("should refuse a single candidate that is not the invoice the reference names", () => {
    const receipt = txn(950_000, "INV-9999", "payment for INV-9999");
    expect(determinateCandidates(receipt, [txn(1_000_000, "INV-2847")])).toEqual([]);
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

  it("should still refuse a split remittance when only one of its invoices is open", () => {
    // Finding one of the two does not make the receipt a payment against that
    // one. Diagnosing the whole 1,500,000 against a 1,000,000 invoice reports a
    // 500,000 shortfall that does not exist, on a single-invoice action draft.
    const receipt = txn(1_500_000, "INV-2847 INV-2848", "part settlement");
    const chosen = determinateCandidates(receipt, [txn(1_000_000, "INV-2847"), txn(900_000, "INV-9000")]);
    expect(chosen).toEqual([]);
  });

  it("should treat one invoice named twice as one invoice, not a split", () => {
    // The control for the rule above: the same number routinely appears in both
    // the reference and the description, and counting raw hits would read that
    // as a two-invoice remittance and refuse every ordinary receipt.
    const receipt = txn(950_000, "INV-2847", "payment for INV-2847");
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const chosen = determinateCandidates(receipt, [exact, txn(955_000, "INV-3100")]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  it("should not let a longer invoice number swallow a shorter one", () => {
    // Substring matching made INV-2847 match INV-28470, so a receipt whose real
    // invoice is absent from the open pool attached to a longer one and
    // quantified a shortfall against it.
    const receipt = txn(950_000, "INV-2847", "payment for INV-2847");
    const longer = txn(1_000_000, "INV-28470", "Invoice INV-28470");
    expect(determinateCandidates(receipt, [longer, txn(900_000, "INV-3100")])).toEqual([]);
  });

  it("should still match the exact invoice when it is present alongside the longer one", () => {
    // The control: the rule above must reject a PREFIX, not reject matching.
    const receipt = txn(950_000, "INV-2847", "payment for INV-2847");
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const longer = txn(955_000, "INV-28470", "Invoice INV-28470");
    const chosen = determinateCandidates(receipt, [longer, exact]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  it("should refuse when the named invoice is not among the candidates", () => {
    const receipt = txn(950_000, "INV-9999", "payment for INV-9999");
    const chosen = determinateCandidates(receipt, [txn(1_000_000, "INV-2847"), txn(955_000, "INV-3100")]);
    expect(chosen).toEqual([]);
  });
});

describe("when a split remittance names its invoices in shorthand", () => {
  /**
   * The prefix is written once and the remaining legs are left bare, which is
   * how distributors actually write a batch remittance. INVOICE_PATTERN needs a
   * prefix on every identifier, so it extracted only the first and the
   * split-remittance guard — which counts extracted identifiers — saw a
   * single-invoice payment. The whole receipt was then diagnosed against one
   * leg, reporting a shortfall the size of the legs nobody had seen.
   */
  // Each case carries the invoice ref its OWN first leg names. Reusing one
  // fixture across every reference made the range case pass vacuously — its leg
  // was absent from the pool, so it was refused by the "named invoice is not
  // among the candidates" rule and would have passed with the shorthand guard
  // deleted. A test that cannot fail is not evidence.
  it.each([
    ["INV-1001 and 1002", "INV-1001", "a bare second leg joined by 'and'"],
    ["INV-1001, 1002, 1003", "INV-1001", "a comma-separated list"],
    ["INV-2001-2005", "INV-2001", "a hyphenated range"],
    ["INV-1001 & 1002", "INV-1001", "an ampersand list"],
    ["INV-1001 to 1005", "INV-1001", "a spelled-out range"],
    ["INV-1001/1002", "INV-1001", "a slash-separated pair"],
    // The separators that broke the previous, allowlist-based guard. They are
    // listed for the record, not because the rule enumerates them — it asks
    // whether an invoice-length number is left unaccounted for, which is why
    // the last three (never named in review) pass without being anticipated.
    ["INV-1001; 1002", "INV-1001", "a semicolon"],
    ["INV-1001: 1002", "INV-1001", "a colon"],
    ["INV-1001 or 1002", "INV-1001", "'or'"],
    ["INV-1001 plus 1002", "INV-1001", "'plus'"],
    ["INV-1001|1002", "INV-1001", "a pipe"],
    ["INV-1001\n1002", "INV-1001", "a newline"],
  ])("should refuse %s (%s)", (reference, firstLeg) => {
    // The first leg IS open and IS the nearest by amount — the trap. Returning
    // it quantifies the unseen legs as a shortfall against this one.
    const receipt = txn(1_500_000, reference, `remittance ${reference}`);
    expect(determinateCandidates(receipt, [txn(1_000_000, firstLeg)])).toEqual([]);
    expect(determinateCandidates(receipt, [txn(1_000_000, firstLeg), txn(500_000, "INV-7777")])).toEqual([]);
  });

  it("should still refuse when the shorthand list is the only thing in the reference", () => {
    // No pool-size escape either: a single candidate is not made unambiguous by
    // being alone when the reference names more than one invoice.
    const receipt = txn(1_500_000, "INV-2001-2005", null);
    expect(determinateCandidates(receipt, [txn(1_000_000, "INV-2001")])).toEqual([]);
  });
});

describe("what the shorthand guard must NOT refuse", () => {
  // The control for the block above. A guard that declines everything is
  // indistinguishable from deleting the feature, and these are the ordinary
  // references it has to keep resolving.
  it("should still resolve a single invoice carrying a stated deduction amount", () => {
    // "less 1500" is a deduction, not a second invoice. The connector list is
    // what separates the two, and it does not contain "less".
    const receipt = txn(998_500, "INV-2847 less 1500", "payment INV-2847 less 1500 bank charge");
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const chosen = determinateCandidates(receipt, [exact, txn(955_000, "INV-3100")]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  it("should still resolve an invoice number carrying a short line suffix", () => {
    // "INV-2847-01" is one invoice with a line/sequence suffix. Two digits
    // cannot be an invoice number, so the range reading is not available.
    const receipt = txn(950_000, "INV-2847-01", "payment for INV-2847-01");
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const chosen = determinateCandidates(receipt, [exact, txn(955_000, "INV-3100")]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  it("should still resolve a plain single-invoice reference", () => {
    const receipt = txn(950_000, "INV-2847 less promo", "MOMO COLLECTION less promo allowance");
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const chosen = determinateCandidates(receipt, [exact, txn(955_000, "INV-3100")]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  // Inverting the rule to "any invoice-length number nothing accounts for"
  // widens what can trip it, so the numbers a remittance ordinarily carries
  // have to stay accounted for. Each of these WOULD decline without its entry
  // in ACCOUNTED_NUMBER_PATTERNS.
  it.each([
    ["INV-2847 less 1,500 bank charge", "a thousands-separated amount"],
    ["INV-2847 less 2500.00", "a decimal amount"],
    ["INV-2847 NGN 950000", "a currency-cued amount"],
    ["INV-2847 amount 950000", "an amount cue"],
    ["INV-2847 balance 50000", "a balance cue"],
    ["INV-2847 20260812", "a yyyymmdd value date"],
    ["INV-2847 12/08/2026", "a slash date"],
  ])("should still resolve %s (%s)", (reference) => {
    const receipt = txn(950_000, reference, `payment ${reference}`);
    const exact = txn(1_000_000, "INV-2847", "Invoice INV-2847");
    const chosen = determinateCandidates(receipt, [exact, txn(955_000, "INV-3100")]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(exact.id);
  });

  it("should still use a single candidate when the narration carries stray digits", () => {
    // No invoice identifier was extracted, so "more invoices than I found" is
    // not a claim this rule makes. A phone number in a mobile-money narration
    // must not withdraw the single-candidate branch, which rests on there
    // being one open invoice rather than on reading the reference.
    const receipt = txn(950_000, null, "MOMO COLLECTION 0771234567 KAMPALA");
    const only = txn(1_000_000);
    expect(determinateCandidates(receipt, [only])).toEqual([only]);
  });
});


/**
 * What may enter the candidate pool at all.
 *
 * Four rounds of pool defects were fixed inside a SQL `WHERE` clause no test
 * could reach, which is why the same class kept arriving by a different route.
 * The rule is now pure and asserted directly. Every exclusion is paired with
 * its admitting case, or a function that always returned false would look
 * identical to one that works.
 */
describe("what may be compared against a receipt at all", () => {
  const receipt = txn(950_000, "INV-2847", "MOMO COLLECTION INV-2847");

  it("should admit an invoice from the same payer", () => {
    expect(isComparableCandidate(receipt, invoice(1_000_000))).toBe(true);
  });

  it("should reject a reversal", () => {
    // Reversed money is not an obligation to measure against; it is the
    // b2b_receipt_reversed_after_allocation exception.
    expect(isComparableCandidate(receipt, invoice(1_000_000, { isReversal: true }))).toBe(false);
  });

  it("should reject another distributor's invoice", () => {
    expect(isComparableCandidate(receipt, invoice(1_000_000, { counterparty: "Jinja Traders Ltd" }))).toBe(false);
  });

  it("should reject a different currency, which is an FX exception not a shortfall", () => {
    expect(isComparableCandidate(receipt, invoice(1_000_000, { currency: "NGN" }))).toBe(false);
  });

  it("should reject the transaction itself", () => {
    expect(isComparableCandidate(receipt, receipt)).toBe(false);
  });

  it("should compare against nothing when the payer is unknown", () => {
    // No counterparty is not a wildcard — missing_counterparty is the correct
    // diagnosis, and inventing a comparison fabricates the figure.
    const anonymous = txn(950_000);
    anonymous.counterparty = null;
    expect(isComparableCandidate(anonymous, invoice(1_000_000))).toBe(false);
    expect(isComparableCandidate(receipt, invoice(1_000_000, { counterparty: null }))).toBe(false);
  });

  it("should tolerate the payer being spelled with different punctuation", () => {
    // The control for the counterparty rule: it must reject a DIFFERENT payer,
    // not reject matching. Feeds routinely differ in case and punctuation.
    expect(isComparableCandidate(receipt, invoice(1_000_000, { counterparty: "kampala distributors, ltd." }))).toBe(true);
  });
});

/**
 * Direction, which review found wrong in BOTH directions in one round — the
 * signal that the type was wrong rather than the logic.
 *
 * Too permissive: a same-side receipt was scored against the receipt being
 * diagnosed. Too strict: an unconditional opposite-direction test deleted the
 * genuine counterpart for feeds that never recorded a direction, because
 * `apiIngestionService` stores `row.debitCredit || row.type || "debit"` — a CSV
 * with neither column lands BOTH legs as `debit`, and those SFTP/bucket/API
 * drops are exactly the pilot's own source contracts (B2).
 */
describe("when the feeds do record a direction", () => {
  const receipt = txn(950_000, "INV-2847", "MOMO COLLECTION INV-2847");

  it("should keep the opposite-direction invoice and drop the same-side payment", () => {
    const realLeg = invoice(1_000_000);
    const strayReceipt = invoice(980_000, { debitCredit: "credit" });
    const { legs, directionSignal } = selectCounterpartLegs(receipt, [realLeg, strayReceipt]);
    expect(directionSignal).toBe("discriminating");
    expect(legs.map((l) => l.id)).toEqual([realLeg.id]);
  });

  it("should drop a same-side payment even when it is numerically nearer", () => {
    // The trap: findNearestTarget picks by amount, so the stray wins on
    // proximity and the gap between two payments becomes a "shortfall".
    const realLeg = invoice(1_000_000);
    const nearerStray = invoice(950_500, { debitCredit: "credit" });
    const { legs } = selectCounterpartLegs(receipt, [nearerStray, realLeg]);
    expect(legs.map((l) => l.id)).toEqual([realLeg.id]);
  });
});

describe("when neither feed recorded a direction", () => {
  it("should keep the counterpart rather than emptying the pool", () => {
    // Both legs arrive as "debit" because the CSV had neither column. An
    // unconditional opposite-direction filter removed the real invoice here and
    // the shortfall silently vanished — for the customers whose files are least
    // well-formed, which is the worst possible population to fail quietly on.
    const receipt = txn(950_000, "INV-2847", "COLLECTION INV-2847");
    receipt.debitCredit = "debit";
    const realLeg = invoice(1_000_000);
    const { legs, directionSignal } = selectCounterpartLegs(receipt, [realLeg]);
    expect(directionSignal).toBe("uninformative");
    expect(legs.map((l) => l.id)).toEqual([realLeg.id]);
  });

  it("should report the signal so the caller can say the column was never populated", () => {
    const receipt = txn(950_000);
    receipt.debitCredit = "debit";
    const { directionSignal } = selectCounterpartLegs(receipt, [invoice(1_000_000), invoice(900_000)]);
    // Not "discriminating": nothing was discriminated. Saying so is the point —
    // neither true nor false is a safe answer for "the column is unpopulated".
    expect(directionSignal).toBe("uninformative");
  });

  it("should still apply every rule that does NOT depend on direction", () => {
    // The control: ignoring direction must not become ignoring everything.
    const receipt = txn(950_000);
    receipt.debitCredit = "debit";
    const { legs } = selectCounterpartLegs(receipt, [
      invoice(1_000_000, { isReversal: true }),
      invoice(1_000_000, { counterparty: "Jinja Traders Ltd" }),
      invoice(1_000_000, { currency: "NGN" }),
    ]);
    expect(legs).toEqual([]);
  });
});

describe("when there is nothing to compare against", () => {
  it("should report none rather than uninformative", () => {
    // An empty pool is not a direction problem, and conflating the two would
    // make a missing counterparty look like a data-quality defect.
    const receipt = txn(950_000);
    const { legs, directionSignal } = selectCounterpartLegs(receipt, []);
    expect(legs).toEqual([]);
    expect(directionSignal).toBe("none");
  });
});
