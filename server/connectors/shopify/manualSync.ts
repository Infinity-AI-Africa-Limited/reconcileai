/**
 * Manual ("refresh now") Shopify order syncs, run on the job queue.
 *
 * A manual sync used to run inside the HTTP request. A store's first sync reads
 * read_orders' whole 60-day window, which for a busy store outlasts a proxy
 * timeout: the merchant saw an error while the work carried on regardless. Now
 * the request only records that a sync was asked for and queues it; the page
 * learns the outcome from the sync cursor, which a reload does not lose:
 *
 *   pending   syncRequestedAt is later than both lastSuccessfulAt and lastErrorAt
 *   failed    lastErrorCode is set
 *   current   otherwise, once lastSuccessfulAt exists
 */
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { runShopifyOrderSync } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyManualSyncPayload {
  storeId: number;
  organizationId: number;
}

export type ShopifyManualSyncErrorCode = "STORE_UNAVAILABLE" | "QUEUE_UNAVAILABLE" | "SERVICE_UNAVAILABLE";

export class ShopifyManualSyncError extends Error {
  constructor(public readonly code: ShopifyManualSyncErrorCode) {
    super(code);
    this.name = "ShopifyManualSyncError";
  }
}

/** Recorded when the queue refused the work, so the request does not look pending forever. */
export const SHOPIFY_SYNC_QUEUE_UNAVAILABLE = "sync_queue_unavailable";
/** Recorded when a queued run ended without recording an outcome of its own. */
export const SHOPIFY_SYNC_NOT_COMPLETED = "sync_not_completed";

export interface ShopifyManualSyncDeps {
  db?: Db;
  now?: () => Date;
  enqueue?: (payload: ShopifyManualSyncPayload) => Promise<void>;
}

async function defaultEnqueue(payload: ShopifyManualSyncPayload): Promise<void> {
  const { enqueueShopifyManualSync } = await import("./syncQueue");
  await enqueueShopifyManualSync(payload);
}

/**
 * Record a manual sync request for an active store of this tenant, and queue
 * it. The store is looked up by id, tenant AND status together, so a store of
 * another tenant, an unknown id and an inactive store get one answer.
 */
export async function requestShopifyManualSync(
  params: ShopifyManualSyncPayload,
  deps: ShopifyManualSyncDeps = {},
): Promise<{ requestedAt: Date }> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new ShopifyManualSyncError("SERVICE_UNAVAILABLE");

  const [store] = await db
    .select({ id: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, params.storeId),
        eq(shopifyConnectorStores.organizationId, params.organizationId),
        eq(shopifyConnectorStores.status, "active"),
      ),
    )
    .limit(1);
  if (!store) throw new ShopifyManualSyncError("STORE_UNAVAILABLE");

  // Recorded BEFORE the enqueue: a worker that finished first would otherwise
  // record its success earlier than the request, and the request would look
  // pending for ever.
  const requestedAt = (deps.now ?? (() => new Date()))();
  await db
    .insert(shopifySyncCursors)
    .values({
      storeId: params.storeId,
      organizationId: params.organizationId,
      resource: "orders",
      syncRequestedAt: requestedAt,
    })
    .onDuplicateKeyUpdate({ set: { syncRequestedAt: requestedAt } });

  try {
    await (deps.enqueue ?? defaultEnqueue)(params);
  } catch (error) {
    console.error("[shopify-sync] manual sync could not be queued", {
      storeId: params.storeId,
      organizationId: params.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    const failedAt = (deps.now ?? (() => new Date()))();
    try {
      await db
        .update(shopifySyncCursors)
        .set({ lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, lastErrorAt: failedAt })
        .where(
          and(
            eq(shopifySyncCursors.storeId, params.storeId),
            eq(shopifySyncCursors.organizationId, params.organizationId),
            eq(shopifySyncCursors.resource, "orders"),
          ),
        );
    } catch {
      // The refusal below is what the caller must see; the page then shows the
      // request as stalled rather than failed, which is still not "done".
    }
    throw new ShopifyManualSyncError("QUEUE_UNAVAILABLE");
  }
  return { requestedAt };
}

/** The queue worker. `runShopifyOrderSync` records its own success or failure. */
export async function handleShopifyManualSync(payload: ShopifyManualSyncPayload): Promise<void> {
  await runShopifyOrderSync({ ...payload, trigger: "manual" });
}

/**
 * Final-failure hook. A run that failed inside `runShopifyOrderSync` has already
 * recorded its precise code; this records a generic one ONLY when nothing was
 * recorded after the request (the store vanished, or the database was down
 * when the run began), so the page does not show "pending" indefinitely — and
 * it never overwrites the precise code.
 */
export async function markShopifyManualSyncFailed(
  payload: ShopifyManualSyncPayload,
  deps: { db?: Db; now?: () => Date } = {},
): Promise<void> {
  const db = deps.db ?? (await getDb());
  if (!db) return;
  await db
    .update(shopifySyncCursors)
    .set({ lastErrorCode: SHOPIFY_SYNC_NOT_COMPLETED, lastErrorAt: (deps.now ?? (() => new Date()))() })
    .where(
      and(
        eq(shopifySyncCursors.storeId, payload.storeId),
        eq(shopifySyncCursors.organizationId, payload.organizationId),
        eq(shopifySyncCursors.resource, "orders"),
        isNotNull(shopifySyncCursors.syncRequestedAt),
        or(isNull(shopifySyncCursors.lastErrorAt), lt(shopifySyncCursors.lastErrorAt, shopifySyncCursors.syncRequestedAt)),
        or(
          isNull(shopifySyncCursors.lastSuccessfulAt),
          lt(shopifySyncCursors.lastSuccessfulAt, shopifySyncCursors.syncRequestedAt),
        ),
      ),
    );
}
