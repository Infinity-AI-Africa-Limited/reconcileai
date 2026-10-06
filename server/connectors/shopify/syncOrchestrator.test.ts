import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import { toShopifyOrderTransaction, toShopifyRefundTransaction } from "./ingest";
import { computeShopifyOrderSuppressionDigest } from "./privacySuppression";
import {
  filterTombstonedShopifyOrders,
  markShopifyWebhookSyncFailed,
  materialShopifyOrderEvidenceChanged,
  partitionShopifyOrders,
  planShopifyRefundRows,
  runShopifyOrderSync,
  runShopifyOrderSyncToNow,
  type ShopifyOrderSyncReport,
} from "./syncOrchestrator";
import { rowOf, scriptedDb } from "./scriptedDb.testkit";
import type { NormalizedShopifyOrder, NormalizedShopifyRefund } from "./orders";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
const USERS = "users";
const CHANNELS = "channels";
const TRANSACTIONS = "transactions";
const BATCHES = "upload_batches";
const TOMBSTONES = "shopify_order_redaction_tombstones";
const SUPPRESSION_KEYS = [{ version: "v1", key: Buffer.alloc(32, 7) }];
const MATCHES = "matches";
const EVENTS = "shopify_webhook_events";

const order = (over: Partial<NormalizedShopifyOrder> = {}): NormalizedShopifyOrder => ({
  gid: "gid://shopify/Order/1001",
  name: "#1001",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:05:00.000Z",
  processedAt: "2026-09-20T10:01:00.000Z",
  currencyCode: "USD",
  totalPrice: { amount: "19.95", currencyCode: "USD" },
  totalRefunded: { amount: "0.00", currencyCode: "USD" },
  refunds: [],
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
const writableStore = { id: 7, status: "active", privacyRedactionState: "active" };

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

  it("filters only exact tombstoned Shopify order GIDs", () => {
    expect(
      filterTombstonedShopifyOrders([order(), order({ gid: "gid://shopify/Order/1002" })], new Set([order().gid])),
    ).toEqual([order({ gid: "gid://shopify/Order/1002" })]);
  });

  it("should treat as material only what matching reads: total, currency and dates", () => {
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
    expect(materialShopifyOrderEvidenceChanged(existing, order({ totalPrice: { amount: "20.95", currencyCode: "USD" } }))).toBe(true);
    expect(materialShopifyOrderEvidenceChanged(existing, order({ processedAt: "2026-09-21T00:00:00.000Z" }))).toBe(true);
    expect(materialShopifyOrderEvidenceChanged(existing, order({ currencyCode: "EUR" }))).toBe(true);
    // A refund changes these, and is its own row: the order still matches its payment.
    expect(materialShopifyOrderEvidenceChanged(existing, order({ displayFinancialStatus: "PARTIALLY_REFUNDED" }))).toBe(false);
    expect(materialShopifyOrderEvidenceChanged(existing, order({ cancelledAt: "2026-09-22T00:00:00.000Z" }))).toBe(false);
    expect(
      materialShopifyOrderEvidenceChanged(existing, order({ totalRefunded: { amount: "5.00", currencyCode: "USD" } })),
    ).toBe(false);
  });
});

