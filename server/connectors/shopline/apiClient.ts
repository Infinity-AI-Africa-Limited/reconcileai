/**
 * SHOPLINE REST API Client
 *
 * Wraps all SHOPLINE API calls with:
 *   - Automatic token injection (Authorization: Bearer)
 *   - API version pinning (v20260601)
 *   - Rate limit awareness (leaky bucket: burst 40, drain 4 req/s per store)
 *   - Link-header cursor pagination (per spec §A5)
 *   - Structured error parsing with traceId logging
 *
 * Base URL pattern (spec §A5):
 *   https://{handle}.myshopline.com/admin/openapi/{version}/{endpoint}.json
 *
 * Key endpoints (spec §A6):
 *   GET  /orders.json
 *   GET  /payments/store/transactions.json
 *   GET  /payments/store/payouts.json
 *   GET  /payments/store/balance_transactions.json
 *   GET  /payments/store/balance.json
 *   GET  /store.json
 *   POST /webhooks.json
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
    public readonly traceId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ShoplineApiError";
  }
}

/**
 * Parse the `link` response header to extract the next page cursor.
 * Format: `<url?page_info=CURSOR>; rel="next"` (and optionally rel="previous")
 */
function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function shoplineRequest<T>(
  opts: ShoplineApiOptions,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<{ data: T; nextPageInfo: string | null }> {
  const url = `https://${opts.storeHandle}.myshopline.com/admin/openapi/${SHOPLINE_API_VERSION}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${opts.accessToken}`,
      ...(init.headers ?? {}),
    },
  });

  // Log traceId for debugging (SHOPLINE includes it on every response)
  const traceId = response.headers.get("traceId") ?? response.headers.get("x-request-id") ?? undefined;

  // Rate limit — exponential backoff (leaky bucket: burst 40, drain 4/s)
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
      shoplineCode = parsed?.errors ?? parsed?.error_code ?? parsed?.code;
    } catch { /* ignore */ }
    throw new ShoplineApiError(
      response.status,
      shoplineCode,
      traceId,
      `SHOPLINE API ${response.status} [trace:${traceId}]: ${body}`,
    );
  }

  // Parse link header for pagination cursor
  const linkHeader = response.headers.get("link");
  const nextPageInfo = parseNextPageInfo(linkHeader);

  const data = await response.json() as T;
  return { data, nextPageInfo };
}

// ─── Orders (spec §A6) ─────────────────────────────────────────────────────

export interface ShoplineOrder {
  id: string;
  name: string; // order number/name (e.g. "#1001")
  financial_status: string; // "unpaid"|"authorized"|"pending"|"partially_paid"|"paid"|"partially_refunded"|"refunded"
  currency: string;
  presentment_currency: string;
  current_total_price_set: { shop_money: { amount: string; currency_code: string } };
  total_outstanding: string;
  payment_details: Array<{
    gateway: string;
    pay_amount: string;
    pay_channel: string;
    pay_channel_deal_id: string;
    giftcard_presentment_money?: string;
    create_time: string;
  }>;
  payment_gateway_names: string[];
  refunds: unknown[];
  created_at: string;
  updated_at: string;
  processed_at: string;
}

