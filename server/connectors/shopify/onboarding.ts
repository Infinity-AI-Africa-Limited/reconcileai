import crypto from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { organizations, users } from "../../../drizzle/schema";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_ORDER_LED_SCOPES,
  shopifyConnectorStores,
  type ShopifyConnectorStore,
  type ShopifyStatusReason,
} from "../../../drizzle/shopify_schema";
import { createAuditLog, getDb } from "../../db";
import { isDuplicateKeyError } from "../../dbErrors";
import { sendWelcomeEmail } from "../../magicLinkService";
import { sha256, type ShopifyTokenResponse } from "./auth";
import { affectedRows, encryptShopifyTokens, markReauthorizationRequired, writeShopifyTokens } from "./tokenStore";

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

export type ShopifyOnboardingErrorCode =
  | "EMAIL_CONFLICT"
  | "MISSING_CONTACT_EMAIL"
  | "DB_UNAVAILABLE"
  | "TOKEN_STORE_FAILED"
  /** The shop's contact email matches no active administrator of the workspace that owns it. */
  | "OWNERSHIP_UNVERIFIED"
  /** The shop's permanent domain and its Shopify id point at different records. */
  | "SHOP_IDENTITY_CONFLICT"
  /** The shop's deterministic workspace code is taken, but no store record explains it. */
  | "WORKSPACE_CONFLICT";

export class ShopifyOnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: ShopifyOnboardingErrorCode,
  ) {
    super(message);
    this.name = "ShopifyOnboardingError";
  }
}

/** organizations.name is varchar(255); a longer Shopify shop name must not fail the install. */
const ORGANIZATION_NAME_MAX = 255;

/** Deterministic, non-identifying tenant code; a shop's display name is not a safe key. */
export function deriveShopifyOrganizationCode(shopDomain: string): string {
  return `SHP_${sha256(shopDomain).slice(0, 14).toUpperCase()}`;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Case-insensitive email equality, in SQL.
 *
 * Production is TiDB, whose default utf8mb4 collation is `utf8mb4_bin` — binary,
 * so case-SENSITIVE. A bare `eq(users.email, email)` there misses an address
 * stored with different case: an ownership check would refuse its own merchant,
 * and a collision check would wave a duplicate through.
 */
function emailEquals(email: string) {
  return eq(sql<string>`lower(${users.email})`, email);
}

/**
 * Create or reconnect one merchant-owned ReconcileAI tenant after Shopify has
 * authenticated the shop. It does not create any reconciliation data or run a
 * sync: the first data cycle belongs to the separately reviewed sync phase.
 *
 * ── The fact every branch below is built on ──────────────────────────────
 *
 * By the time this runs the callback has already exchanged the authorization
 * code, and Shopify retires every OTHER refresh token for the app on the store
 * at that moment (shopify.dev, "How refresh token rotation works"). So for a
 * store we already hold credentials for, the stored refresh token is dead
 * whatever happens next. Any branch that does not store the new pair must take
 * the store out of service — leaving it `active` would report a connection that
 * stops working within the hour.
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

  const existing = await findExistingStore(db, params.shopDomain, params.metadata.id);
  if (existing) return reauthorizeExistingStore(db, existing, params, email);

  try {
    return await createMerchantWorkspace(db, params, email);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Two first-time callbacks for one shop both passed the lookup above; the
    // unique workspace code / store identity let exactly one create the tenant.
    // That tenant is now committed, so this callback is a reauthorization of it
    // and goes through the same ownership check — not a failed install, which
    // is what the merchant was shown while the other tab had succeeded.
    const winner = await findExistingStore(db, params.shopDomain, params.metadata.id);
    if (!winner) {
      throw new ShopifyOnboardingError(
        "The workspace code for this shop is already in use by a workspace with no Shopify store",
        "WORKSPACE_CONFLICT",
      );
    }
    return reauthorizeExistingStore(db, winner, params, email);
  }
}

/**
 * The store record this shop already has, by its Shopify id OR its permanent
 * domain. Both are unique, and they must agree: a domain that now names a
 * different shop id (or two records, one per key) cannot be resolved by picking
 * one — attaching a fresh grant to the wrong tenant is the failure being
 * prevented, so it is refused instead.
 */
async function findExistingStore(db: Db, shopDomain: string, shopId: string): Promise<ShopifyConnectorStore | null> {
  const rows = await db
    .select()
    .from(shopifyConnectorStores)
    .where(or(eq(shopifyConnectorStores.shopId, shopId), eq(shopifyConnectorStores.shopDomain, shopDomain)))
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length > 1 || rows[0].shopId !== shopId) {
    console.error("[shopify-onboarding] shop identity conflict", {
      shopDomain,
      storeIds: rows.map((row) => row.id),
    });
    throw new ShopifyOnboardingError("This Shopify store's identity conflicts with an existing connection", "SHOP_IDENTITY_CONFLICT");
  }
  return rows[0];
}

