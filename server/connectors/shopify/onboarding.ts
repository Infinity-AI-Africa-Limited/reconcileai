import { and, eq } from "drizzle-orm";
import { organizations, users } from "../../../drizzle/schema";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_ORDER_LED_SCOPES,
  shopifyConnectorStores,
  shopifyConnectorTokens,
} from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { createAuditLog } from "../../db";
import { sendWelcomeEmail } from "../../magicLinkService";
import { sha256, type ShopifyTokenResponse } from "./auth";
import { saveShopifyTokens } from "./tokenStore";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyShopMetadata {
  id: string;
  name: string;
  contactEmail: string;
  primaryDomain: string | null;
  currencyCode: string | null;
  ianaTimezone: string | null;
}

export interface ShopifyOnboardingResult {
  storeId: number;
  organizationId: number;
  organizationCode: string;
  connectedUserId: number;
  isReinstallation: boolean;
  welcomeEmailSent: boolean;
}

export class ShopifyOnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: "EMAIL_CONFLICT" | "MISSING_CONTACT_EMAIL" | "DB_UNAVAILABLE" | "TOKEN_STORE_FAILED",
  ) {
    super(message);
    this.name = "ShopifyOnboardingError";
  }
}

/** Deterministic, non-identifying tenant code; a shop's display name is not a safe key. */
export function deriveShopifyOrganizationCode(shopDomain: string): string {
  return `SHP_${sha256(shopDomain).slice(0, 14).toUpperCase()}`;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Create or reconnect one merchant-owned ReconcileAI tenant after Shopify has
 * authenticated the shop. It does not create any reconciliation data or run a
 * sync: the first data cycle belongs to the separately reviewed sync phase.
 */
export async function onboardShopifyMerchant(params: {
  shopDomain: string;
  metadata: ShopifyShopMetadata;
  tokenResponse: ShopifyTokenResponse;
  origin: string;
}): Promise<ShopifyOnboardingResult> {
  const db = await getDb();
  if (!db) throw new ShopifyOnboardingError("Database unavailable", "DB_UNAVAILABLE");
  const email = params.metadata.contactEmail.trim().toLowerCase();
  if (!validEmail(email)) {
    throw new ShopifyOnboardingError("Shopify did not return a usable shop contact email", "MISSING_CONTACT_EMAIL");
  }

  const [existingStore] = await db
    .select()
    .from(shopifyConnectorStores)
    .where(eq(shopifyConnectorStores.shopDomain, params.shopDomain))
    .limit(1);

  if (existingStore) {
    const [existingUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.organizationId, existingStore.organizationId), eq(users.role, "admin")))
      .limit(1);
    if (!existingUser) {
      throw new ShopifyOnboardingError("Existing Shopify tenant has no administrator", "DB_UNAVAILABLE");
    }

    await db
      .update(shopifyConnectorStores)
      .set({
        shopId: params.metadata.id,
        displayName: params.metadata.name,
        primaryDomain: params.metadata.primaryDomain,
        currency: params.metadata.currencyCode,
        ianaTimezone: params.metadata.ianaTimezone,
        grantedScopes: params.tokenResponse.scope,
        requestedScopes: SHOPIFY_ORDER_LED_SCOPES.join(","),
        apiVersion: SHOPIFY_API_VERSION,
        status: "active",
        claimedByUserId: existingUser.id,
        claimedAt: new Date(),
        uninstalledAt: null,
      })
      .where(eq(shopifyConnectorStores.id, existingStore.id));
    await saveShopifyTokens(db, {
      storeId: existingStore.id,
      organizationId: existingStore.organizationId,
      response: params.tokenResponse,
    });

    const [organization] = await db
      .select({ code: organizations.code })
      .from(organizations)
      .where(eq(organizations.id, existingStore.organizationId))
      .limit(1);
    await auditConnectorEvent({
      db,
      organizationId: existingStore.organizationId,
      userId: existingUser.id,
      action: "shopify_store_reauthorized",
      storeId: existingStore.id,
      shopDomain: params.shopDomain,
    });
    return {
      storeId: existingStore.id,
      organizationId: existingStore.organizationId,
      organizationCode: organization?.code ?? "",
      connectedUserId: existingUser.id,
      isReinstallation: true,
      welcomeEmailSent: false,
    };
  }

  // A public merchant address must never be silently attached to another tenant.
  const [emailOwner] = await db
    .select({ id: users.id, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (emailOwner) {
    throw new ShopifyOnboardingError("That Shopify contact email is already linked to a different workspace", "EMAIL_CONFLICT");
  }

  const organizationCode = deriveShopifyOrganizationCode(params.shopDomain);
  const openId = `shopify_${sha256(`${params.shopDomain}:${Date.now()}:${Math.random()}`).slice(0, 40)}`;
  const { organizationId, userId, storeId } = await db.transaction(async (tx) => {
    const orgResult = await tx.insert(organizations).values({
      name: params.metadata.name,
      code: organizationCode,
      country: "GLB",
      baseCurrency: params.metadata.currencyCode?.slice(0, 3) || "USD",
      segment: "retail_commerce",
      onboardingChannel: "shopify_public_app",
      isActive: true,
    });
    const organizationId = Number((orgResult as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
    if (!organizationId) throw new ShopifyOnboardingError("Could not create merchant workspace", "DB_UNAVAILABLE");

    const userResult = await tx.insert(users).values({
      openId,
      name: params.metadata.name,
      email,
      loginMethod: "invite",
      role: "admin",
      organizationId,
      isActive: true,
      isReadOnly: false,
    });
    const userId = Number((userResult as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
    if (!userId) throw new ShopifyOnboardingError("Could not create merchant administrator", "DB_UNAVAILABLE");

    const storeResult = await tx.insert(shopifyConnectorStores).values({
      organizationId,
      shopDomain: params.shopDomain,
      shopId: params.metadata.id,
      displayName: params.metadata.name,
      primaryDomain: params.metadata.primaryDomain,
      currency: params.metadata.currencyCode,
      ianaTimezone: params.metadata.ianaTimezone,
      grantedScopes: params.tokenResponse.scope,
      requestedScopes: SHOPIFY_ORDER_LED_SCOPES.join(","),
      apiVersion: SHOPIFY_API_VERSION,
      status: "active",
      claimedByUserId: userId,
      claimedAt: new Date(),
    });
    const storeId = Number((storeResult as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
    if (!storeId) throw new ShopifyOnboardingError("Could not create Shopify store record", "DB_UNAVAILABLE");
    return { organizationId, userId, storeId };
  });

  try {
    await saveShopifyTokens(db, { storeId, organizationId, response: params.tokenResponse });
  } catch (error) {
    // A workspace with no usable token must never appear active.
    await db
      .update(shopifyConnectorStores)
      .set({ status: "reauthorization_required" })
      .where(eq(shopifyConnectorStores.id, storeId));
    throw new ShopifyOnboardingError(
      `Could not secure Shopify access tokens: ${error instanceof Error ? error.message : "unknown failure"}`,
      "TOKEN_STORE_FAILED",
    );
  }

  await auditConnectorEvent({
    db,
    organizationId,
    userId,
    action: "shopify_store_installed",
    storeId,
    shopDomain: params.shopDomain,
  });

  let welcomeEmailSent = false;
  try {
    const result = await sendWelcomeEmail({
      userId,
      name: params.metadata.name,
      email,
      role: "admin",
      origin: params.origin,
      returnTo: `/shopify/welcome?shop=${encodeURIComponent(params.shopDomain)}`,
    });
    welcomeEmailSent = result.success;
  } catch (error) {
    // The connection is retained and auditable. A support workflow can resend the
    // magic link; silently losing OAuth credentials would be worse than a delivery failure.
    console.error("[shopify-onboarding] welcome email delivery failed", {
      storeId,
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { storeId, organizationId, organizationCode, connectedUserId: userId, isReinstallation: false, welcomeEmailSent };
}

async function auditConnectorEvent(params: {
  db: Db;
  organizationId: number;
  userId: number;
  action: string;
  storeId: number;
  shopDomain: string;
}): Promise<void> {
  try {
    await createAuditLog(
      {
        organizationId: params.organizationId,
        userId: params.userId,
        action: params.action,
        entityType: "shopify_store",
        entityId: params.storeId,
        details: { shopDomain: params.shopDomain, provider: "shopify" },
      },
      params.db,
    );
  } catch (error) {
    // The connector's durable store/token record remains authoritative; audit
    // failure must surface in logs without sending raw OAuth material anywhere.
    console.error("[shopify-onboarding] audit write failed", {
      storeId: params.storeId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
