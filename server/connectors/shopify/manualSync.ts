/**
 * Manual ("refresh now") Shopify order syncs, run on the job queue.
 *
 * A manual sync used to run inside the HTTP request. A store's first sync reads
 * read_orders' whole 60-day window, which for a busy store outlasts a proxy
 * timeout: the merchant saw an error while the work carried on regardless. Now
 * the request only records that a sync was asked for and queues it, and the
 * page learns the outcome from the sync cursor, which a reload does not lose.
 *
 * Which run answers which request is decided by COUNTING, not by time:
 *
 *   - every request increments syncRequestSeq;
 *   - a manual run reads syncRequestSeq when it STARTS — it will answer every
 *     request made up to that moment — and records that number as
 *     syncAnsweredSeq when it finishes, successfully or not;
 *   - a request is pending while syncRequestSeq > syncAnsweredSeq.
 *
 * A request made after a run started is never answered by that run: the queue
 * keeps exactly one follow-up for a request that arrives mid-run (coalesceKey),
 * and the follow-up's own snapshot covers it. Every sync writes this cursor, so
 * "some outcome was recorded after the request" cannot be the test (a webhook
 * sync finishing mid-request would pass it); and the cursor's timestamps are
 * whole seconds, so no comparison of them can order two events in one second.
 * syncRequestedAt remains, for display and for noticing a stalled request.
 *
 * Answering a number answers every request below it, so each writer answers
 * only what it can vouch for: a run, what it counted when it started; a refused
 * enqueue, its own request and only while no other is outstanding (another
 * request's run will cover it, and must not find itself already "failed").
 */
import { and, eq, sql } from "drizzle-orm";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { runShopifyOrderSyncToNow, shopifySyncFailureCode } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The store a manual sync is for. */
export interface ShopifyManualSyncTarget {
  storeId: number;
  organizationId: number;
}

/**
 * What the queue carries: the store, and the number of the request that queued
 * the job. The run answers every request counted when it starts; the number is
 * what it can still answer if it cannot read that count.
 */
