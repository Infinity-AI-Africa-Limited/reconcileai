/**
 * The tolerance pass with a zero allowance.
 *
 * A governed daily control queued `dateWindowDays: 0`. Pass 1 matches on
 * reference and was unaffected, so the defect was invisible wherever the two
 * legs shared a reference. Everywhere else the score became `NaN` — `1 - 0/0`
 * — and because every `NaN > best` comparison is false, the pass selected
 * NOTHING rather than scoring badly. Valid pairs were reported as exceptions,
 * which on a reconciliation platform corrupts the primary output: the run
 * looks like it worked and the numbers are wrong.
 *
 * The allowance is a parameter, so the fix belongs to the engine rather than to
 * the one caller that tripped it.
 *
 * Every fixture here carries NO reference and deliberately dissimilar
 * descriptions and counterparties, so pass 1 cannot match the pair and pass 3
 * cannot either — the tolerance pass is the only thing that can, and
 * `matchType` is asserted to prove it was. Without that the first version of
 * this file passed through pass 3's description similarity and would have gone
 * on passing with the NaN still in place.
 */
import { describe, expect, it } from "vitest";
import type { Transaction } from "../drizzle/schema";
import {
  proximityScore,
  runMatchingEngine,
  type ReconciliationConfig,
} from "./reconciliationEngine";

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    organizationId: 1,
    channelId: 10,
    userId: 1,
    batchId: 1,
    transactionRef: null,
    amount: "2500.00",
    currency: "NGN",
    transactionDate: new Date("2026-10-09T12:00:00Z"),
    description: "Switch settlement advice 0912",
    counterparty: "NIBSS",
    debitCredit: "credit",
    isReversal: false,
    status: "unmatched",
    rawData: null,
    ...overrides,
  } as Transaction;
}

function config(overrides: Partial<ReconciliationConfig> = {}): ReconciliationConfig {
  return {
    amountTolerance: 0.005,
    dateWindowDays: 1,
    ...overrides,
  } as ReconciliationConfig;
}

const source = txn({ id: 1, channelId: 10 });

/** The other leg of the same payment, as a different system records it. */
const register = (overrides: Partial<Transaction> = {}) =>
  txn({
    id: 2,
    channelId: 20,
    description: "Core banking general ledger posting",
    counterparty: "Internal register",
    ...overrides,
  });

describe("when the date allowance is zero and the two legs share an instant", () => {
  it("should match the pair on amount, not report it as an exception", () => {
    const result = runMatchingEngine([source], [register()], config({ dateWindowDays: 0 }));

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      sourceId: 1,
      targetId: 2,
      // The tolerance pass, which is the one that divided by the allowance.
      matchType: "date_window",
    });
  });

  it("should score it as a perfect hit rather than NaN", () => {
    // A number, and the best one available. `NaN` satisfies no comparison, so
    // a test that only asserted "not NaN" would also pass for a score of zero.
    const result = runMatchingEngine([source], [register()], config({ dateWindowDays: 0 }));

    // 70 base + 15 (exact amount) + 10 (exact date), no reference nudge.
    expect(result.matches[0]?.confidenceScore).toBe(95);
  });

  it("should still refuse a pair whose instants differ", () => {
    // The zero allowance must keep MEANING zero: the fix is to the score, not
    // to the filter. A minute apart is outside a zero-day window.
    const result = runMatchingEngine(
      [source],
      [register({ transactionDate: new Date("2026-10-09T12:01:00Z") })],
      config({ dateWindowDays: 0 })
    );

    expect(result.matches).toHaveLength(0);
  });
});

describe("when the amount allowance is zero", () => {
  it("should match an exactly equal amount rather than selecting nothing", () => {
    // The same division, the other operand. Any caller demanding exact amounts
    // reaches it, so it is fixed with the date case rather than left as the
    // next instance of this bug.
    const result = runMatchingEngine(
      [source],
      [register()],
      config({ amountTolerance: 0, dateWindowDays: 0 })
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.confidenceScore).toBe(95);
  });

  it("should still refuse amounts that differ at all", () => {
    const result = runMatchingEngine(
      [source],
      [register({ amount: "2500.01" })],
      config({ amountTolerance: 0, dateWindowDays: 0 })
    );

    expect(result.matches).toHaveLength(0);
  });
});

describe("when the proximity score is called directly", () => {
  // Directly, because the engine's own passes filter a too-large difference
  // out before scoring it. Through the engine alone, a version that called
  // every zero-allowance pair perfect was indistinguishable from the real one.
  it("should call an exact hit perfect under a zero allowance", () => {
    expect(proximityScore(0, 0)).toBe(1);
  });

  it("should refuse to call a non-zero difference perfect under a zero allowance", () => {
    expect(proximityScore(0.5, 0)).toBe(0);
  });

  it("should be the plain ratio for a positive allowance", () => {
    expect(proximityScore(0, 2)).toBe(1);
    expect(proximityScore(1, 2)).toBe(0.5);
    expect(proximityScore(2, 2)).toBe(0);
  });

  it("should never leave the 0..1 range, whatever it is handed", () => {
    // A score outside the range would silently reweight the whole confidence
    // figure; NaN would stop the pass selecting anything at all.
    //
    // The NaN rows pin the function's contract, not a reachable engine state:
    // today an unparseable `transactionDate` throws `RangeError: Invalid time
    // value` in `buildIndex` before any scoring happens — a separate,
    // pre-existing defect in which one bad row fails the whole run. This keeps
    // the helper total so that bug cannot grow a second, quieter symptom.
    for (const [difference, allowance] of [
      [5, 2],
      [-1, 2],
      [1, -2],
      [1, Number.NaN],
      [Number.NaN, 2],
    ]) {
      const score = proximityScore(difference, allowance);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("when the allowances are the ordinary positive ones", () => {
  it("should score a partly-off pair exactly as it always did", () => {
    // Guards the refactor itself: for a positive allowance the helper must
    // still be `1 - diff/allowance`, not a reinterpretation of it. Half the
    // date window away costs half of the date component's 10 points.
    const result = runMatchingEngine(
      [source],
      [register({ transactionDate: new Date("2026-10-10T00:00:00Z") })],
      config({ dateWindowDays: 1 })
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.confidenceScore).toBe(90);
  });
});
