import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { channels, matches, transactions, uploadBatches, users, type InsertTransaction } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifySyncCursors,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { getDb, type DbExecutor } from "../../db";
import { toShopifyOrderTransaction } from "./ingest";
import {
  ShopifyOrderApiError,
  computeShopifyOrderWindow,
  fetchShopifyOrdersWindow,
  type NormalizedShopifyOrder,
} from "./orders";
import { affectedRows } from "./tokenStore";

const ORDER_RESOURCE = "orders" as const;
const TRANSACTION_LOOKUP_CHUNK = 500;

export type ShopifyOrderSyncTrigger = "manual" | "webhook" | "backstop";

export interface ShopifyOrderSyncReport {
  success: boolean;
  organizationId: number;
  storeId: number;
  window: { from: Date; to: Date };
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  batchId: number | null;
  errorCode?: string;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyOrderSyncDeps {
  db?: Db;
  now?: () => Date;
  fetchOrders?: typeof fetchShopifyOrdersWindow;
}

export function shopifyOrdersChannelCode(storeId: number): string {
  return `shopify_orders_${storeId}`;
}

interface ExistingOrderRow {
  id: number;
  transactionRef: string | null;
  shopifyUpdatedAt: Date | null;
  amount?: string | null;
  currency?: string | null;
  transactionDate?: Date | null;
  valueDate?: Date | null;
  shopifyOrderCurrency?: string | null;
  shopifyFinancialStatus?: string | null;
  shopifyCancelledAt?: Date | null;
  status?: string;
  matchId?: number | null;
}

/**
 * Partition fetched orders into inserts, monotonic updates, and exact/older
 * replays. It is pure so idempotency and late-event handling are DB-free tests.
 */
export function partitionShopifyOrders(
  orders: NormalizedShopifyOrder[],
  existing: ExistingOrderRow[],
): {
  inserts: NormalizedShopifyOrder[];
  updates: Array<{ transactionId: number; order: NormalizedShopifyOrder }>;
  unchanged: number;
} {
  const byGid = new Map(
    existing
      .filter((row): row is ExistingOrderRow & { transactionRef: string } => Boolean(row.transactionRef))
      .map((row) => [row.transactionRef, row]),
  );
  const inserts: NormalizedShopifyOrder[] = [];
  const updates: Array<{ transactionId: number; order: NormalizedShopifyOrder }> = [];
  let unchanged = 0;
  for (const order of orders) {
    const row = byGid.get(order.gid);
    if (!row) {
      inserts.push(order);
    } else if (!row.shopifyUpdatedAt || new Date(order.updatedAt) > row.shopifyUpdatedAt) {
      updates.push({ transactionId: row.id, order });
    } else {
      unchanged += 1;
    }
  }
  return { inserts, updates, unchanged };
}

export class ShopifyActorUnavailableError extends Error {
  constructor() {
    super("Shopify store has no authorised sync actor: active tenant administrator unavailable");
    this.name = "ShopifyActorUnavailableError";
  }
}

export async function resolveAuthorizedShopifyActor(
  db: DbExecutor,
  store: { id: number; organizationId: number; claimedByUserId: number | null },
): Promise<number> {
  if (store.claimedByUserId) {
    const [claimant] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, store.claimedByUserId),
          eq(users.organizationId, store.organizationId),
          eq(users.role, "admin"),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    if (claimant) return claimant.id;
  }

  // Store ownership remains tenant-bound even if its original claimant is later
  // deactivated. The deterministic fallback is another active administrator of
  // that SAME tenant; no ordinary role and no cross-tenant super-admin is valid.
  const [fallback] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, store.organizationId),
        eq(users.role, "admin"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.id)
    .limit(1);
  if (!fallback) throw new ShopifyActorUnavailableError();
  return fallback.id;
}

