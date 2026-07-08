/**
 * File storage helpers — AWS S3 / S3-compatible (Cloudflare R2).
 *
 * Replaces the Manus storage proxy (which required BUILT_IN_FORGE_*). The public
 * interface is unchanged — storagePut / storageGet / storageDelete keep the same
 * signatures and `{ key, url }` return shape — so no call sites change.
 *
 * Configure via env (see docs/env.example.md):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET
 *   AWS_REGION        (default "auto" — correct for R2)
 *   AWS_S3_ENDPOINT   (required for R2 / any S3-compatible service; omit for AWS S3)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

// Presigned-URL lifetime. SigV4 caps presigned URLs at 7 days; use just under it.
// Durable, non-expiring access is available via the /manus-storage/<key> proxy route.
const PRESIGN_TTL_SECONDS = 60 * 60 * 24 * 6; // 6 days

let cachedClient: S3Client | null = null;

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

// ─── Org-scoped key convention (PCI remediation, WS-2) ───────────────────────
// New org-owned objects MUST be written under `org/<organizationId>/…` so the
// storage proxy can enforce owner-based access. Legacy keys without the prefix
// are served to any AUTHENTICATED user (never anonymously) — a documented
// caveat until historical objects are migrated.

/** Prefix a relative key with its owning organization: `org/42/reports/x.csv`. */
export function orgScopedKey(organizationId: number, relKey: string): string {
  return `org/${organizationId}/${normalizeKey(relKey)}`;
}

/** Extract the owning org from a key under the convention; null for legacy keys. */
export function orgIdFromKey(key: string): number | null {
  const m = /^org\/(\d+)\//.exec(normalizeKey(key));
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function getClient(): { s3: S3Client; bucket: string } {
  const bucket = ENV.awsS3Bucket;
  if (!ENV.awsAccessKeyId || !ENV.awsSecretAccessKey || !bucket) {
    throw new Error(
      "Storage not configured: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and " +
        "AWS_S3_BUCKET (and AWS_S3_ENDPOINT for Cloudflare R2 / S3-compatible services)."
    );
  }

  if (!cachedClient) {
    cachedClient = new S3Client({
      region: ENV.awsRegion || "auto",
      // A custom endpoint signals an S3-compatible service (R2, MinIO, …).
      endpoint: ENV.awsS3Endpoint || undefined,
      // Path-style addressing is the safe default for S3-compatible endpoints.
      forcePathStyle: Boolean(ENV.awsS3Endpoint),
      credentials: {
        accessKeyId: ENV.awsAccessKeyId,
        secretAccessKey: ENV.awsSecretAccessKey,
      },
    });
  }

  return { s3: cachedClient, bucket };
}

function toBody(data: Buffer | Uint8Array | string): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * Upload an object and return its key plus a presigned download URL.
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: toBody(data),
      ContentType: contentType,
    })
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );
  return { key, url };
}

/**
 * Return a fresh presigned download URL for an existing object.
 */
export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );
  return { key, url };
}

/**
 * Delete an object. Missing objects are treated as success.
 */
export async function storageDelete(relKey: string): Promise<void> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 404) return; // already gone
    throw err;
  }
}
