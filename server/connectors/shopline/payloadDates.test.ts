/**
 * What the SHOPLINE connector does with a timestamp the API sent unreadably.
 *
 * `apiClient.ts` declares these payloads with required fields — `created_at:
 * string`, `create_time: string`, `posting_time: string` — but they are
 * hand-written interfaces over third-party JSON with no runtime validation
 * behind them. The type asserts a guarantee SHOPLINE never made, which is why
 * no call site looked risky while `new Date(order.created_at)` could produce
 * an **Invalid Date** on a canonical transaction row from a missing, null,
 * empty or oddly-formatted value.
 *
 * The policy these tests pin:
 *
 * - a row whose OWN transaction date is unreadable is not ingested, and is
 *   counted rather than dropped silently;
 * - an unreadable OPTIONAL timestamp (`valueDate`) becomes null;
 * - the clock is never used as a fallback;
 * - one bad row never costs the other rows in the same page.
 *
 * (The Shopify connector needs none of this: its API client validates every
 * timestamp with `iso()` at the boundary, so `NormalizedShopifyOrder` cannot
 * carry an unreadable one.)
 */
import { describe, expect, it } from "vitest";
import {
  normaliseBalanceTransaction,
  normaliseIngestBatch,
  normaliseOrder,
  normalisePaymentTransaction,
  normalisePayout,
  normaliseRefund,
  type IngestContext,
} from "./ingest";
import { normaliseToTransactions } from "./settlementSync";

const ctx: IngestContext = {
  organizationId: 7,
  ordersChannelId: 11,
  paymentsChannelId: 12,
  batchId: 5,
  userId: 3,
  defaultCurrency: "USD",
} as IngestContext;

/** Every shape SHOPLINE could send in place of a timestamp. */
const UNREADABLE = ["", "   ", "not a date", "0000-00-00 00:00:00", null, undefined];

const order = (created_at: unknown, processed_at?: unknown, id = "ORD1") =>
  ({
    id,
    name: "#1001",
    financial_status: "paid",
    currency: "USD",
    current_total_price_set: { shop_money: { amount: "100.00" } },
    payment_gateway_names: ["stripe"],
    created_at,
    processed_at,
  }) as never;

const payment = (create_time: unknown, settle_time?: unknown, seller_order_id = "ORD1") =>
  ({
    trade_order_id: "TRD1",
    seller_order_id,
    channel_deal_id: "CD1",
    amount: "100.00",
    currency: "USD",
    status: "SUCCEEDED",
    payment_method: "card",
    create_time,
    additional_data: settle_time === undefined ? undefined : { settle_time },
  }) as never;

describe("when an order's own date is unreadable", () => {
  it("should refuse the row rather than dating it from the clock", () => {
    // A guessed date is the dangerous outcome, not the missing one: it files
    // real money in the wrong control period, and the day still reads complete.
    for (const value of UNREADABLE) {
      expect(normaliseOrder(order(value), ctx)).toBeNull();
    }
  });

  it("should keep a sound order, with its date read as sent", () => {
    const row = normaliseOrder(order("2026-10-09T12:00:00Z"), ctx);

    expect(row?.transactionDate).toEqual(new Date("2026-10-09T12:00:00Z"));
  });
});

describe("when only an order's OPTIONAL date is unreadable", () => {
  it("should keep the row and leave valueDate null", () => {
    // `valueDate` is nullable, so null is representable and honest. Skipping
    // the row would lose a payment over a field reconciliation does not need.
    for (const value of UNREADABLE) {
      const row = normaliseOrder(order("2026-10-09T12:00:00Z", value), ctx);

      expect(row).not.toBeNull();
      expect(row?.valueDate).toBeNull();
    }
  });

  it("should still carry a readable valueDate through", () => {
    const row = normaliseOrder(
      order("2026-10-09T12:00:00Z", "2026-10-10T08:00:00Z"),
      ctx
    );

    expect(row?.valueDate).toEqual(new Date("2026-10-10T08:00:00Z"));
  });
});

describe("when any other leg's own date is unreadable", () => {
  it("should refuse a payment, payout, refund and balance transaction alike", () => {
    // One rule across all five normalisers: a new leg should not be able to
    // reintroduce this by being written to a different standard.
    expect(normalisePaymentTransaction(payment("not a date"), ctx)).toBeNull();
    expect(
      normalisePayout({ payout_transaction_no: "P1", amount: "5", currency: "USD", status: "SUCCESS", time: "" } as never, ctx)
    ).toBeNull();
    expect(
      normaliseRefund({ id: "R1", order_id: "ORD1", created_at: null, refund_line_items: [] } as never, ctx)
    ).toBeNull();
    expect(
      normaliseBalanceTransaction({ id: "BT1", amount: "5", type: "payout", account_type: "main", posting_time: undefined } as never, ctx)
    ).toBeNull();
  });

  it("should leave a payment's unreadable settle_time as a null valueDate", () => {
    const row = normalisePaymentTransaction(
      payment("2026-10-09T12:00:00Z", "nonsense"),
      ctx
    );

    expect(row).not.toBeNull();
    expect(row?.valueDate).toBeNull();
  });
});

