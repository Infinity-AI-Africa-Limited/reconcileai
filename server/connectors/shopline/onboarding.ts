/**
 * SHOPLINE Merchant Self-Serve Onboarding
 *
 * When a SHOPLINE merchant installs ReconcileAI from the App Store, the OAuth
 * callback triggers this onboarding flow. It mirrors the WoodCore connector's
 * 4-step contract but is fully automated (no operator involvement):
 *
 *   1. organization  (segment retail_commerce, onboardingChannel shopline_app_store)
 *   2. admin user    (identity derived from SHOPLINE — no separate password)
 *   3. channels      (shopline_orders + shopline_payments)
 *   4. connector     (sl_connector_stores row, token stored)
 *
 * The merchant is ready to reconcile within 60 seconds of clicking "Install".
 */
import { eq, and } from "drizzle-orm";
import { organizations, users, channels } from "../../../drizzle/schema";
import { slConnectorStores, slConnectorTokens } from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { SHOPLINE_ONBOARDING_CHANNELS } from "../../../shared/shoplineConstants";
import type { ShoplineTokenResponse } from "./auth";
import { saveToken } from "./tokenStore";

export const SHOPLINE_ONBOARDING_CHANNEL = SHOPLINE_ONBOARDING_CHANNELS.APP_STORE;

/**
 * Deterministic, unique channel codes for a store's two data legs. Both the
 * onboarding provisioner and the sync orchestrator resolve channels by these
 * codes so they never create duplicates (channels.code is UNIQUE, so a name
 * mismatch between the two would otherwise throw on the first sync).
 */
export function shoplineOrdersChannelCode(handle: string): string {
  return `sl_orders_${handle}`.slice(0, 50);
}
export function shoplinePaymentsChannelCode(handle: string): string {
  return `sl_payments_${handle}`.slice(0, 50);
}

export interface ShoplineStoreInfo {
  /** Store handle (subdomain, e.g. "mystore") */
  handle: string;
  /** SHOPLINE-assigned store ID */
  storeId: string;
  /** SHOPLINE-assigned merchant ID */
  merchantId?: string;
  /** Primary domain */
  domain?: string;
  /** Store name (for org display name) */
  storeName?: string;
  /** ISO 4217 currency */
  currency?: string;
  /** IANA timezone */
  ianaTimezone?: string;
  /** Granted scopes (comma-separated) */
  grantedScopes?: string;
}

export interface OnboardShoplineMerchantInput {
  /** Store metadata from the OAuth callback / store.json API */
  store: ShoplineStoreInfo;
  /** The access token response from the token create endpoint */
  tokenResponse: ShoplineTokenResponse;
  /** Admin email (from store info or SHOPLINE identity) */
  adminEmail?: string;
  /** Admin name (from store info or SHOPLINE identity) */
  adminName?: string;
}

export interface OnboardShoplineMerchantResult {
  organizationId: number;
  organizationCode: string;
  adminUserId: number;
  slStoreId: number;
  ordersChannelId: number;
  paymentsChannelId: number;
  isReconnection: boolean;
}

export class ShoplineOnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: "DB_UNAVAILABLE" | "DUPLICATE_STORE" | "TOKEN_FAILED",
  ) {
    super(message);
    this.name = "ShoplineOnboardingError";
  }
}

/**
 * Derive an org code from the store handle, e.g. "mystore" → "SL_MYSTORE".
 */
export function deriveShoplineOrgCode(handle: string): string {
  const base = handle
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 35);
  return `SL_${base || "STORE"}`;
}

/**
 * Onboard a SHOPLINE merchant: fully automated, self-serve, zero-touch.
 *
 * Idempotent on store handle: if the store already exists and is active,
 * this is a reconnection (token refresh after reinstall). If uninstalled,
 * it reactivates the existing org.
 */
