/**
 * SHOPLINE API page-size limits — regression cover.
 *
 * On 2026-08-01 every sync cycle for every store failed on its very first API
 * call with:
 *
 *   SHOPLINE API 500: invalid OpenApiOrderSearchReqDTO.Limit:
 *   value must be less than or equal to 100
 *
 * `fetchOrders` defaulted to `limit=250`. SHOPLINE caps the Orders endpoint at
 * 100 and answers 500 (not 4xx) above it, so `fetchAllOrders` — the first call
 * in `runSyncCycle` — threw before a single order was fetched. No store ever
 * reached ingestion, which is why the Settlement Monitor stayed empty.
 *
 * The clamp was also applied to only ONE of each function's two branches (the
 * filter branch, not the `page_info` pagination branch), so an over-large limit
 * could still escape on page 2+. These tests pin BOTH branches of every
 * paginated endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchOrders,
  fetchPaymentTransactions,
  fetchPayouts,
  fetchBalanceTransactions,
  type ShoplineApiOptions,
} from "./connectors/shopline/apiClient";

const opts: ShoplineApiOptions = { storeHandle: "reconcileai-dev", accessToken: "test-token" };

/** Capture the URL of the last fetch and return an empty, well-formed payload. */
let lastUrl = "";
function mockFetchOk(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      lastUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ orders: [], data: [], items: [] }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
}

/** The effective `limit` query parameter of the last request. */
function sentLimit(): number {
  return Number(new URL(lastUrl).searchParams.get("limit"));
}

beforeEach(() => {
  lastUrl = "";
  mockFetchOk();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOrders — SHOPLINE caps Orders at 100", () => {
  it("defaults to 100, not the old 250 that triggered the 500", async () => {
    await fetchOrders(opts, { createdAtMin: "2026-08-01T00:00:00Z" });
    expect(sentLimit()).toBe(100);
  });

  it("clamps an over-large caller limit down to 100", async () => {
    await fetchOrders(opts, { createdAtMin: "2026-08-01T00:00:00Z", limit: 250 });
    expect(sentLimit()).toBe(100);
  });

  it("clamps on the page_info branch too — the path taken for page 2+", async () => {
    await fetchOrders(opts, { pageInfo: "cursor-abc", limit: 250 });
    expect(lastUrl).toContain("page_info=cursor-abc");
    expect(sentLimit()).toBe(100);
  });

  it("honours a smaller caller limit", async () => {
    await fetchOrders(opts, { createdAtMin: "2026-08-01T00:00:00Z", limit: 25 });
    expect(sentLimit()).toBe(25);
  });
});

describe("other paginated endpoints clamp on BOTH branches", () => {
  const window = { dateMin: "2026-07-01T00:00:00Z", dateMax: "2026-08-01T00:00:00Z" };

  it("fetchPaymentTransactions keeps its 250 default on both branches", async () => {
    await fetchPaymentTransactions(opts, window);
    expect(sentLimit()).toBe(250);
    await fetchPaymentTransactions(opts, { ...window, pageInfo: "cur" });
    expect(sentLimit()).toBe(250);
  });

  it("fetchPaymentTransactions clamps to its ceiling on the page_info branch", async () => {
    // Previously this branch was uncapped, so 99999 went out as-is.
    await fetchPaymentTransactions(opts, { ...window, pageInfo: "cur", limit: 99999 });
    expect(sentLimit()).toBe(1000);
  });

  it("fetchPayouts clamps to 100 on both branches", async () => {
    const w = { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" };
    await fetchPayouts(opts, { ...w, limit: 5000 });
    expect(sentLimit()).toBe(100);
    await fetchPayouts(opts, { ...w, pageInfo: "cur", limit: 5000 });
    expect(sentLimit()).toBe(100);
  });

  it("fetchBalanceTransactions clamps to 100 on both branches", async () => {
    await fetchBalanceTransactions(opts, { limit: 5000 });
    expect(sentLimit()).toBe(100);
    await fetchBalanceTransactions(opts, { pageInfo: "cur", limit: 5000 });
    expect(sentLimit()).toBe(100);
  });
});
