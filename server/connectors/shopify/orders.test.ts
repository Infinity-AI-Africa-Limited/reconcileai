import { describe, expect, it, vi } from "vitest";
import {
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_READ_ONLY_QUERY_ALLOWLIST,
  ShopifyOrderApiError,
  assertMinimalReadOnlyOrderQuery,
  computeShopifyOrderWindow,
  fetchShopifyOrdersWindow,
  normalizeShopifyOrder,
} from "./orders";

const rawOrder = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/1001",
  name: "#1001",
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: "2026-09-20T10:05:00Z",
  processedAt: "2026-09-20T10:01:00Z",
  currencyCode: "USD",
  currentTotalPrice: { shopMoney: { amount: "19.95", currencyCode: "USD" } },
  displayFinancialStatus: "PAID",
  cancelledAt: null,
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("the fixed Shopify order operation", () => {
  it("is the sole allowlisted read-only operation and requests no denied buyer/detail fields", () => {
    expect(Object.keys(SHOPIFY_READ_ONLY_QUERY_ALLOWLIST)).toEqual(["orders"]);
    expect(() => assertMinimalReadOnlyOrderQuery(SHOPIFY_ORDERS_QUERY)).not.toThrow();
    expect(SHOPIFY_ORDERS_QUERY).toMatch(/^query /);
    expect(SHOPIFY_ORDERS_QUERY).not.toMatch(/\bmutation\b/i);
    for (const denied of [
      "customer",
      "email",
      "phone",
      "billingAddress",
      "shippingAddress",
      "displayAddress",
      "note",
      "lineItems",
      "checkoutToken",
      "cartToken",
    ]) {
      expect(SHOPIFY_ORDERS_QUERY).not.toMatch(new RegExp(`\\b${denied}\\b`));
    }
  });

  it("rejects mutation strings, denied fields, and non-allowlisted query text", () => {
    expect(() => assertMinimalReadOnlyOrderQuery("mutation { orderCancel(id: 1) { id } }")).toThrow(/read-only/);
    expect(() => assertMinimalReadOnlyOrderQuery("query { orders(first: 1) { nodes { customer { id } } } }")).toThrow(/customer/);
    expect(() => assertMinimalReadOnlyOrderQuery("query Other { shop { id } }")).toThrow(/allowlisted/);
  });
});

describe("Shopify order normalization", () => {
  it("returns exactly the deterministic minimal fields", () => {
    expect(normalizeShopifyOrder(rawOrder())).toEqual({
      gid: "gid://shopify/Order/1001",
      name: "#1001",
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:05:00.000Z",
      processedAt: "2026-09-20T10:01:00.000Z",
      currencyCode: "USD",
      currentTotalPrice: { amount: "19.95", currencyCode: "USD" },
      displayFinancialStatus: "PAID",
      cancelledAt: null,
    });
  });

  it("refuses malformed money or timestamps rather than persisting defaults", () => {
    expect(() => normalizeShopifyOrder(rawOrder({ updatedAt: "not-a-date" }))).toThrow(ShopifyOrderApiError);
    expect(() =>
      normalizeShopifyOrder(rawOrder({ currentTotalPrice: { shopMoney: { amount: "NaN", currencyCode: "USD" } } })),
    ).toThrow(ShopifyOrderApiError);
  });

  it("keeps an unprocessed order's value date absent instead of inventing one", () => {
    expect(normalizeShopifyOrder(rawOrder({ processedAt: null })).processedAt).toBeNull();
  });
});

describe("Shopify order window fetching", () => {
  it("uses the exact tenant/store pair for token refresh, paginates, de-duplicates, and sorts", async () => {
    const getAccessToken = vi.fn(async () => "access-token");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            orders: {
              nodes: [rawOrder({ id: "gid://shopify/Order/2", name: "#2", updatedAt: "2026-09-20T10:10:00Z" })],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            orders: {
              nodes: [
                rawOrder({ id: "gid://shopify/Order/1", name: "#1", updatedAt: "2026-09-20T10:08:00Z" }),
                rawOrder({ id: "gid://shopify/Order/2", name: "#2", updatedAt: "2026-09-20T10:11:00Z" }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );

    const result = await fetchShopifyOrdersWindow(
      {
        storeId: 7,
        organizationId: 42,
        shopDomain: "merchant.myshopify.com",
        from: new Date("2026-09-20T10:00:00Z"),
        to: new Date("2026-09-20T11:00:00Z"),
      },
      { getAccessToken, fetchImpl },
    );

    expect(getAccessToken).toHaveBeenCalledWith({ storeId: 7, organizationId: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).variables).toEqual({
      first: 100,
      after: null,
      query: "updated_at:>='2026-09-20T10:00:00.000Z' updated_at:<='2026-09-20T11:00:00.000Z'",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).variables.after).toBe("cursor-1");
    expect(result.map((order) => [order.gid, order.updatedAt])).toEqual([
      ["gid://shopify/Order/1", "2026-09-20T10:08:00.000Z"],
      ["gid://shopify/Order/2", "2026-09-20T10:11:00.000Z"],
    ]);
  });

  it("does not leak Shopify GraphQL/user error text into its own error message", async () => {
    for (const body of [
      { errors: [{ message: "sensitive provider detail" }] },
      { data: { userErrors: [{ message: "sensitive provider detail" }], orders: { nodes: [], pageInfo: {} } } },
    ]) {
      await expect(
        fetchShopifyOrdersWindow(
          {
            storeId: 7,
            organizationId: 42,
            shopDomain: "merchant.myshopify.com",
            from: new Date("2026-09-20T10:00:00Z"),
            to: new Date("2026-09-20T11:00:00Z"),
          },
          { getAccessToken: vi.fn(async () => "token"), fetchImpl: vi.fn(async () => jsonResponse(body)) },
        ),
      ).rejects.not.toThrow(/sensitive provider detail/);
    }
  });

  it("refuses a non-advancing pagination cursor", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } }));
    await expect(
      fetchShopifyOrdersWindow(
        {
          storeId: 7,
          organizationId: 42,
          shopDomain: "merchant.myshopify.com",
          from: new Date("2026-09-20T10:00:00Z"),
          to: new Date("2026-09-20T11:00:00Z"),
        },
        { getAccessToken: vi.fn(async () => "token"), fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "PAGINATION_ERROR" });
  });
});

describe("the persisted watermark window", () => {
  it("overlaps a previous watermark by five minutes", () => {
    expect(
      computeShopifyOrderWindow({
        now: new Date("2026-09-20T12:00:00Z"),
        watermark: new Date("2026-09-20T11:30:00Z"),
      }),
    ).toEqual({
      from: new Date("2026-09-20T11:25:00Z"),
      to: new Date("2026-09-20T12:00:00Z"),
    });
  });

  it("uses only the last 24 hours for a first read_orders sync", () => {
    expect(
      computeShopifyOrderWindow({ now: new Date("2026-09-20T12:00:00Z"), watermark: null }).from,
    ).toEqual(new Date("2026-09-19T12:00:00Z"));
  });
});
