/**
 * Connector secret encryption — AES-256-GCM, same wire format as sftpService
 * (`iv:authTag:ciphertext`, hex-encoded).
 *
 * Key resolution, in order:
 *  1. CONNECTOR_ENCRYPTION_KEY (64 hex chars) — set this in production.
 *  2. Derived from JWT_SECRET — deterministic across restarts, so credentials
 *     survive a redeploy even when no dedicated key is configured.
 *  3. Random per-process key (dev only; logged) — secrets won't survive restart.
 */
import crypto from "crypto";
import { ENV } from "../../_core/env";

const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = (process.env.CONNECTOR_ENCRYPTION_KEY ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
    cachedKey = Buffer.from(explicit, "hex");
    return cachedKey;
  }
  if (ENV.cookieSecret) {
    cachedKey = crypto.createHash("sha256").update(`${ENV.cookieSecret}:wc-connector`).digest();
    return cachedKey;
  }
  console.warn(
    "[wc-connector] No CONNECTOR_ENCRYPTION_KEY or JWT_SECRET set — using an ephemeral key; stored connector secrets will not survive a restart.",
  );
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, resolveKey(), iv);
  let enc = cipher.update(plain, "utf8", "hex");
  enc += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, resolveKey(), Buffer.from(parts[0], "hex"));
    decipher.setAuthTag(Buffer.from(parts[1], "hex"));
    let dec = decipher.update(parts[2], "hex", "utf8");
    dec += decipher.final("utf8");
    return dec;
  } catch {
    // Wrong key (e.g. rotated) or corrupted value — treat as unset rather than crash.
    return null;
  }
}

/** Mask a secret for display: keeps last 4 chars, e.g. "••••••1a2b". */
export function maskSecret(stored: string | null | undefined): string | null {
  const plain = decryptSecret(stored);
  if (!plain) return null;
  return `••••••${plain.slice(-4)}`;
}

// ─── Tenant-scoped variants (multi-tenant hardening) ─────────────────────────
// New secret WRITES are encrypted under the organization's own DEK (envelope
// encryption via server/_core/tenantKeys.ts) so one tenant's credentials are
// cryptographically isolated from every other tenant. READS handle both the
// tenant format (tk1:...) and the legacy global-key format, so secrets stored
// before this change keep working; they migrate to tenant keys on next save.

export async function encryptSecretForOrg(plain: string, organizationId: number): Promise<string> {
  const { encryptForTenant } = await import("../../_core/tenantKeys");
  return encryptForTenant(organizationId, plain);
}

export async function decryptSecretForOrg(
  stored: string | null | undefined,
  organizationId: number,
): Promise<string | null> {
  if (!stored) return null;
  const { isTenantCiphertext, decryptForTenant } = await import("../../_core/tenantKeys");
  if (isTenantCiphertext(stored)) return decryptForTenant(organizationId, stored);
  return decryptSecret(stored);
}

export async function maskSecretForOrg(
  stored: string | null | undefined,
  organizationId: number,
): Promise<string | null> {
  const plain = await decryptSecretForOrg(stored, organizationId);
  if (!plain) return null;
  return `••••••${plain.slice(-4)}`;
}
