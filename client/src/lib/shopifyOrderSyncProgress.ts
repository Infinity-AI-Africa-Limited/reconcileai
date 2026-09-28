/**
 * Where a store's order-evidence sync stands, from the sync cursor alone.
 *
 * Manual syncs run on the job queue, so the page cannot wait on the request —
 * it reads the cursor instead, and so still knows after a reload:
 *   pending  a sync was requested and is not yet answered: no manual run has
 *            finished for it, and orders are not yet synced through it
 *   stalled  pending for longer than any sync should take — the run may have
 *            been lost with a restart; asking again is safe (repeat requests
 *            for one store coalesce), and the page keeps checking, slowly
 *   failed   the latest recorded outcome is an error
 *   current  the latest recorded outcome is a success
 *   never    nothing has been synced or requested yet
 *
 * "Answered" is deliberately NOT "some outcome was recorded after the request":
 * every sync writes the same cursor, and a webhook sync that began before the
 * request but finished after it would pass that test without covering it.
 */
export type ShopifySyncProgress = "pending" | "stalled" | "failed" | "current" | "never";

/**
 * A first sync reads 60 days; at Shopify's pacing the largest stores this
 * connector can take (100,000 orders) need around half an hour, so a request
 * still pending after that is treated as stalled.
 */
export const SHOPIFY_SYNC_STALL_MS = 45 * 60_000;

export type ShopifySyncCursorView = {
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  requestedAt: string | null;
  /** The latest request a finished manual run answered. */
  answeredAt: string | null;
  /** Orders are synced through this time, whichever sync did it. */
  syncedThrough: string | null;
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function shopifySyncProgress(sync: ShopifySyncCursorView, now: Date): ShopifySyncProgress {
  const requested = time(sync.requestedAt);
  const reaches = (value: string | null) => {
    const at = time(value);
    return at !== null && requested !== null && at >= requested;
  };
  if (requested !== null && !reaches(sync.answeredAt) && !reaches(sync.syncedThrough)) {
    return now.getTime() - requested > SHOPIFY_SYNC_STALL_MS ? "stalled" : "pending";
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
export function withLatestRequest(sync: ShopifySyncCursorView, requestedAt: string | null): ShopifySyncCursorView {
  const own = time(requestedAt);
  const recorded = time(sync.requestedAt);
  if (own === null || (recorded !== null && recorded >= own)) return sync;
  return { ...sync, requestedAt };
}
