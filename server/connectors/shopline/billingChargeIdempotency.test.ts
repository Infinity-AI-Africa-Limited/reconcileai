/**
 * `appsubscription/paid` is applied once per CHARGE, not once per delivery.
 *
 * Webhook dedupe keys on `X-Shopline-Webhook-Id`, so it stops a delivery being
 * processed twice and nothing more. One charge arrives under several ids when
 * two subscriptions cover the topic (a legacy Partner Portal configuration
 * beside the one the connector registers), and SHOPLINE retries a delivery it
 * thinks failed. Counted per delivery, one failed charge delivered three times
 * put a paying merchant past_due and started their grace period.
 *
 * These drive the real handler over an in-memory ledger whose writes land, so
 * a second delivery reads what the first one wrote. The locking that keeps two
 * SIMULTANEOUS deliveries apart needs a real engine:
 * billingChargeIdempotency.db.test.ts.
 *
 * Each case asserts the subscription's state before the outcome label: the
 * state is the behaviour, and the label only names it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHOPLINE_BILLING_PAID_STATUS,
  TIER_1_GRACE_PERIOD_DAYS,
} from "../../../shared/shoplineConstants";
import type { SlConnectorSubscription } from "../../../drizzle/connector_schema";
import {
  billingChargeRef,
  handleSubscriptionPaid,
  type AppSubscriptionPaidPayload,
} from "./billingWebhook";
import { billingLedgerFake, CHARGES, SUBSCRIPTIONS, type BillingLedgerFake } from "./billingLedger.testkit";

const ORG = 42;
const STORE = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const { SUCCESS, CANCELLED, FAILED } = SHOPLINE_BILLING_PAID_STATUS;
const OCT_1 = Date.UTC(2026, 9, 1);

/** A delivery's body, typed as the dispatcher hands it over: whatever SHOPLINE sent. */
function paid(status: number, bizOrderNo: unknown, subTime = OCT_1): AppSubscriptionPaidPayload {
  const body: Record<string, unknown> = { appkey: "k", handle: "acme", subId: "SUB-1", status, subTime, bizOrderNo };
  return body as AppSubscriptionPaidPayload;
}

function storeWith(subscription: Partial<SlConnectorSubscription> = {}): BillingLedgerFake {
  return billingLedgerFake({ organizationId: ORG, slStoreId: STORE, subscription });
}

const deliver = (fake: BillingLedgerFake, payload: AppSubscriptionPaidPayload) =>
  handleSubscriptionPaid(fake.db as never, ORG, STORE, payload);

async function deliverAll(fake: BillingLedgerFake, payloads: AppSubscriptionPaidPayload[]) {
  const outcomes: string[] = [];
  for (const payload of payloads) outcomes.push(await deliver(fake, payload));
  return outcomes;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("when one failed charge is delivered more than once", () => {
  it("should count it once", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(FAILED, "PAY-1")]);

    expect(fake.subscription()?.failedBillingAttempts).toBe(1);
    expect(fake.charges()).toMatchObject([{ bizOrderNo: "PAY-1", deliveries: 2 }]);
    expect(fake.charges()[0]?.failureCountedAt).toBeInstanceOf(Date);
    expect(outcomes).toEqual(["failure_counted", "duplicate"]);
  });

  it("should not put the store past_due, however many times it arrives", async () => {
    const fake = storeWith();

    await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(FAILED, "PAY-1"), paid(FAILED, "PAY-1")]);

    expect(fake.subscription()).toMatchObject({ failedBillingAttempts: 1, status: "active", graceEndsAt: null });
    expect(fake.charges()).toMatchObject([{ bizOrderNo: "PAY-1", deliveries: 3 }]);
  });

  it("should treat a surrounding space as the same charge", async () => {
    const fake = storeWith();

    await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(FAILED, " PAY-1 ")]);

    expect(fake.subscription()?.failedBillingAttempts).toBe(1);
  });
});

