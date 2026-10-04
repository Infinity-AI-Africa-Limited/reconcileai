/**
 * The codes of the channels a Shopify store's data lives in — one definition.
 *
 * Every writer that files a store's data into a channel, and every reader that
 * has to find all of it again (the shop-redaction inventory above all), takes
 * the code from here. A channel a reader does not know about is data it cannot
 * account for: the settlement-evidence channel was missed by the inventory
 * exactly that way while the order code sat duplicated in three modules.
 */

/** Orders synced from Shopify for one store. */
export function shopifyOrdersChannelCode(storeId: number): string {
  return `shopify_orders_${storeId}`;
}

/** Merchant-provided settlement evidence for one store; never names a provider. */
export function shopifySettlementEvidenceChannelCode(storeId: number): string {
  return `shopify_settlement_evidence_${storeId}`;
}
