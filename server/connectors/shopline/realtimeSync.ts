/**
 * SHOPLINE Real-Time Reconciliation Trigger
 *
 * Webhook deliveries drive reconciliation instead of waiting for the 15-minute
 * poll — but a naive "one webhook, one sync" would be actively harmful:
 *
 *  - A store importing 200 orders emits 200+ webhooks in seconds. Each
 *    `runSyncCycle` fetches orders + payments + payouts (paginated), so that
 *    would burn straight through SHOPLINE's per-store rate limit (leaky
 *    bucket: burst 40, drain 4 req/s) and get us 429'd.
 *  - Concurrent cycles for the same store would race on persistence and
 *    duplicate work.
 *
 * So requests are COALESCED per store, on a queue rather than in this
 * process's memory. The first relevant event opens a window of
 * `COALESCE_WINDOW_MS`; every further event for that store inside it is
 * absorbed, and the window does not move, so a continuous stream cannot starve
 * the sync. When it closes, exactly one sync runs. Events that arrive WHILE it
 * runs earn exactly one follow-up, which opens a fresh window when the run ends.
 *
 * On BullMQ this holds across every instance: the window is one delayed job
 * per store, deduplicated in Redis by a tenant-qualified key, so each instance's
 * webhooks feed the same job and only one instance runs it. (Until 2026-10-09
 * each process kept its own timers, so with several instances a store could
 * sync once per instance per window.) Without REDIS_URL the in-process queue
 * applies the same rule within the one process, which is the whole deployment.
 *
 * The webhook HTTP handler already acks 200 before any of this happens
 * (`ingestWebhook` is fire-and-forget), and scheduling never throws: a request
 * that cannot be queued is logged, and the 15-minute poll picks the store up.
 */
import { createQueue, type EnqueueOptions, type JobQueue, type QueueJob } from "../../jobQueue";
import { runSyncCycle } from "./syncOrchestrator";
import { loggableError } from "../../dbErrors";
import { stackFrames } from "../../errorText";

/**
 * Topics that change reconciliation state and therefore justify a sync.
 *
 * Excluded deliberately:
 *  - `orders/create` — a newly created order is typically unpaid, so there is
 *    nothing to match yet; `orders/paid` follows when it matters.
 *  - `orders/delete` — removal is handled by the next full batch; triggering a
 *    fetch for a deleted order gains nothing.
 *  - GDPR and app-subscription topics — not reconciliation events.
 */
export const RECONCILIATION_TRIGGER_TOPICS: readonly string[] = [
  "orders/paid",
  "orders/updated",
  "orders/edited",
  "orders/cancelled",
  "refunds/create",
  "refunds/update",
  "order_transactions/create",
];

export function isReconciliationTrigger(topic: string): boolean {
  return RECONCILIATION_TRIGGER_TOPICS.includes(topic);
}

/**
 * How long a store's window stays open after the event that opened it. A
 * store under sustained load syncs about once per window plus its run time,
 * one store at a time, which keeps it inside SHOPLINE's per-store rate limit.
 */
export const COALESCE_WINDOW_MS = 20_000;

export const SHOPLINE_REALTIME_QUEUE = "shopline-realtime-sync";

/** Stores synced at once by one instance's worker; one store never runs twice at once. */
const REALTIME_SYNC_CONCURRENCY = 4;

export interface ShoplineRealtimeSyncPayload {
  organizationId: number;
  slStoreId: number;
  /** The topic of the event that opened (or, for a follow-up, last fed) the window. */
  topic: string;
  /** ISO time of that event, so the log can say how long the sync waited. */
  requestedAt: string;
}

/** One window per store, qualified by tenant as every queue key here is. */
export function realtimeCoalesceKey(payload: Pick<ShoplineRealtimeSyncPayload, "organizationId" | "slStoreId">): string {
  return `shopline-realtime:${payload.organizationId}:${payload.slStoreId}`;
}