describe("when different charges fail", () => {
  // The per-delivery counter this replaced counted these correctly too. They
  // guard the other direction: a fix that deduplicated by store instead of by
  // charge would fail them.
  it("should count each one", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(FAILED, "PAY-2")]);

    expect(fake.subscription()?.failedBillingAttempts).toBe(2);
    expect(fake.charges().map((charge) => charge.bizOrderNo)).toEqual(["PAY-1", "PAY-2"]);
    expect(outcomes).toEqual(["failure_counted", "failure_counted"]);
  });

  it("should go past_due at the third and start the grace period once", async () => {
    const fake = storeWith();
    const third = OCT_1 + 2 * DAY_MS;

    await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(FAILED, "PAY-2", OCT_1 + DAY_MS), paid(FAILED, "PAY-3", third)]);

    expect(fake.subscription()).toMatchObject({ failedBillingAttempts: 3, status: "past_due" });
    expect(fake.subscription()?.graceEndsAt?.getTime()).toBe(third + TIER_1_GRACE_PERIOD_DAYS * DAY_MS);

    // A fourth failure, days later, must not push the deadline out.
    await deliver(fake, paid(FAILED, "PAY-4", third + 3 * DAY_MS));

    expect(fake.subscription()?.failedBillingAttempts).toBe(4);
    expect(fake.subscription()?.graceEndsAt?.getTime()).toBe(third + TIER_1_GRACE_PERIOD_DAYS * DAY_MS);
  });
});

describe("when a failure names no charge", () => {
  it("should record it on the subscription and never count it", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(FAILED, undefined), paid(FAILED, undefined)]);

    expect(fake.subscription()).toMatchObject({ failedBillingAttempts: 0, status: "active", graceEndsAt: null });
    expect(fake.subscription()?.lastFailureReason).toContain("not counted");
    expect(fake.charges()).toEqual([]);
    expect(outcomes).toEqual(["failure_unidentified", "failure_unidentified"]);
  });

  it.each([
    ["an empty string", ""],
    ["only spaces", "   "],
    ["one longer than the ledger can hold", "P".repeat(129)],
    ["an object", { id: "PAY-1" }],
    ["an integer too large to read exactly", 2 ** 60],
  ])("should not count one whose reference is %s", async (_label, bizOrderNo) => {
    const fake = storeWith();

    const outcome = await deliver(fake, paid(FAILED, bizOrderNo));

    expect(fake.subscription()?.failedBillingAttempts).toBe(0);
    expect(fake.charges()).toEqual([]);
    expect(outcome).toBe("failure_unidentified");
  });

  it("should key a reference sent as a safe integer by its digits", () => {
    expect(billingChargeRef(20240726123456)).toBe("20240726123456");
    expect(billingChargeRef(" PAY-1 ")).toBe("PAY-1");
    expect(billingChargeRef("P".repeat(128))).toBe("P".repeat(128));
  });
});

describe("when a failed charge arrives again after a success", () => {
  it("should not re-open failures", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(FAILED, "PAY-1"), paid(SUCCESS, "PAY-2"), paid(FAILED, "PAY-1")]);

    expect(fake.subscription()).toMatchObject({
      failedBillingAttempts: 0,
      status: "active",
      graceEndsAt: null,
      lastFailureReason: null,
    });
    expect(outcomes).toEqual(["failure_counted", "succeeded", "duplicate"]);
  });

  it("should not count a failure for a charge that has already succeeded", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(SUCCESS, "PAY-1"), paid(FAILED, "PAY-1")]);

    expect(fake.subscription()?.failedBillingAttempts).toBe(0);
    expect(outcomes).toEqual(["succeeded", "stale_failure"]);
  });

  it("should not count a failure for a charge that has been cancelled", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(CANCELLED, "PAY-1"), paid(FAILED, "PAY-1")]);

    expect(fake.subscription()).toMatchObject({ failedBillingAttempts: 0, status: "cancelled" });
    expect(outcomes).toEqual(["cancelled", "stale_failure"]);
  });
});

