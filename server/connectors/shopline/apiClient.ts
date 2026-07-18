/**
 * SHOPLINE REST API Client
 *
 * Wraps all SHOPLINE API calls with:
 *   - Automatic token injection (Bearer + X-Shopline-Access-Token)
 *   - API version header (X-Shopline-Api-Version: v20260601)
 *   - Rate limit awareness (429 → exponential backoff, max 3 retries)
 *   - Structured error parsing
 *
 * Base URL pattern: https://{storeHandle}.myshopline.com/openapi/{version}/
 *
 * Key endpoints used in Phase 1:
 *   GET  /orders.json?status=paid&created_at_min=...&limit=250&page_info=...
 *   GET  /payments/transactions.json?created_at_min=...&limit=250
 *   GET  /payouts.json?date_min=...&date_max=...
 *   GET  /refunds.json?created_at_min=...
 *   POST /webhooks.json  (register webhook topics)
 *   GET  /shop.json      (store metadata)
 */

import { SHOPLINE_API_VERSION } from "../../../shared/shoplineConstants";

export interface ShoplineApiOptions {
  storeHandle: string;
  accessToken: string;
}

export interface ShoplinePaginatedResponse<T> {
  data: T[];
  /** Cursor for the next page (null when on last page) */
  nextPageInfo: string | null;
}

export class ShoplineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly shoplineCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ShoplineApiError";
  }
}

