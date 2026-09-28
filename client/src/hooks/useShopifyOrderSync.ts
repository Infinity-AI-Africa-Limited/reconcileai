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
  withOwnRequest,
} from "@/lib/shopifyOrderSyncProgress";

/**
 * Requests a queued order sync and follows it through the workspace context.
 * `refresh` reloads the context without the page's full loading state, and
 * must be stable (useCallback), or polling restarts on every render.
 */
export function useShopifyOrderSync(
  sync: ShopifyAppBridgeContext["sync"] | null,
  refresh: () => Promise<void>,
) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // OUR request, numbered among the store's: until a loaded context counts it,
  // the page follows it itself — even if the reload right after asking fails,
  // or an older poll answers after it.
  const [ownRequest, setOwnRequest] = useState<{ requestNumber: number; requestedAt: string } | null>(null);
  const [now, setNow] = useState(() => new Date());

  const progress = sync ? shopifySyncProgress(withOwnRequest(sync, ownRequest), now) : "never";
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
      setOwnRequest({ requestNumber: queued.requestNumber, requestedAt: queued.requestedAt });
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
    requestedHere: ownRequest !== null,
    canRequest: canRequestShopifySync(progress, requesting),
    request,
  };
}
