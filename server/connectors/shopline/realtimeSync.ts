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
 * So events are COALESCED per store: the first relevant event opens a short
 * quiet period; further events inside it reset the timer (up to a hard cap so
 * a continuous stream still gets serviced). When the timer fires, exactly one
 * sync runs for that store. A store under sustained load therefore syncs about
 * once per `MAX_WAIT_MS`, not once per event.
 *
 * The webhook HTTP handler already acks 200 before any of this happens
 * (`ingestWebhook` is fire-and-forget), so SHOPLINE's 5-second budget is never
 * at risk from reconciliation work.
 *
 * Scope note: this scheduler is per-process. With multiple Railway instances
 * each holds its own timers, so a store could sync once per instance in a
 * window — wasteful but not incorrect (ingest dedupes, and `runSyncCycle` is
 * idempotent over its window). Moving the trigger onto the BullMQ queue once
 * `REDIS_URL` is provisioned makes it cluster-wide; see CLAUDE.md §10.
 */
import { runSyncCycle } from "./syncOrchestrator";

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

/** Quiet period: wait this long after the last event before syncing. */
export const DEBOUNCE_MS = 20_000;
/** Hard cap: never delay a sync longer than this after the FIRST event. */
export const MAX_WAIT_MS = 60_000;

interface PendingEntry {
  organizationId: number;
  timer: NodeJS.Timeout;
  /** When the first event in this batch arrived (drives MAX_WAIT_MS). */
  firstQueuedAt: number;
  /** Distinct topics seen in this batch — logged for traceability. */
  topics: Set<string>;
}

const pending = new Map<number, PendingEntry>();
const inFlight = new Set<number>();
/** Stores that received an event while a sync was running — rerun once it ends. */
const rerunRequested = new Map<number, number>();

/** Test seam: clear all scheduler state. */
export function __resetRealtimeState(): void {
  for (const entry of Array.from(pending.values())) clearTimeout(entry.timer);
  pending.clear();
  inFlight.clear();
  rerunRequested.clear();
}

/** Introspection for tests/health: stores currently queued or running. */
export function realtimeStatus(): { pending: number[]; inFlight: number[] } {
  return { pending: Array.from(pending.keys()), inFlight: Array.from(inFlight) };
}

/**
 * Request a reconciliation for a store in response to a webhook.
 *
 * Non-blocking and never throws: the caller is on the webhook path, which has
 * already acked. Returns immediately after (re)arming the debounce timer.
 */
export function scheduleReconciliation(
  organizationId: number,
  slStoreId: number,
  topic: string,
): void {
  if (!isReconciliationTrigger(topic)) return;

  // A sync is already running for this store — note that more work arrived so
  // we run exactly one more pass when it finishes, rather than piling on.
  if (inFlight.has(slStoreId)) {
    rerunRequested.set(slStoreId, organizationId);
    return;
  }

  const existing = pending.get(slStoreId);
  const now = Date.now();

  if (existing) {
    existing.topics.add(topic);
    // Respect the hard cap: if we've already waited MAX_WAIT_MS since the
    // first event, let the pending timer stand rather than pushing it out
    // again — otherwise a steady stream of events would starve the sync.
    if (now - existing.firstQueuedAt >= MAX_WAIT_MS) return;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void fire(slStoreId), DEBOUNCE_MS);
    // Timers must not hold the process open during shutdown.
    existing.timer.unref?.();
    return;
  }

  const timer = setTimeout(() => void fire(slStoreId), DEBOUNCE_MS);
  timer.unref?.();
  pending.set(slStoreId, {
    organizationId,
    timer,
    firstQueuedAt: now,
    topics: new Set([topic]),
  });
}

/** Run the coalesced sync for a store. Never throws. */
async function fire(slStoreId: number): Promise<void> {
  const entry = pending.get(slStoreId);
  if (!entry) return;
  pending.delete(slStoreId);

  const { organizationId, topics, firstQueuedAt } = entry;
  inFlight.add(slStoreId);
  const waitedMs = Date.now() - firstQueuedAt;

  try {
    const report = await runSyncCycle({
      organizationId,
      slStoreId,
      triggeredBy: 0, // system
    });
    if (report.error) {
      console.warn(
        `[shopline-realtime] sync failed store=${slStoreId} topics=[${Array.from(topics).join(",")}] error=${report.error}`,
      );
    } else {
      console.info(
        `[shopline-realtime] synced store=${slStoreId} after ${waitedMs}ms ` +
          `topics=[${Array.from(topics).join(",")}] orders=${report.ordersIngested} ` +
          `payments=${report.paymentsIngested} matched=${report.matchedCount} exceptions=${report.exceptionCount}`,
      );
    }
  } catch (err) {
    console.error(`[shopline-realtime] sync threw for store=${slStoreId}:`, err);
  } finally {
    inFlight.delete(slStoreId);
    // Events that arrived mid-run get exactly one follow-up pass.
    const orgForRerun = rerunRequested.get(slStoreId);
    if (orgForRerun !== undefined) {
      rerunRequested.delete(slStoreId);
      scheduleReconciliation(orgForRerun, slStoreId, "orders/updated");
    }
  }
}
