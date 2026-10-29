/**
 * `appsubscription/paid` deliveries racing on a REAL MySQL — CI's database, or
 * a local one; gated like the other *.db.test.ts files because the local .env
 * names production and this test writes rows.
 *
 * billingChargeIdempotency.test.ts proves the decisions over an in-memory
 * ledger. Only an engine proves the locking: two deliveries of one charge at
 * the same moment must count it once, and two different charges at the same
 * moment must both count.
 *
 * "At the same moment" is arranged, not hoped for. A third transaction holds
 * the subscription row's lock while both deliveries start, then lets go, so
 * both are in flight together on every run. The per-delivery counter this
 * replaced read the counter without a lock: held like this, both its
 * deliveries read 0 and both wrote 1, so two different failed charges counted
 * once.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slConnectorBillingCharges, slConnectorSubscriptions } from "../../../drizzle/connector_schema";
import { SHOPLINE_BILLING_PAID_STATUS } from "../../../shared/shoplineConstants";
import { getDb } from "../../db";
import { classifyDatabaseTarget } from "../../dbTarget";
import { handleSubscriptionPaid, type AppSubscriptionPaidPayload, type PaidDeliveryOutcome } from "./billingWebhook";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const { SUCCESS, FAILED } = SHOPLINE_BILLING_PAID_STATUS;
/** How long the lock is held after both deliveries start: far longer than either needs to reach it. */
const HOLD_MS = 750;

describe.runIf(localDatabase)("when appsubscription/paid deliveries race on a real database", () => {
  // Ids no real tenant uses, removed afterwards.
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const slStoreId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  let db: Db;

  const paid = (status: number, bizOrderNo: string): AppSubscriptionPaidPayload => ({
    appkey: "k",
    handle: "race",
    subId: "SUB-RACE",
    status,
    bizOrderNo,
    subTime: Date.UTC(2026, 9, 1),
  });

  const subscription = async () =>
    (
      await db
        .select()
        .from(slConnectorSubscriptions)
        .where(and(eq(slConnectorSubscriptions.slStoreId, slStoreId), eq(slConnectorSubscriptions.organizationId, organizationId)))
    )[0];

  const charges = () =>
    db
      .select()
      .from(slConnectorBillingCharges)
      .where(and(eq(slConnectorBillingCharges.slStoreId, slStoreId), eq(slConnectorBillingCharges.organizationId, organizationId)))
      .orderBy(slConnectorBillingCharges.bizOrderNo);

  /**
   * Start every delivery while another transaction holds the subscription row,
   * let go once they are all in flight, and wait for them to finish.
   */
  async function deliverTogether(payloads: AppSubscriptionPaidPayload[]): Promise<PaidDeliveryOutcome[]> {
    let all: Promise<PaidDeliveryOutcome[]> = Promise.resolve([]);
    await db.transaction(async (holder) => {
      await holder
        .select({ id: slConnectorSubscriptions.id })
        .from(slConnectorSubscriptions)
        .where(and(eq(slConnectorSubscriptions.slStoreId, slStoreId), eq(slConnectorSubscriptions.organizationId, organizationId)))
        .for("update");
      all = Promise.all(payloads.map((payload) => handleSubscriptionPaid(db, organizationId, slStoreId, payload)));
      // Observed when awaited below; this only stops a failure while the lock is
      // still held from being reported as unhandled.
      all.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    });
    return all;
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
  });

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.delete(slConnectorBillingCharges).where(eq(slConnectorBillingCharges.organizationId, organizationId));
    await db.delete(slConnectorSubscriptions).where(eq(slConnectorSubscriptions.organizationId, organizationId));
    await db.insert(slConnectorSubscriptions).values({
      organizationId,
      slStoreId,
      shoplineSubscriptionId: "SUB-RACE",
      planId: "starter",
      status: "active",
      failedBillingAttempts: 0,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(slConnectorBillingCharges).where(eq(slConnectorBillingCharges.organizationId, organizationId));
    await db.delete(slConnectorSubscriptions).where(eq(slConnectorSubscriptions.organizationId, organizationId));
  });

  it("should count one failed charge once when it is delivered twice in turn", async () => {
    await handleSubscriptionPaid(db, organizationId, slStoreId, paid(FAILED, "PAY-RACE-1"));

    const outcome = await handleSubscriptionPaid(db, organizationId, slStoreId, paid(FAILED, "PAY-RACE-1"));

    expect((await subscription())?.failedBillingAttempts).toBe(1);
    expect(await charges()).toMatchObject([{ bizOrderNo: "PAY-RACE-1", deliveries: 2 }]);
    expect(outcome).toBe("duplicate");
  });

  // Held together, the per-delivery counter got this one right by accident:
  // both deliveries read 0 and wrote 1, so its lost update hid its double
  // count. The ledger row is what tells the two apart.
  it("should count one failed charge once when two deliveries of it arrive together", async () => {
    const outcomes = await deliverTogether([paid(FAILED, "PAY-RACE-1"), paid(FAILED, "PAY-RACE-1")]);

    expect((await subscription())?.failedBillingAttempts).toBe(1);
    expect(await charges()).toMatchObject([{ bizOrderNo: "PAY-RACE-1", deliveries: 2 }]);
    expect([...outcomes].sort()).toEqual(["duplicate", "failure_counted"]);
  });

  it("should count both when two different failed charges arrive together", async () => {
    const outcomes = await deliverTogether([paid(FAILED, "PAY-RACE-1"), paid(FAILED, "PAY-RACE-2")]);

    expect((await subscription())?.failedBillingAttempts).toBe(2);
    expect((await charges()).map((charge) => charge.bizOrderNo)).toEqual(["PAY-RACE-1", "PAY-RACE-2"]);
    expect(outcomes).toEqual(["failure_counted", "failure_counted"]);
  });

  it("should count two charges, not four deliveries, when one charge's three deliveries race a second charge", async () => {
    await deliverTogether([
      paid(FAILED, "PAY-RACE-1"),
      paid(FAILED, "PAY-RACE-1"),
      paid(FAILED, "PAY-RACE-1"),
      paid(FAILED, "PAY-RACE-2"),
    ]);

    // Two charges failed, so two count: not four, and not yet past_due.
    expect(await subscription()).toMatchObject({ failedBillingAttempts: 2, status: "active", graceEndsAt: null });
    expect(await charges()).toMatchObject([
      { bizOrderNo: "PAY-RACE-1", deliveries: 3 },
      { bizOrderNo: "PAY-RACE-2", deliveries: 1 },
    ]);
  });

  it("should not re-open failures when a failed charge is delivered again after a success", async () => {
    await handleSubscriptionPaid(db, organizationId, slStoreId, paid(FAILED, "PAY-RACE-1"));
    await handleSubscriptionPaid(db, organizationId, slStoreId, paid(SUCCESS, "PAY-RACE-2"));

    const outcome = await handleSubscriptionPaid(db, organizationId, slStoreId, paid(FAILED, "PAY-RACE-1"));

    expect(await subscription()).toMatchObject({ failedBillingAttempts: 0, status: "active", graceEndsAt: null, lastFailureReason: null });
    expect(outcome).toBe("duplicate");
  });
});
