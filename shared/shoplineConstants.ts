/**
 * SHOPLINE Partnership Constants
 *
 * Shared constants for the SHOPLINE retail commerce vertical.
 * Used by both server (tenant provisioning, connector logic) and client
 * (admin portal, merchant dashboard) code.
 */

// ─── Onboarding Channel Codes ────────────────────────────────────────────────
// These values are stored in organizations.onboardingChannel (varchar, not enum).
export const SHOPLINE_ONBOARDING_CHANNELS = {
  /** Tier 1 — Self-provisioned via SHOPLINE App Store OAuth install */
  APP_STORE: "shopline_app_store",
  /** Tier 2 — SHOPLINE Payments as a single API client tenant */
  PAYMENTS_API: "shopline_payments_api",
  /** Tier 3 — Provisioned by SHOPLINE enterprise sales for on-premise bundle */
  ENTERPRISE: "shopline_enterprise",
} as const;

export type ShoplineOnboardingChannel =
  (typeof SHOPLINE_ONBOARDING_CHANNELS)[keyof typeof SHOPLINE_ONBOARDING_CHANNELS];

// ─── Tier Definitions ────────────────────────────────────────────────────────
export const SHOPLINE_TIERS = {
  TIER_1: {
    id: "tier_1",
    label: "App Store Integration",
    description: "Self-serve reconciliation via SHOPLINE App Store",
    channel: SHOPLINE_ONBOARDING_CHANNELS.APP_STORE,
  },
  TIER_2: {
    id: "tier_2",
    label: "SHOPLINE Payments Embedded",
    description: "White-label reconciliation embedded in SHOPLINE Payments",
    channel: SHOPLINE_ONBOARDING_CHANNELS.PAYMENTS_API,
  },
  TIER_3: {
    id: "tier_3",
    label: "Enterprise Bundle",
    description: "On-premise deployment for enterprise merchants",
    channel: SHOPLINE_ONBOARDING_CHANNELS.ENTERPRISE,
  },
} as const;

// ─── Subscription Bands (Tier 1) ─────────────────────────────────────────────
// CONFIRMED in the SHOPLINE Partner Portal (pricing populated there 2026-07-27).
// SHOPLINE runs the actual billing (App-Store-managed) — these bands exist so
// OUR platform can enforce/report each plan's LIMITS (orders/month, connected
// stores) and honour the grace period. Prices are reference metadata (SHOPLINE
// collects payment; ReconcileAI never renders a price or charges a card).
// spuKeys are what arrive in billing-webhook payloads — do not change them
// without a matching portal change (portal plan "Scale" → spuKey "enterprise",
// portal "Enterprise" → spuKey "enterprise_plus"; see the label vs id below).

/** Free trial before the first charge (portal-confirmed). */
export const TIER_1_FREE_TRIAL_DAYS = 7;

/**
 * Grace period after a FAILED RENEWAL or EXPIRY — the buffer during which a
 * merchant keeps access while they resolve payment, before the connector cuts
 * off sync. Portal-confirmed at 7 days.
 */
export const TIER_1_GRACE_PERIOD_DAYS = 7;

export const TIER_1_SUBSCRIPTION_BANDS = [
  { id: "starter", spuKey: "starter", label: "Starter", maxOrders: 500, maxStores: 1, monthlyPriceUsd: 29, annualPriceUsd: 290,
    description: "Up to 500 orders/month. 1 connected store. Automated reconciliation, exception alerts, and settlement tracking." },
  { id: "growth", spuKey: "growth", label: "Growth", maxOrders: 2_000, maxStores: 3, monthlyPriceUsd: 79, annualPriceUsd: 790,
    description: "Up to 2,000 orders/month. 3 connected stores. Everything in Starter plus multi-store reconciliation and priority exception handling." },
  { id: "professional", spuKey: "professional", label: "Professional", maxOrders: 10_000, maxStores: 5, monthlyPriceUsd: 149, annualPriceUsd: 1490,
    description: "Up to 10,000 orders/month. 5 connected stores. Full reconciliation suite with advanced analytics and dedicated exception management." },
  { id: "enterprise", spuKey: "enterprise", label: "Scale", maxOrders: 50_000, maxStores: 10, monthlyPriceUsd: 299, annualPriceUsd: 2990,
    description: "10,001–50,000 orders. 10 stores. Full platform access with custom reporting, API access, and SLA-backed support." },
  { id: "enterprise_plus", spuKey: "enterprise_plus", label: "Enterprise", maxOrders: Infinity, maxStores: Infinity, monthlyPriceUsd: 499, annualPriceUsd: 4990,
    description: "Unlimited orders. Unlimited stores. Everything in Scale, plus dedicated account management, custom integrations, and white-glove onboarding support." },
] as const;

