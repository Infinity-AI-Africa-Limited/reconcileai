import crypto from "node:crypto";
import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/mysql-core";
import {
  SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS,
  SHOPIFY_REFRESH_LEASE_MS,
  shopifyConnectorStores,
  shopifyConnectorTokens,
  type ShopifyStatusReason,
} from "../../../drizzle/shopify_schema";
import { organizations } from "../../../drizzle/schema";
import { createAuditLog, getDb, type DbExecutor, type DbTransaction } from "../../db";
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

/** Rows changed by an UPDATE/DELETE: mysql2 answers `[ResultSetHeader, fields]`. */
export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * The exact token pair a refresh started from. Every write that follows the
 * refresh is conditioned on it, because the pair may be replaced while the
 * refresh is in flight — by a reinstall, or by a worker that took over an
 * expired lease. The row id is part of it as well as the version: a row that is
 * deleted and re-inserted restarts at version 1, and a version alone would then
 * match a pair that no longer exists.
 */
export interface TokenFence {
  tokenRowId: number;
  rotationVersion: number;
}

/**
 * The credentials a failure is about: an exact token pair, or `"none"` — the
 * store held no token row when the failing operation began. A fail-close acts
 * only while that is still what the store holds, so a stale failure can never
 * destroy credentials a newer grant or rotation stored after it.
 */
export type TokenGeneration = TokenFence | "none";

export interface EncryptedShopifyTokens {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
}

/** Encrypt a token response under the tenant's envelope key. No database write. */
export async function encryptShopifyTokens(
  organizationId: number,
  response: ShopifyTokenResponse,
): Promise<EncryptedShopifyTokens> {
  const accessExpiresAt = tokenExpiryFromSeconds(response.expires_in);
  if (!accessExpiresAt) throw new Error("Shopify token response is missing expires_in");
  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptForTenant(organizationId, response.access_token),
    encryptForTenant(organizationId, response.refresh_token),
  ]);
  return {
    accessTokenEnc,
    refreshTokenEnc,
    accessExpiresAt,
    refreshExpiresAt: tokenExpiryFromSeconds(response.refresh_token_expires_in),
  };
}

/**
 * Replace a store's tokens with a fresh AUTHORIZATION (install or reinstall).
 *
 * The version bump is load-bearing: Shopify retires every other refresh token
 * for the store the moment an authorization-code grant succeeds, so any refresh
 * already in flight is working from a dead pair. Bumping the version makes that
 * refresh's fenced write miss, and its result is discarded rather than stored
 * over the new grant.
 */
export async function writeShopifyTokens(
  executor: DbExecutor,
  params: { storeId: number; organizationId: number; tokens: EncryptedShopifyTokens },
): Promise<void> {
  await executor
    .insert(shopifyConnectorTokens)
    .values({
      storeId: params.storeId,
      organizationId: params.organizationId,
      ...params.tokens,
      rotationVersion: 1,
    })
    .onDuplicateKeyUpdate({
      set: {
        organizationId: params.organizationId,
        ...params.tokens,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
        rotationVersion: sql`${shopifyConnectorTokens.rotationVersion} + 1`,
      },
    });
}

/**
 * Returns a valid access token for a tenant-owned store, rotating the expiring
 * offline token when necessary. Refresh ownership is leased in the database so
 * concurrent workers do not normally spend the same refresh token in parallel;
 * correctness does not depend on the lease, only on the fence (see TokenFence).
 */
export async function getValidShopifyAccessToken(params: {
  storeId: number;
  organizationId: number;
}): Promise<string> {
  const db = await getDb();
  if (!db) throw new ShopifyTokenUnavailableError("Database unavailable", "not_found");

  const refreshThreshold = new Date(Date.now() + SHOPIFY_ACCESS_TOKEN_REFRESH_SKEW_MS);
  const row = await readActiveToken(db, params);
  if (!row) throw new ShopifyTokenUnavailableError("Shopify store is not active", "not_found");

  if (row.token.accessExpiresAt > refreshThreshold) {
    const accessToken = await decryptForTenant(params.organizationId, row.token.accessTokenEnc);
    if (!accessToken) throw new ShopifyTokenUnavailableError("Stored Shopify access token cannot be decrypted", "not_found");
    return accessToken;
  }

  return rotateTokenUnderLease(db, {
    storeId: params.storeId,
    organizationId: params.organizationId,
    shopDomain: row.shopDomain,
    refreshThreshold,
  });
}

