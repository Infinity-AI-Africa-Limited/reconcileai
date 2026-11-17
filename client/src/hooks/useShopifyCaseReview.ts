import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createShopifyCaseReview } from "@/lib/shopifyCaseReview";
import { subscribeShopifyAuthRefusal, type ShopifyAppBridgeContext, type ShopifySettlementEvidenceCommitted } from "@/lib/shopifyAppBridge";

export function useShopifyCaseReview(context: ShopifyAppBridgeContext | null, imported: ShopifySettlementEvidenceCommitted | null) {
  // No internal identities are returned by context. Any changed verified shop
  // identity/view creates a fresh controller, so the very first render is empty.
  const identity = context ? JSON.stringify(context.store) : null;
  const review = useMemo(() => createShopifyCaseReview(), [identity]);
  const state = useSyncExternalStore(review.subscribe, review.getSnapshot, review.getSnapshot);
  useEffect(() => {
    review.activate();
    const unsubscribe = subscribeShopifyAuthRefusal(review.refuseAuthentication);
    if (identity !== null) void review.refresh();
    return () => { unsubscribe(); review.dispose(); };
  }, [review, identity]);
  useEffect(() => {
    if (identity !== null && imported) void review.refresh();
  }, [review, identity, imported]);
  return { state, review };
}