/**
 * A fresh grant for a shop we already know. It is attached to the owning
 * workspace ONLY when the shop's current contact email belongs to an active
 * administrator of that workspace.
 *
 * Without that check a shop that changed hands — sold, or transferred to a new
 * operator — would have the new owner's order access filed under the previous
 * owner's workspace the moment they reinstalled. Refusing is recoverable
 * (support verifies and reattaches); a silent cross-tenant attachment is not.
 */
async function reauthorizeExistingStore(
  db: Db,
  store: ShopifyConnectorStore,
  params: Parameters<typeof onboardShopifyMerchant>[0],
  email: string,
): Promise<ShopifyOnboardingResult> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, store.organizationId),
        eq(users.role, "admin"),
        eq(users.isActive, true),
        emailEquals(email),
      ),
    )
    .limit(1);

  if (!admin) {
    // The new grant has already retired this store's refresh token, so the
    // workspace's connection is dead either way; this records it as such.
    await failClosed(db, store, "ownership_unverified");
    throw new ShopifyOnboardingError(
      "The Shopify store's contact email does not match an administrator of its ReconcileAI workspace",
      "OWNERSHIP_UNVERIFIED",
    );
  }

  try {
    const tokens = await encryptShopifyTokens(store.organizationId, params.tokenResponse);
    await db.transaction(async (tx) => {
      // Store state, credentials and the record of both commit together. The
      // store becomes `active` only in the same commit that stores the pair it
      // is active ON — never ahead of it, as a separate write could leave it.
      const updated = affectedRows(
        await tx
          .update(shopifyConnectorStores)
          .set({
            shopDomain: params.shopDomain,
            displayName: params.metadata.name,
            primaryDomain: params.metadata.primaryDomain,
            currency: params.metadata.currencyCode,
            ianaTimezone: params.metadata.ianaTimezone,
            grantedScopes: params.tokenResponse.scope,
            requestedScopes: SHOPIFY_ORDER_LED_SCOPES.join(","),
            apiVersion: SHOPIFY_API_VERSION,
            status: "active",
            statusReason: null,
            claimedByUserId: admin.id,
            claimedAt: new Date(),
            uninstalledAt: null,
          })
          .where(
            and(
              eq(shopifyConnectorStores.id, store.id),
              eq(shopifyConnectorStores.organizationId, store.organizationId),
            ),
          ),
      );
      if (updated !== 1) throw new Error(`Shopify store ${store.id} was not updated (affected ${updated})`);
      await writeShopifyTokens(tx, { storeId: store.id, organizationId: store.organizationId, tokens });
      await createAuditLog(
        {
          organizationId: store.organizationId,
          userId: admin.id,
          action: "shopify_store_reauthorized",
          entityType: "shopify_store",
          entityId: store.id,
          details: { shopDomain: params.shopDomain, provider: "shopify" },
        },
        tx,
      );
    });
  } catch (error) {
    await failClosed(db, store, "token_store_failed");
    throw new ShopifyOnboardingError(
      `Could not secure Shopify access tokens: ${error instanceof Error ? error.message : "unknown failure"}`,
      "TOKEN_STORE_FAILED",
    );
  }

  const [organization] = await db
    .select({ code: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, store.organizationId))
    .limit(1);
  return {
    storeId: store.id,
    organizationId: store.organizationId,
    organizationCode: organization?.code ?? "",
    connectedUserId: admin.id,
    isReinstallation: true,
    welcomeEmailSent: false,
  };
}

