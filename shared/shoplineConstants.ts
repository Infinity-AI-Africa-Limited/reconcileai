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
// CONFIRMED in SHOPLINE Partner Portal (2026-07-19).
// Plan names and spuKeys match the portal configuration exactly.
export const TIER_1_FREE_TRIAL_DAYS = 7;

export const TIER_1_SUBSCRIPTION_BANDS = [
  { id: "starter", spuKey: "starter", label: "Starter", maxOrders: 500, maxStores: 1, monthlyPriceUsd: 29 },
  { id: "growth", spuKey: "growth", label: "Growth", maxOrders: 2_000, maxStores: 3, monthlyPriceUsd: 79 },
  { id: "professional", spuKey: "professional", label: "Professional", maxOrders: 10_000, maxStores: 10, monthlyPriceUsd: 149 },
  { id: "enterprise", spuKey: "enterprise", label: "Scale", maxOrders: 50_000, maxStores: 50, monthlyPriceUsd: 299 },
  { id: "enterprise_plus", spuKey: "enterprise_plus", label: "Enterprise", maxOrders: Infinity, maxStores: Infinity, monthlyPriceUsd: 499 },
] as const;

export type SubscriptionBandId = (typeof TIER_1_SUBSCRIPTION_BANDS)[number]["id"];

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
