import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createShopifyCaseReview } from "./shopifyCaseReview";
import { ShopifyAppHomeClientError, type ShopifyCase, type ShopifyCasePage } from "./shopifyAppBridge";
import { ShopifyCaseReviewPanel } from "@/components/ShopifyCaseReviewPanel";
const row = (caseId: number): ShopifyCase => ({ caseId, category: "unmatched", severity: "high", status: "open", amount: "9999999999999999.99", currency: "USD", createdAt: "2026-01-03T00:00:00Z", evidenceDate: "2026-01-02T00:00:00Z", sourceKind: "shopify_refund" });
const page: ShopifyCasePage = { cases: [row(1), row(2)], total: 22, page: 1, pageSize: 20 };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const render = (review: ReturnType<typeof createShopifyCaseReview>) => renderToStaticMarkup(createElement(ShopifyCaseReviewPanel, { state: review.getSnapshot(), review }));
describe("when the embedded read-only case panel is used", () => {
  it("should ignore late detail A when B has been selected and after back navigation", async () => {
    const a = deferred<ShopifyCase>(); const b = deferred<ShopifyCase>();
    const review = createShopifyCaseReview({ list: async () => page, detail: id => id === 1 ? a.promise : b.promise });
    await review.refresh(); const first = review.select(1); const second = review.select(2);
    b.resolve(row(2)); await second; a.resolve(row(1)); await first;
    expect(review.getSnapshot().detail?.caseId).toBe(2);
    review.back(); expect(review.getSnapshot().detail).toBeNull();
  });
  it("should ignore late lists and send only bounded status/page inputs", async () => {
    const a = deferred<ShopifyCasePage>(); const b = deferred<ShopifyCasePage>();
    const list = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const review = createShopifyCaseReview({ list, detail: async id => row(id) });
    const first = review.refresh(); const second = review.filter("resolved");
    b.resolve({ ...page, cases: [], total: 0 }); await second; a.resolve(page); await first;
    expect(review.getSnapshot().list?.total).toBe(0); expect(review.getSnapshot().status).toBe("resolved");
    expect(list.mock.calls).toEqual([[{ status: "unresolved", page: 1 }], [{ status: "resolved", page: 1 }]]);
    await review.page(501); expect(list).toHaveBeenCalledTimes(2);
  });
  it("should hide previous list/detail immediately on refresh and not silently show stale data after failure", async () => {
    const list = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error("RAW SECRET"));
    const review = createShopifyCaseReview({ list, detail: async id => row(id) });
    await review.refresh(); await review.select(1);
    const refreshing = review.refresh(); expect(review.getSnapshot().list).toBeNull(); expect(review.getSnapshot().detail).toBeNull();
    await refreshing;
    expect(render(review)).toContain("temporarily unavailable"); expect(render(review)).not.toContain("RAW SECRET");
    expect(render(review)).not.toContain("9999999999999999.99");
  });
  it("should clear sensitive results on auth refusal and invalidate even later successful pending replies", async () => {
    const a = deferred<ShopifyCase>(); const b = deferred<ShopifyCase>();
    const review = createShopifyCaseReview({ list: async () => page, detail: id => id === 1 ? a.promise : b.promise });
    await review.refresh(); const first = review.select(1); const second = review.select(2);
    a.reject(new ShopifyAppHomeClientError("AUTHENTICATION_REQUIRED")); await first;
    b.resolve(row(2)); await second;
    expect(review.getSnapshot()).toMatchObject({ list: null, detail: null, selected: null });
    expect(render(review)).toContain("Refresh this App Home from Shopify Admin"); expect(render(review)).not.toContain("/login");
  });
  it("should clear a disposed context and never deliver its old reply to the next shop", async () => {
    const late = deferred<ShopifyCasePage>();
    const old = createShopifyCaseReview({ list: () => late.promise, detail: async id => row(id) });
    const loading = old.refresh(); old.dispose();
    const next = createShopifyCaseReview({ list: async () => ({ ...page, total: 0, cases: [] }), detail: async id => row(id) });
    await next.refresh(); late.resolve(page); await loading;
    expect(old.getSnapshot().list).toBeNull(); expect(next.getSnapshot().list?.total).toBe(0);
  });
  it("should render list, detail, pagination, and back controls without approval, closure or platform sign-in", async () => {
    const review = createShopifyCaseReview({ list: async () => page, detail: async id => row(id) });
    await review.refresh(); const html = render(review);
    expect(html).toContain("Inspect case 1"); expect(html).toContain("Next page"); expect(html).toContain("All evidence dates");
    await review.select(1); const detail = render(review);
    expect(detail).toContain("Back to cases"); expect(detail).toContain("Primary-leg amount"); expect(detail).toContain("9999999999999999.99");
    expect(detail).not.toMatch(/Approve decision|Close case|Resolve case|Assign|Export|AI analysis|\/login|\/exceptions/);
    expect(detail).toContain("not editable here");
  });
  it("should distinguish not-found from outage and render an empty page without stray zero controls", async () => {
    const review = createShopifyCaseReview({ list: async () => page, detail: async () => { throw new ShopifyAppHomeClientError("NOT_FOUND"); } });
    await review.refresh(); await review.select(1);
    expect(render(review)).toContain("not available in this Shopify workspace");
    const empty = createShopifyCaseReview({ list: async () => ({ ...page, total: 0, cases: [] }), detail: async id => row(id) });
    await empty.refresh(); expect(render(empty)).toContain("No cases on this page"); expect(render(empty)).not.toMatch(/>(false|null)</);
  });
});
