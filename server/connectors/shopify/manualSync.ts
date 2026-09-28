/**
 * Manual ("refresh now") Shopify order syncs, run on the job queue.
 *
 * A manual sync used to run inside the HTTP request. A store's first sync reads
 * read_orders' whole 60-day window, which for a busy store outlasts a proxy
 * timeout: the merchant saw an error while the work carried on regardless. Now
 * the request only records that a sync was asked for and queues it; the page
 * learns the outcome from the sync cursor, which a reload does not lose:
 *
 *   answered  orders are synced through the request (watermarkUpdatedAt ≥
 *             syncRequestedAt), whichever sync did it — or a manual run for
 *             this request has finished (syncAnsweredAt ≥ syncRequestedAt)
 *   pending   otherwise
 *
 * Every sync writes this one cursor, so "an outcome was recorded after the
 * request" is not the test: a webhook sync that began before the request and
 * finished after it would pass it without covering the request at all.
 *
 * All three times are whole seconds. The columns are TIMESTAMP(0), so a
 * millisecond request time compared with a second-precision outcome could put
 * a sync that finished in the same second "before" the request.
 */
import { and, eq, sql } from "drizzle-orm";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { runShopifyOrderSyncToNow } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyManualSyncRequest {
  storeId: number;
  organizationId: number;
}

/** What the queue carries: the request, and the time it was recorded under. */
export interface ShopifyManualSyncPayload extends ShopifyManualSyncRequest {
  /** ISO time, whole seconds — the syncRequestedAt this run answers. */
  requestedAt: string;
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
/** Recorded when a manual run failed without recording a code of its own. */
export const SHOPIFY_SYNC_NOT_COMPLETED = "sync_not_completed";

/** A time at the columns' precision (TIMESTAMP(0)), so stored and returned values agree. */
export function toWholeSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * `db` omitted means "use the application database". An explicit `null` means
 * "there is none" and never falls back to it: with `??`, a test of the
 * no-database path silently reached a real database wherever DATABASE_URL was
 * set (CI), and passed only where it was not.
 */
function databaseFrom(deps: { db?: Db | null }): Promise<Db | null> | Db | null {
  return deps.db !== undefined ? deps.db : getDb();
}

function cursorOf(request: ShopifyManualSyncRequest) {
  return and(
    eq(shopifySyncCursors.storeId, request.storeId),
    eq(shopifySyncCursors.organizationId, request.organizationId),
    eq(shopifySyncCursors.resource, "orders"),
  );
}

export interface ShopifyManualSyncDeps {
  db?: Db | null;
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
  params: ShopifyManualSyncRequest,
  deps: ShopifyManualSyncDeps = {},
): Promise<{ requestedAt: Date }> {
  const db = await databaseFrom(deps);
  if (!db) throw new ShopifyManualSyncError("SERVICE_UNAVAILABLE");
  const now = deps.now ?? (() => new Date());

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
  // answer a request that was not yet written down.
  const requestedAt = toWholeSecond(now());
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
    await (deps.enqueue ?? defaultEnqueue)({ ...params, requestedAt: requestedAt.toISOString() });
  } catch (error) {
    console.error("[shopify-sync] manual sync could not be queued", {
      storeId: params.storeId,
      organizationId: params.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    try {
      // Answered, and failed: no run will ever report on this request.
      await db
        .update(shopifySyncCursors)
        .set({ lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, lastErrorAt: now(), syncAnsweredAt: requestedAt })
        .where(cursorOf(params));
    } catch {
      // The refusal below is what the caller must see; the page then shows the
      // request as stalled rather than failed, which is still not "done".
    }
    throw new ShopifyManualSyncError("QUEUE_UNAVAILABLE");
  }
  return { requestedAt };
}

/**
 * Record that a manual run for `payload.requestedAt` has finished. A failed run
 * that recorded no code of its own after the request (the store vanished, or
 * the database was down when it began) gets a generic one — never overwriting
 * a precise code the run did record. Idempotent: the terminal-failure hook may
 * record the same run again.
 */
export async function recordShopifyManualSyncAnswered(
  payload: ShopifyManualSyncPayload,
  outcome: { failed: boolean },
  deps: { db?: Db | null; now?: () => Date } = {},
): Promise<void> {
  const answered = new Date(payload.requestedAt);
  if (Number.isNaN(answered.getTime())) return;
  const db = await databaseFrom(deps);
  if (!db) return;
  // Encoded through the column, as a plain .set() would be (UTC). A bare Date
  // inside sql`` is formatted by the driver in the connection's LOCAL time zone.
  const answeredParam = sql.param(answered, shopifySyncCursors.syncAnsweredAt);
  const failedAtParam = sql.param((deps.now ?? (() => new Date()))(), shopifySyncCursors.lastErrorAt);
  // Never move backwards: an older request's run finishing late must not
  // un-answer a newer one.
  const set: Record<string, unknown> = {
    syncAnsweredAt: sql`GREATEST(COALESCE(${shopifySyncCursors.syncAnsweredAt}, ${answeredParam}), ${answeredParam})`,
  };
  if (outcome.failed) {
    const noCodeSinceRequest = sql`(${shopifySyncCursors.lastErrorAt} IS NULL OR ${shopifySyncCursors.lastErrorAt} < ${answeredParam})`;
    set.lastErrorCode = sql`CASE WHEN ${noCodeSinceRequest} THEN ${SHOPIFY_SYNC_NOT_COMPLETED} ELSE ${shopifySyncCursors.lastErrorCode} END`;
    set.lastErrorAt = sql`CASE WHEN ${noCodeSinceRequest} THEN ${failedAtParam} ELSE ${shopifySyncCursors.lastErrorAt} END`;
  }
  await db.update(shopifySyncCursors).set(set).where(cursorOf(payload));
}

export interface ShopifyManualSyncHandlerDeps {
  runToNow?: typeof runShopifyOrderSyncToNow;
  record?: typeof recordShopifyManualSyncAnswered;
}

/**
 * The queue worker. Runs sync cycles until orders are current (a first sync
 * advances through bounded windows), then records the request as answered —
 * on failure too, in the same statement as any code, so the page never sees
 * "answered" without the failure that ended it.
 */
export async function handleShopifyManualSync(
  payload: ShopifyManualSyncPayload,
  deps: ShopifyManualSyncHandlerDeps = {},
): Promise<void> {
  const record = deps.record ?? recordShopifyManualSyncAnswered;
  try {
    await (deps.runToNow ?? runShopifyOrderSyncToNow)({
      storeId: payload.storeId,
      organizationId: payload.organizationId,
      trigger: "manual",
    });
  } catch (error) {
    await record(payload, { failed: true }).catch(() => undefined);
    throw error;
  }
  await record(payload, { failed: false }).catch((error: unknown) => {
    // The data is synced (watermarkUpdatedAt says so, and answers the page by
    // itself); only the bookkeeping failed.
    console.error("[shopify-sync] could not record a finished manual sync", {
      storeId: payload.storeId,
      organizationId: payload.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  });
}

/** Terminal-failure hook, for a run that died without reaching the handler's own recording. */
export async function markShopifyManualSyncFailed(payload: ShopifyManualSyncPayload): Promise<void> {
  await recordShopifyManualSyncAnswered(payload, { failed: true });
}
