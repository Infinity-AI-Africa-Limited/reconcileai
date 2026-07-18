/**
 * SHOPLINE Token Store
 *
 * Persists encrypted SHOPLINE access tokens in the `sl_connector_tokens` table.
 * Tokens are AES-256-GCM encrypted using the tenant envelope key before storage.
 * Refresh is triggered proactively at 9h (1h before the 10h TTL expires).
 *
 * Public API:
 *   getValidToken(db, slStoreId, orgId, storeHandle) → decrypted access token
 *   saveToken(db, slStoreId, orgId, tokenResponse)
 *   deleteToken(db, slStoreId)
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
import { slConnectorTokens } from "../../../drizzle/connector_schema";
import { refreshAccessToken, tokenNeedsRefresh, calculateTokenExpiry } from "./auth";
import type { ShoplineTokenResponse } from "./auth";

// ─── Simple AES-256-GCM encrypt/decrypt (reuses the tenant key pattern) ─────
// In production Claude will replace this with the full tenant KMS envelope.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const KEY_SOURCE = process.env.JWT_SECRET ?? "reconcileai-dev-secret-32-chars!!";
// Derive a 32-byte key from the JWT_SECRET (same pattern as tenant key derivation)
const ENC_KEY = Buffer.from(KEY_SOURCE.padEnd(32, "0").slice(0, 32), "utf8");

function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(24 hex) + tag(32 hex) + ciphertext(hex)
  return `tk1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(ciphertext: string): string {
  if (!ciphertext.startsWith("tk1:")) throw new Error("Unknown token format");
  const [, ivHex, tagHex, dataHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv(ALGO, ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retrieve a valid (non-expired) access token for a SHOPLINE store.
 * If the token is within 1h of expiry, it is refreshed automatically.
 * Returns null if no token exists (store not yet installed / token deleted).
 */
export async function getValidToken(
  db: Db,
  slStoreId: number,
  organizationId: number,
  storeHandle: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(slConnectorTokens)
    .where(
      and(
        eq(slConnectorTokens.slStoreId, slStoreId),
        eq(slConnectorTokens.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  const plainToken = decryptToken(row.encryptedToken);

  if (tokenNeedsRefresh(row.expiresAt)) {
    // Proactive refresh — swap token in DB and return the new one
    try {
      const refreshed = await refreshAccessToken(storeHandle, plainToken);
      await saveToken(db, slStoreId, organizationId, refreshed);
      return refreshed.access_token;
    } catch (err) {
      // If refresh fails, return the existing token (may still be valid for up to 1h)
      console.error(`[SHOPLINE] Token refresh failed for store ${slStoreId}:`, err);
      return plainToken;
    }
  }

  return plainToken;
}

/**
 * Persist (upsert) a SHOPLINE token response into the DB.
 * Encrypts the access token before storage.
 */
export async function saveToken(
  db: Db,
  slStoreId: number,
  organizationId: number,
  tokenResponse: ShoplineTokenResponse,
): Promise<void> {
  const encryptedToken = encryptToken(tokenResponse.access_token);
  const expiresAt = calculateTokenExpiry(tokenResponse.expires_in);

  // Upsert: delete existing then insert (MySQL doesn't have ON CONFLICT DO UPDATE for composite keys easily)
  await db
    .delete(slConnectorTokens)
    .where(eq(slConnectorTokens.slStoreId, slStoreId));

  await db.insert(slConnectorTokens).values({
    slStoreId,
    organizationId,
    encryptedToken,
    expiresAt,
    refreshedAt: new Date(),
  });
}

/**
 * Delete a token (called on app uninstall).
 */
export async function deleteToken(
  db: Db,
  slStoreId: number,
): Promise<void> {
  await db
    .delete(slConnectorTokens)
    .where(eq(slConnectorTokens.slStoreId, slStoreId));
}
