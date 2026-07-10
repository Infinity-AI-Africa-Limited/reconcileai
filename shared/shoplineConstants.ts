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
export const TIER_1_SUBSCRIPTION_BANDS = [
  { id: "starter", label: "Starter", maxTransactions: 500, monthlyPriceUsd: 49 },
  { id: "growth", label: "Growth", maxTransactions: 2_000, monthlyPriceUsd: 99 },
  { id: "professional", label: "Professional", maxTransactions: 10_000, monthlyPriceUsd: 199 },
  { id: "scale", label: "Scale", maxTransactions: 50_000, monthlyPriceUsd: 349 },
  { id: "enterprise", label: "Enterprise", maxTransactions: Infinity, monthlyPriceUsd: null },
] as const;

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
// Required OAuth scopes for the SHOPLINE App Store integration (Tier 1)
export const SHOPLINE_REQUIRED_SCOPES = [
  "read_orders",
  "read_payments",
  "read_settlements",
  "read_shop",
] as const;
