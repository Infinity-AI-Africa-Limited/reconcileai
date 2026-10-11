/**
 * One transaction with an unreadable date must not fail the whole run.
 *
 * `new Date(x).toISOString()` throws `RangeError: Invalid time value` on an
 * unreadable date, and three sites did exactly that over every row: the
 * amount+date index, duplicate detection, and the unmatched exception's own
 * description. All three run across the full population, so a single bad
 * timestamp aborted the entire reconciliation and took every sound row with
 * it. A failed run gives an operator nothing to act on.
 *
 * Reachable, not hypothetical: the Shopline and Shopify connectors build
 * `transactionDate` with a bare `new Date(payload.field)`, so a third-party
 * response carrying a missing or oddly-formatted timestamp produces an Invalid
 * Date on a canonical row. (The shared file parser and the API ingestion path
 * both reject such a value instead — those are safe.)
 */
import { describe, expect, it } from "vitest";
import type { Transaction } from "../drizzle/schema";
import {
  categorizeException,
  runMatchingEngine,
  transactionDayKey,
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
  return { amountTolerance: 0.005, dateWindowDays: 1, ...overrides } as ReconciliationConfig;
}

/** What a connector produces from a timestamp it could not parse. */
const UNREADABLE = new Date("not a date");

/** The other leg of the same payment, as a second system records it. */
const register = (overrides: Partial<Transaction> = {}) =>
  txn({
    id: 2,
    channelId: 20,
    description: "Core banking general ledger posting",
    counterparty: "Internal register",
    ...overrides,
  });

describe("when a transaction's date cannot be read", () => {
  it("should complete the run instead of throwing", () => {
    // The regression in one line: this threw `RangeError: Invalid time value`
    // out of `buildIndex`, before any matching happened.
    expect(() =>
      runMatchingEngine([txn({ transactionDate: UNREADABLE })], [register()], config())
    ).not.toThrow();
  });

  it("should still match every sound pair in the same batch", () => {
    // The cost of the old behaviour was never the bad row — it was the good
    // ones that died with it.
    const result = runMatchingEngine(
      [
        txn({ id: 1, transactionDate: UNREADABLE }),
        txn({ id: 3, amount: "900.00" }),
      ],
      [register({ id: 2 }), register({ id: 4, amount: "900.00" })],
      config()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sourceId: 3, targetId: 4 });
  });

  it("should report the row as a format error, not as a missing counterparty", () => {
    // An unreadable date is why this row could not be matched; calling it "no
    // matching transaction found" sends an operator hunting for a counterparty
    // that may well exist. This is also the site that would still have thrown
    // had only the index been fixed — the default description formats the date.
    const row = txn({ transactionDate: UNREADABLE, counterparty: "NIBSS" });

    const exception = categorizeException(row, [], config());

    expect(exception).toMatchObject({ category: "format_error", severity: "high" });
    expect(exception.description).toContain("unreadable transaction date");
  });

  it("should be classified ahead of the reversal and counterparty rules", () => {
    // Those two would otherwise claim the row first and describe the wrong
    // problem: a reversal whose original is "missing", or a blank counterparty,
    // when the row is simply unusable.
    const reversal = txn({
      transactionDate: UNREADABLE,
      isReversal: true,
      description: "NIP reversal",
      counterparty: "",
    });

    expect(categorizeException(reversal, [], config())).toMatchObject({
      category: "format_error",
    });
  });

  it("should keep it out of date-keyed matching, so it cannot match on amount alone", () => {
    // Same amount, same currency, no reference on either side: the only route
    // left is the tolerance pass, which is date-keyed. An undated row must not
    // be paired with whatever shares its amount.
    const result = runMatchingEngine(
      [txn({ transactionDate: UNREADABLE })],
      [register()],
      config()
    );

    expect(result.matches).toHaveLength(0);
  });

  it("should still match it by reference, which never needed a date", () => {
    // Deliberately NOT excluded from everything. Pass 1 matches on an exact
    // reference, and a reference match is just as certain whether or not the
    // timestamp parsed — refusing it would turn a data-quality blemish into a
    // false exception.
    const result = runMatchingEngine(
      [txn({ transactionRef: "NIP-0912", transactionDate: UNREADABLE })],
      [register({ transactionRef: "NIP-0912" })],
      config()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ matchType: "exact", sourceId: 1, targetId: 2 });
  });

  it("should record no date gap for that match, rather than NaN", () => {
    // `matches.dateDifference` is a nullable int. NaN reached it through
    // `Math.round(NaN)`; null is representable and honest — matched by
    // reference, date gap unknown.
    const result = runMatchingEngine(
      [txn({ transactionRef: "NIP-0912", transactionDate: UNREADABLE })],
      [register({ transactionRef: "NIP-0912" })],
      config()
    );

    expect(result.matches[0]?.dateDifference).toBeNull();
  });

  it("should still flag two undated rows as duplicates of each other", () => {
    // Duplicate detection keys on the day, so it needed a sentinel rather than
    // a throw. Undated rows sharing a reference, amount, currency and channel
    // are exactly the kind worth flagging.
    const result = runMatchingEngine(
      [
        txn({ id: 1, transactionRef: "NIP-0912", transactionDate: UNREADABLE }),
        txn({ id: 3, transactionRef: "NIP-0912", transactionDate: UNREADABLE }),
      ],
      [],
      config()
    );

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.transactionIds).toEqual([1, 3]);
  });

  it("should not call an undated row a duplicate of a dated one", () => {
    // What the sentinel's VALUE has to guarantee: it must not look like a real
    // day key. These two agree on reference, amount, currency and channel, so
    // the day is the only thing separating them — and "we could not read this
    // row's date" is not evidence that it happened on any particular day.
    const result = runMatchingEngine(
      [
        txn({ id: 1, transactionRef: "NIP-0912", transactionDate: UNREADABLE }),
        txn({ id: 3, transactionRef: "NIP-0912" }),
      ],
      [],
      config()
    );

    expect(result.duplicates).toHaveLength(0);
  });

  it("should not call two undated rows duplicates when they differ otherwise", () => {
    // The sentinel must not become a bucket everything undated falls into:
    // these two share a day key of "undated" and nothing else.
    const result = runMatchingEngine(
      [
        txn({ id: 1, transactionRef: "NIP-0912", transactionDate: UNREADABLE }),
        txn({ id: 3, transactionRef: "NIP-9999", amount: "77.00", transactionDate: UNREADABLE }),
      ],
      [],
      config()
    );

    expect(result.duplicates).toHaveLength(0);
  });
});

