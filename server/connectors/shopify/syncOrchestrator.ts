import { and, eq, inArray, sql } from "drizzle-orm";
import { channels, transactions, uploadBatches, users, type InsertTransaction } from "../../../drizzle/schema";
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

async function resolveAuthorizedActor(
  db: DbExecutor,
  store: { id: number; organizationId: number; claimedByUserId: number | null },
): Promise<number> {
  if (!store.claimedByUserId) throw new Error("Shopify store has no authorised sync actor");
  const [actor] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, store.claimedByUserId),
        eq(users.organizationId, store.organizationId),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  if (!actor) throw new Error("Shopify store sync actor is not an active member of the tenant");
  return actor.id;
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
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            eq(transactions.shopifyStoreId, params.storeId),
            inArray(transactions.transactionRef, chunk),
          ),
        )),
    );
  }
  return out;
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
    const userId = await resolveAuthorizedActor(db, store);
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
          // inserted the same GID after our lookup; in that case update only the
          // minimal fields and only when the provider updatedAt is newer.
          await tx.insert(transactions).values(rows).onDuplicateKeyUpdate({
            set: {
              batchId: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.batchId}), ${transactions.batchId})`,
              channelId: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.channelId}), ${transactions.channelId})`,
              userId: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.userId}), ${transactions.userId})`,
              externalRef: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.externalRef}), ${transactions.externalRef})`,
              description: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.description}), ${transactions.description})`,
              amount: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.amount}), ${transactions.amount})`,
              currency: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.currency}), ${transactions.currency})`,
              transactionDate: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.transactionDate}), ${transactions.transactionDate})`,
              valueDate: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.valueDate}), ${transactions.valueDate})`,
              shopifyOrderCurrency: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.shopifyOrderCurrency}), ${transactions.shopifyOrderCurrency})`,
              shopifyFinancialStatus: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.shopifyFinancialStatus}), ${transactions.shopifyFinancialStatus})`,
              shopifyCancelledAt: sql`IF(VALUES(${transactions.shopifyUpdatedAt}) > ${transactions.shopifyUpdatedAt}, VALUES(${transactions.shopifyCancelledAt}), ${transactions.shopifyCancelledAt})`,
              shopifyUpdatedAt: sql`GREATEST(VALUES(${transactions.shopifyUpdatedAt}), ${transactions.shopifyUpdatedAt})`,
              rawData: null,
            },
          });
        }

        for (const update of partition.updates) {
          await tx
            .update(transactions)
            .set({ ...transactionFields(update.order), batchId, channelId, userId })
            .where(
              and(
                eq(transactions.id, update.transactionId),
                eq(transactions.organizationId, store.organizationId),
                eq(transactions.shopifyStoreId, store.id),
                eq(transactions.transactionRef, update.order.gid),
              ),
            );
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
        updated: partition.updates.length,
        unchanged: partition.unchanged,
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

/**
 * Durable trigger interface used by the verified webhook route. The generic queue
 * is enabled only when Redis is configured; without it the webhook ledger stays
 * `received` and Shopify is answered 503, so no event is falsely acknowledged.
 */
export async function enqueueShopifyWebhookSync(payload: ShopifyWebhookSyncPayload): Promise<void> {
  const { enqueueShopifyOrderSync } = await import("./syncQueue");
  await enqueueShopifyOrderSync(payload);
}
