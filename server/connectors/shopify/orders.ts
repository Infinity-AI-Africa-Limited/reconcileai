import { assertEgressAllowed } from "../../_core/egress";
import { SHOPIFY_API_VERSION } from "../../../drizzle/shopify_schema";
import { SHOPIFY_INITIAL_ORDER_WINDOW_DAYS } from "../../../shared/shopifyOrderSync";
import { normalizeShopDomain } from "./auth";
import { getValidShopifyAccessToken } from "./tokenStore";

/** Five minutes re-read on every cycle so records landing on a watermark seam are recovered. */
export const SHOPIFY_ORDER_WATERMARK_OVERLAP_MS = 5 * 60_000;
/**
 * The first order sync reads the whole of read_orders' 60-day access window, so
 * a merchant's settlement files from before the install still have orders to
 * match. At one day, nearly every row of a historical file named an order
 * ReconcileAI had never synced and was flagged as an exception.
 *
 * It is not read in one piece: see SHOPIFY_ORDER_WINDOW_MAX_SPAN_MS.
 */
export const SHOPIFY_INITIAL_ORDER_WINDOW_MS = SHOPIFY_INITIAL_ORDER_WINDOW_DAYS * 24 * 60 * 60_000;
/**
 * The most one sync cycle reads. MAX_ORDER_PAGES × SHOPIFY_ORDER_PAGE_SIZE caps a
 * window at 100,000 orders, and a window that hits the cap fails closed without
 * writing a watermark — so a single 60-day window would fail every first sync of
 * a store averaging over ~1,670 orders a day, forever. In 7-day steps each cycle
 * commits its watermark and the next starts there, so a large backfill advances
 * and resumes after a failure; only a store over ~14,000 orders a day in one
 * week still hits the cap. `runShopifyOrderSyncToNow` walks the steps.
 */