describe("when the unreadable date is on the TARGET side", () => {
  // Mutation testing caught this gap: every case above put the bad row on the
  // source side, and the index that threw was built from the TARGETS only. So
  // restoring the original throwing line broke nothing, and the coverage was
  // an illusion. These cases drive the side that actually indexed dates.
  it("should complete the run instead of throwing", () => {
    expect(() =>
      runMatchingEngine([txn({})], [register({ transactionDate: UNREADABLE })], config())
    ).not.toThrow();
  });

  it("should still match every sound pair in the same batch", () => {
    const result = runMatchingEngine(
      [txn({ id: 1, amount: "900.00" })],
      [
        register({ id: 2, transactionDate: UNREADABLE }),
        register({ id: 4, amount: "900.00" }),
      ],
      config()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sourceId: 1, targetId: 4 });
  });

  it("should keep an undated target out of date-keyed matching", () => {
    const result = runMatchingEngine(
      [txn({})],
      [register({ transactionDate: UNREADABLE })],
      config()
    );

    expect(result.matches).toHaveLength(0);
  });

  it("should still match an undated target by reference", () => {
    const result = runMatchingEngine(
      [txn({ transactionRef: "NIP-0912" })],
      [register({ transactionRef: "NIP-0912", transactionDate: UNREADABLE })],
      config()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ matchType: "exact" });
    expect(result.matches[0]?.dateDifference).toBeNull();
  });
});

describe("when a transaction's date is readable", () => {
  it("should match and report the date gap exactly as before", () => {
    // Guards the change itself: the guarded path must not alter a sound run.
    const result = runMatchingEngine(
      [txn({ transactionRef: "NIP-0912" })],
      [register({ transactionRef: "NIP-0912", transactionDate: new Date("2026-10-10T12:00:00Z") })],
      config()
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.dateDifference).toBe(1);
  });
});

describe("when the day key is derived directly", () => {
  it("should give the UTC calendar day for a readable timestamp", () => {
    // UTC, not the reader's zone: the key groups rows across a run, so it must
    // not depend on where the server happens to be.
    expect(transactionDayKey(new Date("2026-10-09T23:30:00Z"))).toBe("2026-10-09");
    expect(transactionDayKey(new Date("2026-10-10T00:30:00Z"))).toBe("2026-10-10");
  });

  it("should answer null rather than throwing for an unreadable one", () => {
    expect(transactionDayKey(UNREADABLE)).toBeNull();
    expect(transactionDayKey(new Date(Number.NaN))).toBeNull();
  });
});
