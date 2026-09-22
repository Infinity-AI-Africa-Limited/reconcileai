/**
 * Per-tenant encryption key management — envelope encryption.
 *
 * Every organization gets its own 256-bit Data Encryption Key (DEK). Tenant
 * data is encrypted under the tenant's DEK (AES-256-GCM, per-record IV); the
 * DEK itself is stored only in wrapped form (tenant_encryption_keys), wrapped
 * by a master key:
 *
 *   local    — AES-256-GCM wrap under TENANT_MASTER_KEY (JWT_SECRET-derived
 *              fallback). The only option for on-prem/air-gapped deployments.
 *   aws_kms  — AWS KMS GenerateDataKey/Decrypt. Loaded dynamically so the SDK
 *              is only required when actually enabled
 *              (`pnpm add @aws-sdk/client-kms`, TENANT_KEY_PROVIDER=aws_kms,
 *               TENANT_KMS_KEY_ID=arn:aws:kms:...).
 *
 * Ciphertext format: `tk1:<orgId>:<keyVersion>:<iv>:<tag>:<ct>` (hex parts).
 * The prefix lets readers distinguish tenant-key ciphertexts from the legacy
 * global-key format and route decryption accordingly.
 *
 * Why envelope encryption matters for isolation: even if an org-scoping bug
 * ever exposed another tenant's ciphertext rows, they are undecryptable
 * without that tenant's DEK. Blast radius of any single leak collapses to
 * one tenant.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { tenantEncryptionKeys } from "../../drizzle/tenant_schema";
import { getDb } from "../db";
import { ENV } from "./env";

const ALGO = "aes-256-gcm";
export const TENANT_CIPHERTEXT_PREFIX = "tk1";

// ─── Master-key providers ────────────────────────────────────────────────────
export interface MasterKeyProvider {
  readonly name: "local" | "aws_kms";
  /** Create a fresh DEK and return it with its wrapped form. */
  generateDek(): Promise<{ dek: Buffer; wrapped: string; kmsKeyId: string | null }>;
  /** Unwrap a stored DEK. */
  unwrapDek(wrapped: string, kmsKeyId: string | null): Promise<Buffer>;
}

function localMasterKey(): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(ENV.tenantMasterKey)) {
    return Buffer.from(ENV.tenantMasterKey, "hex");
  }
  if (ENV.cookieSecret) {
    return crypto.createHash("sha256").update(`${ENV.cookieSecret}:tenant-master`).digest();
  }
  throw new Error("Set TENANT_MASTER_KEY (64 hex chars) or JWT_SECRET for tenant key wrapping");
}

class LocalProvider implements MasterKeyProvider {
  readonly name = "local" as const;

  async generateDek() {
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGO, localMasterKey(), iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const wrapped = `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
    return { dek, wrapped, kmsKeyId: null };
  }

  async unwrapDek(wrapped: string) {
    const [ivHex, tagHex, ctHex] = wrapped.split(":");
    if (!ivHex || !tagHex || !ctHex) throw new Error("Malformed wrapped DEK");
    const decipher = crypto.createDecipheriv(ALGO, localMasterKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
  }
}

/** Minimal structural types for @aws-sdk/client-kms (loaded dynamically). */
interface KmsClientLike {
  send(command: unknown): Promise<{
    Plaintext?: Uint8Array;
    CiphertextBlob?: Uint8Array;
  }>;
}
interface KmsModuleLike {
  KMSClient: new (config: Record<string, unknown>) => KmsClientLike;
  GenerateDataKeyCommand: new (input: Record<string, unknown>) => unknown;
  DecryptCommand: new (input: Record<string, unknown>) => unknown;
}

class KmsProvider implements MasterKeyProvider {
  readonly name = "aws_kms" as const;
  private clientPromise: Promise<{ mod: KmsModuleLike; client: KmsClientLike }> | null = null;

  private load() {
    if (!this.clientPromise) {
      const specifier = "@aws-sdk/client-kms";
      this.clientPromise = import(/* @vite-ignore */ specifier)
        .then((mod: KmsModuleLike) => ({
          mod,
          client: new mod.KMSClient({
            region: ENV.awsRegion === "auto" ? "us-east-1" : ENV.awsRegion,
            credentials: ENV.awsAccessKeyId
              ? { accessKeyId: ENV.awsAccessKeyId, secretAccessKey: ENV.awsSecretAccessKey }
              : undefined,
          }),
        }))
        .catch((err: unknown) => {
          this.clientPromise = null;
          throw new Error(
            `TENANT_KEY_PROVIDER=aws_kms but @aws-sdk/client-kms is not available (pnpm add @aws-sdk/client-kms): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    return this.clientPromise;
  }

