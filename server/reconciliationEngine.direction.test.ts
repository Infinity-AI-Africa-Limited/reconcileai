import { describe, expect, it } from "vitest";
import type { Transaction } from "../drizzle/schema";
import { runMatchingEngine, type ReconciliationConfig } from "./reconciliationEngine";
import { runRetailReconciliation, type RetailReconciliationConfig } from "./retailReconciliationEngine";

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    organizationId: 1,
    channelId: 10,
    userId: 1,
    batchId: 1,
    transactionRef: "1001",
    amount: "100.00",
    currency: "USD",
    transactionDate: new Date("2026-09-01T10:00:00Z"),
    description: "Order 1001",
    counterparty: "Stripe",
    debitCredit: "credit",
    isReversal: false,
    status: "unmatched",
    rawData: { gatewayEventType: "payment" },
    ...overrides,
  } as Transaction;
}

const order = txn({ id: 1, channelId: 10 });
const refundOf = (overrides: Partial<Transaction>) =>
  txn({
    id: 2,
    channelId: 20,
    debitCredit: "debit",
    isReversal: true,
    description: "Settlement import (Stripe) — refund",
    rawData: { gatewayEventType: "refund" },
    ...overrides,
  });

/** One pair per matching pass: each is reachable by that pass alone. */
const PAIRS_BY_PASS = {
  "pass 1 (same reference)": refundOf({}),
  "pass 2 (amount and date, another reference)": refundOf({ transactionRef: "2002" }),
  // Another reference, ten days apart (outside pass 2's window), same words.
  "pass 3 (fuzzy description)": refundOf({
    transactionRef: "3003",
    transactionDate: new Date("2026-09-11T10:00:00Z"),
    description: "Order 1001",
  }),
} as const;

const coreConfig: ReconciliationConfig = { amountTolerance: 0.005, dateWindowDays: 3 };
const retailConfig: RetailReconciliationConfig = { ...coreConfig, settlementCurrency: "USD", chargebackDetection: true };

describe("when the core engine is left at its default", () => {
  it.each(Object.entries(PAIRS_BY_PASS))("should still match opposite directions by %s, as before", (_pass, refund) => {
    expect(runMatchingEngine([order], [refund], coreConfig).matches).toHaveLength(1);
  });
});

describe("when the core engine is asked to require the same direction", () => {
  it.each(Object.entries(PAIRS_BY_PASS))("should refuse a credit/debit pair by %s", (_pass, refund) => {
    const result = runMatchingEngine([order], [refund], { ...coreConfig, requireSameDirection: true });
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedSource).toEqual([order.id]);
  });

  it.each(Object.entries(PAIRS_BY_PASS))("should still match a same-direction pair by %s", (_pass, refund) => {
    const sameWay = { ...refund, debitCredit: "credit" as const };
    expect(runMatchingEngine([order], [sameWay], { ...coreConfig, requireSameDirection: true }).matches).toHaveLength(1);
  });
});

describe("when a retail order is reconciled against a refund", () => {
  it.each(Object.entries(PAIRS_BY_PASS))("should never let the refund settle the order, by %s", (_pass, refund) => {
    const result = runRetailReconciliation([order], [refund], retailConfig);
    expect(result.matches).toHaveLength(0);
  });

  it("should not let a caller's config switch the rule off", () => {
    const result = runRetailReconciliation([order], [PAIRS_BY_PASS["pass 1 (same reference)"]], {
      ...retailConfig,
      requireSameDirection: false,
    });
    expect(result.matches).toHaveLength(0);
  });

  it("should match the order to its payment when a refund of the same amount sits beside it", () => {
    // The refund comes first, so the engine would have taken it before the payment.
    const refund = refundOf({ id: 2 });
    const payment = txn({ id: 3, channelId: 20, description: "Settlement import (Stripe)" });
    const result = runRetailReconciliation([order], [refund, payment], retailConfig);
    expect(result.matches.map((m) => [m.sourceId, m.targetId])).toEqual([[order.id, payment.id]]);
  });

  it("should still pair a refund with a refund", () => {
    const orderSideRefund = txn({ id: 4, channelId: 10, debitCredit: "debit", isReversal: true, transactionRef: "REFUND_9" });
    const result = runRetailReconciliation([orderSideRefund], [refundOf({ id: 5 })], retailConfig);
    expect(result.matches.map((m) => [m.sourceId, m.targetId])).toEqual([[4, 5]]);
  });
});