async function readActiveToken(db: Db, params: { storeId: number; organizationId: number }) {
  const [row] = await db
    .select({ token: shopifyConnectorTokens, shopDomain: shopifyConnectorStores.shopDomain })
    .from(shopifyConnectorTokens)
    .innerJoin(shopifyConnectorStores, eq(shopifyConnectorTokens.storeId, shopifyConnectorStores.id))
    .innerJoin(organizations, eq(organizations.id, shopifyConnectorStores.organizationId))
    .where(
      and(
        eq(shopifyConnectorTokens.storeId, params.storeId),
        eq(shopifyConnectorTokens.organizationId, params.organizationId),
        eq(shopifyConnectorStores.organizationId, params.organizationId),
        eq(shopifyConnectorStores.status, "active"),
        // A tenant fenced for redaction hands out no credential, whatever any
        // single store row says — the fence is the tenant's, not the store's.
        eq(organizations.deletionState, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The token the database holds now, if it is fresh — otherwise "try again".
 *
 * Used whenever this worker's own refresh cannot be the answer: another worker
 * holds the lease, finished first, or replaced the pair mid-flight. Returning
 * the STORED token, never one this worker obtained and failed to persist, is the
 * point: a caller must use the rotation the database retains.
 */
async function storedTokenOrRetry(
  db: Db,
  params: { storeId: number; organizationId: number; refreshThreshold: Date },
): Promise<string> {
  const row = await readActiveToken(db, params);
  if (!row) throw new ShopifyTokenUnavailableError("Shopify store is not active", "not_found");
  if (row.token.accessExpiresAt > params.refreshThreshold) {
    const accessToken = await decryptForTenant(params.organizationId, row.token.accessTokenEnc);
    if (accessToken) return accessToken;
  }
  throw new ShopifyTokenUnavailableError("Shopify token refresh is already in progress", "refresh_in_progress");
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
  const now = new Date();

  await db
    .update(shopifyConnectorTokens)
    .set({ refreshLeaseId: leaseId, refreshLeaseExpiresAt: new Date(now.getTime() + SHOPIFY_REFRESH_LEASE_MS) })
    .where(
      and(
        eq(shopifyConnectorTokens.storeId, params.storeId),
        eq(shopifyConnectorTokens.organizationId, params.organizationId),
        lt(shopifyConnectorTokens.accessExpiresAt, params.refreshThreshold),
        or(isNull(shopifyConnectorTokens.refreshLeaseId), lt(shopifyConnectorTokens.refreshLeaseExpiresAt, now)),
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

  // No lease: another worker holds a live one, or has already refreshed (the
  // claim only matches an expiring token). Either way the answer is theirs.
  if (!claimed) return storedTokenOrRetry(db, params);

  const fence: TokenFence = { tokenRowId: claimed.id, rotationVersion: claimed.rotationVersion };
  try {
    const refreshToken = await decryptForTenant(params.organizationId, claimed.refreshTokenEnc);
    if (!refreshToken) {
      if (!(await markReauthorizationRequired(db, { ...params, reason: "refresh_token_unreadable", fence }))) {
        return storedTokenOrRetry(db, params);
      }
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
      // A 401 is about the refresh token we PRESENTED. If the stored pair has
      // moved on — most often a reinstall, whose grant is exactly what retired
      // the token we sent — the store is healthy and its new credentials must
      // not be deleted over a rejection that was about the old ones.
      if (!(await markReauthorizationRequired(db, { ...params, reason: "refresh_rejected", fence }))) {
        return storedTokenOrRetry(db, params);
      }
      throw new ShopifyTokenUnavailableError("Shopify authorization must be renewed", "reauthorize");
    }
    if (result.kind === "retry") {
      throw new ShopifyTokenUnavailableError("Shopify token refresh can be retried", "refresh_retry");
    }
    if (result.kind === "failed") {
      throw new ShopifyTokenUnavailableError("Shopify token refresh was rejected", "refresh_failed");
    }

    const tokens = await encryptShopifyTokens(params.organizationId, result.token);
    const written = affectedRows(
      await db
        .update(shopifyConnectorTokens)
        .set({
          ...tokens,
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
          rotationVersion: sql`${shopifyConnectorTokens.rotationVersion} + 1`,
        })
        .where(
          and(
            eq(shopifyConnectorTokens.id, fence.tokenRowId),
            eq(shopifyConnectorTokens.organizationId, params.organizationId),
            eq(shopifyConnectorTokens.rotationVersion, fence.rotationVersion),
          ),
        ),
    );
    if (written !== 1) {
      // The pair was replaced while this refresh was in flight — a reinstall,
      // or a worker that took over after our lease expired. The database keeps
      // THEIR rotation, so returning ours would hand the caller a token that
      // differs from the one retained. Discarding ours is safe: Shopify keeps a
      // presented refresh token usable until its successor is used, precisely
      // so that a lost refresh response does not strand the store.
      console.warn("[shopify-token] refresh result discarded: token pair replaced mid-refresh", {
        storeId: params.storeId,
      });
      return storedTokenOrRetry(db, params);
    }
    return result.token.access_token;
  } finally {
    // Keep no lease after any terminal/transient failure. The next scheduled
    // operation may retry, while the DB still prevents concurrent refresh calls.
    await db
      .update(shopifyConnectorTokens)
      .set({ refreshLeaseId: null, refreshLeaseExpiresAt: null })
      .where(and(eq(shopifyConnectorTokens.id, fence.tokenRowId), eq(shopifyConnectorTokens.refreshLeaseId, leaseId)));
  }
}

/**
 * Take a store out of service: delete its tokens and mark it
 * `reauthorization_required`, with the reason recorded.
 *
 * Always fenced (see TokenGeneration). It acts only while the store still holds
 * the generation the failure was about, and returns false otherwise — the
 * failure is then stale and the store is left alone. There is deliberately no
 * unconditional form: every caller that took the store out of service
 * unconditionally was one overlapping request away from deleting a newer,
 * valid installation.
 *
 * The state change is committed without waiting on its audit record. A control
 * that revokes credentials must not be able to fail because logging did; the
 * record is written afterwards and a failure there is logged loudly.
 */
export async function markReauthorizationRequired(
  db: Db,
  params: {
    storeId: number;
    organizationId: number;
    reason: ShopifyStatusReason;
    fence: TokenGeneration;
    /** Checked first, inside the same transaction; false makes the whole call a no-op. */
    guard?: (tx: DbTransaction) => Promise<boolean>;
  },
): Promise<boolean> {
  const { fence } = params;
  const marked = await db.transaction(async (tx) => {
    if (params.guard && !(await params.guard(tx))) return false;
    const storeScope = and(
      eq(shopifyConnectorStores.id, params.storeId),
      eq(shopifyConnectorStores.organizationId, params.organizationId),
    );
    if (fence === "none") {
      // Nothing to retire; mark the store only if no pair has been stored
      // since. One statement, so the check and the change cannot interleave.
      const updated = affectedRows(
        await tx
          .update(shopifyConnectorStores)
          .set({ status: "reauthorization_required", statusReason: params.reason })
          .where(
            and(
              storeScope,
              notExists(
                new QueryBuilder()
                  .select({ id: shopifyConnectorTokens.id })
                  .from(shopifyConnectorTokens)
                  .where(eq(shopifyConnectorTokens.storeId, params.storeId)),
              ),
            ),
          ),
      );
      return updated === 1;
    }
    const deleted = affectedRows(
      await tx
        .delete(shopifyConnectorTokens)
        .where(
          and(
            eq(shopifyConnectorTokens.storeId, params.storeId),
            eq(shopifyConnectorTokens.organizationId, params.organizationId),
            eq(shopifyConnectorTokens.id, fence.tokenRowId),
            eq(shopifyConnectorTokens.rotationVersion, fence.rotationVersion),
          ),
        ),
    );
    if (deleted !== 1) return false;
    await tx
      .update(shopifyConnectorStores)
      .set({ status: "reauthorization_required", statusReason: params.reason })
      .where(storeScope);
    return true;
  });

  if (marked) {
    try {
      await createAuditLog({
        organizationId: params.organizationId,
        userId: null,
        action: "shopify_store_reauthorization_required",
        entityType: "shopify_store",
        entityId: params.storeId,
        details: { reason: params.reason, provider: "shopify" },
      });
    } catch (error) {
      console.error("[shopify-token] AUDIT WRITE FAILED for a fail-closed store", {
        storeId: params.storeId,
        reason: params.reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return marked;
}