describe("tenant-isolated sync orchestration", () => {
  it("refuses a tenant/store mismatch before fetching protected order data", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const fetchOrders = vi.fn(async () => [order()]);
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 999, trigger: "manual" },
        { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders },
      ),
    ).rejects.toThrow(/not found for tenant/);
    expect(fetchOrders).not.toHaveBeenCalled();
    // Nothing is written for a store it could not find.
    expect(fake.writes("insert", CURSORS)).toEqual([]);
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual(expect.arrayContaining([7, 999, "active"]));
  });

  it("uses the onboarded active actor, scopes every lookup, and persists a replay only once", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], [writableStore]],
        [CURSORS]: [[{ watermarkUpdatedAt: new Date("2026-09-20T10:00:00Z") }]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[{ id: 501, transactionRef: order().gid, shopifyUpdatedAt: new Date(order().updatedAt) }]],
        [TOMBSTONES]: [[]],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "backstop" },
      {
        db: fake.db as never,
        fetchOrders,
        now: () => new Date("2026-09-20T11:00:00Z"),
        suppressionKeys: SUPPRESSION_KEYS,
      },
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

  it("does not re-import an exact tenant/store tombstoned order", async () => {
    const tombstone = computeShopifyOrderSuppressionDigest(SUPPRESSION_KEYS[0].key, 42, 7, order().gid);
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], [writableStore]],
        [CURSORS]: [[{ watermarkUpdatedAt: new Date("2026-09-20T10:00:00Z") }]],
        [USERS]: [[{ id: 9 }]],
        [TOMBSTONES]: [[{ keyVersion: "v1", orderDigest: tombstone }]],
        [CHANNELS]: [[{ id: 70 }]],
      },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "backstop" },
      {
        db: fake.db as never,
        fetchOrders: vi.fn(async () => [order()]),
        now: () => new Date("2026-09-20T11:00:00Z"),
        suppressionKeys: SUPPRESSION_KEYS,
      },
    );

    expect(report).toMatchObject({ success: true, fetched: 1, inserted: 0, updated: 0, unchanged: 0, batchId: null });
    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
    expect(fake.writes("insert", BATCHES)).toEqual([]);
    const tombstoneLookup = fake.ops.find((op) => op.kind === "select" && op.table === TOMBSTONES);
    expect(tombstoneLookup?.where?.params).toEqual(expect.arrayContaining([42, 7, "v1", tombstone]));
    expect(tombstoneLookup?.where?.sql).not.toMatch(/transactionRef|externalRef|email|name|rawData/i);
  });

  it("fails closed before a durable sync write when no retained suppression key is available", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], [writableStore]],
        [CURSORS]: [[{ watermarkUpdatedAt: new Date("2026-09-20T10:00:00Z") }]],
        [USERS]: [[{ id: 9 }]],
      },
    });
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 42, trigger: "manual" },
        { db: fake.db as never, fetchOrders: vi.fn(async () => [order()]), suppressionKeys: [] },
      ),
    ).rejects.toThrow(/suppression_key_unavailable/);
    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
  });

  it("advances a watermark the cursor row holds as NULL — GREATEST alone would keep it NULL", async () => {
    // A cursor row can exist before the first success: a failed first sync
    // records its error on one, and a manual request numbers itself on one.
    // GREATEST(NULL, x) is NULL in MySQL and TiDB, so without COALESCE every
    // later sync would re-read the oldest window and never reach recent orders.
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], [{ id: store.id }]],
        [CURSORS]: [[{ watermarkUpdatedAt: null, lastErrorCode: "sync_failed" }]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[]],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, fetchOrders: vi.fn(async () => []), now: () => new Date("2026-09-20T11:00:00Z") },
    );

    const success = fake.writes("insert", CURSORS).find((op) => op.onDuplicate && "watermarkUpdatedAt" in op.onDuplicate);
    const merge = new MySqlDialect().sqlToQuery(success?.onDuplicate?.watermarkUpdatedAt as SQL).sql;
    expect(merge).toBe(
      "COALESCE(GREATEST(`shopify_sync_cursors`.`watermarkUpdatedAt`, VALUES(`shopify_sync_cursors`.`watermarkUpdatedAt`)), VALUES(`shopify_sync_cursors`.`watermarkUpdatedAt`))",
    );
  });

  it("falls back to an active administrator of the same tenant when the claimant is absent", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[{ ...store, claimedByUserId: null }], [{ id: store.id }]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 12 }]],
        [CHANNELS]: [[{ id: 70 }]],
        // Absent at partition time; present after the insert, carrying our batch.
        [TRANSACTIONS]: [[], [{ id: 900, transactionRef: order().gid, shopifyUpdatedAt: new Date(order().updatedAt), batchId: 80 }]],
      },
      insert: { [BATCHES]: [80] },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders },
    );
    expect(report.inserted).toBe(1);
    expect(fake.writes("insert", BATCHES)[0]?.data).toMatchObject({ userId: 12, organizationId: 42 });
    const actorLookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookup?.where?.params).toEqual(expect.arrayContaining([42, "admin", true]));
  });

  it("tries a same-tenant active admin fallback only after an inactive claimant and rejects non-admin absence", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], [{ id: store.id }]],
        [CURSORS]: [[]],
        [USERS]: [[], []],
      },
    });
    const fetchOrders = vi.fn(async () => [order()]);
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 42, trigger: "manual" },
        { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders },
      ),
    ).rejects.toThrow(/active tenant administrator unavailable/);
    expect(fetchOrders).not.toHaveBeenCalled();
    // The precise code is recorded, with its time.
    const failure = fake.writes("insert", CURSORS)[0];
    expect(failure?.data).toMatchObject({ lastErrorCode: "sync_actor_unavailable", lastErrorAt: expect.any(Date) });
    expect(rowOf(failure)?.lastErrorAt).toBeInstanceOf(Date);
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
        [STORES]: [[store], [{ id: store.id }]],
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
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
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
        [STORES]: [[store], [{ id: store.id }]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[current]],
        [MATCHES]: [[{ id: 88, sourceTransactionId: 501, targetTransactionId: 777 }]],
      },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report.updated).toBe(1);
    expect(fake.writes("delete", MATCHES)).toEqual([]);
    expect(fake.writes("update", MATCHES)[0]).toMatchObject({ data: { status: "rejected" } });
    expect(fake.writes("update", MATCHES)[0]?.where?.params).toEqual(expect.arrayContaining([42, 88]));
    const reopenWrites = fake.writes("update", TRANSACTIONS).filter((op) => rowOf(op)?.status === "unmatched");
    expect(reopenWrites).toHaveLength(2);
    expect(reopenWrites.every((op) => rowOf(op)?.matchId === null)).toBe(true);
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
        [STORES]: [[store], [{ id: store.id }]],
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
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report.updated).toBe(1);
    const transactionWrites = fake.writes("update", TRANSACTIONS);
    expect(transactionWrites[0]?.where?.sql).toMatch(/shopifyUpdatedAt.*is null|shopifyUpdatedAt.*</i);
    expect(transactionWrites.some((op) => op.where?.params.includes(777) && rowOf(op)?.status === "unmatched")).toBe(true);
    expect(transactionWrites.some((op) => op.where?.params.includes(501) && rowOf(op)?.status === "unmatched")).toBe(true);
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
        [STORES]: [[store], [{ id: store.id }]],
        [CURSORS]: [[]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
        [TRANSACTIONS]: [[current]],
        [MATCHES]: [[]],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    const legacyCounterpart = fake
      .writes("update", TRANSACTIONS)
      .find((op) => op.where?.params.includes(777) && op.where.params.includes(501));
    expect(legacyCounterpart?.data).toMatchObject({ status: "unmatched", matchId: null });
    expect(legacyCounterpart?.where?.params).toEqual(expect.arrayContaining([777, 42, 501, "matched", "manually_matched"]));
  });
});