async function createMerchantWorkspace(
  db: Db,
  params: Parameters<typeof onboardShopifyMerchant>[0],
  email: string,
): Promise<ShopifyOnboardingResult> {
  // A public merchant address must never be silently attached to another tenant.
  const [emailOwner] = await db.select({ id: users.id }).from(users).where(emailEquals(email)).limit(1);
  if (emailOwner) {
    throw new ShopifyOnboardingError("That Shopify contact email is already linked to a different workspace", "EMAIL_CONFLICT");
  }

  const organizationCode = deriveShopifyOrganizationCode(params.shopDomain);
  const openId = `shopify_${crypto.randomBytes(20).toString("hex")}`;

  // 1) The tenant, its administrator and the store record — atomically. The
  //    store starts `pending_claim`: it is not active until its credentials are
  //    stored, so a crash between the two steps leaves a store that truthfully
  //    says it is not connected, and the merchant's retry completes it through
  //    the reauthorization path.
  const { organizationId, userId, storeId } = await db.transaction(async (tx) => {
    const orgResult = await tx.insert(organizations).values({
      name: params.metadata.name.slice(0, ORGANIZATION_NAME_MAX),
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
      status: "pending_claim",
      claimedByUserId: userId,
      claimedAt: new Date(),
    });
    const storeId = Number((storeResult as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
    if (!storeId) throw new ShopifyOnboardingError("Could not create Shopify store record", "DB_UNAVAILABLE");

    await createAuditLog(
      {
        organizationId,
        userId,
        action: "shopify_store_installed",
        entityType: "shopify_store",
        entityId: storeId,
        details: { shopDomain: params.shopDomain, provider: "shopify" },
      },
      tx,
    );
    return { organizationId, userId, storeId };
  });

  // 2) Tenant baseline — the same step every other organisation-creation path
  //    runs (envelope key, quotas, the modules this vertical can use). It runs
  //    after the tenant commits because it writes on its own connections, which
  //    cannot see an uncommitted organisation; and BEFORE the credentials,
  //    because it is what provisions the key they are encrypted under.
  //    Best-effort by contract — it returns a checklist rather than throwing —
  //    and encryption provisions the key itself if this step could not.
  try {
    const { provisionTenantBaseline } = await import("../../provisioning");
    const baseline = await provisionTenantBaseline(organizationId);
    if (!baseline.ok) {
      console.error("[shopify-onboarding] tenant baseline partial failure", {
        organizationId,
        steps: baseline.steps,
      });
    }
  } catch (error) {
    console.error("[shopify-onboarding] tenant baseline failed", {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 3) Credentials, and only with them, `active`.
  try {
    const tokens = await encryptShopifyTokens(organizationId, params.tokenResponse);
    await db.transaction(async (tx) => {
      await writeShopifyTokens(tx, { storeId, organizationId, tokens });
      await tx
        .update(shopifyConnectorStores)
        .set({ status: "active", statusReason: null })
        .where(and(eq(shopifyConnectorStores.id, storeId), eq(shopifyConnectorStores.organizationId, organizationId)));
    });
  } catch (error) {
    // A workspace with no usable token must never appear active.
    await failClosed(db, { id: storeId, organizationId }, "token_store_failed");
    throw new ShopifyOnboardingError(
      `Could not secure Shopify access tokens: ${error instanceof Error ? error.message : "unknown failure"}`,
      "TOKEN_STORE_FAILED",
    );
  }

  let welcomeEmailSent = false;
  try {
    const result = await sendWelcomeEmail({
      userId,
      name: params.metadata.name,
      email,
      role: "admin",
      origin: params.origin,
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

/** Take the store out of service after a failed or refused authorization, never masking the original error. */
async function failClosed(
  db: Db,
  store: Pick<ShopifyConnectorStore, "id" | "organizationId">,
  reason: ShopifyStatusReason,
): Promise<void> {
  try {
    await markReauthorizationRequired(db, { storeId: store.id, organizationId: store.organizationId, reason });
  } catch (error) {
    console.error("[shopify-onboarding] could not take store out of service", {
      storeId: store.id,
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
