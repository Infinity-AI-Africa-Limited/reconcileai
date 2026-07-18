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
 * Data flow:
 *   SHOPLINE API → fetchOrders/fetchTransactions/fetchPayouts
 *     → normaliseToRawData()
 *       → retailReconciliationEngine.runRetailReconciliation()
 *         → exceptions stored in DB
 */

import { getDb } from "../../db";
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
import { eq, and } from "drizzle-orm";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { getValidToken } from "./tokenStore";
import {
  fetchOrders,
  fetchTransactions,
  fetchPayouts,
  type ShoplineOrder,
  type ShoplineTransaction,
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

    // ── Fetch all orders in window (paginated) ──────────────────────────────
    const orders: ShoplineOrder[] = [];
    let orderPageInfo: string | null = null;
    do {
      const page = await fetchOrders(opts, {
        status: "paid",
        createdAtMin: fromIso,
        createdAtMax: toIso,
        limit: 250,
        pageInfo: orderPageInfo ?? undefined,
      });
      orders.push(...page.data);
      orderPageInfo = page.nextPageInfo;
    } while (orderPageInfo);

    // ── Fetch payment transactions in window (paginated) ────────────────────
    const transactions: ShoplineTransaction[] = [];
    let txPageInfo: string | null = null;
    do {
      const page = await fetchTransactions(opts, {
        createdAtMin: fromIso,
        createdAtMax: toIso,
        limit: 250,
        pageInfo: txPageInfo ?? undefined,
      });
      transactions.push(...page.data);
      txPageInfo = page.nextPageInfo;
    } while (txPageInfo);

    // ── Fetch payouts in window ─────────────────────────────────────────────
    const payouts: ShoplinePayout[] = [];
    let payoutPageInfo: string | null = null;
    const dateMin = window.from.toISOString().slice(0, 10);
    const dateMax = window.to.toISOString().slice(0, 10);
    do {
      const page = await fetchPayouts(opts, {
        dateMin,
        dateMax,
        limit: 250,
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
 * Target = SHOPLINE payout transactions (what was actually settled)
 */
function normaliseToTransactions(
  orders: ShoplineOrder[],
  transactions: ShoplineTransaction[],
  payouts: ShoplinePayout[],
  currency: string,
): { sourceTxns: Transaction[]; targetTxns: Transaction[] } {
  // Synthetic batch/channel/user IDs for engine compatibility
  // (the engine only uses id, amount, currency, transactionDate, transactionRef, description, rawData)
  const SYNTHETIC_BATCH = -1;
  const SYNTHETIC_CHANNEL = -1;
  const SYNTHETIC_USER = -1;

  // Source = paid orders (expected settlement amounts)
  const sourceTxns: Transaction[] = orders
    .filter((o) => o.financial_status === "paid")
    .map((o, idx) => ({
      id: -(idx + 1), // negative IDs to avoid DB collision — engine uses these for matching only
      batchId: SYNTHETIC_BATCH,
      channelId: SYNTHETIC_CHANNEL,
      userId: SYNTHETIC_USER,
      organizationId: null,
      transactionRef: o.order_number,
      externalRef: o.id,
      description: `Order ${o.order_number} via ${o.gateway}`,
      amount: o.total_price, // keep as string (decimal type)
      currency,
      transactionDate: new Date(o.processed_at),
      valueDate: null,
      debitCredit: "credit" as const,
      counterparty: o.gateway,
      isReversal: false,
      originalTransactionRef: null,
      status: "unmatched" as const,
      matchId: null,
      rawData: { orderId: o.id, gateway: o.gateway, financialStatus: o.financial_status },
      createdAt: new Date(o.created_at),
    }));

  // Target = successful payment transactions (actual gateway captures)
  const targetTxns: Transaction[] = transactions
    .filter((t) => t.status === "success" && t.kind === "capture")
    .map((t, idx) => ({
      id: -(orders.length + idx + 1),
      batchId: SYNTHETIC_BATCH,
      channelId: SYNTHETIC_CHANNEL,
      userId: SYNTHETIC_USER,
      organizationId: null,
      transactionRef: t.authorization ?? t.id,
      externalRef: t.id,
      description: `${t.kind} via ${t.gateway}`,
      amount: t.amount,
      currency: t.currency,
      transactionDate: new Date(t.processed_at),
      valueDate: null,
      debitCredit: "credit" as const,
      counterparty: t.gateway,
      isReversal: false,
      originalTransactionRef: null,
      status: "unmatched" as const,
      matchId: null,
      rawData: { transactionId: t.id, orderId: t.order_id, gateway: t.gateway, kind: t.kind },
      createdAt: new Date(t.created_at),
    }));

  return { sourceTxns, targetTxns };
}
