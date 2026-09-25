import type { InsertTransaction } from "../../../drizzle/schema";
import type { NormalizedShopifyOrder } from "./orders";

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
    transactionRef: order.gid,
    externalRef: order.name,
    description: `Shopify Order ${order.name}`,
    amount: order.currentTotalPrice.amount,
    currency: order.currentTotalPrice.currencyCode,
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
