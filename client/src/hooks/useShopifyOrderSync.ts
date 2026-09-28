import { useEffect, useState } from "react";
import {
  shopifyAppHomeErrorMessage,
  triggerShopifyOrderSync,
  type ShopifyAppBridgeContext,
} from "@/lib/shopifyAppBridge";
import {
  canRequestShopifySync,
  shopifySyncPollIntervalMs,
  shopifySyncProgress,
  withLatestRequest,
} from "@/lib/shopifyOrderSyncProgress";

/**
 * Requests a queued order sync and follows it through the sync cursor. `refresh`
 * reloads the workspace context without the page's full loading state, and
 * must be stable (useCallback), or polling restarts on every render.
 */
export function useShopifyOrderSync(
  sync: ShopifyAppBridgeContext["sync"] | null,
  refresh: () => Promise<void>,
) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server's answer to OUR request, so the page follows it even if the
  // context reload right after it fails.
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const progress = sync ? shopifySyncProgress(withLatestRequest(sync, requestedAt), now) : "never";
  const pollMs = shopifySyncPollIntervalMs(progress);

  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => {
      setNow(new Date());
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const request = async () => {
    setRequesting(true);
    setError(null);
    try {
      const queued = await triggerShopifyOrderSync();
      setRequestedAt(queued.requestedAt);
      setNow(new Date());
      await refresh();
    } catch (requestError) {
      setError(shopifyAppHomeErrorMessage(requestError));
    } finally {
      setRequesting(false);
    }
  };

  return {
    progress,
    requesting,
    error,
    /** True once this page requested a sync, so a success can be announced rather than merely shown. */
    requestedHere: requestedAt !== null,
    canRequest: canRequestShopifySync(progress, requesting),
    request,
  };
}
