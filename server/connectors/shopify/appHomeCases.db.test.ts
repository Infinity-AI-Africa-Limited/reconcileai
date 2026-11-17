/**
 * Actual MySQL execution of the embedded case reader's Drizzle predicates.
 * Opt-in ONLY for the existing isolated validation database at the numerical
 * loopback endpoint below. No router, boot services, ingestion, or external API.
 *
 * Setup commits one synthetic fixture transaction so the service can open its
 * own real repeatable-read transactions (not a mock or nested-tx substitute).
 * afterAll deletes only recorded fixture IDs, in dependency order, in another
 * transaction, and closes only this suite's root database pool.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channels, exceptions, organizations, transactions } from "../../../drizzle/schema";
import { shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import type { ShopifyCase } from "../../../shared/shopifyAppHomeCases";
import { detailShopifyCase, listShopifyCases } from "./appHomeCases";
import { shopifyOrdersChannelCode, shopifySettlementEvidenceChannelCode } from "./channelCodes";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";

// Inspect only the supplied URL at test collection, never dotenv or a fallback.
// Numeric loopback avoids DNS; reject query options that could override the URI.
function isValidationTarget(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "mysql:" && parsed.hostname === "127.0.0.1" &&
      parsed.port === "3415" && parsed.pathname === "/shopify_embedded_validation" &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}
const url = process.env.DATABASE_URL;
const validationDatabase = isValidationTarget(url);
type Db = Parameters<typeof listShopifyCases>[0];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type StoreInsert = typeof shopifyConnectorStores.$inferInsert;
type OrgInsert = typeof organizations.$inferInsert;
type TransactionInsert = typeof transactions.$inferInsert;
type ExceptionInsert = typeof exceptions.$inferInsert;
const AT = new Date("2001-02-03T04:05:06.000Z");
const PRIMARY_AMOUNT = "9999999999999999.99";
const PRIVATE_MARKER = "SYNTHETIC_NOT_FOR_EMBEDDED_DTO";
const DTO_KEYS = ["caseId", "category", "severity", "status", "createdAt", "amount", "currency", "evidenceDate", "sourceKind"].sort();

interface StoreFixture {
  context: ShopifyEmbeddedContext;
  ordersChannelId: number;
  settlementChannelId: number;
}
interface Fixture {
  organizationIds: number[];
  storeIds: number[];
  channelIds: number[];
  transactionIds: number[];
  exceptionIds: number[];
  a: StoreFixture;
  b: StoreFixture;
  foreign: StoreFixture;
  order: number;
  refund: number;
  settlement: number;
  resolved: number;
  dismissed: number;
  bOrder: number;
  bSettlement: number;
  foreignOrder: number;
  foreignSettlement: number;
  excludedFromA: number[];
}

describe.runIf(validationDatabase)("when embedded case reads execute on isolated validation MySQL", () => {
  let pool: Pool;
  let db: Db;
  let fixture: Fixture | undefined;
  const nonce = randomUUID().replace(/-/g, "");
  let sequence = 0;
  const label = () => `${nonce}-${++sequence}`;

  async function insertId(result: Promise<unknown>): Promise<number> {
    const id = Number((await result as [{ insertId: number }])[0].insertId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("synthetic_fixture_insert_failed");
    return id;
  }

  async function seed(tx: Tx): Promise<Fixture> {
    const organizationIds: number[] = [];
    const storeIds: number[] = [];
    const channelIds: number[] = [];
    const transactionIds: number[] = [];
    const exceptionIds: number[] = [];
    for (const name of ["same-org", "foreign-org"]) {
      organizationIds.push(await insertId(tx.insert(organizations).values({
        name: `Synthetic embedded SQL ${name} ${nonce}`,
        code: `ECASE_${name}_${nonce}`.slice(0, 50),
        segment: "retail_commerce", onboardingChannel: "shopify_public_app",
        isDemo: true, aiAssistanceEnabled: false, isActive: true, deletionState: "active",
      })));
    }

    async function store(organizationId: number): Promise<StoreFixture> {
      const tag = label();
      const shopDomain = `embedded-sql-${tag}.myshopify.com`;
      const storeId = await insertId(tx.insert(shopifyConnectorStores).values({
        organizationId, shopDomain, shopId: `synthetic-${tag}`,
        displayName: "Synthetic SQL fixture store", currency: "USD",
        grantedScopes: "read_orders", requestedScopes: "read_orders",
        status: "active", privacyRedactionState: "active",
      }));
      storeIds.push(storeId);
      const ids: number[] = [];
      for (const code of [shopifyOrdersChannelCode(storeId), shopifySettlementEvidenceChannelCode(storeId)]) {
        const id = await insertId(tx.insert(channels).values({
          organizationId, name: "Synthetic embedded SQL evidence", code,
          channelType: "ecommerce_gateway", defaultCurrency: "USD", isActive: true,
        }));
        channelIds.push(id);
        ids.push(id);
      }
      return {
        context: { storeId, organizationId, shopDomain, displayName: "Synthetic SQL fixture store", currency: "USD", shopifyUserId: "synthetic-staff" },
        ordersChannelId: ids[0], settlementChannelId: ids[1],
      };
    }
    const a = await store(organizationIds[0]);
    const b = await store(organizationIds[0]);
    const foreign = await store(organizationIds[1]);
    const unrelatedChannelId = await insertId(tx.insert(channels).values({
      organizationId: a.context.organizationId, name: "Synthetic unrelated channel",
      code: `ecase_other_${nonce}`, channelType: "bank_transfer",
    }));
    channelIds.push(unrelatedChannelId);

    async function evidence(owner: StoreFixture, patch: Partial<TransactionInsert> = {}): Promise<number> {
      const id = await insertId(tx.insert(transactions).values({
        organizationId: owner.context.organizationId,
        // Deliberately no users, upload batches or reconciliation jobs are seeded.
        // These required legacy scalar IDs have no schema FK and grant no scope.
        userId: 0, batchId: 0, channelId: owner.ordersChannelId,
        shopifyStoreId: owner.context.storeId, transactionRef: `synthetic-${label()}`,
        shopifyRefundId: "", amount: "100.00", currency: "USD",
        transactionDate: AT, debitCredit: "credit", status: "exception", createdAt: AT,
        description: PRIVATE_MARKER, counterparty: PRIVATE_MARKER,
        rawData: { syntheticOnly: PRIVATE_MARKER }, ...patch,
      }));
      transactionIds.push(id);
      return id;
    }
    async function caseFor(transactionId: number, organizationId: number, patch: Partial<ExceptionInsert> = {}): Promise<number> {
      const id = await insertId(tx.insert(exceptions).values({
        organizationId, transactionId, jobId: 0, category: "amount_mismatch",
        severity: "high", status: "open", createdAt: AT,
        // Deliberately differs from primary currency: the reader must use USD.
        currency: "EUR", description: PRIVATE_MARKER, aiAnalysis: PRIVATE_MARKER,
        subCategory: PRIVATE_MARKER, ...patch,
      }));
      exceptionIds.push(id);
      return id;
    }
    const aOrg = a.context.organizationId;
    const orderTransaction = await evidence(a, { amount: PRIMARY_AMOUNT });
    const order = await caseFor(orderTransaction, aOrg);
    const refund = await caseFor(await evidence(a, {
      shopifyRefundId: "gid://shopify/Refund/5550000001", amount: "30.00", debitCredit: "debit", isReversal: true,
    }), aOrg, { status: "in_review", category: "reversal_unmatched" });
    const settlement = await caseFor(await evidence(a, {
      channelId: a.settlementChannelId, shopifyStoreId: null, amount: "110.00",
    }), aOrg, { status: "escalated" });
    const resolved = await caseFor(await evidence(a), aOrg, { status: "resolved" });
    const dismissed = await caseFor(await evidence(a), aOrg, { status: "dismissed" });
    const bOrder = await caseFor(await evidence(b), aOrg);
    const bSettlement = await caseFor(await evidence(b, { channelId: b.settlementChannelId, shopifyStoreId: null }), aOrg);
    const foreignOrder = await caseFor(await evidence(foreign), foreign.context.organizationId);
    const foreignSettlement = await caseFor(await evidence(foreign, {
      channelId: foreign.settlementChannelId, shopifyStoreId: null,
    }), foreign.context.organizationId);

    const excludedFromA = [bOrder, bSettlement, foreignOrder, foreignSettlement];
    // Both halves of the exact orders-channel AND exact-store conjunction.
    for (const patch of [
      { shopifyStoreId: b.context.storeId },
      { channelId: b.ordersChannelId },
      { shopifyStoreId: null },
      { channelId: unrelatedChannelId },
      { channelId: foreign.ordersChannelId },
      { channelId: foreign.settlementChannelId, shopifyStoreId: null },
    ] satisfies Partial<TransactionInsert>[]) {
      excludedFromA.push(await caseFor(await evidence(a, patch), aOrg));
    }
    // Correct channel/store is insufficient when the primary tenant is foreign.
    excludedFromA.push(await caseFor(await evidence(a, { organizationId: foreign.context.organizationId }), aOrg));
    // Correct primary tenant is insufficient when the exception tenant is foreign.
    excludedFromA.push(await caseFor(orderTransaction, foreign.context.organizationId));
    // Orphaned primary evidence cannot derive ownership; never substitutes job scope.
    excludedFromA.push(await caseFor(0, aOrg));
    return { organizationIds, storeIds, channelIds, transactionIds, exceptionIds,
      a, b, foreign, order, refund, settlement, resolved, dismissed,
      bOrder, bSettlement, foreignOrder, foreignSettlement, excludedFromA };
  }

  beforeAll(async () => {
    // Defense in depth immediately before opening the pool; no root getDb cache.
    if (!isValidationTarget(url)) throw new Error("isolated_validation_target_required");
    const { createAppPool } = await import("../../dbSession");
    const rootPool = createAppPool(url!);
    pool = rootPool.promise();
    db = drizzle(rootPool);
    fixture = await db.transaction(seed);
  }, 30_000);

  afterAll(async () => {
    try {
      if (db && fixture) {
        const own = fixture;
        await db.transaction(async tx => {
          await tx.delete(exceptions).where(inArray(exceptions.id, own.exceptionIds));
          await tx.delete(transactions).where(inArray(transactions.id, own.transactionIds));
          await tx.delete(channels).where(inArray(channels.id, own.channelIds));
          await tx.delete(shopifyConnectorStores).where(inArray(shopifyConnectorStores.id, own.storeIds));
          await tx.delete(organizations).where(inArray(organizations.id, own.organizationIds));
        });
      }
    } finally {
      await pool?.end();
    }
  }, 30_000);

  function own(): Fixture {
    if (!fixture) throw new Error("synthetic_fixture_missing");
    return fixture;
  }
  const ids = (cases: ShopifyCase[]) => cases.map(row => row.caseId).sort((a, b) => a - b);

  it("should isolate rows AND SQL counts between same-org stores A/B and a foreign org", async () => {
    const f = own();
    const a = await listShopifyCases(db, f.a.context);
    expect(a).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    // All timestamps tie, so the actual engine must apply descending case ID.
    expect(a.cases.map(row => row.caseId)).toEqual([f.settlement, f.refund, f.order]);
    expect(a.cases.map(row => row.sourceKind)).toEqual(["merchant_settlement", "shopify_refund", "shopify_order"]);
    const b = await listShopifyCases(db, f.b.context);
    expect(b.total).toBe(2);
    expect(ids(b.cases)).toEqual([f.bOrder, f.bSettlement].sort((a, b) => a - b));
    const foreign = await listShopifyCases(db, f.foreign.context);
    expect(foreign.total).toBe(2);
    expect(ids(foreign.cases)).toEqual([f.foreignOrder, f.foreignSettlement].sort((a, b) => a - b));
  });

  it("should execute exact order/store/channel and settlement-channel scope for detail, never job scope", async () => {
    const f = own();
    for (const caseId of f.excludedFromA) {
      await expect(detailShopifyCase(db, f.a.context, caseId)).rejects.toMatchObject({ code: "not_found", message: "not_found" });
    }
    await expect(detailShopifyCase(db, f.b.context, f.order)).rejects.toMatchObject({ code: "not_found" });
    await expect(detailShopifyCase(db, f.foreign.context, f.settlement)).rejects.toMatchObject({ code: "not_found" });
    const [inline] = await db.select({ jobId: exceptions.jobId }).from(exceptions).where(eq(exceptions.id, f.refund));
    expect(inline.jobId).toBe(0);
    expect(await detailShopifyCase(db, f.a.context, f.refund)).toMatchObject({ caseId: f.refund, sourceKind: "shopify_refund", amount: "30.00" });
    // NULL shopifyStoreId is legitimate ONLY on the exact resolved settlement leg.
    expect(await detailShopifyCase(db, f.a.context, f.settlement)).toMatchObject({ sourceKind: "merchant_settlement", amount: "110.00" });
  });

  it("should count unresolved open/in_review/escalated, exclude terminal states, and retain historical evidence", async () => {
    const f = own();
    for (const [status, caseId] of [
      ["open", f.order], ["in_review", f.refund], ["escalated", f.settlement],
      ["resolved", f.resolved], ["dismissed", f.dismissed],
    ] as const) {
      const result = await listShopifyCases(db, f.a.context, { status });
      expect(result.total).toBe(1);
      expect(result.cases.map(row => row.caseId)).toEqual([caseId]);
      expect(result.cases[0].evidenceDate).toBe(AT.toISOString());
    }
    const all = await listShopifyCases(db, f.a.context, { status: "all" });
    expect(all.total).toBe(5);
    expect(ids(all.cases)).toEqual([f.order, f.refund, f.settlement, f.resolved, f.dismissed].sort((a, b) => a - b));
    const second = await listShopifyCases(db, f.a.context, { page: 2 });
    expect(second).toEqual({ cases: [], total: 3, page: 2, pageSize: 20 });
  });

  it("should return primary DECIMAL as an exact string and only the DTO allow-list from actual SQL", async () => {
    const f = own();
    const detail = await detailShopifyCase(db, f.a.context, f.order);
    expect(detail.amount).toBe(PRIMARY_AMOUNT);
    expect(typeof detail.amount).toBe("string");
    expect(detail.currency).toBe("USD");
    expect(detail.createdAt).toBe(AT.toISOString());
    expect(detail.evidenceDate).toBe(AT.toISOString());
    expect(Object.keys(detail).sort()).toEqual(DTO_KEYS);
    const page = await listShopifyCases(db, f.a.context);
    expect(page.cases.find(row => row.caseId === f.order)).toEqual(detail);
    for (const row of page.cases) expect(Object.keys(row).sort()).toEqual(DTO_KEYS);
    expect(JSON.stringify({ detail, page })).not.toMatch(/SYNTHETIC_NOT_FOR_EMBEDDED_DTO|gid:\/\/|organizationId|storeId|channelId|jobId|userId|rawData|aiAnalysis|transactionRef|subCategory/);
  });

  it("should fail each missing/foreign same-code channel leg closed, without widening list, count or detail", async () => {
    const f = own();
    // channels.code is globally unique: move only this fixture's existing exact
    // code to the foreign org rather than fabricate an impossible duplicate.
    for (const moved of [[f.a.ordersChannelId], [f.a.settlementChannelId], [f.a.ordersChannelId, f.a.settlementChannelId]]) {
      try {
        await db.transaction(async tx => {
          await tx.update(channels).set({ organizationId: f.foreign.context.organizationId }).where(inArray(channels.id, moved));
        });
        const result = await listShopifyCases(db, f.a.context);
        const expected = moved.length === 2 ? [] : moved[0] === f.a.ordersChannelId ? [f.settlement] : [f.order, f.refund];
        expect(result.total).toBe(expected.length);
        expect(ids(result.cases)).toEqual(expected.sort((a, b) => a - b));
        for (const caseId of moved.includes(f.a.ordersChannelId) ? [f.order, f.refund] : []) {
          await expect(detailShopifyCase(db, f.a.context, caseId)).rejects.toMatchObject({ code: "not_found" });
        }
        if (moved.includes(f.a.settlementChannelId)) {
          await expect(detailShopifyCase(db, f.a.context, f.settlement)).rejects.toMatchObject({ code: "not_found" });
        }
      } finally {
        await db.transaction(async tx => {
          await tx.update(channels).set({ organizationId: f.a.context.organizationId }).where(inArray(channels.id, moved));
        });
      }
    }
    expect((await listShopifyCases(db, f.a.context)).total).toBe(3);
  });

  const fences: { name: string; store?: Partial<StoreInsert>; organization?: Partial<OrgInsert> }[] = [
    { name: "pending claim", store: { status: "pending_claim" } },
    { name: "reauthorization", store: { status: "reauthorization_required" } },
    { name: "uninstalled", store: { status: "uninstalled" } },
    { name: "shop redacting", store: { status: "redacting" } },
    { name: "customer privacy fence", store: { privacyRedactionState: "customer_redacting" } },
    { name: "organization disabled", organization: { isActive: false } },
    { name: "organization deletion fence", organization: { deletionState: "redacting" } },
    { name: "signed shop binding changed", store: { shopDomain: `changed-${nonce}.myshopify.com` } },
  ];
  it.each(fences)("should recheck $name after the verified context was captured, before list AND detail", async fence => {
    const f = own();
    const context = f.a.context;
    // A successful read precedes the committed lifecycle change; reuse exactly
    // the same stale-auth context, not a fresh lookup that could mask the recheck.
    expect((await detailShopifyCase(db, context, f.order)).caseId).toBe(f.order);
    try {
      await db.transaction(async tx => {
        if (fence.store) await tx.update(shopifyConnectorStores).set(fence.store).where(eq(shopifyConnectorStores.id, context.storeId));
        if (fence.organization) await tx.update(organizations).set(fence.organization).where(eq(organizations.id, context.organizationId));
      });
      await expect(listShopifyCases(db, context)).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
      await expect(detailShopifyCase(db, context, f.order)).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    } finally {
      await db.transaction(async tx => {
        await tx.update(shopifyConnectorStores).set({ status: "active", privacyRedactionState: "active", shopDomain: context.shopDomain })
          .where(eq(shopifyConnectorStores.id, context.storeId));
        await tx.update(organizations).set({ isActive: true, deletionState: "active" }).where(eq(organizations.id, context.organizationId));
      });
    }
    expect((await listShopifyCases(db, context)).total).toBe(3);
  });

  it("should recheck exact organization binding when only this fixture's store is rebound", async () => {
    const f = own();
    try {
      await db.transaction(async tx => {
        await tx.update(shopifyConnectorStores).set({ organizationId: f.foreign.context.organizationId }).where(eq(shopifyConnectorStores.id, f.a.context.storeId));
      });
      await expect(listShopifyCases(db, f.a.context)).rejects.toMatchObject({ code: "unavailable" });
      await expect(detailShopifyCase(db, f.a.context, f.order)).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await db.transaction(async tx => {
        await tx.update(shopifyConnectorStores).set({ organizationId: f.a.context.organizationId }).where(eq(shopifyConnectorStores.id, f.a.context.storeId));
      });
    }
    expect((await listShopifyCases(db, f.a.context)).total).toBe(3);
  });
});