/** The corrected order as it stood before this sync: older evidence, matched. */
const matchedBefore = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const baseSelects = () => ({
  [STORES]: [[store], [{ id: store.id }]],
  [CURSORS]: [[]],
  [USERS]: [[{ id: 9 }]],
  [CHANNELS]: [[{ id: 70 }]],
});

describe("when a corrected order reopens its reconciliation", () => {
  it("should leave a counterpart that is still matched to another transaction", async () => {
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [[matchedBefore()]],
        // Our match, then — read after rejecting it — the counterpart's other one.
        [MATCHES]: [[{ id: 88, sourceTransactionId: 501, targetTransactionId: 777 }], [{ sourceTransactionId: 777, targetTransactionId: 900 }]],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    const reopened = fake.writes("update", TRANSACTIONS).filter((op) => rowOf(op)?.status === "unmatched");
    expect(reopened.some((op) => op.where?.params.includes(777))).toBe(false);
    expect(reopened.some((op) => op.where?.params.includes(501))).toBe(true);
    // The still-matched check is scoped to the tenant and to active matches only.
    const check = fake.ops.filter((op) => op.kind === "select" && op.table === MATCHES)[1];
    expect(check?.where?.params).toEqual(expect.arrayContaining([42, "confirmed", "pending_review", 777]));
  });

  it("should take back only a matched summary, never an exception or a pairing elsewhere", async () => {
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [[matchedBefore()]],
        [MATCHES]: [[{ id: 88, sourceTransactionId: 501, targetTransactionId: 777 }], []],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    const counterpart = fake
      .writes("update", TRANSACTIONS)
      .find((op) => rowOf(op)?.status === "unmatched" && op.where?.params.includes(777));
    expect(counterpart?.where?.params).toEqual(expect.arrayContaining([42, 777, "matched", "manually_matched", 501]));
    // An open exception record owns an `exception` status; this sync does not resolve it.
    expect(counterpart?.where?.params).not.toContain("exception");
    // Only a legacy pointer that is empty or points back at this order is cleared.
    expect(counterpart?.where?.sql).toMatch(/`matchId` is null or `transactions`\.`matchId` = \?/i);
  });

  it("should leave the corrected order's own non-matched status alone", async () => {
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [[matchedBefore({ status: "exception" })]],
        [MATCHES]: [[]],
      },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    const self = fake
      .writes("update", TRANSACTIONS)
      .find((op) => rowOf(op)?.status === "unmatched" && op.where?.params.includes(501));
    expect(self?.where?.params).toEqual(expect.arrayContaining([501, 42, "matched", "manually_matched"]));
    expect(self?.where?.params).not.toContain("exception");
  });
});

