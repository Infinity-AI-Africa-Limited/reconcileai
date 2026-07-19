/**
 * SHOPLINE Settlement Sync
 *
 * Pulls orders, payment transactions, and payout data from the SHOPLINE API
 * for a given date window, then normalises the data into the `rawData` shape
 * expected by the retail reconciliation engine.
 *
 * Called by:
 *   - The daily scheduled sync (Phase 2 job queue)
 *   - Manual "Sync Now" from the Super Admin portal
 *   - The initial 90-day historical backfill on install
 *
 * Data flow (spec §A6 three-leg join):
 *   Orders (source leg) — what the merchant sold
 *   Payment Transactions (gateway leg) — what the gateway captured
 *   Balance Transactions (settlement leg) — what was actually settled/paid out
 *
 * The reconciliation engine matches source ↔ target:
 *   Source = orders (expected settlement amounts)
 *   Target = payment transactions with settlement confirmation
 */

import { getDb } from "../../db";
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
import { eq, and } from "drizzle-orm";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { getValidToken } from "./tokenStore";
import {
  fetchOrders,
  fetchPaymentTransactions,
  fetchPayouts,
  type ShoplineOrder,
  type ShoplinePaymentTransaction,
  type ShoplinePayout,
} from "./apiClient";
import {
  runRetailReconciliation,
  type RetailReconciliationConfig,
} from "../../retailReconciliationEngine";
import type { Transaction } from "../../../drizzle/schema";

export interface SyncWindow {
  from: Date;
  to: Date;
}

export interface SyncResult {
  organizationId: number;
  slStoreId: number;
  storeHandle: string;
  window: SyncWindow;
  ordersIngested: number;
  transactionsIngested: number;
  payoutsIngested: number;
  exceptionsFound: number;
  durationMs: number;
  error?: string;
}

/**
 * Run a full settlement sync for a single SHOPLINE store.
 * Returns a structured result with counts and any error.
 */
