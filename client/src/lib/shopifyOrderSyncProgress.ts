/**
 * Where a store's order-evidence sync stands, from the workspace context.
 *
 * Manual syncs run on the job queue, so the page cannot wait on the request —
 * it reads each request's own record instead, and so still knows after a
 * reload:
 *   pending  a manual sync request has not been settled by a run yet
 *   stalled  pending for longer than any sync should take — the run may have
 *            been lost with a restart; asking again is safe (repeat requests
 *            for one store coalesce), and the page keeps checking, slowly
 *   failed   the most recent recorded outcome is a failure
 *   current  the most recent recorded outcome is a success
 *   never    nothing has been synced or requested yet
 *
 * Outcomes come from two records: the sync cursor (every sync, whatever
 * triggered it) and the latest manual request (its run's outcome, or the
 * queue's refusal). The most recent of them decides, and a tie goes to failure:
 * the times are whole seconds, and a false "failed" is resolved by asking
 * again, where a false "current" would hide a failure.
 */
export type ShopifySyncProgress = "pending" | "stalled" | "failed" | "current" | "never";

/**
 * A first sync reads 60 days in 7-day steps; at Shopify's pacing the largest
 * stores need around half an hour, so a request still pending after this is
 * treated as stalled.
 */
export const SHOPIFY_SYNC_STALL_MS = 45 * 60_000;

export type ShopifySyncView = {
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /** The newest manual request, settled or not. */
  latestRequest: { status: "queued" | "succeeded" | "failed"; answeredAt: string | null } | null;
  /** When the newest request still queued was made, or null when none is. */
  pendingSince: string | null;
};

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

type Outcome = { at: number; failed: boolean };

function latestOutcome(sync: ShopifySyncView): Outcome | null {
  const outcomes: Outcome[] = [];
  const success = time(sync.lastSuccessfulAt);
  if (success !== null) outcomes.push({ at: success, failed: false });
  // A success clears lastErrorCode, so a code that is still set is the cursor's
  // latest outcome — at least as recent as its success, even when it predates
  // lastErrorAt and so carries no time.
  if (sync.lastErrorCode) {
    outcomes.push({ at: time(sync.lastErrorAt) ?? success ?? Number.NEGATIVE_INFINITY, failed: true });
  }
  const request = sync.latestRequest;
  const answered = request && request.status !== "queued" ? time(request.answeredAt) : null;
  if (request && answered !== null) outcomes.push({ at: answered, failed: request.status === "failed" });
  return outcomes.reduce<Outcome | null>((latest, outcome) => {
    if (!latest || outcome.at > latest.at) return outcome;
    return outcome.at === latest.at && outcome.failed ? outcome : latest;
  }, null);
}

export function shopifySyncProgress(sync: ShopifySyncView, now: Date): ShopifySyncProgress {
  const pendingSince = time(sync.pendingSince);
  if (pendingSince !== null) {
    return now.getTime() - pendingSince > SHOPIFY_SYNC_STALL_MS ? "stalled" : "pending";
  }
  const outcome = latestOutcome(sync);
  if (!outcome) return "never";
  return outcome.failed ? "failed" : "current";
}

export const SHOPIFY_SYNC_POLL_MS = 5_000;
/** Still checked when stalled — a slow run can finish — but no longer eagerly. */
export const SHOPIFY_SYNC_STALLED_POLL_MS = 60_000;

/** How often the page should ask the server for the outcome, or null for not at all. */
export function shopifySyncPollIntervalMs(progress: ShopifySyncProgress): number | null {
  if (progress === "pending") return SHOPIFY_SYNC_POLL_MS;
  if (progress === "stalled") return SHOPIFY_SYNC_STALLED_POLL_MS;
  return null;
}

/** Whether the merchant may ask for another sync now. */
export function canRequestShopifySync(progress: ShopifySyncProgress, requesting: boolean): boolean {
  return !requesting && progress !== "pending";
}

/**
 * The view as the page should judge it, given a request this page made. Until
 * a view loaded AFTER the request arrives (`loadedSince` false), the view on
 * screen cannot show the request, so the page treats it as pending itself —
 * otherwise a failed reload right after asking would read as "nothing to wait
 * for". Once a later view has loaded, the server's record decides.
 */
export function withOwnRequest(
  sync: ShopifySyncView,
  own: { requestedAt: string; loadedSince: boolean } | null,
): ShopifySyncView {
  if (!own || own.loadedSince) return sync;
  const pendingSince = time(sync.pendingSince);
  const requested = time(own.requestedAt);
  if (requested === null || (pendingSince !== null && pendingSince >= requested)) return sync;
  return { ...sync, pendingSince: own.requestedAt };
}
