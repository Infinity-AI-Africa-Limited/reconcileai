import { assertEgressAllowed } from "../../_core/egress";
import { SHOPIFY_API_VERSION } from "../../../drizzle/shopify_schema";
import { normalizeShopDomain } from "./auth";
import { getValidShopifyAccessToken } from "./tokenStore";

/** Five minutes re-read on every cycle so records landing on a watermark seam are recovered. */
export const SHOPIFY_ORDER_WATERMARK_OVERLAP_MS = 5 * 60_000;
/** The first order sync stays well inside read_orders' recent-order access window. */
export const SHOPIFY_INITIAL_ORDER_WINDOW_MS = 24 * 60 * 60_000;
export const SHOPIFY_ORDER_PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 1_000;

/**
 * Shopify Admin 2026-07 exposes the current total as currentTotalPriceSet.
 * Alias it to the product name and select only shopMoney's MoneyV2 fields; no
 * presentment/customer/order-detail object crosses the connector boundary.
 */
export const SHOPIFY_ORDERS_QUERY = `query ReconcileAIOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id
      name
      createdAt
      updatedAt
      processedAt
      currencyCode
      currentTotalPrice: currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      displayFinancialStatus
      cancelledAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

/** There is deliberately no generic arbitrary-query entry point in this client. */
export const SHOPIFY_READ_ONLY_QUERY_ALLOWLIST = Object.freeze({
  orders: SHOPIFY_ORDERS_QUERY,
});

const DENIED_ORDER_FIELDS = [
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
] as const;

/** Build-time/testable guard against accidentally widening the fixed operation. */
export function assertMinimalReadOnlyOrderQuery(query: string): void {
  if (!/^\s*query\b/.test(query) || /\bmutation\b/i.test(query)) {
    throw new Error("Shopify order operation must be a read-only query");
  }
  for (const field of DENIED_ORDER_FIELDS) {
    if (new RegExp(`\\b${field}\\b`).test(query)) {
      throw new Error(`Shopify order operation requests denied field ${field}`);
    }
  }
  if (query !== SHOPIFY_READ_ONLY_QUERY_ALLOWLIST.orders) {
    throw new Error("Shopify order operation is not allowlisted");
  }
}

export interface NormalizedShopifyOrder {
  gid: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Shopify returns null until an order has been processed; keep that absence explicit. */
  processedAt: string | null;
  currencyCode: string;
  currentTotalPrice: { amount: string; currencyCode: string };
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
}

interface ShopifyOrderNode {
  id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  processedAt?: unknown;
  currencyCode?: unknown;
  currentTotalPrice?: { shopMoney?: { amount?: unknown; currencyCode?: unknown } | null } | null;
  displayFinancialStatus?: unknown;
  cancelledAt?: unknown;
}

interface OrdersGraphqlData {
  orders?: {
    nodes?: ShopifyOrderNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    userErrors?: Array<{ message?: string }>;
  };
  userErrors?: Array<{ message?: string }>;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export class ShopifyOrderApiError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "HTTP_ERROR"
      | "INVALID_RESPONSE"
      | "GRAPHQL_ERROR"
      | "USER_ERROR"
      | "PAGINATION_ERROR",
  ) {
    super(message);
    this.name = "ShopifyOrderApiError";
  }
}

function endpointFor(shopDomain: string): string {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) throw new Error("Invalid Shopify shop domain");
  return `https://${normalized}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new ShopifyOrderApiError(`Shopify order ${field} is invalid`, "INVALID_RESPONSE");
  }
  return new Date(value).toISOString();
}

function nullableIso(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : iso(value, field);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShopifyOrderApiError(`Shopify order ${field} is invalid`, "INVALID_RESPONSE");
  }
  return value;
}

export function normalizeShopifyOrder(node: ShopifyOrderNode): NormalizedShopifyOrder {
  const amount = text(node.currentTotalPrice?.shopMoney?.amount, "currentTotalPrice.amount");
  if (!/^-?\d+(?:\.\d+)?$/.test(amount)) {
    throw new ShopifyOrderApiError("Shopify order currentTotalPrice.amount is invalid", "INVALID_RESPONSE");
  }
  const currencyCode = text(node.currencyCode, "currencyCode");
  const moneyCurrency = text(node.currentTotalPrice?.shopMoney?.currencyCode, "currentTotalPrice.currencyCode");
  return {
    gid: text(node.id, "id"),
    name: text(node.name, "name"),
    createdAt: iso(node.createdAt, "createdAt"),
    updatedAt: iso(node.updatedAt, "updatedAt"),
    processedAt: nullableIso(node.processedAt, "processedAt"),
    currencyCode,
    currentTotalPrice: { amount, currencyCode: moneyCurrency },
    displayFinancialStatus:
      node.displayFinancialStatus === null || node.displayFinancialStatus === undefined
        ? null
        : text(node.displayFinancialStatus, "displayFinancialStatus"),
    cancelledAt:
      node.cancelledAt === null || node.cancelledAt === undefined
        ? null
        : iso(node.cancelledAt, "cancelledAt"),
  };
}