export type SubscriptionBandId = (typeof TIER_1_SUBSCRIPTION_BANDS)[number]["id"];
export type ShoplinePlanLimits = { maxOrders: number; maxStores: number };

/** Look up a band by its stored planId (== spuKey) or its id. Null if unknown. */
export function getShoplineBand(planId: string | null | undefined) {
  if (!planId) return null;
  return (
    TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === planId || b.id === planId) ?? null
  );
}

/**
 * Enforceable limits for a plan. Unknown plan → most-generous (Infinity) so a
 * webhook lag or a plan we don't recognise never wrongly throttles a merchant;
 * SHOPLINE remains the source of truth for billing/plan assignment.
 */
export function getShoplinePlanLimits(planId: string | null | undefined): ShoplinePlanLimits {
  const band = getShoplineBand(planId);
  return {
    maxOrders: band ? band.maxOrders : Infinity,
    maxStores: band ? band.maxStores : Infinity,
  };
}

// ─── Retail Channel Type Codes ───────────────────────────────────────────────
// Corresponds to the new channelType enum values added in drizzle/schema.ts
export const RETAIL_CHANNEL_TYPES = [
  "ecommerce_gateway",
  "marketplace_payout",
  "buy_now_pay_later",
  "digital_wallet",
] as const;

export type RetailChannelType = (typeof RETAIL_CHANNEL_TYPES)[number];

// ─── Revenue Share ───────────────────────────────────────────────────────────
/** SHOPLINE's revenue share percentage on Tier 1 App Store subscriptions */
export const SHOPLINE_REVENUE_SHARE_PERCENT = 15;

// ─── API Scopes ──────────────────────────────────────────────────────────────
// Required OAuth scopes for the SHOPLINE App Store integration (Tier 1).
// VERIFIED against the published AccessScope list (developer.shopline.com,
// 2026-07-18 — see docs/SHOPLINE_PHASE1_API_EXTRACT.md §A4). Note: settlement
// and payout data live under `read_payment` (singular); there is no
// `read_settlements` scope, and store info is `read_store_information`.
export const SHOPLINE_REQUIRED_SCOPES = [
  "read_orders", // orders, transactions, fulfillments, order payment
  "read_payment", // SHOPLINE Payments: payouts, balance, transactions, billing records
  "read_store_information", // store info incl. currency + iana_timezone
  "read_returns", // returns / return orders (refund-leg reconciliation)
  "read_gift_card", // gift card ops (retail_giftcard_split_tender category)
] as const;

// ─── Verified API constants (docs/SHOPLINE_PHASE1_API_EXTRACT.md) ────────────
/** Current stable Admin REST API version (quarterly cadence, 12-month support). */
export const SHOPLINE_API_VERSION = "v20260601";

/** Access tokens expire after 10 hours; refresh proactively well before. */
export const SHOPLINE_TOKEN_TTL_HOURS = 10;

/** Webhook topics the Tier 1 connector subscribes to per store (reconciliation). */
export const SHOPLINE_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/edited",
  "orders/paid",
  "orders/cancelled",
  "orders/delete",
  "refunds/create",
  "refunds/update",
  "order_transactions/create",
] as const;

/**
 * Billing & lifecycle webhook topics registered in the SHOPLINE Partner Portal.
 * These are received at the same /api/webhooks/shopline endpoint.
 * CONFIRMED in portal (2026-07-19).
 */
export const SHOPLINE_BILLING_WEBHOOK_TOPICS = [
  "app_plan/activated",
  "app_plan/expired",
  "billing_attempts/succeed",
  "billing_attempts/fail",
  "app/installation_status_changed",
] as const;

export type ShoplineBillingWebhookTopic = (typeof SHOPLINE_BILLING_WEBHOOK_TOPICS)[number];

/** Mandatory GDPR topics (configured in the SHOPLINE Developer Center, not via API). */
export const SHOPLINE_GDPR_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

/**
 * Canonical GDPR endpoint paths registered in the SHOPLINE Partner Portal.
 * (The older customers-redact / merchants-redact paths remain as aliases in
 * the Express router for any previously-registered URL.)
 */
export const SHOPLINE_GDPR_ENDPOINTS = {
  customerDataRequest: "/api/shopline/gdpr/customers-data-request",
  shopDataRequest: "/api/shopline/gdpr/shop-data-request",
} as const;
