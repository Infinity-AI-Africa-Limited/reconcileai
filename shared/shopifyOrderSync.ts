/**
 * How far back a store's FIRST order sync reads, in days. Shared so the App
 * Home's description of the sync and the server's actual window cannot drift
 * apart.
 *
 * 60 is the `read_orders` scope's own limit: without `read_all_orders`, Shopify
 * returns only orders from the last 60 days, so a longer window asks for
 * nothing more. Later syncs start from the stored watermark instead.
 */
export const SHOPIFY_INITIAL_ORDER_WINDOW_DAYS = 60;
