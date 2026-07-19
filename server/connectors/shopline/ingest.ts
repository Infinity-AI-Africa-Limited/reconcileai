/**
 * SHOPLINE Data Ingest — Normalises SHOPLINE API responses to canonical
 * ReconcileAI transaction rows.
 *
 * This is the data bridge between the SHOPLINE API (orders, payments, payouts,
 * refunds) and the retail reconciliation engine. It transforms SHOPLINE's
 * domain-specific JSON into the `transactions` table schema, populating the
 * `rawData` field with the metadata the retail exception classifier expects:
 *
 *   gatewayEventType, originalOrderRef, gatewayRef, cardScheme, cardType,
 *   cardRegion, capturedAmount, authorisedAmount, feeAmount,
 *   settlementBatchId, chargebackArn, refundId, voidStatus
 *
 * Three data legs (the "three-leg join"):
 *   1. Orders leg — what the merchant sold (order-level amounts)
 *   2. Payments leg — what the gateway captured (transaction-level)
 *   3. Settlements leg — what was paid out (payout-level)
 *
 * Each leg lands in its own channel so the reconciliation engine can
 * cross-match: Orders ↔ Payments (capture completeness) and
 * Payments ↔ Settlements (payout accuracy).
 */
import type { InsertTransaction } from "../../../drizzle/schema";
import type {
  ShoplineOrder,
  ShoplinePaymentTransaction,
  ShoplinePayout,
  ShoplineRefund,
  ShoplineBalanceTransaction,
} from "./apiClient";

// ─── Canonical rawData shape for the retail reconciliation engine ────────────
export interface ShoplineRawData {
  gatewayEventType: "payment" | "refund" | "chargeback" | "payout" | "fee" | "reserve";
  originalOrderRef?: string;
  gatewayRef?: string;
  cardScheme?: string;
  cardType?: string;
  cardRegion?: string;
  capturedAmount?: number;
  authorisedAmount?: number;
  feeAmount?: number;
  settlementBatchId?: string;
  chargebackArn?: string;
  refundId?: string;
  voidStatus?: boolean;
  /** SHOPLINE-specific metadata for audit trail */
  shoplineOrderId?: string;
  shoplineTransactionId?: string;
  shoplinePayoutId?: string;
  financialStatus?: string;
  paymentMethod?: string;
  disputeType?: string;
}

// ─── Ingest context (passed by the sync job or webhook handler) ─────────────
export interface IngestContext {
  organizationId: number;
  /** The "orders" channel ID for this store */
  ordersChannelId: number;
  /** The "payments" channel ID for this store */
  paymentsChannelId: number;
  /** The batch ID for this ingest run */
  batchId: number;
  /** The user ID that triggered the ingest (system user for automated sync) */
  userId: number;
  /** Store currency (fallback if transaction doesn't specify) */
  defaultCurrency: string;
}

// ─── Order Normalisation ────────────────────────────────────────────────────
/**
 * Normalise a SHOPLINE order into a canonical transaction row.
 * This represents the "merchant expectation" side of reconciliation.
 *
 * ShoplineOrder fields (from apiClient.ts):
 *   id, name, financial_status, currency, presentment_currency,
 *   current_total_price_set.shop_money.amount, total_outstanding,
 *   payment_details[], payment_gateway_names[], refunds[], created_at, updated_at
 */
export function normaliseOrder(
  order: ShoplineOrder,
  ctx: IngestContext,
): InsertTransaction {
  const amount = parseFloat(order.current_total_price_set?.shop_money?.amount || "0");
  const currency = order.currency || ctx.defaultCurrency;

  return {
    batchId: ctx.batchId,
    channelId: ctx.ordersChannelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    // Join key: the engine's pass-1 exact match is on transactionRef, and the
    // payment leg carries the order id back as seller_order_id — so the order's
    // ref MUST be order.id (order.name like "#1001" never appears gateway-side).
    transactionRef: order.id,
    externalRef: order.name || order.id, // human-readable order number
    description: `SHOPLINE Order ${order.name || order.id}`,
    amount: String(amount),
    currency,
    transactionDate: new Date(order.created_at),
    valueDate: order.processed_at ? new Date(order.processed_at) : null,
    debitCredit: "credit" as const,
    counterparty: order.payment_gateway_names?.[0] || "SHOPLINE",
    isReversal: false,
    status: "unmatched" as const,
    rawData: {
      gatewayEventType: "payment",
      originalOrderRef: order.name || order.id,
      shoplineOrderId: order.id,
      financialStatus: order.financial_status,
      capturedAmount: amount,
      authorisedAmount: amount,
    } satisfies ShoplineRawData,
  };
}