export async function onboardShoplineMerchant(
  input: OnboardShoplineMerchantInput,
): Promise<OnboardShoplineMerchantResult> {
  const db = await getDb();
  if (!db) throw new ShoplineOnboardingError("Database unavailable", "DB_UNAVAILABLE");

  const { store, tokenResponse, adminEmail, adminName } = input;

  // ─── Check for existing store (reconnection / reinstall) ──────────────
  const existingStore = await db
    .select()
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, store.handle))
    .limit(1);

  if (existingStore.length > 0) {
    const existing = existingStore[0];
    // Reconnection: reactivate and update token
    await db
      .update(slConnectorStores)
      .set({
        status: "active",
        storeId: store.storeId,
        merchantId: store.merchantId ?? existing.merchantId,
        domain: store.domain ?? existing.domain,
        currency: store.currency ?? existing.currency,
        ianaTimezone: store.ianaTimezone ?? existing.ianaTimezone,
        grantedScopes: store.grantedScopes ?? existing.grantedScopes,
        uninstalledAt: null,
      })
      .where(eq(slConnectorStores.id, existing.id));

    // Upsert token (AES-256-GCM encrypted via the token store — never plaintext)
    await saveToken(db, existing.id, existing.organizationId, tokenResponse);

    // Find existing channels by their deterministic codes
    const orgChannels = await db
      .select({ id: channels.id, code: channels.code })
      .from(channels)
      .where(eq(channels.organizationId, existing.organizationId));

    const ordersCode = shoplineOrdersChannelCode(existing.storeHandle);
    const paymentsCode = shoplinePaymentsChannelCode(existing.storeHandle);
    const ordersChannel = orgChannels.find((c) => c.code === ordersCode);
    const paymentsChannel = orgChannels.find((c) => c.code === paymentsCode);

    // Find admin user
    const adminUser = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, existing.organizationId), eq(users.role, "admin")))
      .limit(1);

    const orgRecord = await db
      .select({ code: organizations.code })
      .from(organizations)
      .where(eq(organizations.id, existing.organizationId))
      .limit(1);

    return {
      organizationId: existing.organizationId,
      organizationCode: orgRecord[0]?.code ?? "",
      adminUserId: adminUser[0]?.id ?? 0,
      slStoreId: existing.id,
      ordersChannelId: ordersChannel?.id ?? 0,
      paymentsChannelId: paymentsChannel?.id ?? 0,
      isReconnection: true,
    };
  }

  // ─── New installation: full 4-step provisioning ───────────────────────

  // 1) Organization
  const orgName = store.storeName || `${store.handle} Store`;
  let code = deriveShoplineOrgCode(store.handle);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.code, code))
      .limit(1);
    if (clash.length === 0) break;
    code = `${deriveShoplineOrgCode(store.handle).slice(0, 36)}_${attempt + 2}`;
  }

  const orgRes = await db.insert(organizations).values({
    name: orgName,
    code,
    segment: "retail_commerce",
    onboardingChannel: SHOPLINE_ONBOARDING_CHANNEL,
    country: "GLB", // Global — SHOPLINE merchants are worldwide
    baseCurrency: store.currency ?? "USD",
    isActive: true,
  });
  const organizationId = Number((orgRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  if (!organizationId) {
    throw new ShoplineOnboardingError("Failed to create organization", "DB_UNAVAILABLE");
  }

  // 2) Admin user — identity derived from SHOPLINE (no password)
  const email = (adminEmail || `${store.handle}@shopline.merchant`).trim().toLowerCase();
  const name = adminName || orgName;
  const openId = `shopline_${store.storeId}_${Date.now()}`;

  const userRes = await db.insert(users).values({
    openId,
    name,
    email,
    role: "admin",
    organizationId,
    isActive: true,
    loginMethod: "invite", // SHOPLINE identity — no password
  });
  const adminUserId = Number((userRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  // 3) Channels — two data feeds for the reconciliation engine
  const ordersChannelRes = await db.insert(channels).values({
    organizationId,
    name: `SHOPLINE Orders — ${orgName}`,
    code: shoplineOrdersChannelCode(store.handle),
    description: "Order data from SHOPLINE (order leg of reconciliation)",
    channelType: "ecommerce_gateway",
    country: "GLB",
    defaultCurrency: store.currency ?? "USD",
    matchingConfig: JSON.stringify({
      amountTolerance: 0.005, // 0.5% for FX variance
      dateWindowDays: 3,
      refFormat: "shopline_order_id",
    }),
    isActive: true,
  });
  const ordersChannelId = Number((ordersChannelRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  const paymentsChannelRes = await db.insert(channels).values({
    organizationId,
    name: `SHOPLINE Payments — ${orgName}`,
    code: shoplinePaymentsChannelCode(store.handle),
    description: "Payment transaction and settlement data from SHOPLINE Payments (gateway leg)",
    channelType: "ecommerce_gateway",
    country: "GLB",
    defaultCurrency: store.currency ?? "USD",
    matchingConfig: JSON.stringify({
      amountTolerance: 0.005,
      dateWindowDays: 3,
      refFormat: "shopline_channel_deal_id",
    }),
    isActive: true,
  });
  const paymentsChannelId = Number((paymentsChannelRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  // 4) Connector store record + token
  const storeRes = await db.insert(slConnectorStores).values({
    organizationId,
    storeHandle: store.handle,
    storeId: store.storeId,
    merchantId: store.merchantId ?? null,
    domain: store.domain ?? null,
    currency: store.currency ?? null,
    ianaTimezone: store.ianaTimezone ?? null,
    grantedScopes: store.grantedScopes ?? null,
    status: "active",
  });
  const slStoreId = Number((storeRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

  // Store the access token (AES-256-GCM encrypted via the token store)
  await saveToken(db, slStoreId, organizationId, tokenResponse);

  // 5) Tenant baseline (encryption key, quotas, modules) — fire-and-forget
  try {
    const { provisionTenantBaseline } = await import("../../provisioning");
    const baseline = await provisionTenantBaseline(organizationId);
    if (!baseline.ok) {
      console.error("[sl-onboarding] tenant baseline partial failure:", JSON.stringify(baseline.steps));
    }
  } catch (err) {
    console.error("[sl-onboarding] tenant baseline failed:", err);
  }

  // 6) Seed retail exception resolution templates for this org — fire-and-forget
  try {
    const { seedRetailExceptionDefaults } = await import("../../seedResolutionTemplates");
    await seedRetailExceptionDefaults();
  } catch (err) {
    console.error("[sl-onboarding] retail exception seed failed:", err);
  }

  return {
    organizationId,
    organizationCode: code,
    adminUserId,
    slStoreId,
    ordersChannelId,
    paymentsChannelId,
    isReconnection: false,
  };
}

/**
 * Handle merchant uninstall: mark store uninstalled and cancel its
 * subscription. Called from the `shop/redact` GDPR webhook, which SHOPLINE
 * fires 48h after an uninstall (there is no installation-status topic).
 * Cancelling here is what stops the connector syncing — a cancelled
 * subscription blocks immediately, with no grace buffer.
 */
export async function handleShoplineUninstall(storeHandle: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const stores = await db
    .select({ id: slConnectorStores.id })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.storeHandle, storeHandle));

  await db
    .update(slConnectorStores)
    .set({
      status: "uninstalled",
      uninstalledAt: new Date(),
    })
    .where(eq(slConnectorStores.storeHandle, storeHandle));

  const { cancelSubscriptionForStore } = await import("./billingWebhook");
  for (const s of stores) {
    await cancelSubscriptionForStore(db, s.id);
  }
}