  async generateDek() {
    if (!ENV.tenantKmsKeyId) throw new Error("TENANT_KMS_KEY_ID is required for aws_kms provider");
    const { mod, client } = await this.load();
    const res = await client.send(
      new mod.GenerateDataKeyCommand({ KeyId: ENV.tenantKmsKeyId, KeySpec: "AES_256" }),
    );
    if (!res.Plaintext || !res.CiphertextBlob) throw new Error("KMS GenerateDataKey returned no key material");
    return {
      dek: Buffer.from(res.Plaintext),
      wrapped: Buffer.from(res.CiphertextBlob).toString("base64"),
      kmsKeyId: ENV.tenantKmsKeyId,
    };
  }

  async unwrapDek(wrapped: string) {
    const { mod, client } = await this.load();
    const res = await client.send(
      new mod.DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, "base64") }),
    );
    if (!res.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    return Buffer.from(res.Plaintext);
  }
}

export function getMasterKeyProvider(): MasterKeyProvider {
  return ENV.tenantKeyProvider === "aws_kms" ? new KmsProvider() : new LocalProvider();
}

// ─── DEK cache + lifecycle ───────────────────────────────────────────────────
const dekCache = new Map<number, { dek: Buffer; version: number }>();

/** Test-only. */
export function clearDekCacheForTests(): void {
  dekCache.clear();
}

/** Get (or lazily create) the active DEK for a tenant. */
export async function getTenantDek(organizationId: number): Promise<{ dek: Buffer; version: number }> {
  const cached = dekCache.get(organizationId);
  if (cached) return cached;

  const db = await getDb();
  if (!db) throw new Error("Database unavailable for tenant key lookup");

  const [row] = await db
    .select()
    .from(tenantEncryptionKeys)
    .where(
      and(
        eq(tenantEncryptionKeys.organizationId, organizationId),
        eq(tenantEncryptionKeys.isActive, true),
      ),
    )
    .limit(1);

  const provider = getMasterKeyProvider();

  if (row) {
    if (row.provider !== provider.name) {
      // Key was wrapped by a different provider than currently configured —
      // unwrap with the provider that wrapped it (local always available).
      const wrappingProvider: MasterKeyProvider =
        row.provider === "local" ? new LocalProvider() : new KmsProvider();
      const dek = await wrappingProvider.unwrapDek(row.wrappedDek, row.kmsKeyId);
      const entry = { dek, version: row.version };
      dekCache.set(organizationId, entry);
      return entry;
    }
    const dek = await provider.unwrapDek(row.wrappedDek, row.kmsKeyId);
    const entry = { dek, version: row.version };
    dekCache.set(organizationId, entry);
    return entry;
  }

  // First use for this tenant — provision a key (also done at onboarding).
  return provisionTenantKey(organizationId);
}

/** Create and persist a fresh DEK for a tenant (idempotent-safe on races). */
export async function provisionTenantKey(
  organizationId: number,
): Promise<{ dek: Buffer; version: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable for tenant key provisioning");
  const provider = getMasterKeyProvider();
  const { dek, wrapped, kmsKeyId } = await provider.generateDek();
  try {
    await db.insert(tenantEncryptionKeys).values({
      organizationId,
      provider: provider.name,
      wrappedDek: wrapped,
      kmsKeyId,
      version: 1,
      isActive: true,
    });
  } catch (err) {
    // Unique (org, version) — a concurrent provisioner won; use theirs.
    if (/duplicate/i.test(err instanceof Error ? err.message : String(err))) {
      dekCache.delete(organizationId);
      return getTenantDek(organizationId);
    }
    throw err;
  }
  const entry = { dek, version: 1 };
  dekCache.set(organizationId, entry);
  return entry;
}

// ─── Tenant-scoped encrypt/decrypt ───────────────────────────────────────────
export async function encryptForTenant(organizationId: number, plaintext: string): Promise<string> {
  const { dek, version } = await getTenantDek(organizationId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    TENANT_CIPHERTEXT_PREFIX,
    String(organizationId),
    String(version),
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    ct.toString("hex"),
  ].join(":");
}

export function isTenantCiphertext(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${TENANT_CIPHERTEXT_PREFIX}:`);
}

/**
 * Decrypt a tenant ciphertext. The embedded orgId must match the caller's
 * resolved tenant — a ciphertext copied across tenant boundaries refuses to
 * decrypt even though the bytes are present.
 */
export async function decryptForTenant(organizationId: number, stored: string): Promise<string | null> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== TENANT_CIPHERTEXT_PREFIX) return null;
  const [, orgStr, , ivHex, tagHex, ctHex] = parts;
  if (Number(orgStr) !== organizationId) {
    console.error(
      `[tenantKeys] cross-tenant decrypt refused: ciphertext org ${orgStr}, caller org ${organizationId}`,
    );
    return null;
  }
  try {
    const { dek } = await getTenantDek(organizationId);
    const decipher = crypto.createDecipheriv(ALGO, dek, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong key / corrupted — treat as unreadable, never throw into callers
  }
}