// ─── Payment Transaction Normalisation ──────────────────────────────────────
/**
 * Normalise a SHOPLINE payment transaction into a canonical row.
 * This represents the "gateway captured" side.
 *
 * ShoplinePaymentTransaction fields (from apiClient.ts):
 *   trade_order_id, seller_order_id, channel_deal_id, amount, paid_amount,
 *   currency, fee, fee_type, exchange?, additional_data?, dispute_type?,
 *   status, payment_method, credit_card?, create_time, update_time
 */
export function normalisePaymentTransaction(
  txn: ShoplinePaymentTransaction,
  ctx: IngestContext,
): InsertTransaction {
  const amount = parseFloat(txn.amount || "0");
  const currency = txn.currency || ctx.defaultCurrency;

  // Determine event type from dispute_type or payment status
  let gatewayEventType: ShoplineRawData["gatewayEventType"] = "payment";
  if (txn.dispute_type) gatewayEventType = "chargeback";

  return {
    batchId: ctx.batchId,
    channelId: ctx.paymentsChannelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    // Join key: seller_order_id === the order's id (matches normaliseOrder's ref).
    // channel_deal_id is retained in rawData.gatewayRef for the settlement leg.
    transactionRef: txn.seller_order_id || txn.trade_order_id,
    externalRef: txn.trade_order_id,
    description: `SHOPLINE payment — ${txn.payment_method || "unknown"} (${txn.status})`,
    amount: String(Math.abs(amount)),
    currency,
    transactionDate: new Date(txn.create_time),
    valueDate: txn.additional_data?.settle_time ? new Date(txn.additional_data.settle_time) : null,
    debitCredit: amount >= 0 ? "credit" : "debit",
    counterparty: txn.payment_method || "SHOPLINE Payments",
    isReversal: false,
    originalTransactionRef: txn.seller_order_id || undefined,
    status: "unmatched" as const,
    rawData: {
      gatewayEventType,
      originalOrderRef: txn.seller_order_id,
      gatewayRef: txn.channel_deal_id,
      shoplineTransactionId: txn.trade_order_id,
      shoplineOrderId: txn.seller_order_id,
      capturedAmount: parseFloat(txn.paid_amount || txn.amount || "0"),
      feeAmount: Math.abs(parseFloat(txn.fee || "0")),
      paymentMethod: txn.payment_method,
      cardScheme: txn.credit_card?.brand,
      cardType: txn.credit_card?.type,
      cardRegion: txn.fee_type === "international" ? "international" : "domestic",
      disputeType: txn.dispute_type,
      voidStatus: false,
    } satisfies ShoplineRawData,
  };
}

// ─── Payout Normalisation ───────────────────────────────────────────────────
/**
 * Normalise a SHOPLINE payout into a canonical row.
 * This represents the "settlement received" side.
 *
 * ShoplinePayout fields (from apiClient.ts):
 *   payout_transaction_no, amount, currency, status, time
 */
export function normalisePayout(
  payout: ShoplinePayout,
  ctx: IngestContext,
): InsertTransaction {
  const amount = parseFloat(payout.amount || "0");
  const currency = payout.currency || ctx.defaultCurrency;

  return {
    batchId: ctx.batchId,
    channelId: ctx.paymentsChannelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    transactionRef: `PAYOUT_${payout.payout_transaction_no}`,
    externalRef: payout.payout_transaction_no,
    description: `SHOPLINE Payout ${payout.payout_transaction_no} (${payout.status})`,
    amount: String(Math.abs(amount)),
    currency,
    transactionDate: new Date(payout.time),
    valueDate: payout.status === "SUCCESS" ? new Date(payout.time) : null,
    debitCredit: "credit" as const,
    counterparty: "SHOPLINE Payments Settlement",
    isReversal: false,
    status: "unmatched" as const,
    rawData: {
      gatewayEventType: "payout",
      shoplinePayoutId: payout.payout_transaction_no,
      settlementBatchId: payout.payout_transaction_no,
    } satisfies ShoplineRawData,
  };
}

// ─── Refund Normalisation ───────────────────────────────────────────────────
/**
 * Normalise a SHOPLINE refund into a canonical row.
 *
 * ShoplineRefund fields (from apiClient.ts):
 *   id, order_id, created_at, note, processed_at, refund_line_items[]
 */