/** Run the coalesced sync for a store. Never throws: the 15-minute poll is the retry. */
export async function runRealtimeSync(job: QueueJob<ShoplineRealtimeSyncPayload>): Promise<void> {
  const { organizationId, slStoreId, topic, requestedAt } = job.data;
  const waitedMs = Date.now() - Date.parse(requestedAt);
  try {
    const report = await runSyncCycle({
      organizationId,
      slStoreId,
      triggeredBy: 0, // system
    });
    if (report.error) {
      console.warn(`[shopline-realtime] sync failed store=${slStoreId} topic=${topic} error=${report.error}`);
    } else {
      console.info(
        `[shopline-realtime] synced store=${slStoreId} after ${waitedMs}ms ` +
          `topic=${topic} orders=${report.ordersIngested} ` +
          `payments=${report.paymentsIngested} matched=${report.matchedCount} exceptions=${report.exceptionCount}`,
      );
    }
  } catch (err) {
    console.error(`[shopline-realtime] sync threw for store=${slStoreId}:`, {
      ...loggableError(err),
      frames: stackFrames(err),
    });
  }
}

/**
 * The realtime queue, under `name`. Production uses the one module-level queue
 * below; the real-Redis test builds its own under a name no running app uses,
 * so it can never consume a live store's sync.
 */
export function createShoplineRealtimeQueue(
  name: string = SHOPLINE_REALTIME_QUEUE,
): Promise<JobQueue<ShoplineRealtimeSyncPayload>> {
  return createQueue<ShoplineRealtimeSyncPayload>(name, runRealtimeSync, {
    // One attempt: a failed cycle is logged, and the 15-minute poll retries it
    // with fresh data rather than replaying a stale trigger.
    attempts: 1,
    backoffMs: COALESCE_WINDOW_MS,
    concurrency: REALTIME_SYNC_CONCURRENCY,
  });
}

/** How one request is enqueued: one delayed window per store, coalesced per tenant and store. */
export function shoplineRealtimeJob(
  payload: ShoplineRealtimeSyncPayload,
): [name: string, payload: ShoplineRealtimeSyncPayload, options: EnqueueOptions] {
  return [
    `store-${payload.slStoreId}`,
    payload,
    { coalesceKey: realtimeCoalesceKey(payload), delayMs: COALESCE_WINDOW_MS },
  ];
}

let queuePromise: Promise<JobQueue<ShoplineRealtimeSyncPayload>> | null = null;

function realtimeQueue(): Promise<JobQueue<ShoplineRealtimeSyncPayload>> {
  if (!queuePromise) {
    queuePromise = createShoplineRealtimeQueue().catch(error => {
      // Never cache a rejection: the next request should try again.
      queuePromise = null;
      throw error;
    });
  }
  return queuePromise;
}

/**
 * Test seam: drop the queue so the next request builds a fresh one. A test
 * that leaves work behind would otherwise share it with the next.
 */
export async function __resetRealtimeQueue(): Promise<void> {
  const pending = queuePromise;
  queuePromise = null;
  if (pending) await (await pending.catch(() => null))?.close();
}

/** Queue one coalesced request. Never throws; a refusal is logged, not raised. */
async function requestRealtimeSync(payload: ShoplineRealtimeSyncPayload): Promise<void> {
  try {
    const queue = await realtimeQueue();
    await queue.enqueue(...shoplineRealtimeJob(payload));
  } catch (err) {
    console.warn("[shopline-realtime] could not schedule a sync; the 15-minute poll will pick the store up", {
      organizationId: payload.organizationId,
      slStoreId: payload.slStoreId,
      ...loggableError(err),
    });
  }
}

/**
 * Request a reconciliation for a store in response to a webhook.
 *
 * Non-blocking and never throws: the caller is on the webhook path, which has
 * already acked. Returns at once; the request is queued in the background.
 */
export function scheduleReconciliation(organizationId: number, slStoreId: number, topic: string): void {
  if (!isReconciliationTrigger(topic)) return;
  void requestRealtimeSync({ organizationId, slStoreId, topic, requestedAt: new Date().toISOString() });
}
