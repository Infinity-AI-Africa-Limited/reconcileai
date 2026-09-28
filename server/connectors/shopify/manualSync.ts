/**
 * Manual ("refresh now") Shopify order syncs, run on the job queue.
 *
 * A manual sync used to run inside the HTTP request. A store's first sync reads
 * read_orders' whole 60-day window, which for a busy store outlasts a proxy
 * timeout: the merchant saw an error while the work carried on regardless. Now
 * the request only records that a sync was asked for and queues it, and the
 * page learns the outcome from the request's own row, which a reload does not
 * lose.
 *
 * Every request is a row in shopify_sync_requests, `queued` until settled, and
 * each writer settles only the rows it can vouch for:
 *
 *   - a refused enqueue settles its own row, `failed` — nothing else;
 *   - a run settles the rows that were `queued` when it STARTED, with its own
 *     outcome. A request made after that is left for the follow-up run the
 *     queue keeps for it (coalesceKey); a row another run has already settled
 *     is not `queued`, so an overlapping run can never overwrite its outcome.
 *
 * Earlier revisions held counters on the sync cursor instead, and every review
 * found another race in them: answering request N answered every request below
 * it, whoever had made them and whatever had become of them. Timestamps were
 * worse — the columns hold whole seconds, so they cannot order two events in
 * one second.
 */
import { and, desc, eq, lte } from "drizzle-orm";
import { shopifyConnectorStores, shopifySyncRequests } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { runShopifyOrderSyncToNow, shopifySyncFailureCode } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The store a manual sync is for. */
export interface ShopifyManualSyncTarget {
  storeId: number;
  organizationId: number;
}

/**
 * What the queue carries: the store, and the request that queued the job. The
 * run settles every request still queued when it starts; this one is what it
 * can still settle if it cannot read them.
 */
export interface ShopifyManualSyncPayload extends ShopifyManualSyncTarget {
  requestId: number;
}

export type ShopifyManualSyncErrorCode = "STORE_UNAVAILABLE" | "QUEUE_UNAVAILABLE" | "SERVICE_UNAVAILABLE";

export class ShopifyManualSyncError extends Error {
  constructor(public readonly code: ShopifyManualSyncErrorCode) {
    super(code);
    this.name = "ShopifyManualSyncError";
  }
}

/** Recorded on a request the queue refused, so it does not look pending forever. */
export const SHOPIFY_SYNC_QUEUE_UNAVAILABLE = "sync_queue_unavailable";

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

function requestsOf(target: ShopifyManualSyncTarget) {
  return and(
    eq(shopifySyncRequests.storeId, target.storeId),
    eq(shopifySyncRequests.organizationId, target.organizationId),
  );
}

function insertedId(result: unknown): number {
  return Number((result as [{ insertId?: number }])?.[0]?.insertId ?? 0);
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
  params: ShopifyManualSyncTarget,
  deps: ShopifyManualSyncDeps = {},
): Promise<{ requestId: number; requestedAt: Date }> {
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

  // Recorded BEFORE the enqueue, so the run that settles it cannot start first.
  const requestedAt = toWholeSecond(now());
  const requestId = insertedId(
    await db.insert(shopifySyncRequests).values({
      storeId: params.storeId,
      organizationId: params.organizationId,
      status: "queued",
      requestedAt,
    }),
  );
  if (!requestId) throw new ShopifyManualSyncError("SERVICE_UNAVAILABLE");

  try {
    await (deps.enqueue ?? defaultEnqueue)({ ...params, requestId });
  } catch (error) {
    console.error("[shopify-sync] manual sync could not be queued", {
      storeId: params.storeId,
      organizationId: params.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    try {
      // No run will settle this request, so settle it here — this row only.
      // Still `queued` is the guard: a run that started after the insert has
      // already settled it with an outcome that stands.
      await db
        .update(shopifySyncRequests)
        .set({ status: "failed", errorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, answeredAt: now() })
        .where(
          and(
            requestsOf(params),
            eq(shopifySyncRequests.id, requestId),
            eq(shopifySyncRequests.status, "queued"),
          ),
        );
    } catch {
      // The refusal below is what the caller must see; the page then shows the
      // request as stalled rather than failed, which is still not "done".
    }
    throw new ShopifyManualSyncError("QUEUE_UNAVAILABLE");
  }
  return { requestId, requestedAt };
}

/** The newest request still queued for this store, or 0. */
async function latestQueuedRequestId(db: Db, target: ShopifyManualSyncTarget): Promise<number> {
  const [row] = await db
    .select({ id: shopifySyncRequests.id })
    .from(shopifySyncRequests)
    .where(and(requestsOf(target), eq(shopifySyncRequests.status, "queued")))
    .orderBy(desc(shopifySyncRequests.id))
    .limit(1);
  return row?.id ?? 0;
}

/**
 * Settle every request of this store that is still `queued` and no newer than
 * `throughId`, with one run's outcome. Rows another run has settled are not
 * `queued`, so they keep that run's outcome.
 */
export async function settleShopifyManualSyncRequests(
  db: Db,
  target: ShopifyManualSyncTarget,
  throughId: number,
  outcome: { status: "succeeded" } | { status: "failed"; errorCode: string },
  deps: { now?: () => Date } = {},
): Promise<void> {
  await db
    .update(shopifySyncRequests)
    .set({
      status: outcome.status,
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      answeredAt: (deps.now ?? (() => new Date()))(),
    })
    .where(
      and(
        requestsOf(target),
        eq(shopifySyncRequests.status, "queued"),
        lte(shopifySyncRequests.id, throughId),
      ),
    );
}

export interface ShopifyManualSyncHandlerDeps {
  db?: Db | null;
  now?: () => Date;
  runToNow?: typeof runShopifyOrderSyncToNow;
}

/**
 * The queue worker. Notes which requests are queued, runs sync cycles until
 * orders are current (a first sync advances through bounded windows), then
 * settles those requests with the outcome — on failure too.
 *
 * No final-failure hook is needed: a run that throws is recorded here — if it
 * cannot read the queued requests, it still settles the one that queued it —
 * and one whose process dies is re-run by the durable queue or, on the
 * in-process fallback, left showing as stalled for the merchant to request
 * again (the next run settles the orphaned row too). Without a database nothing
 * can be recorded; that too shows as stalled.
 */
export async function handleShopifyManualSync(
  payload: ShopifyManualSyncPayload,
  deps: ShopifyManualSyncHandlerDeps = {},
): Promise<void> {
  const db = await databaseFrom(deps);
  if (!db) throw new Error("Database unavailable for a manual Shopify sync");
  let throughId = payload.requestId;

  try {
    throughId = Math.max(throughId, await latestQueuedRequestId(db, payload));
    await (deps.runToNow ?? runShopifyOrderSyncToNow)({
      storeId: payload.storeId,
      organizationId: payload.organizationId,
      trigger: "manual",
    });
  } catch (error) {
    await settleShopifyManualSyncRequests(
      db,
      payload,
      throughId,
      { status: "failed", errorCode: shopifySyncFailureCode(error) },
      deps,
    ).catch(() => undefined);
    throw error;
  }
  await settleShopifyManualSyncRequests(db, payload, throughId, { status: "succeeded" }, deps).catch(
    (error: unknown) => {
      // The orders are synced; only the bookkeeping failed. The page shows the
      // request as pending, then stalled, and asking again is safe.
      console.error("[shopify-sync] could not record a finished manual sync", {
        storeId: payload.storeId,
        organizationId: payload.organizationId,
        reason: error instanceof Error ? error.name : "unknown",
      });
    },
  );
}