function searchWindow(from: Date, to: Date): string {
  // Dates are generated by this process, not interpolated from provider/user text.
  return `updated_at:>='${from.toISOString()}' updated_at:<='${to.toISOString()}'`;
}

function userErrors(data: OrdersGraphqlData | undefined): Array<{ message?: string }> {
  return [...(data?.userErrors ?? []), ...(data?.orders?.userErrors ?? [])];
}

export interface FetchShopifyOrdersParams {
  storeId: number;
  organizationId: number;
  shopDomain: string;
  from: Date;
  to: Date;
}

export interface ShopifyOrderFetchDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: typeof getValidShopifyAccessToken;
}

/**
 * Fetch a complete updated_at window using the tenant-scoped, refreshing token
 * store. The returned records are de-duplicated and sorted deterministically;
 * raw responses are neither returned nor logged.
 */
export async function fetchShopifyOrdersWindow(
  params: FetchShopifyOrdersParams,
  deps: ShopifyOrderFetchDeps = {},
): Promise<NormalizedShopifyOrder[]> {
  assertMinimalReadOnlyOrderQuery(SHOPIFY_ORDERS_QUERY);
  if (!(params.from instanceof Date) || !(params.to instanceof Date) || params.from > params.to) {
    throw new Error("Invalid Shopify order sync window");
  }

  const accessToken = await (deps.getAccessToken ?? getValidShopifyAccessToken)({
    storeId: params.storeId,
    organizationId: params.organizationId,
  });
  const endpoint = endpointFor(params.shopDomain);
  assertEgressAllowed(endpoint, "Shopify order sync");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const byGid = new Map<string, NormalizedShopifyOrder>();
  const seenCursors = new Set<string>();
  let after: string | null = null;

  for (let pageNumber = 1; pageNumber <= MAX_ORDER_PAGES; pageNumber += 1) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: SHOPIFY_ORDERS_QUERY,
        variables: {
          first: SHOPIFY_ORDER_PAGE_SIZE,
          after,
          query: searchWindow(params.from, params.to),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new ShopifyOrderApiError(`Shopify order query failed (${response.status})`, "HTTP_ERROR");
    }

    let body: GraphqlResponse<OrdersGraphqlData>;
    try {
      body = (await response.json()) as GraphqlResponse<OrdersGraphqlData>;
    } catch {
      throw new ShopifyOrderApiError("Shopify order query returned invalid JSON", "INVALID_RESPONSE");
    }
    if (body.errors?.length) {
      throw new ShopifyOrderApiError("Shopify order query returned GraphQL errors", "GRAPHQL_ERROR");
    }
    if (userErrors(body.data).length) {
      throw new ShopifyOrderApiError("Shopify order query returned user errors", "USER_ERROR");
    }
    const connection = body.data?.orders;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new ShopifyOrderApiError("Shopify order query response is incomplete", "INVALID_RESPONSE");
    }

    for (const node of connection.nodes) {
      const normalized = normalizeShopifyOrder(node);
      const existing = byGid.get(normalized.gid);
      if (
        !existing ||
        normalized.updatedAt > existing.updatedAt ||
        (normalized.updatedAt === existing.updatedAt && normalized.gid < existing.gid)
      ) {
        byGid.set(normalized.gid, normalized);
      }
    }

    if (!connection.pageInfo.hasNextPage) break;
    const next = connection.pageInfo.endCursor;
    if (!next || seenCursors.has(next)) {
      throw new ShopifyOrderApiError("Shopify order pagination cursor did not advance", "PAGINATION_ERROR");
    }
    seenCursors.add(next);
    after = next;
    if (pageNumber === MAX_ORDER_PAGES) {
      throw new ShopifyOrderApiError("Shopify order pagination exceeded its safety limit", "PAGINATION_ERROR");
    }
  }

  return [...byGid.values()].sort(
    (left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.gid.localeCompare(right.gid),
  );
}

export function computeShopifyOrderWindow(params: {
  now: Date;
  watermark: Date | null;
  overlapMs?: number;
  initialWindowMs?: number;
}): { from: Date; to: Date } {
  const overlap = params.overlapMs ?? SHOPIFY_ORDER_WATERMARK_OVERLAP_MS;
  const initial = params.initialWindowMs ?? SHOPIFY_INITIAL_ORDER_WINDOW_MS;
  const to = new Date(params.now);
  const candidate = params.watermark
    ? new Date(params.watermark.getTime() - overlap)
    : new Date(to.getTime() - initial);
  const from = candidate > to ? new Date(to.getTime() - overlap) : candidate;
  return { from, to };
}
