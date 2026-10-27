/**
 * The seam between two catch-up steps, against a REAL MySQL — gated like the
 * other *.db.test.ts files because the local .env names production and this
 * test writes rows.
 *
 * The real runSyncCycle runs each step: real ingest, real persistence, the real
 * retail engine, the real watermark write. Only SHOPLINE's network is stubbed,
 * and the stub answers each step with exactly the records its window covers.
 * Steps are chosen by the walker's own catchUpStep and stepReconcileOptions.
 *
 * A step fetches only its own window. Until Greptile's review of #209, it also
 * reconciled only its own window. So an order fetched near a step's end, whose
 * payment came minutes later, met that payment in no reconciliation: each was
 * raised as unmatched, and the walk still reported itself caught up.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyDatabaseTarget } from "../../dbTarget";

type Payload = Record<string, unknown>;

const network = vi.hoisted(() => ({ orders: [] as Payload[], payments: [] as Payload[] }));

vi.mock("./tokenStore", () => ({ getValidToken: vi.fn(async () => "token") }));
vi.mock("./billingWebhook", () => ({ isSyncBlockedBySubscription: vi.fn(async () => ({ blocked: false })) }));
vi.mock("./apiClient", async (importOriginal) => {
  const within = (at: unknown, min: string, max: string) =>
    typeof at === "string" && Date.parse(at) >= Date.parse(min) && Date.parse(at) <= Date.parse(max);
  return {
    ...(await importOriginal<typeof import("./apiClient")>()),
    fetchOrders: vi.fn(async (_opts: unknown, p: { updatedAtMin: string; updatedAtMax: string }) => ({
      data: network.orders.filter((o) => within(o.updated_at, p.updatedAtMin, p.updatedAtMax)),
      nextPageInfo: null,
    })),
    fetchPaymentTransactions: vi.fn(async (_opts: unknown, p: { dateMin: string; dateMax: string }) => ({
      data: network.payments.filter((t) => within(t.create_time, p.dateMin, p.dateMax)),
      nextPageInfo: null,
    })),
    fetchPayouts: vi.fn(async () => ({ data: [], nextPageInfo: null })),
  };
});
// Any request that escapes the stubs fails the suite rather than reaching SHOPLINE.
vi.stubGlobal("fetch", vi.fn(async () => {
  throw new Error("catchUpSeam.db.test.ts must not reach the network");
}));

import { slConnectorStores } from "../../../drizzle/connector_schema";
import { channels, exceptions, transactions, uploadBatches } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { catchUpStep, stepReconcileOptions } from "./scheduledSync";
import { runSyncCycle } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date("2026-10-20T12:00:00Z");
// Dark for 30 hours: two steps, the first ending at NOW - 6h05m.
const WATERMARK = new Date(NOW.getTime() - 30 * HOUR);
const SEAM = catchUpStep(WATERMARK, NOW).to;
const at = (offsetMinutes: number) => new Date(SEAM.getTime() + offsetMinutes * MINUTE).toISOString();

function order(id: string, createdAt: string): Payload {
  return {
    id,
    name: `#${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    currency: "USD",
    financial_status: "paid",
    current_total_price_set: { shop_money: { amount: "50.00" } },
  };
}

function payment(orderId: string, createdAt: string): Payload {
  return {
    trade_order_id: `pay-${orderId}`,
    seller_order_id: orderId,
    amount: "50.00",
    paid_amount: "50.00",
    currency: "USD",
    create_time: createdAt,
    status: "SUCCEEDED",
    payment_method: "card",
  };
}

describe.runIf(localDatabase)("when a catch-up walk's step seam splits an order from its payment", () => {
  // An organisation no real tenant uses, cleaned up after.
  const organizationId = 940_000_000 + Math.floor(Math.random() * 1_000_000);
  let nextStore = 0;

  async function db() {
    const found = await getDb();
    if (!found) throw new Error("no database");
    return found;
  }

  async function storeDarkSinceWatermark(): Promise<{ id: number; handle: string }> {
    const handle = `seam-${organizationId}-${nextStore++}`;
    const [row] = await (await db()).insert(slConnectorStores).values({
      organizationId,
      storeHandle: handle,
      storeId: handle,
      status: "active",
      currency: "USD",
      lastSyncAt: WATERMARK,
      syncedThroughAt: WATERMARK,
    });
    return { id: (row as unknown as { insertId: number }).insertId, handle };
  }

  /** Walk the store from its watermark to NOW, one real sync cycle per step. */
  async function walk(storeId: number): Promise<number> {
    let watermark = WATERMARK;
    let steps = 0;
    for (;;) {
      const window = catchUpStep(watermark, NOW);
      const report = await runSyncCycle({
        organizationId,
        slStoreId: storeId,
        from: window.from,
        to: window.to,
        ...stepReconcileOptions(window, NOW),
      });
      steps++;
      expect(report.error ?? "").toBe("");
      watermark = window.to;
      if (window.to.getTime() >= NOW.getTime()) return steps;
    }
  }

  async function rowsFor(refs: string[]) {
    return (await db())
      .select({ id: transactions.id, ref: transactions.transactionRef, status: transactions.status })
      .from(transactions)
      .where(and(eq(transactions.organizationId, organizationId), inArray(transactions.transactionRef, refs)));
  }

  async function exceptionsFor(transactionIds: number[]) {
    if (transactionIds.length === 0) return [];
    return (await db())
      .select({ transactionId: exceptions.transactionId, subCategory: exceptions.subCategory })
      .from(exceptions)
      .where(and(eq(exceptions.organizationId, organizationId), inArray(exceptions.transactionId, transactionIds)));
  }

  beforeAll(async () => {
    await db();
  });

  afterAll(async () => {
    const found = await getDb();
    if (!found) return;
    await found.delete(exceptions).where(eq(exceptions.organizationId, organizationId));
    await found.delete(transactions).where(eq(transactions.organizationId, organizationId));
    await found.delete(uploadBatches).where(eq(uploadBatches.organizationId, organizationId));
    await found.delete(channels).where(eq(channels.organizationId, organizationId));
    await found.delete(slConnectorStores).where(eq(slConnectorStores.organizationId, organizationId));
  });

  it("should match them, and raise nothing for either", async () => {
    // Placed ten minutes before the seam, paid ten minutes after: further
    // apart than the five-minute overlap, so no single step fetches both.
    const store = await storeDarkSinceWatermark();
    network.orders = [order(`${store.handle}-A`, at(-10))];
    network.payments = [payment(`${store.handle}-A`, at(10))];

    expect(await walk(store.id)).toBe(2);

    const rows = await rowsFor([`${store.handle}-A`]);
    expect(rows.map((r) => r.status).sort()).toEqual(["matched", "matched"]);
    expect(await exceptionsFor(rows.map((r) => r.id))).toEqual([]);
  });

  it("should still raise an order whose payment never comes, in the step after its own", async () => {
    // Held back by the first step, and the second fetches nothing new at all.
    // It must reconcile anyway, or the order is neither matched nor raised.
    const store = await storeDarkSinceWatermark();
    network.orders = [order(`${store.handle}-B`, at(-20))];
    network.payments = [];

    await walk(store.id);

    const [row] = await rowsFor([`${store.handle}-B`]);
    expect(row.status).toBe("unmatched");
    const raised = await exceptionsFor([row.id]);
    expect(raised).toHaveLength(1);
  });
});