export const SHOPIFY_ORDER_WINDOW_MAX_SPAN_MS = 7 * 24 * 60 * 60_000;
export const SHOPIFY_ORDER_PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 1_000;
export const SHOPIFY_ORDER_PAGE_ATTEMPTS = 4;
const SHOPIFY_ORDER_RETRY_BASE_MS = 500;
const SHOPIFY_ORDER_RETRY_MAX_MS = 30_000;
const SHOPIFY_ORDER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The order's amount is its total BEFORE refunds (`totalPriceSet`): what the
 * customer was charged, and so what the gateway settles as the payment. Each
 * refund is recorded as its own money-out row (see SHOPIFY_ORDER_REFUNDS_QUERY),
 * matching the gateway's own refund line. `currentTotalPriceSet` — the total
 * net of refunds — was used before, and a partially refunded order then never
 * matched its own gross payment.
 *
 * `totalRefundedSet` says which orders have refunds to read; only those are
 * asked for them, so this page's cost stays near what it was. Only shopMoney's
 * MoneyV2 fields are selected; no presentment/customer/order-detail object
 * crosses the connector boundary.
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
      totalPrice: totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalRefunded: totalRefundedSet {
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

/**
 * The refunds of orders that have any: id, time and amount only — no line
 * items, note or staff member. `refunds` is a plain list, not a paginated
 * connection, so completeness is checked by the caller: a list as long as
 * `first` may have been cut short (see fetchShopifyOrderRefunds).
 */
export const SHOPIFY_ORDER_REFUNDS_QUERY = `query ReconcileAIOrderRefunds($ids: [ID!]!, $first: Int!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      refunds(first: $first) {
        id
        createdAt
        totalRefunded: totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
}`;

/** There is deliberately no generic arbitrary-query entry point in this client. */
export const SHOPIFY_READ_ONLY_QUERY_ALLOWLIST = Object.freeze({
  orders: SHOPIFY_ORDERS_QUERY,
  orderRefunds: SHOPIFY_ORDER_REFUNDS_QUERY,
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
  if (!(Object.values(SHOPIFY_READ_ONLY_QUERY_ALLOWLIST) as string[]).includes(query)) {
    throw new Error("Shopify order operation is not allowlisted");
  }
}

interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface NormalizedShopifyRefund {
  /** `gid://shopify/Refund/<id>`. */
  gid: string;
  /** Shopify may omit it; the ledger row then falls back to the order's update time. */
  createdAt: string | null;
  /** Money returned by this refund: non-negative, in shop currency. */
  amount: string;
  currencyCode: string;
}

export interface NormalizedShopifyOrder {
  gid: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Shopify returns null until an order has been processed; keep that absence explicit. */
  processedAt: string | null;
  currencyCode: string;
  /** The order total before refunds — what the customer was charged. */
  totalPrice: ShopifyMoney;
  /** Money refunded so far, across all refunds. */
  totalRefunded: ShopifyMoney;
  /** Every refund; empty unless money was refunded. Zero-amount refunds included. */
  refunds: NormalizedShopifyRefund[];
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
}

type ShopifyMoneyBagNode = { shopMoney?: { amount?: unknown; currencyCode?: unknown } | null } | null;

interface ShopifyOrderNode {
  id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  processedAt?: unknown;
  currencyCode?: unknown;
  totalPrice?: ShopifyMoneyBagNode;
  totalRefunded?: ShopifyMoneyBagNode;
  displayFinancialStatus?: unknown;
  cancelledAt?: unknown;
}

interface ShopifyRefundNode {
  id?: unknown;
  createdAt?: unknown;
  totalRefunded?: ShopifyMoneyBagNode;
}

interface OrderRefundsGraphqlData {
  nodes?: Array<{ id?: unknown; refunds?: ShopifyRefundNode[] | null } | null>;
}

interface OrdersGraphqlData {
  orders?: {
    nodes?: ShopifyOrderNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    userErrors?: Array<{ message?: string }>;
  };
  userErrors?: Array<{ message?: string }>;
}

/**
 * Shopify's GraphQL Admin API is rate-limited by query COST, not request
 * count, and a throttled query is answered HTTP 200 with a `THROTTLED` error —
 * never 429. `extensions.cost.throttleStatus` reports the bucket after each call.
 */
interface GraphqlThrottleStatus {
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

interface GraphqlCost {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: GraphqlThrottleStatus;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  extensions?: { cost?: GraphqlCost };
}

export class ShopifyOrderApiError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "HTTP_ERROR"
      | "INVALID_RESPONSE"
      | "GRAPHQL_ERROR"
      | "USER_ERROR"
      | "PAGINATION_ERROR"
      | "THROTTLED"
      | "REFUNDS_TRUNCATED",
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

function money(node: ShopifyMoneyBagNode | undefined, field: string, options: { nonNegative?: boolean } = {}): ShopifyMoney {
  const amount = text(node?.shopMoney?.amount, `${field}.amount`);
  const pattern = options.nonNegative ? /^\d+(?:\.\d+)?$/ : /^-?\d+(?:\.\d+)?$/;
  if (!pattern.test(amount)) {
    throw new ShopifyOrderApiError(`Shopify order ${field}.amount is invalid`, "INVALID_RESPONSE");
  }
  return { amount, currencyCode: text(node?.shopMoney?.currencyCode, `${field}.currencyCode`) };
}

/** True when a decimal amount is above zero. */
export function isPositiveAmount(amount: string): boolean {
  return Number(amount) > 0;
}

export function normalizeShopifyOrder(node: ShopifyOrderNode): NormalizedShopifyOrder {
  const currencyCode = text(node.currencyCode, "currencyCode");
  return {
    gid: text(node.id, "id"),
    name: text(node.name, "name"),
    createdAt: iso(node.createdAt, "createdAt"),
    updatedAt: iso(node.updatedAt, "updatedAt"),
    processedAt: nullableIso(node.processedAt, "processedAt"),
    currencyCode,
    totalPrice: money(node.totalPrice, "totalPrice"),
    totalRefunded: money(node.totalRefunded, "totalRefunded", { nonNegative: true }),
    // Read separately, and only for orders that have refunded money.
    refunds: [],
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

const SHOPIFY_REFUND_GID = /^gid:\/\/shopify\/Refund\/[1-9]\d{0,19}$/;

export function normalizeShopifyRefund(node: ShopifyRefundNode): NormalizedShopifyRefund {
  const gid = text(node.id, "refund.id");
  // Stored in a 64-character key column; the pattern also bounds its length.
  if (!SHOPIFY_REFUND_GID.test(gid)) {
    throw new ShopifyOrderApiError("Shopify order refund.id is invalid", "INVALID_RESPONSE");
  }
  const refunded = money(node.totalRefunded, "refund.totalRefunded", { nonNegative: true });
  return {
    gid,
    createdAt: nullableIso(node.createdAt, "refund.createdAt"),
    amount: refunded.amount,
    currencyCode: refunded.currencyCode,
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
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(response: Response, now: () => number): number | null {
  const value = response.headers?.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, SHOPIFY_ORDER_RETRY_MAX_MS);
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now()), SHOPIFY_ORDER_RETRY_MAX_MS);
}

function transientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Every GraphQL error is a cost throttle — the only GraphQL error worth retrying. */
function onlyThrottled(errors: GraphqlResponse<unknown>["errors"]): boolean {
  return !!errors?.length && errors.every((error) => error.extensions?.code === "THROTTLED");
}

/**
 * How long until the bucket holds enough for another query of this cost, from
 * the throttle status Shopify returned. Null when Shopify did not report one.
 */
export function shopifyThrottleWaitMs(cost: GraphqlCost | undefined): number | null {
  const status = cost?.throttleStatus;
  const available = status?.currentlyAvailable;
  const restoreRate = status?.restoreRate;
  const needed = cost?.requestedQueryCost;
  if (
    typeof available !== "number" ||
    typeof restoreRate !== "number" ||
    typeof needed !== "number" ||
    !(restoreRate > 0)
  ) {
    return null;
  }
  const deficit = needed - available;
  if (deficit <= 0) return 0;
  return Math.min(Math.ceil((deficit / restoreRate) * 1_000), SHOPIFY_ORDER_RETRY_MAX_MS);
}

function backoffMs(attempt: number): number {
  return Math.min(SHOPIFY_ORDER_RETRY_BASE_MS * 2 ** (attempt - 1), SHOPIFY_ORDER_RETRY_MAX_MS);
}

/**
 * One page, parsed. Retries a dropped connection, a 429/5xx, and a GraphQL
 * cost throttle — which Shopify answers with HTTP 200, so an HTTP-only retry
 * would never see it and a busy store's whole window would fail.
 */
async function fetchOrderPage<T = OrdersGraphqlData>(
  endpoint: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  deps: Pick<ShopifyOrderFetchDeps, "sleep" | "now">,
): Promise<GraphqlResponse<T>> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  for (let attempt = 1; attempt <= SHOPIFY_ORDER_PAGE_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        ...init,
        // A fresh timeout is required for every attempt; an already-aborted
        // signal would turn all retries into immediate failures.
        signal: AbortSignal.timeout(SHOPIFY_ORDER_REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === SHOPIFY_ORDER_PAGE_ATTEMPTS) {
        throw new ShopifyOrderApiError("Shopify order query failed after transient network errors", "HTTP_ERROR");
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!response.ok) {
      if (!transientHttpStatus(response.status) || attempt === SHOPIFY_ORDER_PAGE_ATTEMPTS) {
        throw new ShopifyOrderApiError(`Shopify order query failed (${response.status})`, "HTTP_ERROR");
      }
      await sleep(retryAfterMs(response, now) ?? backoffMs(attempt));
      continue;
    }

    let body: GraphqlResponse<T>;
    try {
      body = (await response.json()) as GraphqlResponse<T>;
    } catch {
      throw new ShopifyOrderApiError("Shopify order query returned invalid JSON", "INVALID_RESPONSE");
    }
    if (!onlyThrottled(body.errors)) return body;
    if (attempt === SHOPIFY_ORDER_PAGE_ATTEMPTS) {
      throw new ShopifyOrderApiError("Shopify order query stayed throttled after retries", "THROTTLED");
    }
    // Wait for the reported deficit to restore; fall back to backoff when the
    // response carried no throttle status.
    await sleep(Math.max(shopifyThrottleWaitMs(body.extensions?.cost) ?? 0, backoffMs(attempt)));
  }

  // The bounded loop either returns or throws; this keeps the invariant explicit.
  throw new ShopifyOrderApiError("Shopify order query failed", "HTTP_ERROR");
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
    const body: GraphqlResponse<OrdersGraphqlData> = await fetchOrderPage<OrdersGraphqlData>(endpoint, {
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
    }, fetchImpl, deps);

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
    // Pace the next page by the bucket Shopify just reported, rather than
    // spending it down and waiting to be throttled.
    const pause = shopifyThrottleWaitMs(body.extensions?.cost);
    if (pause) await (deps.sleep ?? defaultSleep)(pause);
  }

  const orders = [...byGid.values()].sort(
    (left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.gid.localeCompare(right.gid),
  );
  const refunded = orders.filter((order) => isPositiveAmount(order.totalRefunded.amount));
  if (refunded.length === 0) return orders;

  const refundsByOrder = await fetchShopifyOrderRefunds(
    refunded.map((order) => order.gid),
    { endpoint, accessToken, fetchImpl },
    deps,
  );
  // Every refund, including any that returned no money: the sync records only
  // those that did, but must see the rest to restate a row it stored earlier.
  return orders.map((order) => ({ ...order, refunds: refundsByOrder.get(order.gid) ?? [] }));
}

/**
 * Orders per refunds request, and refunds read per order on the first pass.
 * Shopify prices a query by what it may return, against a 1,000-point ceiling
 * per query: 10 orders × 10 refunds stays well under it, as does the
 * single-order second pass. An order with SHOPIFY_REFUNDS_PER_ORDER_MAX refunds
 * or more fails the cycle closed (`refunds_truncated`) — far beyond any real
 * order, and visible on the store's sync status if it ever happens.
 */
export const SHOPIFY_REFUND_ORDERS_PER_REQUEST = 10;
export const SHOPIFY_REFUNDS_PER_ORDER = 10;
/** The second, single-order pass for an order whose list filled the first. */
export const SHOPIFY_REFUNDS_PER_ORDER_MAX = 100;

async function fetchRefundsOf(
  ids: string[],
  first: number,
  client: { endpoint: string; accessToken: string; fetchImpl: typeof fetch },
  deps: ShopifyOrderFetchDeps,
): Promise<Map<string, NormalizedShopifyRefund[]>> {
  const body = await fetchOrderPage<OrderRefundsGraphqlData>(client.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": client.accessToken,
    },
    body: JSON.stringify({ query: SHOPIFY_ORDER_REFUNDS_QUERY, variables: { ids, first } }),
  }, client.fetchImpl, deps);
  if (body.errors?.length) {
    throw new ShopifyOrderApiError("Shopify refund query returned GraphQL errors", "GRAPHQL_ERROR");
  }
  const nodes = body.data?.nodes;
  if (!Array.isArray(nodes)) {
    throw new ShopifyOrderApiError("Shopify refund query response is incomplete", "INVALID_RESPONSE");
  }
  const byOrder = new Map<string, NormalizedShopifyRefund[]>();
  for (const node of nodes) {
    // An order read moments ago that is now missing (deleted in between) or
    // malformed: fail the cycle rather than record it without its refunds. The
    // next cycle reads the store afresh.
    if (!node || typeof node.id !== "string" || !ids.includes(node.id) || !Array.isArray(node.refunds)) {
      throw new ShopifyOrderApiError("Shopify refund query returned an unexpected order", "INVALID_RESPONSE");
    }
    byOrder.set(node.id, node.refunds.map(normalizeShopifyRefund));
  }
  if (byOrder.size !== ids.length) {
    throw new ShopifyOrderApiError("Shopify refund query did not return every order", "INVALID_RESPONSE");
  }
  // Pace the next request by the bucket Shopify just reported, as order pages are.
  const pause = shopifyThrottleWaitMs(body.extensions?.cost);
  if (pause) await (deps.sleep ?? defaultSleep)(pause);
  return byOrder;
}

/**
 * Every refund of the given orders. `refunds` is a plain list with no
 * pagination, so a list as long as the limit asked for may have been cut
 * short: such an order is read again on its own with a far larger limit, and
 * if that list fills too the cycle fails rather than record an incomplete set
 * — a missing refund would leave the ledger overstated with nothing to show it.
 */
export async function fetchShopifyOrderRefunds(
  orderGids: string[],
  client: { endpoint: string; accessToken: string; fetchImpl: typeof fetch },
  deps: ShopifyOrderFetchDeps = {},
): Promise<Map<string, NormalizedShopifyRefund[]>> {
  assertMinimalReadOnlyOrderQuery(SHOPIFY_ORDER_REFUNDS_QUERY);
  const result = new Map<string, NormalizedShopifyRefund[]>();
  for (let index = 0; index < orderGids.length; index += SHOPIFY_REFUND_ORDERS_PER_REQUEST) {
    const ids = orderGids.slice(index, index + SHOPIFY_REFUND_ORDERS_PER_REQUEST);
    const batch = await fetchRefundsOf(ids, SHOPIFY_REFUNDS_PER_ORDER, client, deps);
    for (const [gid, refunds] of batch) {
      if (refunds.length < SHOPIFY_REFUNDS_PER_ORDER) {
        result.set(gid, refunds);
        continue;
      }
      const full = (await fetchRefundsOf([gid], SHOPIFY_REFUNDS_PER_ORDER_MAX, client, deps)).get(gid) ?? [];
      if (full.length >= SHOPIFY_REFUNDS_PER_ORDER_MAX) {
        throw new ShopifyOrderApiError("Shopify order has more refunds than can be read", "REFUNDS_TRUNCATED");
      }
      result.set(gid, full);
    }
  }
  return result;
}

export function computeShopifyOrderWindow(params: {
  now: Date;
  watermark: Date | null;
  overlapMs?: number;
  initialWindowMs?: number;
  maxSpanMs?: number;
}): { from: Date; to: Date } {
  const overlap = params.overlapMs ?? SHOPIFY_ORDER_WATERMARK_OVERLAP_MS;
  const initial = params.initialWindowMs ?? SHOPIFY_INITIAL_ORDER_WINDOW_MS;
  const maxSpan = params.maxSpanMs ?? SHOPIFY_ORDER_WINDOW_MAX_SPAN_MS;
  const now = new Date(params.now);
  const candidate = params.watermark
    ? new Date(params.watermark.getTime() - overlap)
    : new Date(now.getTime() - initial);
  const from = candidate > now ? new Date(now.getTime() - overlap) : candidate;
  // A window ending before `now` is a step of a longer catch-up, not a failure:
  // its end becomes the watermark and the next cycle starts from there.
  const to = new Date(Math.min(now.getTime(), from.getTime() + maxSpan));
  return { from, to };
}
