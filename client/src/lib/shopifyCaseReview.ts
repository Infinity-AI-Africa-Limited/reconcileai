import { appHomeErrorCode, loadShopifyCase, loadShopifyCases, shopifyAppHomeErrorMessage, ShopifyAppHomeClientError, type ShopifyCase, type ShopifyCasePage } from "./shopifyAppBridge";
import { SHOPIFY_CASE_MAX_PAGE, type ShopifyCaseStatusFilter } from "@shared/shopifyAppHomeCases";

export type ShopifyCaseReviewState = {
  status: ShopifyCaseStatusFilter; page: number; list: ShopifyCasePage | null;
  selected: number | null; detail: ShopifyCase | null;
  listLoading: boolean; detailLoading: boolean; error: string | null;
};
const empty = (): ShopifyCaseReviewState => ({ status: "unresolved", page: 1, list: null, selected: null, detail: null, listLoading: false, detailLoading: false, error: null });

/** Per mounted verified context, never a shared/persistent cache. No tokens. */
export function createShopifyCaseReview(api = { list: loadShopifyCases, detail: loadShopifyCase }) {
  let state = empty();
  let listSequence = 0;
  let detailSequence = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ShopifyCaseReviewState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown, current: boolean) => {
    if (disposed) return;
    const safeError = new ShopifyAppHomeClientError(appHomeErrorCode(error));
    // Even a late refusal invalidates this context's outstanding reads. An old
    // context has its own disposed controller and cannot clear the new one.
    if (appHomeErrorCode(error) === "AUTHENTICATION_REQUIRED") {
      listSequence++; detailSequence++;
      publish({ ...empty(), error: shopifyAppHomeErrorMessage(safeError) });
    } else if (current) publish({ error: shopifyAppHomeErrorMessage(safeError), listLoading: false, detailLoading: false });
  };
  const refresh = async (status = state.status, page = state.page) => {
    if (disposed || page < 1 || page > SHOPIFY_CASE_MAX_PAGE) return;
    const sequence = ++listSequence;
    detailSequence++;
    // Hide old figures immediately; a failed reload never calls them current.
    publish({ status, page, list: null, selected: null, detail: null, error: null, listLoading: true, detailLoading: false });
    try {
      const list = await api.list({ status, page });
      if (!disposed && sequence === listSequence) publish({ list, listLoading: false });
    } catch (error) { fail(error, sequence === listSequence); }
  };
  return {
    getSnapshot: () => state,
    activate() { disposed = false; },
    refuseAuthentication() { fail(new ShopifyAppHomeClientError("AUTHENTICATION_REQUIRED"), true); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    filter: (status: ShopifyCaseStatusFilter) => refresh(status, 1),
    page: (page: number) => refresh(state.status, page),
    async select(caseId: number) {
      if (disposed || !state.list?.cases.some(row => row.caseId === caseId)) return;
      const sequence = ++detailSequence;
      publish({ selected: caseId, detail: null, detailLoading: true, error: null });
      try {
        const detail = await api.detail(caseId);
        if (!disposed && sequence === detailSequence) publish({ detail, detailLoading: false });
      } catch (error) { fail(error, sequence === detailSequence); }
    },
    back() { detailSequence++; publish({ selected: null, detail: null, detailLoading: false, error: null }); },
    dispose() { disposed = true; listSequence++; detailSequence++; state = empty(); listeners.clear(); },
  };
}
export type ShopifyCaseReview = ReturnType<typeof createShopifyCaseReview>;