export interface ShopifyManualSyncPayload extends ShopifyManualSyncTarget {
  requestSeq: number;
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

function cursorOf(request: ShopifyManualSyncTarget) {
  return and(
    eq(shopifySyncCursors.storeId, request.storeId),
    eq(shopifySyncCursors.organizationId, request.organizationId),
    eq(shopifySyncCursors.resource, "orders"),
  );
}

async function currentRequestSeq(db: Db | Tx, request: ShopifyManualSyncTarget): Promise<number> {
  const [row] = await db
    .select({ requestSeq: shopifySyncCursors.syncRequestSeq })
    .from(shopifySyncCursors)
    .where(cursorOf(request))
    .limit(1);
  return row?.requestSeq ?? 0;
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
): Promise<{ requestedAt: Date; requestSeq: number }> {
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

  // Counted BEFORE the enqueue, so the run that answers it cannot start first,
  // and read back in the same transaction: the upsert holds the row lock until
  // commit, so the number read is this request's own, never a concurrent one's.
  const requestedAt = toWholeSecond(now());
  const requestSeq = await db.transaction(async (tx) => {
    await tx
      .insert(shopifySyncCursors)
      .values({
        storeId: params.storeId,
        organizationId: params.organizationId,
        resource: "orders",
        syncRequestedAt: requestedAt,
        syncRequestSeq: 1,
      })
      .onDuplicateKeyUpdate({
        set: { syncRequestedAt: requestedAt, syncRequestSeq: sql`${shopifySyncCursors.syncRequestSeq} + 1` },
      });
    return currentRequestSeq(tx, params);
  });

  try {
    await (deps.enqueue ?? defaultEnqueue)({ ...params, requestSeq });
  } catch (error) {
    console.error("[shopify-sync] manual sync could not be queued", {
      storeId: params.storeId,
      organizationId: params.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    try {
      // No run will report on this request, so answer it here, failed — but
      // only while it is the sole request outstanding. Answering it would answer
      // every request below it, and one of those may be queued and still to
      // run; a later request that was queued has a run that covers this one.
      // What is left over (every request refused, or an earlier one's run begun
      // before this one was counted) shows as stalled, and this caller has the
      // refusal below.
      await db
        .update(shopifySyncCursors)
        .set({ lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, lastErrorAt: now(), syncAnsweredSeq: requestSeq })
        .where(
          and(
            cursorOf(params),
            eq(shopifySyncCursors.syncRequestSeq, requestSeq),
            eq(shopifySyncCursors.syncAnsweredSeq, requestSeq - 1),
          ),
        );
    } catch {
      // The refusal below is what the caller must see; the page then shows the
      // request as stalled rather than failed, which is still not "done".
    }
    throw new ShopifyManualSyncError("QUEUE_UNAVAILABLE");
  }
  return { requestedAt, requestSeq };
}

/**
 * Record that a manual run has answered every request up to `answeredSeq`.
 *
 * A failure is written again here, in the same statement, although the sync
 * recorded it already: a webhook sync succeeding in between clears the code,
 * and the page would then call a failed request current. A success does not
 * clear a webhook failure recorded in between; that errs towards "failed",
 * which asking again resolves, never towards a success that did not happen.
 */
export async function recordShopifyManualSyncAnswered(
  db: Db,
  request: ShopifyManualSyncTarget,
  answeredSeq: number,
  outcome: { failed: false } | { failed: true; code: string },
  deps: { now?: () => Date } = {},
): Promise<void> {
  // Never move backwards: an earlier run finishing late must not un-answer a later one.
  const set: Record<string, unknown> = {
    syncAnsweredSeq: sql`GREATEST(${shopifySyncCursors.syncAnsweredSeq}, ${answeredSeq})`,
  };
  if (outcome.failed) {
    set.lastErrorCode = outcome.code;
    set.lastErrorAt = (deps.now ?? (() => new Date()))();
  }
  await db.update(shopifySyncCursors).set(set).where(cursorOf(request));
}

export interface ShopifyManualSyncHandlerDeps {
  db?: Db | null;
  now?: () => Date;
  runToNow?: typeof runShopifyOrderSyncToNow;
}

/**
 * The queue worker. Snapshots the request count, runs sync cycles until orders
 * are current (a first sync advances through bounded windows), then records
 * every request up to the snapshot as answered — on failure too.
 *
 * No final-failure hook is needed: a run that throws is recorded here — if it
 * cannot read the count, it still answers the request that queued it — and one
 * whose process dies is re-run by the durable queue or, on the in-process
 * fallback, left showing as stalled for the merchant to request again. Without
 * a database nothing can be recorded; that too shows as stalled.
 */
export async function handleShopifyManualSync(
  payload: ShopifyManualSyncPayload,
  deps: ShopifyManualSyncHandlerDeps = {},
): Promise<void> {
  const db = await databaseFrom(deps);
  if (!db) throw new Error("Database unavailable for a manual Shopify sync");
  let answers = payload.requestSeq;

  try {
    answers = Math.max(answers, await currentRequestSeq(db, payload));
    await (deps.runToNow ?? runShopifyOrderSyncToNow)({
      storeId: payload.storeId,
      organizationId: payload.organizationId,
      trigger: "manual",
    });
  } catch (error) {
    await recordShopifyManualSyncAnswered(
      db,
      payload,
      answers,
      { failed: true, code: shopifySyncFailureCode(error) },
      deps,
    ).catch(() => undefined);
    throw error;
  }
  await recordShopifyManualSyncAnswered(db, payload, answers, { failed: false }, deps).catch((error: unknown) => {
    // The orders are synced; only the bookkeeping failed. The page shows the
    // request as pending, then stalled, and asking again is safe.
    console.error("[shopify-sync] could not record a finished manual sync", {
      storeId: payload.storeId,
      organizationId: payload.organizationId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  });
}