describe("when a corrected order was in a match still awaiting review", () => {
  const EXCEPTIONS = "exceptions";
  const reviewMatch = { id: 88, status: "pending_review", sourceTransactionId: 501, targetTransactionId: 777 };

  async function correct(select: Record<string, unknown[][]>) {
    const fake = scriptedDb({ select: { ...baseSelects(), [TRANSACTIONS]: [[matchedBefore({ status: "exception" })]], ...select } });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );
    return fake;
  }

  const releasedFromReview = (fake: ReturnType<typeof scriptedDb>) =>
    fake.writes("update", TRANSACTIONS).filter((op) => rowOf(op)?.status === "unmatched" && op.where?.params.includes("exception"));
  /** Only the corrected order's own row was released; no counterpart write at all. */
  const onlyOwnReleased = (fake: ReturnType<typeof scriptedDb>) => {
    const released = releasedFromReview(fake);
    expect(released).toHaveLength(1);
    expect(released[0]?.where?.params[0]).toBe(501);
  };

  it("should take back the `exception` status the rejected review match put on both sides", async () => {
    const fake = await correct({ [MATCHES]: [[reviewMatch], []], [EXCEPTIONS]: [[]] });

    const [own, counterpart] = releasedFromReview(fake);
    // The corrected order: only while its pointer is empty or names the counterpart.
    expect(own?.where?.params).toEqual([501, 42, "exception", 777]);
    expect(own?.where?.sql).toMatch(/`matchId` is null or `transactions`\.`matchId` in \(\?\)/i);
    // The counterpart: only while its pointer is empty or names the corrected order.
    expect(counterpart?.where?.params).toEqual([42, 777, "exception", 501]);
    expect(counterpart?.where?.sql).toMatch(/`matchId` is null or `transactions`\.`matchId` = \?/i);
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === EXCEPTIONS);
    expect(lookup?.where?.params).toEqual([42, 501, 777, "open", "in_review", "escalated"]);
  });

  it("should leave an `exception` status that an unresolved exception record still owns", async () => {
    const fake = await correct({ [MATCHES]: [[reviewMatch], []], [EXCEPTIONS]: [[{ transactionId: 777 }]] });

    onlyOwnReleased(fake);
  });

  it("should leave a counterpart the review match shares with another active match", async () => {
    const fake = await correct({
      [MATCHES]: [[reviewMatch], [{ sourceTransactionId: 777, targetTransactionId: 900 }]],
      [EXCEPTIONS]: [[]],
    });

    onlyOwnReleased(fake);
  });

  it("should not touch an `exception` status when the rejected match was already confirmed", async () => {
    const fake = await correct({ [MATCHES]: [[{ ...reviewMatch, status: "confirmed" }], []] });

    expect(releasedFromReview(fake)).toEqual([]);
    expect(fake.ops.some((op) => op.table === EXCEPTIONS)).toBe(false);
  });
});