export function normaliseRefund(
  refund: ShoplineRefund,
  ctx: IngestContext,
): InsertTransaction {
  // Sum up refund line item subtotals
  const amount = refund.refund_line_items.reduce(
    (sum, item) => sum + parseFloat(item.subtotal || "0"),
    0,
  );

  return {
    batchId: ctx.batchId,
    channelId: ctx.ordersChannelId, // Refunds land on the orders channel (merchant side)
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    transactionRef: `REFUND_${refund.id}`,
    externalRef: refund.id,
    description: `SHOPLINE Refund #${refund.id}${refund.note ? ` — ${refund.note}` : ""}`,
    amount: String(Math.abs(amount)),
    currency: ctx.defaultCurrency,
    transactionDate: new Date(refund.created_at),
    valueDate: refund.processed_at ? new Date(refund.processed_at) : null,
    debitCredit: "debit" as const, // Refunds are debits (money going back)
    counterparty: "SHOPLINE Customer Refund",
    isReversal: true,
    originalTransactionRef: refund.order_id,
    status: "unmatched" as const,
    rawData: {
      gatewayEventType: "refund",
      originalOrderRef: refund.order_id,
      refundId: refund.id,
      shoplineOrderId: refund.order_id,
    } satisfies ShoplineRawData,
  };
}

// ─── Balance Transaction Normalisation ──────────────────────────────────────
/**
 * Normalise a SHOPLINE balance transaction (fee, reserve, adjustment).
 *
 * ShoplineBalanceTransaction fields (from apiClient.ts):
 *   id, type, settlement_batch_id?, source_order_id?, amount, net,
 *   interchange_fee?, scheme_fee?, payment_method_fee?, other_fee?, total_fee?,
 *   transaction_currency?, account_currency?, exchange_rate?,
 *   account_type, account_balance?, posting_time
 */
export function normaliseBalanceTransaction(
  bt: ShoplineBalanceTransaction,
  ctx: IngestContext,
): InsertTransaction {
  const amount = parseFloat(bt.amount || "0");
  const currency = bt.transaction_currency || bt.account_currency || ctx.defaultCurrency;

  // Map SHOPLINE balance transaction types to our event types
  let gatewayEventType: ShoplineRawData["gatewayEventType"] = "fee";
  const typeUpper = (bt.type || "").toUpperCase();
  if (typeUpper.includes("PAYOUT") || typeUpper === "SETTLEMENT") gatewayEventType = "payout";
  if (typeUpper.includes("REFUND")) gatewayEventType = "refund";
  if (typeUpper.includes("CHARGEBACK")) gatewayEventType = "chargeback";
  if (typeUpper.includes("RESERVE") || typeUpper.includes("MARGIN")) gatewayEventType = "reserve";

  const totalFee = parseFloat(bt.total_fee || "0");

  return {
    batchId: ctx.batchId,
    channelId: ctx.paymentsChannelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    transactionRef: `BT_${bt.id}`,
    externalRef: bt.id,
    description: `SHOPLINE ${bt.type} (${bt.account_type})`,
    amount: String(Math.abs(amount)),
    currency,
    transactionDate: new Date(bt.posting_time),
    debitCredit: amount >= 0 ? "credit" : "debit",
    counterparty: "SHOPLINE Payments",
    isReversal: typeUpper.includes("REFUND"),
    status: "unmatched" as const,
    rawData: {
      gatewayEventType,
      feeAmount: totalFee !== 0 ? Math.abs(totalFee) : undefined,
      settlementBatchId: bt.settlement_batch_id,
      shoplineOrderId: bt.source_order_id,
    } satisfies ShoplineRawData,
  };
}

// ─── Batch Ingest Helper ────────────────────────────────────────────────────
/**
 * Normalise a batch of mixed SHOPLINE records into canonical transaction rows.
 * Used by the scheduled sync job.
 */
export interface IngestBatch {
  orders?: ShoplineOrder[];
  paymentTransactions?: ShoplinePaymentTransaction[];
  payouts?: ShoplinePayout[];
  refunds?: ShoplineRefund[];
  balanceTransactions?: ShoplineBalanceTransaction[];
}

export function normaliseIngestBatch(
  batch: IngestBatch,
  ctx: IngestContext,
): InsertTransaction[] {
  const rows: InsertTransaction[] = [];

  if (batch.orders) {
    for (const order of batch.orders) {
      rows.push(normaliseOrder(order, ctx));
    }
  }
  if (batch.paymentTransactions) {
    for (const txn of batch.paymentTransactions) {
      rows.push(normalisePaymentTransaction(txn, ctx));
    }
  }
  if (batch.payouts) {
    for (const payout of batch.payouts) {
      rows.push(normalisePayout(payout, ctx));
    }
  }
  if (batch.refunds) {
    for (const refund of batch.refunds) {
      rows.push(normaliseRefund(refund, ctx));
    }
  }
  if (batch.balanceTransactions) {
    for (const bt of batch.balanceTransactions) {
      rows.push(normaliseBalanceTransaction(bt, ctx));
    }
  }

  return rows;
}