describe("when a success or a cancellation arrives again", () => {
  it("should leave a newer failure counted", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(SUCCESS, "PAY-1"), paid(FAILED, "PAY-2"), paid(SUCCESS, "PAY-1")]);

    expect(fake.subscription()?.failedBillingAttempts).toBe(1);
    expect(outcomes).toEqual(["succeeded", "failure_counted", "duplicate"]);
  });

  it("should not cancel a subscription the merchant has paid since", async () => {
    const fake = storeWith();

    const outcomes = await deliverAll(fake, [paid(CANCELLED, "PAY-1"), paid(SUCCESS, "PAY-2"), paid(CANCELLED, "PAY-1")]);

    expect(fake.subscription()?.status).toBe("active");
    expect(outcomes).toEqual(["cancelled", "succeeded", "duplicate"]);
  });
});

describe("when status decides the outcome", () => {
  it("should activate on 200 and clear the failure count and grace period", async () => {
    const fake = storeWith({ status: "past_due", failedBillingAttempts: 2, graceEndsAt: new Date(OCT_1) });

    const outcome = await deliver(fake, paid(SUCCESS, "PAY-9"));

    expect(fake.subscription()).toMatchObject({
      status: "active",
      graceEndsAt: null,
      failedBillingAttempts: 0,
      lastFailureReason: null,
    });
    expect(fake.subscription()?.activatedAt?.getTime()).toBe(OCT_1);
    expect(outcome).toBe("succeeded");
  });

  it("should cancel on 300", async () => {
    const fake = storeWith();

    const outcome = await deliver(fake, paid(CANCELLED, "PAY-9"));

    expect(fake.subscription()?.status).toBe("cancelled");
    expect(fake.subscription()?.cancelledAt?.getTime()).toBe(OCT_1);
    expect(outcome).toBe("cancelled");
  });

  it("should still apply a success that names no charge", async () => {
    const fake = storeWith({ status: "past_due", failedBillingAttempts: 3 });

    const outcome = await deliver(fake, paid(SUCCESS, undefined));

    expect(fake.subscription()).toMatchObject({ status: "active", failedBillingAttempts: 0 });
    expect(fake.charges()).toEqual([]);
    expect(outcome).toBe("succeeded");
  });

  it("should keep the existing status for an early failure and start no grace period", async () => {
    const fake = storeWith({ status: "trialing" });

    await deliver(fake, paid(FAILED, "PAY-1"));

    expect(fake.subscription()).toMatchObject({ status: "trialing", failedBillingAttempts: 1, graceEndsAt: null });
    expect(fake.subscription()?.lastFailureReason).toBe("Payment failed (status 400, order PAY-1)");
  });
});

describe("when the store has no subscription row", () => {
  it("should change nothing and record no charge", async () => {
    const fake = billingLedgerFake({ organizationId: ORG, slStoreId: STORE, subscription: null });

    const outcome = await deliver(fake, paid(FAILED, "PAY-1"));

    expect(fake.charges()).toEqual([]);
    expect(fake.statements).toEqual([{ kind: "select", table: SUBSCRIPTIONS, locked: true, txId: 1 }]);
    expect(outcome).toBe("no_subscription");
  });
});

describe("when a delivery is applied", () => {
  it("should lock the subscription row first and do everything in one transaction", async () => {
    const fake = storeWith();

    await deliver(fake, paid(FAILED, "PAY-1"));

    expect(fake.statements).toEqual([
      { kind: "select", table: SUBSCRIPTIONS, locked: true, txId: 1 },
      { kind: "insert", table: CHARGES, locked: false, txId: 1 },
      { kind: "select", table: CHARGES, locked: true, txId: 1 },
      { kind: "update", table: CHARGES, locked: false, txId: 1 },
      { kind: "update", table: SUBSCRIPTIONS, locked: false, txId: 1 },
    ]);
  });

  it("should write nothing to the subscription for a duplicate", async () => {
    const fake = storeWith();
    await deliver(fake, paid(FAILED, "PAY-1"));
    const before = fake.statements.length;

    await deliver(fake, paid(FAILED, "PAY-1"));

    const second = fake.statements.slice(before);
    expect(second.filter((statement) => statement.kind === "update").map((statement) => statement.table)).toEqual([CHARGES]);
  });
});