async function shoplineRequest<T>(
  opts: ShoplineApiOptions,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const url = `https://${opts.storeHandle}.myshopline.com/openapi/${SHOPLINE_API_VERSION}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.accessToken}`,
      "X-Shopline-Access-Token": opts.accessToken,
      "X-Shopline-Api-Version": SHOPLINE_API_VERSION,
      ...(init.headers ?? {}),
    },
  });

  // Rate limit — exponential backoff
  if (response.status === 429 && attempt < 3) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "2", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000 * Math.pow(2, attempt)));
    return shoplineRequest<T>(opts, path, init, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let shoplineCode: string | undefined;
    try {
      const parsed = JSON.parse(body);
      shoplineCode = parsed?.errors?.[0]?.code ?? parsed?.error_code;
    } catch { /* ignore */ }
    throw new ShoplineApiError(response.status, shoplineCode, `SHOPLINE API ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export interface ShoplineOrder {
  id: string;
  order_number: string;
  financial_status: string; // "paid" | "refunded" | "partially_refunded" | "pending"
  fulfillment_status: string | null;
  currency: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_discounts: string;
  created_at: string; // ISO 8601
  updated_at: string;
  processed_at: string;
  gateway: string; // payment gateway name
  payment_gateway_names: string[];
  transactions?: ShoplineTransaction[];
}

export async function fetchOrders(
  opts: ShoplineApiOptions,
  params: {
    status?: string;
    createdAtMin?: string;
    createdAtMax?: string;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplineOrder>> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("financial_status", params.status);
  if (params.createdAtMin) qs.set("created_at_min", params.createdAtMin);
  if (params.createdAtMax) qs.set("created_at_max", params.createdAtMax);
  qs.set("limit", String(params.limit ?? 250));
  if (params.pageInfo) qs.set("page_info", params.pageInfo);

  const result = await shoplineRequest<{ orders: ShoplineOrder[]; next_page_info?: string }>(
    opts,
    `/orders.json?${qs.toString()}`,
  );

  return {
    data: result.orders ?? [],
    nextPageInfo: result.next_page_info ?? null,
  };
}

// ─── Payment Transactions ─────────────────────────────────────────────────────

export interface ShoplineTransaction {
  id: string;
  order_id: string;
  kind: string; // "sale" | "capture" | "refund" | "void" | "authorization"
  status: string; // "success" | "failure" | "pending" | "error"
  amount: string;
  currency: string;
  gateway: string;
  created_at: string;
  processed_at: string;
  authorization: string | null;
  error_code: string | null;
  message: string | null;
}

export async function fetchTransactions(
  opts: ShoplineApiOptions,
  params: {
    createdAtMin?: string;
    createdAtMax?: string;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplineTransaction>> {
  const qs = new URLSearchParams();
  if (params.createdAtMin) qs.set("created_at_min", params.createdAtMin);
  if (params.createdAtMax) qs.set("created_at_max", params.createdAtMax);
  qs.set("limit", String(params.limit ?? 250));
  if (params.pageInfo) qs.set("page_info", params.pageInfo);

  const result = await shoplineRequest<{ transactions: ShoplineTransaction[]; next_page_info?: string }>(
    opts,
    `/payments/transactions.json?${qs.toString()}`,
  );

  return {
    data: result.transactions ?? [],
    nextPageInfo: result.next_page_info ?? null,
  };
}

// ─── Payouts (Settlement Reports) ────────────────────────────────────────────

export interface ShoplinePayout {
  id: string;
  status: string; // "scheduled" | "in_transit" | "paid" | "failed" | "cancelled"
  date: string; // YYYY-MM-DD
  currency: string;
  amount: string;
  summary: {
    adjustments_fee_amount: string;
    adjustments_gross_amount: string;
    charges_fee_amount: string;
    charges_gross_amount: string;
    refunds_fee_amount: string;
    refunds_gross_amount: string;
    reserved_funds_fee_amount: string;
    reserved_funds_gross_amount: string;
    retried_payouts_fee_amount: string;
    retried_payouts_gross_amount: string;
  };
}

export async function fetchPayouts(
  opts: ShoplineApiOptions,
  params: {
    dateMin?: string;
    dateMax?: string;
    status?: string;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplinePayout>> {
  const qs = new URLSearchParams();
  if (params.dateMin) qs.set("date_min", params.dateMin);
  if (params.dateMax) qs.set("date_max", params.dateMax);
  if (params.status) qs.set("status", params.status);
  qs.set("limit", String(params.limit ?? 250));
  if (params.pageInfo) qs.set("page_info", params.pageInfo);

  const result = await shoplineRequest<{ payouts: ShoplinePayout[]; next_page_info?: string }>(
    opts,
    `/payouts.json?${qs.toString()}`,
  );

  return {
    data: result.payouts ?? [],
    nextPageInfo: result.next_page_info ?? null,
  };
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

export interface ShoplineRefund {
  id: string;
  order_id: string;
  created_at: string;
  note: string | null;
  user_id: string | null;
  processed_at: string;
  restock: boolean;
  refund_line_items: Array<{
    id: string;
    quantity: number;
    line_item_id: string;
    subtotal: string;
    total_tax: string;
  }>;
  transactions: ShoplineTransaction[];
}

export async function fetchRefunds(
  opts: ShoplineApiOptions,
  orderId: string,
): Promise<ShoplineRefund[]> {
  const result = await shoplineRequest<{ refunds: ShoplineRefund[] }>(
    opts,
    `/orders/${orderId}/refunds.json`,
  );
  return result.refunds ?? [];
}

// ─── Shop Metadata ────────────────────────────────────────────────────────────

export interface ShoplineShop {
  id: string;
  name: string;
  email: string;
  domain: string;
  currency: string;
  timezone: string;
  iana_timezone: string;
  money_format: string;
  created_at: string;
}

export async function fetchShopMetadata(opts: ShoplineApiOptions): Promise<ShoplineShop> {
  const result = await shoplineRequest<{ shop: ShoplineShop }>(opts, "/shop.json");
  return result.shop;
}

// ─── Webhook Registration ─────────────────────────────────────────────────────

export interface ShoplineWebhookRegistration {
  id: string;
  topic: string;
  address: string;
  format: string;
  created_at: string;
}

export async function registerWebhook(
  opts: ShoplineApiOptions,
  topic: string,
  callbackUrl: string,
): Promise<ShoplineWebhookRegistration> {
  const result = await shoplineRequest<{ webhook: ShoplineWebhookRegistration }>(
    opts,
    "/webhooks.json",
    {
      method: "POST",
      body: JSON.stringify({ webhook: { topic, address: callbackUrl, format: "json" } }),
    },
  );
  return result.webhook;
}

export async function listWebhooks(opts: ShoplineApiOptions): Promise<ShoplineWebhookRegistration[]> {
  const result = await shoplineRequest<{ webhooks: ShoplineWebhookRegistration[] }>(
    opts,
    "/webhooks.json",
  );
  return result.webhooks ?? [];
}
