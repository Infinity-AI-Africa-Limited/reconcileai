/**
 * The URLs Shopify is told about, in one place.
 *
 * `shopify.app.toml` deploys them to Shopify as the App URL, the OAuth
 * redirect allow-list and the webhook endpoint. The routes serve them from
 * these constants, and appConfig.test.ts checks the TOML against them. A path
 * renamed in code therefore fails that test instead of leaving Shopify
 * pointing at a dead URL: an OAuth redirect Shopify refuses, or webhook
 * deliveries failing until Shopify removes the subscription.
 *
 * The webhook path is also where the raw-body parser is mounted (webhookBody.ts),
 * which the HMAC check depends on. One constant keeps the parser and the handler
 * on the same route.
 */
export const SHOPIFY_APP_HOME_PATH = "/shopify/app";
/**
 * The retired authorization-code path. Both routes still answer (routes.ts),
 * only to refuse: installation is Shopify-managed. The callback stays listed in
 * shopify.app.toml because the CLI requires a redirect allow-list.
 */
export const SHOPIFY_RETIRED_INSTALL_PATH = "/api/shopify/install";
export const SHOPIFY_OAUTH_CALLBACK_PATH = "/api/shopify/callback";
export const SHOPIFY_WEBHOOK_PATH = "/api/webhooks/shopify";
