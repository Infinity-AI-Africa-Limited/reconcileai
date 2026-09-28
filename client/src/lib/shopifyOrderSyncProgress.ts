/**
 * Where a store's order-evidence sync stands, from the sync cursor alone.
 *
 * Manual syncs run on the job queue, so the page cannot wait on the request —
 * it reads the cursor instead, and so still knows after a reload:
 *   pending  a sync was requested and no outcome has been recorded since
 *   stalled  pending for longer than any sync should take — the run may have
 *            been lost with a restart; asking again is safe (repeat requests
 *            for one store coalesce)
 *   failed   the latest recorded outcome is an error
 *   current  the latest recorded outcome is a success
 *   never    nothing has been synced or requested yet
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
  lastErrorAt: string | null;
  requestedAt: string | null;
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function shopifySyncProgress(sync: ShopifySyncCursorView, now: Date): ShopifySyncProgress {
  const requested = time(sync.requestedAt);
  const succeeded = time(sync.lastSuccessfulAt);
  const failed = time(sync.lastErrorAt);

  const answeredSince = (at: number | null) => at !== null && requested !== null && at >= requested;
  if (requested !== null && !answeredSince(succeeded) && !answeredSince(failed)) {
    return now.getTime() - requested > SHOPIFY_SYNC_STALL_MS ? "stalled" : "pending";
  }
  // A success clears lastErrorCode, so a code that is still set is the latest outcome.
  if (sync.lastErrorCode) return "failed";
  return succeeded !== null ? "current" : "never";
}

/** Whether the page should keep asking the server for the outcome. */
export function shouldPollShopifySync(progress: ShopifySyncProgress): boolean {
  return progress === "pending";
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
