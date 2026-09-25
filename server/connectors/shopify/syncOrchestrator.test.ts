import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import { toShopifyOrderTransaction } from "./ingest";
import {
  markShopifyWebhookSyncFailed,
  materialShopifyOrderEvidenceChanged,
  partitionShopifyOrders,
  runShopifyOrderSync,
} from "./syncOrchestrator";
import { scriptedDb } from "./scriptedDb.testkit";
import type { NormalizedShopifyOrder } from "./orders";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
const USERS = "users";
const CHANNELS = "channels";
const TRANSACTIONS = "transactions";
const BATCHES = "upload_batches";
const MATCHES = "matches";
const EVENTS = "shopify_webhook_events";

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

  it("distinguishes material reconciliation evidence from descriptive-only changes", () => {
    const existing = {
      id: 501,
      transactionRef: order().gid,
      shopifyUpdatedAt: new Date(order().updatedAt),
      amount: "19.95",
      currency: "USD",
      transactionDate: new Date(order().createdAt),
      valueDate: new Date(order().processedAt!),
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "PAID",
      shopifyCancelledAt: null,
    };
    expect(materialShopifyOrderEvidenceChanged(existing, order({ name: "#1001-edited" }))).toBe(false);
    expect(materialShopifyOrderEvidenceChanged(existing, order({ currentTotalPrice: { amount: "20.95", currencyCode: "USD" } }))).toBe(true);
    expect(materialShopifyOrderEvidenceChanged(existing, order({ displayFinancialStatus: "REFUNDED" }))).toBe(true);
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
    expect(actorLookup?.where?.params).toEqual(expect.arrayContaining([9, 42, "admin", true]));
    const txnLookup = fake.ops.find((op) => op.kind === "select" && op.table === TRANSACTIONS);
    expect(txnLookup?.where?.params).toEqual(expect.arrayContaining([42, 7, order().gid]));
  });

  it("falls back to an active administrator of the same tenant when the claimant is absent", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[{ ...store, claimedByUserId: null }]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 12 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[]],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, fetchOrders },
    );
    expect(report.inserted).toBe(1);
    expect(fake.writes("insert", BATCHES)[0]?.data).toMatchObject({ userId: 12, organizationId: 42 });
    const actorLookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookup?.where?.params).toEqual(expect.arrayContaining([42, "admin", true]));
  });

  it("tries a same-tenant active admin fallback only after an inactive claimant and rejects non-admin absence", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[]],
        [USERS]: [[], []],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 42, trigger: "manual" },
        { db: fake.db as never, fetchOrders },
      ),
    ).rejects.toThrow(/active tenant administrator unavailable/);
    expect(fetchOrders).not.toHaveBeenCalled();
    const actorLookups = fake.ops.filter((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookups).toHaveLength(2);
    expect(actorLookups[0]?.where?.params).toEqual(expect.arrayContaining([9, 42, "admin", true]));
    expect(actorLookups[1]?.where?.params).toEqual(expect.arrayContaining([42, "admin", true]));
  });

  it("guards the evidence write by provider updatedAt at persistence time", async () => {
    const current = {
      id: 501,
      transactionRef: order().gid,
      shopifyUpdatedAt: new Date("2026-09-20T10:04:00Z"),
      amount: "18.95",
      currency: "USD",
      transactionDate: new Date(order().createdAt),
      valueDate: new Date(order().processedAt!),
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "AUTHORIZED",
      shopifyCancelledAt: null,
      status: "unmatched",
      matchId: null,
    };
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[current]],
      },
      // Simulate a later overlapping sync winning after the earlier pre-read.
      update: { [TRANSACTIONS]: [0] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report).toMatchObject({ updated: 0, unchanged: 1 });
    const evidenceWrite = fake.writes("update", TRANSACTIONS)[0];
    expect(evidenceWrite?.where?.params).toEqual(
      expect.arrayContaining([501, 42, 7, order().gid, "2026-09-20 10:05:00.000"]),
    );
    expect(evidenceWrite?.where?.sql).toMatch(/shopifyUpdatedAt.*is null|shopifyUpdatedAt.*</i);
    expect(fake.writes("update", MATCHES)).toEqual([]);
  });

  it("reopens a material correction and its direct counterpart while retaining generic match audit evidence", async () => {
    const current = {
      id: 501,
      transactionRef: order().gid,
      shopifyUpdatedAt: new Date("2026-09-20T10:04:00Z"),
      amount: "18.95",
      currency: "USD",
      transactionDate: new Date(order().createdAt),
      valueDate: new Date(order().processedAt!),
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "AUTHORIZED",
      shopifyCancelledAt: null,
      status: "matched",
      matchId: null,
    };
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[current]],
        [MATCHES]: [[{ id: 88, sourceTransactionId: 501, targetTransactionId: 777 }]],
      },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report.updated).toBe(1);
    expect(fake.writes("delete", MATCHES)).toEqual([]);
    expect(fake.writes("update", MATCHES)[0]).toMatchObject({ data: { status: "rejected" } });
    expect(fake.writes("update", MATCHES)[0]?.where?.params).toEqual(expect.arrayContaining([42, 88]));
    const reopenWrites = fake.writes("update", TRANSACTIONS).filter((op) => op.data?.status === "unmatched");
    expect(reopenWrites).toHaveLength(2);
    expect(reopenWrites.every((op) => op.data?.matchId === null)).toBe(true);
    expect(reopenWrites.some((op) => op.where?.params.includes(777))).toBe(true);
    expect(reopenWrites.some((op) => op.where?.params.includes(501))).toBe(true);
  });

  it("routes an insert-conflict correction through guarded evidence update and reconciliation reopening", async () => {
    const raced = {
      id: 501,
      transactionRef: order().gid,
      shopifyUpdatedAt: new Date("2026-09-20T10:04:00Z"),
      amount: "18.95",
      currency: "USD",
      transactionDate: new Date(order().createdAt),
      valueDate: new Date(order().processedAt!),
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "AUTHORIZED",
      shopifyCancelledAt: null,
      status: "matched",
      matchId: 777,
    };
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        // Missing during partition, then present after the conflict-safe insert.
        [TRANSACTIONS]: [[], [raced]],
        [MATCHES]: [[]],
      },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report.updated).toBe(1);
    const transactionWrites = fake.writes("update", TRANSACTIONS);
    expect(transactionWrites[0]?.where?.sql).toMatch(/shopifyUpdatedAt.*is null|shopifyUpdatedAt.*</i);
    expect(transactionWrites.some((op) => op.where?.params.includes(777) && op.data?.status === "unmatched")).toBe(true);
    expect(transactionWrites.some((op) => op.where?.params.includes(501) && op.data?.status === "unmatched")).toBe(true);
  });

  it("clears a legacy manually-matched pair only when the counterpart still points back", async () => {
    const current = {
      id: 501,
      transactionRef: order().gid,
      shopifyUpdatedAt: new Date("2026-09-20T10:04:00Z"),
      amount: "18.95",
      currency: "USD",
      transactionDate: new Date(order().createdAt),
      valueDate: new Date(order().processedAt!),
      shopifyOrderCurrency: "USD",
      shopifyFinancialStatus: "AUTHORIZED",
      shopifyCancelledAt: null,
      status: "manually_matched",
      matchId: 777,
    };
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[current]],
        [MATCHES]: [[]],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, fetchOrders: vi.fn(async () => [order()]) },
    );

    const legacyCounterpart = fake
      .writes("update", TRANSACTIONS)
      .find((op) => op.where?.params.includes(777) && op.where.params.includes(501));
    expect(legacyCounterpart?.data).toMatchObject({ status: "unmatched", matchId: null });
    expect(legacyCounterpart?.where?.params).toEqual(expect.arrayContaining([777, 42, 501, "matched", "manually_matched"]));
  });
});

describe("terminal webhook sync failure evidence", () => {
  it("keeps the receipt failed and tenant/store scoped after attempts are exhausted", async () => {
    const fake = scriptedDb();
    await markShopifyWebhookSyncFailed(
      { storeId: 7, organizationId: 42, webhookId: "wh-exhausted" },
      { db: fake.db as never },
    );

    const write = fake.writes("update", EVENTS)[0];
    expect(write?.data).toMatchObject({
      status: "failed",
      errorCode: "order_sync_attempts_exhausted",
    });
    expect(write?.data?.status).not.toBe("processed");
    expect(write?.where?.params).toEqual(expect.arrayContaining(["wh-exhausted", 7, 42, "received"]));
  });
});
