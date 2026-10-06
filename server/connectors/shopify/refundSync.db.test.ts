/**
 * Order and refund rows written by the real sync against a REAL MySQL — CI's
 * database only, gated like syncCursor.db.test.ts because the local .env names
 * production and this test writes rows.
 *
 * What a scripted handle cannot prove: that the widened unique key lets an
 * order and its refunds share a reference while still refusing a second copy
 * of either, that the order lookup ignores its refund rows, and that the sync
 * converges — a replay writes nothing, a later version adds only what is new.
 */
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channels, transactions, uploadBatches, users } from "../../../drizzle/schema";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import type { NormalizedShopifyOrder, NormalizedShopifyRefund } from "./orders";
import { runShopifyOrderSync } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const GID = "gid://shopify/Order/5550001";
const refund = (id: number, amount: string): NormalizedShopifyRefund => ({
  gid: `gid://shopify/Refund/${id}`,
  createdAt: "2026-09-21T09:00:00.000Z",
  amount,
  currencyCode: "USD",
});
const order = (updatedAt: string, refunds: NormalizedShopifyRefund[]): NormalizedShopifyOrder => ({
  gid: GID,
  name: "#5001",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt,
  processedAt: "2026-09-20T10:01:00.000Z",
  currencyCode: "USD",
  totalPrice: { amount: "100.00", currencyCode: "USD" },
  totalRefunded: {
    amount: refunds.reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2),
    currencyCode: "USD",
  },
  refunds,
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  cancelledAt: null,
});

describe.runIf(localDatabase)("when an order and its refunds are synced into MySQL", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  // Ids no real tenant uses, cleaned up after.
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  let storeId = 0;
  const keys = [{ version: "v1", key: Buffer.alloc(32, 7) }];

  const sync = (fetched: NormalizedShopifyOrder) =>
    runShopifyOrderSync(
      { storeId, organizationId, trigger: "manual" },
      { db: db as never, suppressionKeys: keys, fetchOrders: async () => [fetched], now: () => new Date("2026-09-22T00:00:00Z") },
    );
  const ledger = () =>
    db
      .select({
        shopifyRefundId: transactions.shopifyRefundId,
        amount: transactions.amount,
        debitCredit: transactions.debitCredit,
        isReversal: transactions.isReversal,
        rawData: transactions.rawData,
      })
      .from(transactions)
      .where(and(eq(transactions.organizationId, organizationId), eq(transactions.shopifyStoreId, storeId)))
      .orderBy(asc(transactions.shopifyRefundId));

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
    const [user] = await db.insert(users).values({
      openId: `refund-sync-test-${organizationId}`,
      role: "admin",
      organizationId,
      isActive: true,
    });
    const [store] = await db.insert(shopifyConnectorStores).values({
      organizationId,
      shopDomain: `refund-sync-${organizationId}.myshopify.com`,
      shopId: String(organizationId),
      displayName: "Refund sync test",
      currency: "USD",
      grantedScopes: "read_orders",
      requestedScopes: "read_orders",
      status: "active",
      claimedByUserId: (user as { insertId: number }).insertId,
    });
    storeId = (store as { insertId: number }).insertId;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(transactions).where(eq(transactions.organizationId, organizationId));
    await db.delete(uploadBatches).where(eq(uploadBatches.organizationId, organizationId));
    await db.delete(channels).where(eq(channels.organizationId, organizationId));
    await db.delete(shopifySyncCursors).where(eq(shopifySyncCursors.organizationId, organizationId));
    await db.delete(shopifyConnectorStores).where(eq(shopifyConnectorStores.organizationId, organizationId));
    await db.delete(users).where(eq(users.organizationId, organizationId));
    await pool.end();
  });

  it("should store the order at its total before refunds, and the refund as its own money-out row", async () => {
    const report = await sync(order("2026-09-21T09:00:05.000Z", [refund(9, "30.00")]));

    expect(report).toMatchObject({ inserted: 1, refundsInserted: 1 });
    expect(await ledger()).toEqual([
      { shopifyRefundId: "", amount: "100.00", debitCredit: "credit", isReversal: false, rawData: null },
      { shopifyRefundId: "gid://shopify/Refund/9", amount: "30.00", debitCredit: "debit", isReversal: true, rawData: null },
    ]);
  });

  it("should write nothing when the same version is read again", async () => {
    const report = await sync(order("2026-09-21T09:00:05.000Z", [refund(9, "30.00")]));

    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, refundsInserted: 0, refundsUpdated: 0, batchId: null });
    expect(await ledger()).toHaveLength(2);
  });

  it("should add only the new refund when a later version brings one", async () => {
    const report = await sync(order("2026-09-23T08:00:00.000Z", [refund(9, "30.00"), refund(10, "20.00")]));

    expect(report).toMatchObject({ refundsInserted: 1 });
    expect((await ledger()).map((row) => [row.shopifyRefundId, row.amount])).toEqual([
      ["", "100.00"],
      ["gid://shopify/Refund/10", "20.00"],
      ["gid://shopify/Refund/9", "30.00"],
    ]);
  });

  it("should refuse a second copy of a refund row", async () => {
    const [existing] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.shopifyStoreId, storeId), eq(transactions.shopifyRefundId, "gid://shopify/Refund/9")));
    const { id: _id, ...copy } = existing;

    // Drizzle wraps the driver's error; the duplicate key is the cause.
    await expect(db.insert(transactions).values(copy)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "ER_DUP_ENTRY", message: expect.stringMatching(/uq_txn_shopify_record/) }),
    });
  });

  it("should restate an order stored net of its refunds at its total before them", async () => {
    // As the previous release stored it: the total after the refunds.
    await db
      .update(transactions)
      .set({ amount: "50.00" })
      .where(and(eq(transactions.shopifyStoreId, storeId), eq(transactions.shopifyRefundId, "")));

    const report = await sync(order("2026-09-23T08:00:00.000Z", [refund(9, "30.00"), refund(10, "20.00")]));

    expect(report).toMatchObject({ updated: 1, refundsInserted: 0, refundsUpdated: 0 });
    expect((await ledger())[0]).toMatchObject({ shopifyRefundId: "", amount: "100.00" });
  });
});
