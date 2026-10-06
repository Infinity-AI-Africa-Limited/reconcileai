import type { InsertTransaction } from "../../../drizzle/schema";
import type { NormalizedShopifyOrder, NormalizedShopifyRefund } from "./orders";

export interface ShopifyOrderIngestContext {
  organizationId: number;
  storeId: number;
  channelId: number;
  batchId: number;
  userId: number;
}

/**
 * Project one already-normalized Shopify order into the canonical table. No raw
 * response, buyer identity, contact data, address, note, token or line item is
 * accepted by this function's input type or persisted in rawData.
 *
 * The amount is the order total BEFORE refunds — what the customer was charged,
 * and so what the gateway settles as the payment. Refunds are their own rows
 * (`toShopifyRefundTransaction`).
 */
export function toShopifyOrderTransaction(
  order: NormalizedShopifyOrder,
  ctx: ShopifyOrderIngestContext,
): InsertTransaction {
  return {
    batchId: ctx.batchId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    shopifyStoreId: ctx.storeId,
    shopifyRefundId: "",
    transactionRef: order.gid,
    externalRef: order.name,
    description: shopifyOrderDescription(order.name),
    amount: order.totalPrice.amount,
    currency: order.totalPrice.currencyCode,
    transactionDate: new Date(order.createdAt),
    valueDate: order.processedAt ? new Date(order.processedAt) : null,
    shopifyOrderCurrency: order.currencyCode,
    shopifyUpdatedAt: new Date(order.updatedAt),
    shopifyFinancialStatus: order.displayFinancialStatus,
    shopifyCancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    debitCredit: "credit",
    counterparty: "Shopify",
    isReversal: false,
    status: "unmatched",
    rawData: null,
  };
}

export function shopifyOrderDescription(name: string): string {
  return `Shopify Order ${name}`;
}

export function shopifyRefundDescription(name: string): string {
  return `Shopify Order ${name} refund`;
}

/**
 * Project one refund of a Shopify order: money OUT, under the ORDER's reference
 * so it matches the gateway's refund line by reference the way the order
 * matches its payment, told apart from the order's own row by its refund id.
 *
 * The same minimisation as the order: no line item, note or staff member, and
 * rawData stays NULL — the privacy pipeline proves a Shopify row holds nothing
 * beyond this projection. The retail engine learns the row is a refund from its
 * refund id at reconciliation time, not from anything stored here.
 */
export function toShopifyRefundTransaction(
  order: NormalizedShopifyOrder,
  refund: NormalizedShopifyRefund,
  ctx: ShopifyOrderIngestContext,
): InsertTransaction {
  return {
    batchId: ctx.batchId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    ...shopifyRefundTransactionFields(order, refund),
    shopifyStoreId: ctx.storeId,
    shopifyRefundId: refund.gid,
    transactionRef: order.gid,
    debitCredit: "debit",
    counterparty: "Shopify",
    isReversal: true,
    status: "unmatched",
  };
}

/** The fields a later sync may restate on an existing refund row. */
export function shopifyRefundTransactionFields(order: NormalizedShopifyOrder, refund: NormalizedShopifyRefund) {
  // Shopify may omit a refund's time; the order's update time is the latest
  // moment it can have happened by.
  const refundedAt = new Date(refund.createdAt ?? order.updatedAt);
  return {
    externalRef: order.name,
    description: shopifyRefundDescription(order.name),
    amount: refund.amount,
    currency: refund.currencyCode,
    transactionDate: refundedAt,
    valueDate: refundedAt,
    shopifyOrderCurrency: order.currencyCode,
    shopifyUpdatedAt: new Date(order.updatedAt),
    shopifyFinancialStatus: order.displayFinancialStatus,
    shopifyCancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    rawData: null,
  };
}
