import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import { toShopifyOrderTransaction } from "./ingest";
import { partitionShopifyOrders, runShopifyOrderSync } from "./syncOrchestrator";
import { scriptedDb } from "./scriptedDb.testkit";
import type { NormalizedShopifyOrder } from "./orders";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
const USERS = "users";
const CHANNELS = "channels";
const TRANSACTIONS = "transactions";
const BATCHES = "upload_batches";

const order = (over: Partial<NormalizedShopifyOrder> = {}): NormalizedShopifyOrder => ({
  gid: "gid://shopify/Order/1001",
  name: "#1001",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:05:00.000Z",
  processedAt: "2026-09-20T10:01:00.000Z",
  currencyCode: "USD",
  currentTotalPrice: { amount: "19.95", currencyCode: "USD" },
  displayFinancialStatus: "PAID",
  cancelledAt: null,
  ...over,
});

const store = {
  id: 7,
  organizationId: 42,
  shopDomain: "merchant.myshopify.com",
  displayName: "Merchant",
  currency: "USD",
  claimedByUserId: 9,
};

beforeEach(() => vi.clearAllMocks());

describe("canonical Shopify order projection", () => {
  it("persists only minimal scalar evidence and no raw payload", () => {
    const row = toShopifyOrderTransaction(order(), {
      organizationId: 42,
      storeId: 7,
      channelId: 70,
      batchId: 80,
      userId: 9,
    });
    expect(row).toMatchObject({
      organizationId: 42,
      shopifyStoreId: 7,
      transactionRef: "gid://shopify/Order/1001",
      externalRef: "#1001",
      amount: "19.95",
      currency: "USD",
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "PAID",
      rawData: null,
    });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["customer", "email", "phone", "address", "note", "lineItems"]));
  });
});

describe("Shopify order idempotency", () => {
  it("inserts a new GID, updates only newer evidence, and ignores equal/older replays", () => {
    const result = partitionShopifyOrders(
      [
        order({ gid: "new" }),
        order({ gid: "newer", updatedAt: "2026-09-20T10:06:00.000Z" }),
        order({ gid: "same" }),
        order({ gid: "older", updatedAt: "2026-09-20T10:04:00.000Z" }),
      ],
      [
        { id: 2, transactionRef: "newer", shopifyUpdatedAt: new Date("2026-09-20T10:05:00Z") },
        { id: 3, transactionRef: "same", shopifyUpdatedAt: new Date("2026-09-20T10:05:00Z") },
        { id: 4, transactionRef: "older", shopifyUpdatedAt: new Date("2026-09-20T10:05:00Z") },
      ],
    );
    expect(result.inserts.map((item) => item.gid)).toEqual(["new"]);
    expect(result.updates.map((item) => [item.transactionId, item.order.gid])).toEqual([[2, "newer"]]);
    expect(result.unchanged).toBe(2);
  });
});

describe("tenant-isolated sync orchestration", () => {
  it("refuses a tenant/store mismatch before fetching protected order data", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const fetchOrders = vi.fn(async () => [order()]);
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 999, trigger: "manual" },
        { db: fake.db as never, fetchOrders },
      ),
    ).rejects.toThrow(/not found for tenant/);
    expect(fetchOrders).not.toHaveBeenCalled();
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual(expect.arrayContaining([7, 999, "active"]));
  });

  it("uses the onboarded active actor, scopes every lookup, and persists a replay only once", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[{ watermarkUpdatedAt: new Date("2026-09-20T10:00:00Z") }]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[{ id: 501, transactionRef: order().gid, shopifyUpdatedAt: new Date(order().updatedAt) }]],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "backstop" },
      { db: fake.db as never, fetchOrders, now: () => new Date("2026-09-20T11:00:00Z") },
    );

    expect(report).toMatchObject({ success: true, fetched: 1, inserted: 0, updated: 0, unchanged: 1, batchId: null });
    expect(fetchOrders).toHaveBeenCalledWith({
      storeId: 7,
      organizationId: 42,
      shopDomain: store.shopDomain,
      from: new Date("2026-09-20T09:55:00Z"),
      to: new Date("2026-09-20T11:00:00Z"),
    });
    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
    expect(fake.writes("insert", BATCHES)).toEqual([]);
    const actorLookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookup?.where?.params).toEqual(expect.arrayContaining([9, 42, true]));
    const txnLookup = fake.ops.find((op) => op.kind === "select" && op.table === TRANSACTIONS);
    expect(txnLookup?.where?.params).toEqual(expect.arrayContaining([42, 7, order().gid]));
  });

  it("does not invent user id 0 when the claimed actor is absent", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[{ ...store, claimedByUserId: null }]],
        [CURSORS]: [[]],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 42, trigger: "manual" },
        { db: fake.db as never, fetchOrders },
      ),
    ).rejects.toThrow(/no authorised sync actor/);
    expect(fetchOrders).not.toHaveBeenCalled();
    expect(fake.writes("insert", BATCHES)).toEqual([]);
  });
});
