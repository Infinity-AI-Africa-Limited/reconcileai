import { and, count, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { channels, exceptions, organizations, transactions } from "../../../drizzle/schema";
import { shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import { SHOPIFY_CASE_CATEGORIES, SHOPIFY_CASE_PAGE_SIZE, SHOPIFY_CASE_SEVERITIES, shopifyCaseDetailInput, shopifyCaseListInput, type ShopifyCase, type ShopifyCaseListRequest, type ShopifyCasePage } from "../../../shared/shopifyAppHomeCases";
import type { getDb } from "../../db";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import { shopifyOrdersChannelCode, shopifySettlementEvidenceChannelCode } from "./channelCodes";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export class ShopifyCaseReadError extends Error {
  constructor(public readonly code: "not_found" | "unavailable") { super(code); }
}

/** Only reads, in one repeatable-read snapshot; no channel creation or job join. */
async function ownership(tx: Tx, context: ShopifyEmbeddedContext): Promise<{ predicate: SQL; settlement: number | undefined }> {
  // Authentication's lookup predates this transaction. Recheck the exact signed
  // shop binding and ALL lifecycle/privacy fences before reading case evidence.
  const [active] = await tx.select({ active: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .innerJoin(organizations, eq(organizations.id, shopifyConnectorStores.organizationId))
    .where(and(
      eq(shopifyConnectorStores.id, context.storeId),
      eq(shopifyConnectorStores.organizationId, context.organizationId),
      eq(shopifyConnectorStores.shopDomain, context.shopDomain),
      eq(shopifyConnectorStores.status, "active"),
      eq(shopifyConnectorStores.privacyRedactionState, "active"),
      eq(organizations.id, context.organizationId),
      eq(organizations.isActive, true),
      eq(organizations.deletionState, "active"),
    )).limit(1);
  if (!active) throw new ShopifyCaseReadError("unavailable");
  const ordersCode = shopifyOrdersChannelCode(context.storeId);
  const settlementCode = shopifySettlementEvidenceChannelCode(context.storeId);
  const resolved = await tx.select({ id: channels.id, code: channels.code }).from(channels)
    .where(and(eq(channels.organizationId, context.organizationId), inArray(channels.code, [ordersCode, settlementCode]))).limit(2);
  const orders = resolved.find(row => row.code === ordersCode)?.id;
  const settlement = resolved.find(row => row.code === settlementCode)?.id;
  // Absent channels produce FALSE, never an omitted predicate or tenant fallback.
  return { settlement, predicate: and(
    eq(exceptions.organizationId, context.organizationId),
    eq(transactions.organizationId, context.organizationId),
    or(
      orders === undefined ? sql`false` : and(eq(transactions.channelId, orders), eq(transactions.shopifyStoreId, context.storeId)),
      settlement === undefined ? sql`false` : eq(transactions.channelId, settlement),
    ),
  )! };
}

const projection = (settlement: number | undefined) => ({
  caseId: exceptions.id, category: exceptions.category, severity: exceptions.severity,
  status: exceptions.status, createdAt: exceptions.createdAt,
  amount: transactions.amount, currency: transactions.currency, evidenceDate: transactions.transactionDate,
  // Derive a static source code IN SQL: no refund GID or channel ID leaves the query.
  sourceKind: sql<ShopifyCase["sourceKind"]>`case when ${settlement === undefined ? sql`false` : eq(transactions.channelId, settlement)} then 'merchant_settlement' when ${transactions.shopifyRefundId} <> '' then 'shopify_refund' else 'shopify_order' end`,
});
type Row = Omit<ShopifyCase, "createdAt" | "evidenceDate"> & { createdAt: Date; evidenceDate: Date };
function dto(row: Row): ShopifyCase {
  // Defense in depth against corrupt enums/decimal data. No raw field is spread.
  if (!Number.isSafeInteger(row.caseId) || row.caseId <= 0 ||
      !SHOPIFY_CASE_CATEGORIES.includes(row.category) || !SHOPIFY_CASE_SEVERITIES.includes(row.severity) ||
      !["open", "in_review", "escalated", "resolved", "dismissed"].includes(row.status) ||
      !["shopify_order", "shopify_refund", "merchant_settlement"].includes(row.sourceKind) ||
      typeof row.amount !== "string" || !/^-?\d{1,16}\.\d{2}$/.test(row.amount) ||
      !/^[A-Z]{3}$/.test(row.currency)) throw new ShopifyCaseReadError("unavailable");
  return { caseId: row.caseId, category: row.category, severity: row.severity, status: row.status,
    createdAt: row.createdAt.toISOString(), amount: row.amount, currency: row.currency,
    evidenceDate: row.evidenceDate.toISOString(), sourceKind: row.sourceKind };
}

async function read<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try { return await db.transaction(fn, { isolationLevel: "repeatable read" }); }
  catch (error) {
    if (error instanceof ShopifyCaseReadError) throw error;
    // Never retain/log operational errors or convert an outage to an empty list.
    throw new ShopifyCaseReadError("unavailable");
  }
}
export async function listShopifyCases(db: Db, context: ShopifyEmbeddedContext, request?: ShopifyCaseListRequest): Promise<ShopifyCasePage> {
  const input = shopifyCaseListInput.parse(request);
  return read(db, async tx => {
    const scope = await ownership(tx, context);
    const predicate = and(scope.predicate, input.status === "all" ? undefined : input.status === "unresolved"
      ? and(ne(exceptions.status, "resolved"), ne(exceptions.status, "dismissed")) : eq(exceptions.status, input.status));
    const [{ total }] = await tx.select({ total: count() }).from(exceptions)
      .innerJoin(transactions, eq(transactions.id, exceptions.transactionId)).where(predicate);
    const rows = await tx.select(projection(scope.settlement)).from(exceptions)
      .innerJoin(transactions, eq(transactions.id, exceptions.transactionId)).where(predicate)
      .orderBy(desc(exceptions.createdAt), desc(exceptions.id)).limit(SHOPIFY_CASE_PAGE_SIZE)
      .offset((input.page - 1) * SHOPIFY_CASE_PAGE_SIZE);
    return { cases: rows.map(dto), total, page: input.page, pageSize: SHOPIFY_CASE_PAGE_SIZE };
  });
}
export async function detailShopifyCase(db: Db, context: ShopifyEmbeddedContext, caseId: number): Promise<ShopifyCase> {
  shopifyCaseDetailInput.parse({ caseId });
  return read(db, async tx => {
    const scope = await ownership(tx, context);
    const [row] = await tx.select(projection(scope.settlement)).from(exceptions)
      .innerJoin(transactions, eq(transactions.id, exceptions.transactionId))
      .where(and(scope.predicate, eq(exceptions.id, caseId))).limit(1);
    if (!row) throw new ShopifyCaseReadError("not_found");
    return dto(row);
  });
}