async function resolveOrdersChannel(
  db: DbExecutor,
  store: { id: number; organizationId: number; displayName: string; currency: string | null },
): Promise<number> {
  const code = shopifyOrdersChannelCode(store.id);
  const [existing] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organizationId, store.organizationId), eq(channels.code, code)))
    .limit(1);
  if (existing) return existing.id;

  // The code embeds the internal store id and channels.code is globally unique,
  // so concurrent provisioners converge. Re-read after the upsert rather than
  // trusting insertId, which is 0 on a duplicate update.
  await db
    .insert(channels)
    .values({
      organizationId: store.organizationId,
      name: `Shopify Orders — ${store.displayName}`.slice(0, 100),
      code,
      description: "Field-minimised Shopify financial order data",
      channelType: "ecommerce_gateway",
      country: "GLB",
      defaultCurrency: (store.currency ?? "USD").slice(0, 3),
      matchingConfig: {
        provider: "shopify",
        resource: "orders",
        refFormat: "shopify_order_gid",
        readOnly: true,
      },
      isActive: true,
    })
    .onDuplicateKeyUpdate({ set: { code: sql`${channels.code}` } });
  const [created] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organizationId, store.organizationId), eq(channels.code, code)))
    .limit(1);
  if (!created) throw new Error("Could not provision Shopify orders channel");
  return created.id;
}