describe("when two syncs of one store overlap", () => {
  it("should take the store row lock before reading or writing any order", async () => {
    const fake = scriptedDb({
      select: { ...baseSelects(), [TRANSACTIONS]: [[]] },
    });
    await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    const inTx = fake.ops.filter((op) => op.txId !== null);
    expect(inTx[0]).toMatchObject({ kind: "select", table: STORES, locked: true });
    // Active lifecycle AND no customer redaction holding the store's write fence.
    expect(inTx[0]?.where?.params).toEqual([7, 42, "active", "active"]);
    expect(inTx[0]?.where?.sql).toMatch(/`privacyRedactionState` = \?/);
  });

  it("should write nothing when a customer redaction fenced the store after the API read", async () => {
    const fake = scriptedDb({
      select: { [STORES]: [[store], []], [CURSORS]: [[]], [USERS]: [[{ id: 9 }]], [CHANNELS]: [[{ id: 70 }]] },
    });
    await expect(
      runShopifyOrderSync(
        { storeId: 7, organizationId: 42, trigger: "manual" },
        { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
      ),
    ).rejects.toThrow(/write fence/);
    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
  });

  it("should count as inserted only the rows this cycle wrote", async () => {
    const a = order({ gid: "gid://shopify/Order/2001", name: "#A" });
    const b = order({ gid: "gid://shopify/Order/2002", name: "#B" });
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [
          [],
          [
            { id: 1, transactionRef: a.gid, shopifyUpdatedAt: new Date(a.updatedAt), batchId: 80 },
            // Inserted by the other sync first, with the same evidence.
            { id: 2, transactionRef: b.gid, shopifyUpdatedAt: new Date(b.updatedAt), batchId: 55 },
          ],
        ],
      },
      insert: { [BATCHES]: [80] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [a, b]) },
    );

    expect(report).toMatchObject({ inserted: 1, updated: 0, unchanged: 1, batchId: 80 });
    // The batch was sized from the plan (2); it records what was written (1).
    const resize = fake.writes("update", BATCHES)[0];
    expect(resize?.data).toEqual({ validRows: 1 });
    expect(resize?.where?.params).toEqual(expect.arrayContaining([80, 42]));
  });

  it("should count a raced row with newer evidence as updated, not inserted", async () => {
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [[], [matchedBefore({ status: "unmatched", batchId: 55 })]],
        [MATCHES]: [[]],
      },
      insert: { [BATCHES]: [80] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, batchId: 80 });
    expect(fake.writes("update", BATCHES)).toEqual([]); // planned 1, wrote 1
  });

  it("should discard its batch when the other sync wrote everything first", async () => {
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [[], [{ id: 2, transactionRef: order().gid, shopifyUpdatedAt: new Date(order().updatedAt), batchId: 55 }]],
      },
      insert: { [BATCHES]: [80] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]) },
    );

    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, batchId: null });
    const discard = fake.writes("delete", BATCHES)[0];
    expect(discard?.where?.params).toEqual(expect.arrayContaining([80, 42]));
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
    expect(rowOf(write)?.status).not.toBe("processed");
    expect(write?.where?.params).toEqual(expect.arrayContaining(["wh-exhausted", 7, 42, "received"]));
  });
});