export async function fetchOrders(
  opts: ShoplineApiOptions,
  params: {
    financialStatus?: string;
    createdAtMin?: string;
    createdAtMax?: string;
    updatedAtMin?: string;
    updatedAtMax?: string;
    sinceId?: string;
    limit?: number;
    pageInfo?: string;
    fields?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplineOrder>> {
  const qs = new URLSearchParams();
  // When page_info is present, all other filters except limit/fields are ignored (spec §A5)
  if (params.pageInfo) {
    qs.set("page_info", params.pageInfo);
    qs.set("limit", String(params.limit ?? 250));
    if (params.fields) qs.set("fields", params.fields);
  } else {
    if (params.financialStatus) qs.set("financial_status", params.financialStatus);
    if (params.createdAtMin) qs.set("created_at_min", params.createdAtMin);
    if (params.createdAtMax) qs.set("created_at_max", params.createdAtMax);
    if (params.updatedAtMin) qs.set("updated_at_min", params.updatedAtMin);
    if (params.updatedAtMax) qs.set("updated_at_max", params.updatedAtMax);
    if (params.sinceId) qs.set("since_id", params.sinceId);
    qs.set("limit", String(params.limit ?? 250));
    if (params.fields) qs.set("fields", params.fields);
  }

  const { data, nextPageInfo } = await shoplineRequest<{ orders: ShoplineOrder[] }>(
    opts,
    `/orders.json?${qs.toString()}`,
  );

  return { data: data.orders ?? [], nextPageInfo };
}

// ─── Payment Transactions (spec §A6: /payments/store/transactions.json) ─────

export interface ShoplinePaymentTransaction {
  trade_order_id: string;
  seller_order_id: string; // → join to order id/name
  channel_deal_id: string;
  amount: string;
  paid_amount: string;
  currency: string;
  fee: string; // negative = charged
  fee_type: string; // "domestic" | "international"
  exchange?: { amount: string; currency: string; rate: string };
  additional_data?: {
    is_settled?: boolean;
    settle_time?: string;
    statement_time?: string;
    reserve_held?: string;
    reserve_release_time?: string;
  };
  dispute_type?: string; // "CHARGEBACK"|"PRE_CHARGEBACK"|"RETRIEVAL"|"FRAUD_NOTIFICATION"
  stage?: string;
  stage_final_amount?: string;
  reason?: string;
  status: string;
  sub_status?: string;
  payment_method: string;
  sub_payment_method?: string;
  credit_card?: { brand: string; bin: string; last4: string; type: string; issuer_country: string };
  create_time: string;
  update_time: string;
}

export async function fetchPaymentTransactions(
  opts: ShoplineApiOptions,
  params: {
    dateMin: string; // required (pair with dateMax, ≤6 months apart)
    dateMax: string; // required
    transactionType?: string; // "PAYMENT"|"REFUND"|"DISPUTE"
    status?: string;
    sinceId?: string;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplinePaymentTransaction>> {
  const qs = new URLSearchParams();
  if (params.pageInfo) {
    qs.set("page_info", params.pageInfo);
    qs.set("limit", String(params.limit ?? 250));
  } else {
    qs.set("date_min", params.dateMin);
    qs.set("date_max", params.dateMax);
    if (params.transactionType) qs.set("transaction_type", params.transactionType);
    if (params.status) qs.set("status", params.status);
    if (params.sinceId) qs.set("since_id", params.sinceId);
    qs.set("limit", String(Math.min(params.limit ?? 250, 1000)));
  }

  const { data, nextPageInfo } = await shoplineRequest<{ transactions: ShoplinePaymentTransaction[] }>(
    opts,
    `/payments/store/transactions.json?${qs.toString()}`,
  );

  return { data: data.transactions ?? [], nextPageInfo };
}

// ─── Payouts (spec §A6: /payments/store/payouts.json) ───────────────────────

export interface ShoplinePayout {
  payout_transaction_no: string;
  amount: string;
  currency: string;
  status: string; // "CREATED"|"PROCESSING"|"SUCCESS"|"FAILED"
  time: string;
}

export async function fetchPayouts(
  opts: ShoplineApiOptions,
  params: {
    startTime: string; // required (pair with endTime, ≤3 months apart)
    endTime: string; // required
    status?: string;
    sinceId?: string;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplinePayout>> {
  const qs = new URLSearchParams();
  if (params.pageInfo) {
    qs.set("page_info", params.pageInfo);
    qs.set("limit", String(params.limit ?? 50));
  } else {
    qs.set("start_time", params.startTime);
    qs.set("end_time", params.endTime);
    if (params.status) qs.set("status", params.status);
    if (params.sinceId) qs.set("since_id", params.sinceId);
    qs.set("limit", String(Math.min(params.limit ?? 50, 100)));
  }

  const { data, nextPageInfo } = await shoplineRequest<{ payouts: ShoplinePayout[] }>(
    opts,
    `/payments/store/payouts.json?${qs.toString()}`,
  );

  return { data: data.payouts ?? [], nextPageInfo };
}

// ─── Balance Transactions / Billing Records (spec §A6) ──────────────────────

export interface ShoplineBalanceTransaction {
  id: string;
  type: string; // ~60 codes: PAYMENT, SETTLEMENT, REFUND*, CHARGEBACK*, PAYOUT, etc.
  settlement_batch_id?: string;
  source_order_id?: string;
  source_order_transaction_id?: string;
  amount: string;
  net: string;
  interchange_fee?: string;
  scheme_fee?: string;
  payment_method_fee?: string;
  other_fee?: string;
  total_fee?: string;
  transaction_amount?: string;
  transaction_currency?: string;
  account_currency?: string;
  exchange_rate?: string;
  account_type: string; // "PendingSettlementAccount"|"PayoutAccount"|"RevolvingMarginAccount"|"FixedMarginAccount"
  account_balance?: string;
  posting_time: string;
}

export async function fetchBalanceTransactions(
  opts: ShoplineApiOptions,
  params: {
    startTime?: string;
    endTime?: string;
    payoutId?: string;
    isSettlementDetails?: boolean;
    limit?: number;
    pageInfo?: string;
  },
): Promise<ShoplinePaginatedResponse<ShoplineBalanceTransaction>> {
  const qs = new URLSearchParams();
  if (params.pageInfo) {
    qs.set("page_info", params.pageInfo);
    qs.set("limit", String(params.limit ?? 100));
  } else {
    if (params.startTime) qs.set("start_time", params.startTime);
    if (params.endTime) qs.set("end_time", params.endTime);
    if (params.payoutId) qs.set("payout_id", params.payoutId);
    if (params.isSettlementDetails !== undefined) qs.set("is_settlement_details", String(params.isSettlementDetails));
    qs.set("limit", String(params.limit ?? 100));
  }

  const { data, nextPageInfo } = await shoplineRequest<{ transactions: ShoplineBalanceTransaction[] }>(
    opts,
    `/payments/store/balance_transactions.json?${qs.toString()}`,
  );

  return { data: data.transactions ?? [], nextPageInfo };
}

// ─── Store Balance (spec §A6: /payments/store/balance.json) ─────────────────

export interface ShoplineStoreBalance {
  account_identify_code?: string;
  pending_settlement_balance: string;
  payout_account_available_balance: string;
  payout_account_frozen_balance: string;
  payout_account_balance: string;
  fixed_margin_account_balance: string;
  revolving_margin_account_balance: string;
  currency: string;
}

export async function fetchStoreBalance(opts: ShoplineApiOptions): Promise<ShoplineStoreBalance> {
  // Response shape per the endpoint spec: { balance: { ... } }
  const { data } = await shoplineRequest<{ balance: ShoplineStoreBalance }>(
    opts,
    "/payments/store/balance.json",
  );
  return data.balance;
}

// ─── Store Metadata (GET /merchants/shop.json) ──────────────────────────────

export interface ShoplineStore {
  id: string;
  merchant_id: string;
  name: string;
  domain: string;
  currency: string;
  iana_timezone: string;
  language: string;
  biz_store_status: string;
  email: string;
}

export async function fetchStoreMetadata(opts: ShoplineApiOptions): Promise<ShoplineStore> {
  // Endpoint is /merchants/shop.json with a `data` wrapper (query-store-information
  // spec) — NOT /store.json as an earlier draft of the extract stated.
  const { data } = await shoplineRequest<{ data: ShoplineStore }>(opts, "/merchants/shop.json");
  return data.data;
}

// ─── Refunds (spec §A6: /orders/{id}/refunds) ──────────────────────────────

export interface ShoplineRefund {
  id: string;
  order_id: string;
  created_at: string;
  note: string | null;
  processed_at: string;
  refund_line_items: Array<{
    id: string;
    quantity: number;
    line_item_id: string;
    subtotal: string;
    total_tax: string;
  }>;
}

export async function fetchRefunds(
  opts: ShoplineApiOptions,
  orderId: string,
): Promise<ShoplineRefund[]> {
  const { data } = await shoplineRequest<{ refunds: ShoplineRefund[] }>(
    opts,
    `/orders/${orderId}/refunds.json`,
  );
  return data.refunds ?? [];
}

// ─── Webhook Registration (spec §A6: /webhooks.json) ────────────────────────

export interface ShoplineWebhookRegistration {
  id: string;
  topic: string;
  address: string;
  api_version: string;
  created_at: string;
}

/**
 * Register a webhook subscription for a store.
 * Per spec §A6: body = { webhook: { api_version, topic, address } }
 */
export async function registerWebhook(
  opts: ShoplineApiOptions,
  topic: string,
  callbackUrl: string,
): Promise<ShoplineWebhookRegistration> {
  const { data } = await shoplineRequest<{ webhook: ShoplineWebhookRegistration }>(
    opts,
    "/webhooks.json",
    {
      method: "POST",
      body: JSON.stringify({
        webhook: {
          api_version: SHOPLINE_API_VERSION,
          topic,
          address: callbackUrl,
        },
      }),
    },
  );
  return data.webhook;
}

export async function listWebhooks(opts: ShoplineApiOptions): Promise<ShoplineWebhookRegistration[]> {
  const { data } = await shoplineRequest<{ webhooks: ShoplineWebhookRegistration[] }>(
    opts,
    "/webhooks.json",
  );
  return data.webhooks ?? [];
}
