import crypto from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS,
  SHOPIFY_REFRESH_LEASE_MS,
  shopifyConnectorStores,
  shopifyConnectorTokens,
} from "../../../drizzle/shopify_schema";
import { getDb } from "../../db";
import { decryptForTenant, encryptForTenant } from "../../_core/tenantKeys";
import { ENV } from "../../_core/env";
import {
  refreshExpiringOfflineToken,
  tokenExpiryFromSeconds,
  type ShopifyTokenResponse,
} from "./auth";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export class ShopifyTokenUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: "not_found" | "reauthorize" | "refresh_in_progress" | "refresh_retry" | "refresh_failed",
  ) {
    super(message);
    this.name = "ShopifyTokenUnavailableError";
  }
}

function assertTokenTiming(response: ShopifyTokenResponse): {
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
} {
  const accessExpiresAt = tokenExpiryFromSeconds(response.expires_in);
  if (!accessExpiresAt) throw new Error("Shopify token response is missing expires_in");
  return {
    accessExpiresAt,
    refreshExpiresAt: tokenExpiryFromSeconds(response.refresh_token_expires_in),
  };
}

/** Encrypt and atomically replace both rotating token values for a store. */
export async function saveShopifyTokens(
  db: Db,
  params: { storeId: number; organizationId: number; response: ShopifyTokenResponse },
): Promise<void> {
  const { accessExpiresAt, refreshExpiresAt } = assertTokenTiming(params.response);
  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptForTenant(params.organizationId, params.response.access_token),
    encryptForTenant(params.organizationId, params.response.refresh_token),
  ]);

  await db
    .insert(shopifyConnectorTokens)
    .values({
      storeId: params.storeId,
      organizationId: params.organizationId,
      accessTokenEnc,
      refreshTokenEnc,
      accessExpiresAt,
      refreshExpiresAt,
      rotationVersion: 1,
    })
    .onDuplicateKeyUpdate({
      set: {
        organizationId: params.organizationId,
        accessTokenEnc,
        refreshTokenEnc,
        accessExpiresAt,
        refreshExpiresAt,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        rotationVersion: sql`${shopifyConnectorTokens.rotationVersion} + 1`,
      },
    });
}

/**
 * Returns a valid access token for a tenant-owned store, rotating the expiring
 * offline token when necessary. Refresh ownership is leased in the database so
 * concurrent workers do not use the same one-time refresh token in parallel.
 */
export async function getValidShopifyAccessToken(params: {
  storeId: number;
  organizationId: number;
}): Promise<string> {
  const db = await getDb();
  if (!db) throw new ShopifyTokenUnavailableError("Database unavailable", "not_found");

  const [row] = await db
    .select({ token: shopifyConnectorTokens, shopDomain: shopifyConnectorStores.shopDomain })
    .from(shopifyConnectorTokens)
    .innerJoin(shopifyConnectorStores, eq(shopifyConnectorTokens.storeId, shopifyConnectorStores.id))
    .where(
      and(
        eq(shopifyConnectorTokens.storeId, params.storeId),
        eq(shopifyConnectorTokens.organizationId, params.organizationId),
        eq(shopifyConnectorStores.organizationId, params.organizationId),
        eq(shopifyConnectorStores.status, "active"),
      ),
    )
    .limit(1);
  if (!row) throw new ShopifyTokenUnavailableError("Shopify store is not active", "not_found");

  const accessToken = await decryptForTenant(params.organizationId, row.token.accessTokenEnc);
  if (!accessToken) throw new ShopifyTokenUnavailableError("Stored Shopify access token cannot be decrypted", "not_found");

  const refreshThreshold = new Date(Date.now() + SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS);
  if (row.token.accessExpiresAt > refreshThreshold) return accessToken;

  return rotateTokenUnderLease(db, {
    storeId: params.storeId,
    organizationId: params.organizationId,
    shopDomain: row.shopDomain,
    refreshThreshold,
  });
}

