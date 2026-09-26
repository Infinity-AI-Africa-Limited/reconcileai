import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import { toShopifyOrderTransaction } from "./ingest";
import { computeShopifyOrderSuppressionDigest } from "./privacySuppression";
import {
  filterTombstonedShopifyOrders,
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
        { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders },
      ),
    ).rejects.toThrow(/not found for tenant/);
    expect(fetchOrders).not.toHaveBeenCalled();
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
        { db: fake.db as never, suppressionKeys: SUPPRESSION_KEYS, fetchOrders: vi.fn(async () => [order()]), suppressionKeys: [] },
      ),
    ).rejects.toThrow(/suppression_key_unavailable/);
    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
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

    const reopened = fake.writes("update", TRANSACTIONS).filter((op) => op.data?.status === "unmatched");
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
      .find((op) => op.data?.status === "unmatched" && op.where?.params.includes(777));
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
      .find((op) => op.data?.status === "unmatched" && op.where?.params.includes(501));
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
    fake.writes("update", TRANSACTIONS).filter((op) => op.data?.status === "unmatched" && op.where?.params.includes("exception"));
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
    expect(write?.data?.status).not.toBe("processed");
    expect(write?.where?.params).toEqual(expect.arrayContaining(["wh-exhausted", 7, 42, "received"]));
  });
});
