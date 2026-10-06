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
import { channels, exceptions, transactions, uploadBatches, users } from "../../../drizzle/schema";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { shopifySettlementEvidenceChannelCode } from "./channelCodes";
import type { NormalizedShopifyOrder, NormalizedShopifyRefund } from "./orders";
import { importShopifySettlementEvidence } from "./settlementEvidence";
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
const order = (updatedAt: string, refunds: NormalizedShopifyRefund[], gid = GID): NormalizedShopifyOrder => ({
  gid,
  name: `#${gid.split("/").pop()}`,
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
    await db.delete(exceptions).where(eq(exceptions.organizationId, organizationId));
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
  describe("when the gateway's lines were imported before Shopify synced the order", () => {
    const LATE = "gid://shopify/Order/5550002";
    const QUIET = "gid://shopify/Order/5550003";
    const statusOf = async (gid: string) =>
      (
        await db
          .select({ channelId: transactions.channelId, amount: transactions.amount, status: transactions.status })
          .from(transactions)
          .where(and(eq(transactions.organizationId, organizationId), eq(transactions.transactionRef, gid)))
          .orderBy(asc(transactions.channelId), asc(transactions.amount))
      ).map((row) => [row.amount, row.status]);

    it("should match the order and its refund to the evidence waiting for them", async () => {
      // The evidence import's channel and rows, as it writes them, before the sync.
      const [channel] = await db.insert(channels).values({
        organizationId,
        name: "Settlement Evidence — test",
        code: shopifySettlementEvidenceChannelCode(storeId),
        channelType: "ecommerce_gateway",
        country: "GLB",
        defaultCurrency: "USD",
        isActive: true,
      });
      const evidenceChannelId = (channel as { insertId: number }).insertId;
      const line = (amount: string, debitCredit: "credit" | "debit", settledOn: string) => ({
        batchId: 1,
        channelId: evidenceChannelId,
        userId: 1,
        organizationId,
        transactionRef: LATE,
        amount,
        currency: "USD",
        // Settled a week after the refund: outside any three-day window.
        transactionDate: new Date(settledOn),
        debitCredit,
        isReversal: debitCredit === "debit",
        status: "unmatched" as const,
      });
      await db.insert(transactions).values([line("100.00", "credit", "2026-09-27"), line("15.00", "debit", "2026-09-28")]);

      const report = await sync(order("2026-09-21T10:00:00.000Z", [refund(31, "15.00")], LATE));

      expect(report.evidenceMatched).toBe(2);
      // Evidence rows first (higher channel id is the evidence channel).
      expect((await statusOf(LATE)).every(([, status]) => status === "matched")).toBe(true);
      expect(await statusOf(LATE)).toHaveLength(4);
    });

    it("should match the waiting payment but not flag a refund whose line has not arrived", async () => {
      const PARTIAL = "gid://shopify/Order/5550004";
      const [channel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.organizationId, organizationId), eq(channels.code, shopifySettlementEvidenceChannelCode(storeId))));
      await db.insert(transactions).values({
        batchId: 1,
        channelId: channel.id,
        userId: 1,
        organizationId,
        transactionRef: PARTIAL,
        amount: "100.00",
        currency: "USD",
        transactionDate: new Date("2026-09-22"),
        debitCredit: "credit",
        status: "unmatched",
      });

      const report = await sync(order("2026-09-25T10:00:00.000Z", [refund(51, "20.00")], PARTIAL));

      expect(report.evidenceMatched).toBe(1);
      expect(await statusOf(PARTIAL)).toEqual([
        ["20.00", "unmatched"],
        ["100.00", "matched"],
        ["100.00", "matched"],
      ]);
    });

    it("should leave an order with no evidence yet untouched, and flag nothing", async () => {
      const report = await sync(order("2026-09-21T11:00:00.000Z", [refund(41, "5.00")], QUIET));

      expect(report).toMatchObject({ inserted: 1, refundsInserted: 1, evidenceMatched: 0 });
      expect(await statusOf(QUIET)).toEqual([
        ["5.00", "unmatched"],
        ["100.00", "unmatched"],
      ]);
      const flagged = await db
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(eq(exceptions.organizationId, organizationId));
      expect(flagged).toEqual([]);
    });
  });
  describe("when a refund's settlement never arrives", () => {
    const OVERDUE = "gid://shopify/Order/5550005";
    // The import, as App Home calls it, with the file already parsed.
    const importFile = (lines: Array<{ order: string; amount: string; date: string }>) =>
      importShopifySettlementEvidence(
        {
          storeId,
          organizationId,
          shopDomain: `refund-sync-${organizationId}.myshopify.com`,
          displayName: "Refund sync test",
          currency: "USD",
          shopifyUserId: "staff-1",
        },
        { fileName: "settlement.csv", content: "x", contentEncoding: "utf8", sourceLabel: "Gateway", dryRun: false },
        db as never,
        {
          parseFile: async () => ({
            headers: ["order_number", "settled_amount", "settlement_date"],
            rows: lines.map((line) => ({ order_number: line.order, settled_amount: line.amount, settlement_date: line.date })),
            parseErrors: [],
          }),
          auditCommitted: async () => undefined,
        },
      );
    const refundFlags = async (gid = OVERDUE, refundId = "gid://shopify/Refund/61") => {
      const [refundRow] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.transactionRef, gid), eq(transactions.shopifyRefundId, refundId)));
      return db
        .select({ subCategory: exceptions.subCategory })
        .from(exceptions)
        .where(and(eq(exceptions.organizationId, organizationId), eq(exceptions.transactionId, refundRow.id)));
    };

    it("should hold the alert while the refund may still settle in the next file", async () => {
      await sync(order("2026-09-21T10:00:00.000Z", [refund(61, "10.00")], OVERDUE));
      // The order's payment settles; the refund made the day before does not appear.
      await importFile([{ order: "#5550005", amount: "100.00", date: "2026-09-22" }]);

      expect(await refundFlags()).toEqual([]);
    });

    it("should flag it once a later file covers past its grace period, though that file names another order", async () => {
      await importFile([{ order: "#5550002", amount: "7.00", date: "2026-10-05" }]);

      expect(await refundFlags()).toEqual([{ subCategory: "retail_refund_not_settled" }]);
      // So is the earlier order whose payment was evidenced but whose refund line never came…
      expect(await refundFlags("gid://shopify/Order/5550004", "gid://shopify/Refund/51")).toEqual([
        { subCategory: "retail_refund_not_settled" },
      ]);
      // …but not a refund of an order with no evidence on file: it may be paid elsewhere.
      expect(await refundFlags("gid://shopify/Order/5550003", "gid://shopify/Refund/41")).toEqual([]);
    });

    it("should not flag it again", async () => {
      await importFile([{ order: "#5550002", amount: "8.00", date: "2026-10-12" }]);

      expect(await refundFlags()).toHaveLength(1);
    });
  });
});