async function rotateTokenUnderLease(
  db: Db,
  params: {
    storeId: number;
    organizationId: number;
    shopDomain: string;
    refreshThreshold: Date;
  },
): Promise<string> {
  const leaseId = crypto.randomUUID();
  const leaseExpiry = new Date(Date.now() + SHOPIFY_REFRESH_LEASE_MS);

  await db
    .update(shopifyConnectorTokens)
    .set({ refreshLeaseId: leaseId, refreshLeaseExpiresAt: leaseExpiry })
    .where(
      and(
        eq(shopifyConnectorTokens.storeId, params.storeId),
        eq(shopifyConnectorTokens.organizationId, params.organizationId),
        lt(shopifyConnectorTokens.accessExpiresAt, params.refreshThreshold),
        or(
          isNull(shopifyConnectorTokens.refreshLeaseId),
          lt(shopifyConnectorTokens.refreshLeaseExpiresAt, new Date()),
        ),
      ),
    );

  const [claimed] = await db
    .select()
    .from(shopifyConnectorTokens)
    .where(
      and(
        eq(shopifyConnectorTokens.storeId, params.storeId),
        eq(shopifyConnectorTokens.organizationId, params.organizationId),
        eq(shopifyConnectorTokens.refreshLeaseId, leaseId),
      ),
    )
    .limit(1);

  if (!claimed) {
    // Another worker owns a valid lease. It must finish or expire before a retry;
    // returning the expiring token would reintroduce stale-token races.
    throw new ShopifyTokenUnavailableError("Shopify token refresh is already in progress", "refresh_in_progress");
  }

  try {
    const refreshToken = await decryptForTenant(params.organizationId, claimed.refreshTokenEnc);
    if (!refreshToken) {
      await markReauthorizationRequired(db, params);
      throw new ShopifyTokenUnavailableError("Stored Shopify refresh token cannot be decrypted", "reauthorize");
    }
    if (!ENV.shopifyClientId || !ENV.shopifyClientSecret) {
      throw new ShopifyTokenUnavailableError("Shopify client credentials are not configured", "refresh_failed");
    }

    const result = await refreshExpiringOfflineToken({
      shopDomain: params.shopDomain,
      clientId: ENV.shopifyClientId,
      clientSecret: ENV.shopifyClientSecret,
      refreshToken,
    });

    if (result.kind === "reauthorize") {
      await markReauthorizationRequired(db, params);
      throw new ShopifyTokenUnavailableError("Shopify authorization must be renewed", "reauthorize");
    }
    if (result.kind === "retry") {
      throw new ShopifyTokenUnavailableError("Shopify token refresh can be retried", "refresh_retry");
    }
    if (result.kind === "failed") {
      throw new ShopifyTokenUnavailableError("Shopify token refresh was rejected", "refresh_failed");
    }

    const { accessExpiresAt, refreshExpiresAt } = assertTokenTiming(result.token);
    const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
      encryptForTenant(params.organizationId, result.token.access_token),
      encryptForTenant(params.organizationId, result.token.refresh_token),
    ]);
    await db
      .update(shopifyConnectorTokens)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        accessExpiresAt,
        refreshExpiresAt,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        rotationVersion: sql`${shopifyConnectorTokens.rotationVersion} + 1`,
      })
      .where(
        and(
          eq(shopifyConnectorTokens.storeId, params.storeId),
          eq(shopifyConnectorTokens.organizationId, params.organizationId),
          eq(shopifyConnectorTokens.refreshLeaseId, leaseId),
        ),
      );
    return result.token.access_token;
  } finally {
    // Keep no lease after any terminal/transient failure. The next scheduled
    // operation may retry, while the DB still prevents concurrent refresh calls.
    await db
      .update(shopifyConnectorTokens)
      .set({ refreshLeaseId: null, refreshLeaseExpiresAt: null })
      .where(
        and(
          eq(shopifyConnectorTokens.storeId, params.storeId),
          eq(shopifyConnectorTokens.organizationId, params.organizationId),
          eq(shopifyConnectorTokens.refreshLeaseId, leaseId),
        ),
      );
  }
}

async function markReauthorizationRequired(
  db: Db,
  params: { storeId: number; organizationId: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(shopifyConnectorStores)
      .set({ status: "reauthorization_required" })
      .where(
        and(
          eq(shopifyConnectorStores.id, params.storeId),
          eq(shopifyConnectorStores.organizationId, params.organizationId),
        ),
      );
    await tx
      .delete(shopifyConnectorTokens)
      .where(
        and(
          eq(shopifyConnectorTokens.storeId, params.storeId),
          eq(shopifyConnectorTokens.organizationId, params.organizationId),
        ),
      );
  });
}