async function loadExistingOrders(
  db: DbExecutor,
  params: { organizationId: number; storeId: number; gids: string[] },
): Promise<ExistingOrderRow[]> {
  const out: ExistingOrderRow[] = [];
  for (let i = 0; i < params.gids.length; i += TRANSACTION_LOOKUP_CHUNK) {
    const chunk = params.gids.slice(i, i + TRANSACTION_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    out.push(
      ...(await db
        .select({
          id: transactions.id,
          transactionRef: transactions.transactionRef,
          shopifyUpdatedAt: transactions.shopifyUpdatedAt,
          amount: transactions.amount,
          currency: transactions.currency,
          transactionDate: transactions.transactionDate,
          valueDate: transactions.valueDate,
          shopifyOrderCurrency: transactions.shopifyOrderCurrency,
          shopifyFinancialStatus: transactions.shopifyFinancialStatus,
          shopifyCancelledAt: transactions.shopifyCancelledAt,
          status: transactions.status,
          matchId: transactions.matchId,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            eq(transactions.shopifyStoreId, params.storeId),
            inArray(transactions.transactionRef, chunk),
          ),
        )
        .for("update")),
    );
  }
  return out;
}

function sameInstant(left: Date | null | undefined, right: string | null): boolean {
  return (left?.getTime() ?? null) === (right === null ? null : new Date(right).getTime());
}

/** Fields that can change whether, or to what, this order reconciles. */
export function materialShopifyOrderEvidenceChanged(
  existing: ExistingOrderRow,
  order: NormalizedShopifyOrder,
): boolean {
  return (
    String(existing.amount) !== order.currentTotalPrice.amount ||
    existing.currency !== order.currentTotalPrice.currencyCode ||
    !sameInstant(existing.transactionDate, order.createdAt) ||
    !sameInstant(existing.valueDate, order.processedAt) ||
    existing.shopifyOrderCurrency !== order.currencyCode ||
    (existing.shopifyFinancialStatus ?? null) !== order.displayFinancialStatus ||
    !sameInstant(existing.shopifyCancelledAt, order.cancelledAt)
  );
}

/**
 * Reopen only the corrected transaction and directly evidenced counterparts.
 * Generic match rows are retained as audit evidence and moved to `rejected`;
 * the legacy reciprocal matchId path is cleared only when it still points back.
 */
async function reopenAffectedReconciliation(
  tx: DbExecutor,
  params: { organizationId: number; transactionId: number; legacyMatchId: number | null },
): Promise<void> {
  const activeMatches = await tx
    .select({
      id: matches.id,
      sourceTransactionId: matches.sourceTransactionId,
      targetTransactionId: matches.targetTransactionId,
    })
    .from(matches)
    .where(
      and(
        eq(matches.organizationId, params.organizationId),
        inArray(matches.status, ["confirmed", "pending_review"]),
        or(
          eq(matches.sourceTransactionId, params.transactionId),
          eq(matches.targetTransactionId, params.transactionId),
        ),
      ),
    );

  const matchRowIds = activeMatches.map((match) => match.id);
  if (matchRowIds.length > 0) {
    await tx
      .update(matches)
      .set({ status: "rejected" })
      .where(
        and(
          eq(matches.organizationId, params.organizationId),
          inArray(matches.id, matchRowIds),
          inArray(matches.status, ["confirmed", "pending_review"]),
        ),
      );
  }

  const genericCounterparts = [
    ...new Set(
      activeMatches
        .map((match) =>
          match.sourceTransactionId === params.transactionId
            ? match.targetTransactionId
            : match.sourceTransactionId,
        )
        .filter((id) => id !== params.transactionId),
    ),
  ];
  if (genericCounterparts.length > 0) {
    await tx
      .update(transactions)
      .set({ status: "unmatched", matchId: null })
      .where(
        and(
          eq(transactions.organizationId, params.organizationId),
          inArray(transactions.id, genericCounterparts),
          inArray(transactions.status, ["matched", "manually_matched", "exception"]),
        ),
      );
  }

  if (params.legacyMatchId && !genericCounterparts.includes(params.legacyMatchId)) {
    await tx
      .update(transactions)
      .set({ status: "unmatched", matchId: null })
      .where(
        and(
          eq(transactions.id, params.legacyMatchId),
          eq(transactions.organizationId, params.organizationId),
          eq(transactions.matchId, params.transactionId),
          inArray(transactions.status, ["matched", "manually_matched"]),
        ),
      );
  }

  await tx
    .update(transactions)
    .set({ status: "unmatched", matchId: null })
    .where(and(eq(transactions.id, params.transactionId), eq(transactions.organizationId, params.organizationId)));
}

function transactionFields(order: NormalizedShopifyOrder) {
  return {
    externalRef: order.name,
    description: `Shopify Order ${order.name}`,
    amount: order.currentTotalPrice.amount,
    currency: order.currentTotalPrice.currencyCode,
    transactionDate: new Date(order.createdAt),
    valueDate: order.processedAt ? new Date(order.processedAt) : null,
    shopifyOrderCurrency: order.currencyCode,
    shopifyUpdatedAt: new Date(order.updatedAt),
    shopifyFinancialStatus: order.displayFinancialStatus,
    shopifyCancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    rawData: null,
  };
}

function maxUpdatedAt(orders: NormalizedShopifyOrder[], fallback: Date): Date {
  return orders.reduce((latest, order) => {
    const updated = new Date(order.updatedAt);
    return updated > latest ? updated : latest;
  }, fallback);
}

function errorCode(error: unknown): string {
  if (error instanceof ShopifyOrderApiError) return error.code.toLowerCase();
  if (error instanceof Error && /authorised sync actor/.test(error.message)) return "sync_actor_unavailable";
  if (error instanceof Error && /not an active member/.test(error.message)) return "sync_actor_invalid";
  return "sync_failed";
}

/**
 * Fetch and persist one tenant-owned store. The store lookup, token call,
 * transaction lookup, writes and cursor update all carry organizationId.
 */
export async function runShopifyOrderSync(
  params: {
    storeId: number;
    organizationId: number;
    trigger: ShopifyOrderSyncTrigger;
    webhookId?: string;
  },
  deps: ShopifyOrderSyncDeps = {},
): Promise<ShopifyOrderSyncReport> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();

  const [store] = await db
    .select({
      id: shopifyConnectorStores.id,
      organizationId: shopifyConnectorStores.organizationId,
      shopDomain: shopifyConnectorStores.shopDomain,
      displayName: shopifyConnectorStores.displayName,
      currency: shopifyConnectorStores.currency,
      claimedByUserId: shopifyConnectorStores.claimedByUserId,
    })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, params.storeId),
        eq(shopifyConnectorStores.organizationId, params.organizationId),
        eq(shopifyConnectorStores.status, "active"),
      ),
    )
    .limit(1);
  if (!store) throw new Error("Shopify store not found for tenant or inactive");

  const [cursor] = await db
    .select()
    .from(shopifySyncCursors)
    .where(
      and(
        eq(shopifySyncCursors.storeId, store.id),
        eq(shopifySyncCursors.organizationId, store.organizationId),
        eq(shopifySyncCursors.resource, ORDER_RESOURCE),
      ),
    )
    .limit(1);
  const window = computeShopifyOrderWindow({ now, watermark: cursor?.watermarkUpdatedAt ?? null });

  try {
    // Prove the actor before fetching protected order data. The actor was created
    // and bound to this tenant during OAuth onboarding; no synthetic user 0.
    const userId = await resolveAuthorizedShopifyActor(db, store);
    const fetched = await (deps.fetchOrders ?? fetchShopifyOrdersWindow)({
      storeId: store.id,
      organizationId: store.organizationId,
      shopDomain: store.shopDomain,
      ...window,
    });

    const result = await db.transaction(async (tx) => {
      const channelId = await resolveOrdersChannel(tx, store);
      const existing = await loadExistingOrders(tx, {
        organizationId: store.organizationId,
        storeId: store.id,
        gids: fetched.map((order) => order.gid),
      });
      const partition = partitionShopifyOrders(fetched, existing);
      const changed = partition.inserts.length + partition.updates.length;
      let batchId: number | null = null;
      let updated = 0;
      let unchanged = partition.unchanged;

      if (changed > 0) {
        const batch = await tx.insert(uploadBatches).values({
          userId,
          channelId,
          organizationId: store.organizationId,
          fileName: `shopify_orders_${store.id}_${window.from.toISOString()}`,
          fileHash: `shopify_orders_${store.id}_${window.from.getTime()}_${window.to.getTime()}`,
          detectedFormat: "shopify_graphql_orders",
          totalRows: fetched.length,
          validRows: changed,
          invalidRows: 0,
          status: "completed",
          completedAt: new Date(),
        });
        batchId = Number((batch as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
        if (!batchId) throw new Error("Could not create Shopify order upload batch");

        const rows: InsertTransaction[] = partition.inserts.map((order) =>
          toShopifyOrderTransaction(order, {
            organizationId: store.organizationId,
            storeId: store.id,
            channelId,
            batchId: batchId!,
            userId,
          }),
        );
        if (rows.length > 0) {
          // The unique key is the concurrency backstop. A racing cycle may have
          // inserted the same GID after our locking lookup. Do not overwrite any
          // evidence in the duplicate branch: re-read the winning row below and
          // route a genuinely newer correction through the same guarded update
          // and reconciliation-invalidation path as every ordinary update.
          await tx.insert(transactions).values(rows).onDuplicateKeyUpdate({
            set: {
              transactionRef: sql`${transactions.transactionRef}`,
            },
          });
        }

        const racedRows = await loadExistingOrders(tx, {
          organizationId: store.organizationId,
          storeId: store.id,
          gids: partition.inserts.map((order) => order.gid),
        });
        const racedCorrections = partitionShopifyOrders(partition.inserts, racedRows).updates;

        for (const update of [...partition.updates, ...racedCorrections]) {
          const current = [...existing, ...racedRows].find((row) => row.id === update.transactionId);
          const write = await tx
            .update(transactions)
            .set({ ...transactionFields(update.order), batchId, channelId, userId })
            .where(
              and(
                eq(transactions.id, update.transactionId),
                eq(transactions.organizationId, store.organizationId),
                eq(transactions.shopifyStoreId, store.id),
                eq(transactions.transactionRef, update.order.gid),
                or(
                  isNull(transactions.shopifyUpdatedAt),
                  lt(transactions.shopifyUpdatedAt, new Date(update.order.updatedAt)),
                ),
              ),
            );
          if (affectedRows(write) === 0) {
            unchanged += 1;
            continue;
          }
          updated += 1;
          if (current && materialShopifyOrderEvidenceChanged(current, update.order)) {
            await reopenAffectedReconciliation(tx, {
              organizationId: store.organizationId,
              transactionId: update.transactionId,
              legacyMatchId: current.matchId ?? null,
            });
          }
        }
      }

      const watermark = maxUpdatedAt(fetched, window.to);
      await tx
        .insert(shopifySyncCursors)
        .values({
          storeId: store.id,
          organizationId: store.organizationId,
          resource: ORDER_RESOURCE,
          cursor: null,
          watermarkUpdatedAt: watermark,
          lastSuccessfulAt: new Date(),
          lastErrorCode: null,
        })
        .onDuplicateKeyUpdate({
          set: {
            cursor: null,
            watermarkUpdatedAt: sql`GREATEST(${shopifySyncCursors.watermarkUpdatedAt}, VALUES(${shopifySyncCursors.watermarkUpdatedAt}))`,
            lastSuccessfulAt: new Date(),
            lastErrorCode: null,
          },
        });

      if (params.webhookId) {
        await tx
          .update(shopifyWebhookEvents)
          .set({ status: "processed", errorCode: null, processedAt: new Date() })
          .where(
            and(
              eq(shopifyWebhookEvents.webhookId, params.webhookId),
              eq(shopifyWebhookEvents.storeId, store.id),
              eq(shopifyWebhookEvents.organizationId, store.organizationId),
            ),
          );
      }

      return {
        inserted: partition.inserts.length,
        updated,
        unchanged,
        batchId,
      };
    });

    return {
      success: true,
      organizationId: store.organizationId,
      storeId: store.id,
      window,
      fetched: fetched.length,
      ...result,
    };
  } catch (error) {
    const code = errorCode(error);
    await db
      .insert(shopifySyncCursors)
      .values({
        storeId: store.id,
        organizationId: store.organizationId,
        resource: ORDER_RESOURCE,
        lastErrorCode: code,
      })
      .onDuplicateKeyUpdate({ set: { lastErrorCode: code } });
    throw error;
  }
}

type ShopifyWebhookSyncPayload = { storeId: number; organizationId: number; webhookId: string };

/** A webhook worker hook; queue integration stays injectable and independently testable. */
export async function handleShopifyWebhookSync(payload: ShopifyWebhookSyncPayload): Promise<void> {
  await runShopifyOrderSync({ ...payload, trigger: "webhook" });
}

/** Terminal queue evidence: retained for operators and eligible for redelivery. */
export async function markShopifyWebhookSyncFailed(
  payload: ShopifyWebhookSyncPayload,
  deps: { db?: Db } = {},
): Promise<void> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable while recording failed Shopify order sync");
  await db
    .update(shopifyWebhookEvents)
    .set({ status: "failed", errorCode: "order_sync_attempts_exhausted", processedAt: new Date() })
    .where(
      and(
        eq(shopifyWebhookEvents.webhookId, payload.webhookId),
        eq(shopifyWebhookEvents.storeId, payload.storeId),
        eq(shopifyWebhookEvents.organizationId, payload.organizationId),
        eq(shopifyWebhookEvents.status, "received"),
      ),
    );
}

/**
 * Durable trigger interface used by the verified webhook route. The generic queue
 * is enabled only when Redis is configured; without it the webhook ledger stays
 * `received` and Shopify is answered 503, so no event is falsely acknowledged.
 */
export async function enqueueShopifyWebhookSync(payload: ShopifyWebhookSyncPayload): Promise<void> {
  const { enqueueShopifyOrderSync } = await import("./syncQueue");
  await enqueueShopifyOrderSync(payload);
}
