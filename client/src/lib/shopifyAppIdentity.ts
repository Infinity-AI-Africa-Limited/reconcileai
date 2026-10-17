/**
 * The name merchants see for the Shopify app: the `name` in shopify.app.toml,
 * which is what Shopify Admin shows in its app list. App Home uses it so the
 * embedded workspace says what Admin says.
 *
 * It names the Shopify app, not the platform behind it. The platform, its
 * sign-in and its Payment Exceptions page are ReconcileAI, and so is whoever
 * issues privacy and legal statements. Keep it apart from stable technical
 * identifiers such as URL paths, session attributes and database fields.
 */
export const SHOPIFY_APP_DISPLAY_NAME = "ReconcileAI Dev Store";