export async function runSettlementSync(
  db: Db,
  organizationId: number,
  slStoreId: number,
  window: SyncWindow,
): Promise<SyncResult> {
  const startedAt = Date.now();

  // Resolve store record
  const stores = await db
    .select()
    .from(slConnectorStores)
    .where(
      and(
        eq(slConnectorStores.id, slStoreId),
        eq(slConnectorStores.organizationId, organizationId),
        eq(slConnectorStores.status, "active"),
      ),
    )
    .limit(1);

  if (stores.length === 0) {
    return {
      organizationId,
      slStoreId,
      storeHandle: "",
      window,
      ordersIngested: 0,
      transactionsIngested: 0,
      payoutsIngested: 0,
      exceptionsFound: 0,
      durationMs: Date.now() - startedAt,
      error: `Store ${slStoreId} not found or inactive`,
    };
  }

  const store = stores[0];
  const storeHandle = store.storeHandle;

  try {
    // Get a valid (auto-refreshed) access token
    const accessToken = await getValidToken(db, slStoreId, organizationId, storeHandle);
    if (!accessToken) {
      throw new Error(`No access token for store ${slStoreId} — re-install required`);
    }

    const opts = { storeHandle, accessToken };
    const fromIso = window.from.toISOString();
    const toIso = window.to.toISOString();

    // ── Fetch all orders in window (paginated, using updated_at watermark) ──
    const orders: ShoplineOrder[] = [];
    let orderPageInfo: string | null = null;
    do {
      const page = await fetchOrders(opts, {
        financialStatus: "paid",
        updatedAtMin: fromIso,
        updatedAtMax: toIso,
        limit: 250,
        pageInfo: orderPageInfo ?? undefined,
      });
      orders.push(...page.data);
      orderPageInfo = page.nextPageInfo;
    } while (orderPageInfo);

    // ── Fetch payment transactions in window (paginated, ≤6 months) ─────────
    // Spec: date_min/date_max required, max 6 months apart
    const transactions: ShoplinePaymentTransaction[] = [];
    let txPageInfo: string | null = null;
    do {
      const page = await fetchPaymentTransactions(opts, {
        dateMin: fromIso,
        dateMax: toIso,
        // Only PAYMENT rows form the gateway capture leg; REFUND/DISPUTE rows
        // would otherwise be mis-counted as captures. They are pulled
        // separately by the sync orchestrator for exception classification.
        transactionType: "PAYMENT",
        limit: 250,
        pageInfo: txPageInfo ?? undefined,
      });
      transactions.push(...page.data);
      txPageInfo = page.nextPageInfo;
    } while (txPageInfo);

    // ── Fetch payouts in window (paginated, ≤3 months) ─────────────────────
    const payouts: ShoplinePayout[] = [];
    let payoutPageInfo: string | null = null;
    do {
      const page = await fetchPayouts(opts, {
        startTime: fromIso,
        endTime: toIso,
        limit: 50,
        pageInfo: payoutPageInfo ?? undefined,
      });
      payouts.push(...page.data);
      payoutPageInfo = page.nextPageInfo;
    } while (payoutPageInfo);

    // ── Normalise to source/target Transaction arrays ─────────────────────
    const { sourceTxns, targetTxns } = normaliseToTransactions(
      orders,
      transactions,
      payouts,
      store.currency ?? "USD",
    );

    // ── Build a minimal retail config ─────────────────────────────────────
    const config: RetailReconciliationConfig = {
      amountTolerance: 0.005,
      dateWindowDays: 3,
      settlementCurrency: store.currency ?? "USD",
      chargebackDetection: true,
      fxMarkupTolerance: 0.03,
    };

    // ── Run the retail reconciliation engine ───────────────────────────────
    const engineResult = runRetailReconciliation(sourceTxns, targetTxns, config);

    // ── Update lastSyncAt ──────────────────────────────────────────────────
    await db
      .update(slConnectorStores)
      .set({ lastSyncAt: new Date() })
      .where(eq(slConnectorStores.id, slStoreId));

    return {
      organizationId,
      slStoreId,
      storeHandle,
      window,
      ordersIngested: orders.length,
      transactionsIngested: transactions.length,
      payoutsIngested: payouts.length,
      exceptionsFound: engineResult.retailExceptions.length,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      organizationId,
      slStoreId,
      storeHandle,
      window,
      ordersIngested: 0,
      transactionsIngested: 0,
      payoutsIngested: 0,
      exceptionsFound: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Normalise SHOPLINE API responses into source/target Transaction arrays
 * expected by the retail reconciliation engine.
 *
 * Source = SHOPLINE order-level expected amounts (what should have been settled)
 * Target = SHOPLINE payment transactions (what was actually captured by the gateway)
 *
 * The three-leg join (spec §A6):
 *   Order.id → PaymentTransaction.seller_order_id (join key)
 *   PaymentTransaction.channel_deal_id → BalanceTransaction.source_order_transaction_id
 */
export function normaliseToTransactions(
  orders: ShoplineOrder[],
  transactions: ShoplinePaymentTransaction[],
  _payouts: ShoplinePayout[],
  currency: string,
): { sourceTxns: Transaction[]; targetTxns: Transaction[] } {
  // Synthetic batch/channel/user IDs for engine compatibility
  const SYNTHETIC_BATCH = -1;
  const SYNTHETIC_CHANNEL = -1;
  const SYNTHETIC_USER = -1;

  // Source = paid orders (expected settlement amounts).
  // Match key: the engine's pass-1 exact match is on transactionRef, so the
  // source ref must be the order id — payment transactions carry it back as
  // seller_order_id. (o.name like "#1001" never appears on the gateway leg.)
  const sourceTxns: Transaction[] = orders
    .filter((o) => o.financial_status === "paid" || o.financial_status === "partially_refunded")
    .map((o, idx) => {
      const totalPrice = o.current_total_price_set?.shop_money?.amount ?? "0";
      const gateway = o.payment_gateway_names?.[0] ?? "unknown";
      return {
        id: -(idx + 1), // negative IDs to avoid DB collision — engine uses these for matching only
        batchId: SYNTHETIC_BATCH,
        channelId: SYNTHETIC_CHANNEL,
        userId: SYNTHETIC_USER,
        organizationId: null,
        transactionRef: o.id,
        externalRef: o.name, // human-readable order number (e.g. "#1001")
        description: `Order ${o.name} via ${gateway}`,
        amount: totalPrice,
        currency,
        transactionDate: new Date(o.processed_at),
        valueDate: null,
        debitCredit: "credit" as const,
        counterparty: gateway,
        isReversal: false,
        originalTransactionRef: null,
        status: "unmatched" as const,
        matchId: null,
        rawData: { orderId: o.id, gateway, financialStatus: o.financial_status },
        createdAt: new Date(o.created_at),
      };
    });

  // Target = successful payment transactions (actual gateway captures).
  // PAYMENT rows use status SUCCEEDED (spec §A6) — payouts use SUCCESS.
  // Match key: seller_order_id joins back to the order id on the source leg.
  const targetTxns: Transaction[] = transactions
    .filter((t) => t.status === "SUCCEEDED")
    .map((t, idx) => ({
      id: -(orders.length + idx + 1),
      batchId: SYNTHETIC_BATCH,
      channelId: SYNTHETIC_CHANNEL,
      userId: SYNTHETIC_USER,
      organizationId: null,
      transactionRef: t.seller_order_id ?? t.trade_order_id,
      externalRef: t.trade_order_id,
      description: `${t.payment_method} capture via ${t.sub_payment_method ?? t.payment_method}`,
      amount: t.paid_amount ?? t.amount,
      currency: t.currency,
      transactionDate: new Date(t.create_time),
      valueDate: null,
      debitCredit: "credit" as const,
      counterparty: t.payment_method,
      isReversal: false,
      originalTransactionRef: null,
      status: "unmatched" as const,
      matchId: null,
      rawData: {
        tradeOrderId: t.trade_order_id,
        sellerOrderId: t.seller_order_id,
        channelDealId: t.channel_deal_id,
        fee: t.fee,
        disputeType: t.dispute_type,
      },
      createdAt: new Date(t.create_time),
    }));

  return { sourceTxns, targetTxns };
}