describe("when a batch mixes sound rows with undated ones", () => {
  it("should ingest the sound rows and count the rest", () => {
    // The cost of the old behaviour would have been an Invalid Date reaching
    // the canonical table; the cost of a silent fix would be a payment
    // vanishing. Neither: the rows arrive and the gap is reported.
    const result = normaliseIngestBatch(
      {
        orders: [order("2026-10-09T12:00:00Z"), order("not a date"), order("")],
        paymentTransactions: [payment("2026-10-09T12:05:00Z"), payment(null)],
      },
      ctx
    );

    expect(result.rows).toHaveLength(2);
    expect(result.undatedRowsSkipped).toBe(3);
  });

  it("should report no skips for a clean batch", () => {
    const result = normaliseIngestBatch(
      { orders: [order("2026-10-09T12:00:00Z")] },
      ctx
    );

    expect(result.rows).toHaveLength(1);
    expect(result.undatedRowsSkipped).toBe(0);
  });
});

describe("when the settlement sync builds engine rows", () => {
  it("should drop an order it cannot date and keep the others", () => {
    // This leg dates off `processed_at`, which an order may simply not carry —
    // the likeliest of all these paths to fire in production.
    const result = normaliseToTransactions(
      [
        order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z", "ORD-OK"),
        order("2026-10-09T10:00:00Z", undefined, "ORD-UNDATED"),
      ],
      [],
      [],
      "USD"
    );

    expect(result.sourceTxns).toHaveLength(1);
    expect(result.sourceTxns[0]?.transactionDate).toEqual(
      new Date("2026-10-09T12:00:00Z")
    );
  });

  it("should drop a capture it cannot date and keep the others", () => {
    const result = normaliseToTransactions(
      [],
      [
        payment("2026-10-09T12:00:00Z", undefined, "ORD-OK"),
        payment("not a date", undefined, "ORD-UNDATED"),
      ],
      [],
      "USD"
    );

    expect(result.targetTxns).toHaveLength(1);
  });

  it("should report how many eligible rows it dropped", () => {
    // Filtering without counting is what let the caller report `orders.length`
    // as ingested over a row that never reached the engine — a complete-looking
    // sync with a real gap in it.
    const result = normaliseToTransactions(
      [
        order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z", "ORD-A"),
        order("2026-10-09T10:00:00Z", undefined, "ORD-B"),
      ],
      [
        payment("2026-10-09T12:00:00Z", undefined, "ORD-A"),
        payment("", undefined, "ORD-C"),
      ],
      [],
      "USD"
    );

    expect(result.undatedRowsSkipped).toBe(2);
  });

  it("should not count an unpaid order as a dropped one", () => {
    // Counted against the ELIGIBLE rows: an order that was never paid is
    // filtered for a different reason, and folding the two together would
    // report a skip for every unpaid order in the window.
    const unpaid = order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z") as {
      financial_status: string;
    };
    unpaid.financial_status = "pending";

    const result = normaliseToTransactions([unpaid as never], [], [], "USD");

    expect(result.sourceTxns).toHaveLength(0);
    expect(result.undatedRowsSkipped).toBe(0);
  });

  it("should withhold an order whose capture could not be dated", () => {
    // The false-alert case. Dropping the capture and keeping its order has the
    // engine report "no matching transaction found" about a payment that
    // exists and merely could not be dated — a data-quality problem rewritten
    // as a missing payment, which is the reading that corrupts a
    // reconciliation. Neither half is offered to the engine.
    const result = normaliseToTransactions(
      [order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z")],
      [payment("")],
      [],
      "USD"
    );

    expect(result.sourceTxns).toHaveLength(0);
    expect(result.targetTxns).toHaveLength(0);
    expect(result.undatedRowsSkipped).toBe(1);
  });

  it("should withhold a capture whose order could not be dated", () => {
    // The mirror: the surviving capture would be excepted as having no order.
    const result = normaliseToTransactions(
      [order("2026-10-09T10:00:00Z", undefined)],
      [payment("2026-10-09T12:00:00Z")],
      [],
      "USD"
    );

    expect(result.sourceTxns).toHaveLength(0);
    expect(result.targetTxns).toHaveLength(0);
  });

  it("should still reconcile the pairs that are intact", () => {
    // The point of withholding per pair rather than skipping the run: one
    // broken pair must not cost the others their reconciliation.
    const result = normaliseToTransactions(
      [
        order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z", "ORD-GOOD"),
        order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z", "ORD-BROKEN"),
      ],
      [
        payment("2026-10-09T12:00:00Z", undefined, "ORD-GOOD"),
        payment("", undefined, "ORD-BROKEN"),
      ],
      [],
      "USD"
    );

    expect(result.sourceTxns.map(r => r.transactionRef)).toEqual(["ORD-GOOD"]);
    expect(result.targetTxns.map(r => r.transactionRef)).toEqual(["ORD-GOOD"]);
  });

  it("should never hand the engine an Invalid Date", () => {
    // The assertion that matters whatever the filtering looks like: every row
    // that reaches the engine can be dated. An Invalid Date there used to fail
    // the entire run.
    const result = normaliseToTransactions(
      [order("2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z"), order("", "")],
      [payment("2026-10-09T12:00:00Z"), payment("")],
      [],
      "USD"
    );

    for (const row of [...result.sourceTxns, ...result.targetTxns]) {
      expect(Number.isNaN(new Date(row.transactionDate).getTime())).toBe(false);
      expect(Number.isNaN(new Date(row.createdAt).getTime())).toBe(false);
    }
  });
});
