/**
 * Where a store's order-evidence sync stands, from the sync cursor alone.
 *
 * Manual syncs run on the job queue, so the page cannot wait on the request —
 * it reads the cursor instead, and so still knows after a reload:
 *   pending  a manual sync was requested and no run that started after it has
 *            finished yet (requestSeq > answeredSeq)
 *   stalled  pending for longer than any sync should take — the run may have
 *            been lost with a restart; asking again is safe (repeat requests
 *            for one store coalesce), and the page keeps checking, slowly
 *   failed   the latest recorded outcome is an error
 *   current  the latest recorded outcome is a success
 *   never    nothing has been synced or requested yet
 *
 * Requests are counted, not timed (server/connectors/shopify/manualSync.ts): a
 * run answers exactly the requests made before it started, so neither a webhook
 * sync finishing mid-request nor two events in the same second can end a wait
 * early. requestedAt is used only to notice a stall.
 */
export type ShopifySyncProgress = "pending" | "stalled" | "failed" | "current" | "never";

/**
 * A first sync reads 60 days in 7-day steps; at Shopify's pacing the largest
 * stores need around half an hour, so a request still pending after this is
 * treated as stalled.
 */
export const SHOPIFY_SYNC_STALL_MS = 45 * 60_000;

export type ShopifySyncCursorView = {
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  requestedAt: string | null;
  requestSeq: number;
  answeredSeq: number;
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function shopifySyncProgress(sync: ShopifySyncCursorView, now: Date): ShopifySyncProgress {
  if (sync.requestSeq > sync.answeredSeq) {
    const requested = time(sync.requestedAt);
    return requested !== null && now.getTime() - requested > SHOPIFY_SYNC_STALL_MS ? "stalled" : "pending";
  }
  // A success clears lastErrorCode, so a code that is still set is the latest outcome.
  if (sync.lastErrorCode) return "failed";
  return time(sync.lastSuccessfulAt) !== null ? "current" : "never";
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

/** The cursor as the page should judge it, given a request this page made itself. */
export function withLatestRequest(
  sync: ShopifySyncCursorView,
  own: { requestSeq: number; requestedAt: string } | null,
): ShopifySyncCursorView {
  if (!own || own.requestSeq <= sync.requestSeq) return sync;
  return { ...sync, requestSeq: own.requestSeq, requestedAt: own.requestedAt };
}