describe("when a store is further behind than one sync window", () => {
  const NOW = new Date("2026-09-20T12:00:00Z");
  const DAY = 24 * 60 * 60_000;
  function cycleReport(to: Date): ShopifyOrderSyncReport {
    return {
      success: true,
      organizationId: 42,
      storeId: 7,
      window: { from: new Date(to.getTime() - 7 * DAY), to },
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      refundsInserted: 0,
      refundsUpdated: 0,
      batchId: null,
    };
  }

  it("should run cycles until a window reaches now, each committing its own step", async () => {
    const ends = [
      new Date(NOW.getTime() - 53 * DAY),
      new Date(NOW.getTime() - 46 * DAY),
      NOW,
    ];
    const runCycle = vi.fn(async () => cycleReport(ends.shift()!));

    const reports = await runShopifyOrderSyncToNow(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { now: () => NOW, runCycle },
    );

    expect(runCycle).toHaveBeenCalledTimes(3);
    expect(reports.at(-1)?.window.to).toEqual(NOW);
  });

  it("should run exactly one cycle for a store that is already current", async () => {
    const runCycle = vi.fn(async () => cycleReport(NOW));
    await runShopifyOrderSyncToNow({ storeId: 7, organizationId: 42, trigger: "webhook" }, { now: () => NOW, runCycle });
    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it("should stop rather than spin when a window does not move forward", async () => {
    const stuck = new Date(NOW.getTime() - 30 * DAY);
    const runCycle = vi.fn(async () => cycleReport(stuck));
    await runShopifyOrderSyncToNow({ storeId: 7, organizationId: 42, trigger: "manual" }, { now: () => NOW, runCycle });
    expect(runCycle).toHaveBeenCalledTimes(2);
  });

  describe("when the caller gives it a time budget", () => {
    // A clock that moves 20 seconds every time it is read.
    function steppingClock(stepMs: number) {
      let t = NOW.getTime();
      return () => new Date((t += stepMs));
    }
    const behind = () => cycleReport(new Date(NOW.getTime() - 50 * DAY));

    it("should start no further cycle once the budget is spent", async () => {
      const runCycle = vi
        .fn()
        .mockResolvedValueOnce(cycleReport(new Date(NOW.getTime() - 53 * DAY)))
        .mockResolvedValueOnce(cycleReport(new Date(NOW.getTime() - 46 * DAY)))
        .mockResolvedValue(cycleReport(new Date(NOW.getTime() - 39 * DAY)));
      // Read at start (t+20s), before cycle 1 (+40s), cycle 2 (+60s: 40s spent, under 45s),
      // cycle 3 (+80s: 60s spent) — which is not started.
      await runShopifyOrderSyncToNow(
        { storeId: 7, organizationId: 42, trigger: "backstop" },
        { now: steppingClock(20_000), runCycle, budgetMs: 45_000 },
      );
      expect(runCycle).toHaveBeenCalledTimes(2);
    });

    it("should always run the first cycle, even with no budget left", async () => {
      const runCycle = vi.fn(async () => behind());
      await runShopifyOrderSyncToNow(
        { storeId: 7, organizationId: 42, trigger: "backstop" },
        { now: steppingClock(20_000), runCycle, budgetMs: 0 },
      );
      expect(runCycle).toHaveBeenCalledTimes(1);
    });
  });

  it("should stop at the first failing cycle, keeping the steps already committed", async () => {
    const runCycle = vi
      .fn()
      .mockResolvedValueOnce(cycleReport(new Date(NOW.getTime() - 53 * DAY)))
      .mockRejectedValueOnce(new Error("pagination_error"));
    await expect(
      runShopifyOrderSyncToNow({ storeId: 7, organizationId: 42, trigger: "manual" }, { now: () => NOW, runCycle }),
    ).rejects.toThrow("pagination_error");
    expect(runCycle).toHaveBeenCalledTimes(2);
  });
});

const refundOf = (over: Partial<NormalizedShopifyRefund> = {}): NormalizedShopifyRefund => ({
  gid: "gid://shopify/Refund/9",
  createdAt: "2026-09-21T09:00:00.000Z",
  amount: "5.00",
  currencyCode: "USD",
  ...over,
});
const REFUNDED_AT = "2026-09-21T09:00:05.000Z";
const refundedOrder = (over: Partial<NormalizedShopifyOrder> = {}) =>
  order({ updatedAt: REFUNDED_AT, totalRefunded: { amount: "5.00", currencyCode: "USD" }, refunds: [refundOf()], ...over });
const INGEST = { organizationId: 42, storeId: 7, channelId: 70, batchId: 80, userId: 9 };
const storedRefund = (over: Record<string, unknown> = {}) => ({
  id: 601,
  transactionRef: order().gid,
  shopifyRefundId: refundOf().gid,
  shopifyUpdatedAt: new Date(REFUNDED_AT),
  amount: "5.00",
  currency: "USD",
  transactionDate: new Date(refundOf().createdAt!),
  matchId: null,
  ...over,
});

describe("when an order has been refunded", () => {
  it("should record the refund as money out, under its order's reference, with nothing raw", () => {
    expect(toShopifyRefundTransaction(refundedOrder(), refundOf(), INGEST)).toEqual({
      batchId: 80,
      channelId: 70,
      userId: 9,
      organizationId: 42,
      shopifyStoreId: 7,
      shopifyRefundId: "gid://shopify/Refund/9",
      transactionRef: "gid://shopify/Order/1001",
      externalRef: "#1001",
      description: "Shopify Order #1001 refund",
      amount: "5.00",
      currency: "USD",
      transactionDate: new Date("2026-09-21T09:00:00.000Z"),
      valueDate: new Date("2026-09-21T09:00:00.000Z"),
      shopifyOrderCurrency: "USD",
      shopifyUpdatedAt: new Date(REFUNDED_AT),
      shopifyFinancialStatus: "PAID",
      shopifyCancelledAt: null,
      debitCredit: "debit",
      counterparty: "Shopify",
      isReversal: true,
      status: "unmatched",
      rawData: null,
    });
  });

  it("should date a refund Shopify gives no time for by its order's last update", () => {
    const row = toShopifyRefundTransaction(refundedOrder(), refundOf({ createdAt: null }), INGEST);
    expect(row.transactionDate).toEqual(new Date(REFUNDED_AT));
  });

  it("should keep the order's own row at its total before refunds", () => {
    const row = toShopifyOrderTransaction(refundedOrder({ totalPrice: { amount: "100.00", currencyCode: "USD" } }), INGEST);
    expect(row).toMatchObject({ amount: "100.00", debitCredit: "credit", isReversal: false, shopifyRefundId: "" });
  });
});

describe("when refunds are planned against what is stored", () => {
  it("should insert a new refund that returned money, and not one that returned none", () => {
    const plan = planShopifyRefundRows(
      [refundedOrder({ refunds: [refundOf(), refundOf({ gid: "gid://shopify/Refund/10", amount: "0.00" })] })],
      [],
    );
    expect(plan.inserts.map(({ refund }) => refund.gid)).toEqual(["gid://shopify/Refund/9"]);
    expect(plan.updates).toEqual([]);
  });

  it("should restate a stored refund from a newer version of its order", () => {
    const plan = planShopifyRefundRows([refundedOrder()], [storedRefund({ shopifyUpdatedAt: new Date("2026-09-21T09:00:00Z") })]);
    expect(plan.updates.map((update) => update.transactionId)).toEqual([601]);
  });

  it("should restate a stored refund the same version now reads differently — including to zero", () => {
    const plan = planShopifyRefundRows([refundedOrder({ refunds: [refundOf({ amount: "0.00" })] })], [storedRefund()]);
    expect(plan.updates.map((update) => [update.transactionId, update.refund.amount])).toEqual([[601, "0.00"]]);
  });

  it("should leave a stored refund alone when nothing changed, or its order's version is older", () => {
    expect(planShopifyRefundRows([refundedOrder()], [storedRefund()])).toMatchObject({ inserts: [], updates: [], unchanged: 1 });
    const older = planShopifyRefundRows(
      [refundedOrder({ updatedAt: "2026-09-21T08:00:00.000Z", refunds: [refundOf({ amount: "9.99" })] })],
      [storedRefund()],
    );
    expect(older).toMatchObject({ inserts: [], updates: [], unchanged: 1 });
  });
});

describe("when an order stored net of its refunds is read again at the same version", () => {
  it("should restate it at its total before refunds", () => {
    const current = order();
    const result = partitionShopifyOrders(
      [current],
      [
        {
          id: 501,
          transactionRef: current.gid,
          shopifyUpdatedAt: new Date(current.updatedAt),
          amount: "14.95", // written as the total net of a 5.00 refund
          currency: "USD",
          transactionDate: new Date(current.createdAt),
          valueDate: new Date(current.processedAt!),
          shopifyOrderCurrency: "USD",
        },
      ],
    );
    expect(result.updates.map((update) => update.transactionId)).toEqual([501]);
  });
});

describe("when the sync writes an order's refunds", () => {
  it("should insert each refund that returned money as its own row, and look orders up by their own row only", async () => {
    const refunded = refundedOrder({ refunds: [refundOf(), refundOf({ gid: "gid://shopify/Refund/10", amount: "0.00" })] });
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        // The order's own row (none yet), its stored refunds (none), then the reload of inserted orders.
        [TRANSACTIONS]: [[], [], [{ id: 1, transactionRef: refunded.gid, shopifyUpdatedAt: new Date(REFUNDED_AT), batchId: 80 }]],
      },
      insert: { [BATCHES]: [80] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "manual" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [refunded]) },
    );

    expect(report).toMatchObject({ inserted: 1, refundsInserted: 1, refundsUpdated: 0, batchId: 80 });
    const [orderInsert, refundInsert] = fake.writes("insert", TRANSACTIONS);
    expect(orderInsert?.data).toEqual([expect.objectContaining({ amount: "19.95", debitCredit: "credit", shopifyRefundId: "" })]);
    expect(refundInsert?.data).toEqual([
      expect.objectContaining({
        transactionRef: refunded.gid,
        shopifyRefundId: "gid://shopify/Refund/9",
        amount: "5.00",
        debitCredit: "debit",
        isReversal: true,
        batchId: 80,
        rawData: null,
      }),
    ]);
    const [orderLookup, refundLookup] = fake.ops.filter((op) => op.kind === "select" && op.table === TRANSACTIONS);
    expect(orderLookup?.where?.sql).toMatch(/`shopifyRefundId` = \?/);
    expect(orderLookup?.where?.params).toContain("");
    expect(refundLookup?.where?.sql).toMatch(/`shopifyRefundId` <> \?/);
    expect(refundLookup?.locked).toBe(true);
  });

  it("should restate a changed refund under its version guard, and reopen its match", async () => {
    const refunded = refundedOrder();
    const fake = scriptedDb({
      select: {
        ...baseSelects(),
        [TRANSACTIONS]: [
          [
            {
              id: 501,
              transactionRef: refunded.gid,
              shopifyUpdatedAt: new Date(REFUNDED_AT),
              amount: "19.95",
              currency: "USD",
              transactionDate: new Date(refunded.createdAt),
              valueDate: new Date(refunded.processedAt!),
              shopifyOrderCurrency: "USD",
            },
          ],
          [storedRefund({ shopifyUpdatedAt: new Date("2026-09-21T09:00:00Z"), amount: "4.00", status: "matched" })],
        ],
        [MATCHES]: [[]],
      },
      insert: { [BATCHES]: [80] },
    });
    const report = await runShopifyOrderSync(
      { storeId: 7, organizationId: 42, trigger: "webhook" },
      { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [refunded]) },
    );

    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, refundsInserted: 0, refundsUpdated: 1 });
    const [restate] = fake.writes("update", TRANSACTIONS);
    expect(restate?.data).toMatchObject({ amount: "5.00", batchId: 80 });
    expect(restate?.where?.params).toEqual(expect.arrayContaining([601, 42, 7, refunded.gid, "gid://shopify/Refund/9"]));
    expect(restate?.where?.sql).toMatch(/`shopifyUpdatedAt` <= \?/);
    // Reopening reads the refund's active matches.
    expect(fake.ops.some((op) => op.kind === "select" && op.table === MATCHES)).toBe(true);
  });
});
