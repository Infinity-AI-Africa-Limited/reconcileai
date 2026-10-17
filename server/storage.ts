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
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isTenantId } from "@shared/tenantId";
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

/**
 * The key for an object holding ONE tenant's data: under `org/<id>/` when the
 * data has a tenant, so the storage proxy's owner check applies and erasing the
 * tenant finds the object by listing its prefix. Data with no tenant keeps its
 * relative key. Name the tenant whose data it is — not the uploader's own
 * organisation, which differs when staff export a tenant's job.
 */
export function tenantObjectKey(organizationId: number | null | undefined, relKey: string): string {
  return isTenantId(organizationId) ? orgScopedKey(organizationId, relKey) : normalizeKey(relKey);
}

/** A bucket and the S3 service it lives on (`endpoint` empty or null for AWS S3). */
export interface StorageLocation {
  bucket: string;
  endpoint: string | null;
}

/** Where the platform stores its objects; `bucket` is "" when storage is not configured. */
export function platformStorageLocation(): StorageLocation {
  return { bucket: ENV.awsS3Bucket.trim(), endpoint: ENV.awsS3Endpoint.trim() };
}

/**
 * The service an endpoint names. Bucket names are global on AWS S3, so no
 * endpoint and any amazonaws.com host are one service there. Elsewhere (R2,
 * MinIO) names are scoped to the endpoint's origin — scheme, host and port,
 * which the URL parser normalises (case, default port, trailing path). An
 * endpoint that is not a URL can only match itself: no client could have
 * reached a bucket by it.
 */
function storageService(endpoint: string | null | undefined): string {
  const raw = (endpoint ?? "").trim();
  if (!raw) return "aws";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `unparsed:${raw.toLowerCase()}`;
  }
  const host = url.hostname.toLowerCase();
  if (host === "amazonaws.com" || host.endsWith(".amazonaws.com")) return "aws";
  return url.origin;
}

/** Do two locations name the same bucket: the same service, and the same bucket name? */
export function sameStorageBucket(a: StorageLocation, b: StorageLocation): boolean {
  const name = a.bucket.trim().toLowerCase();
  return (
    name !== "" &&
    name === b.bucket.trim().toLowerCase() &&
    storageService(a.endpoint) === storageService(b.endpoint)
  );
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
  contentType = "application/octet-stream",
  options: { abortSignal?: AbortSignal } = {}
): Promise<{ key: string; url: string }> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: toBody(data),
      ContentType: contentType,
    }),
    { abortSignal: options.abortSignal }
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );
  return { key, url };
}

/**
 * Upload a private object without creating any bearer URL. Purpose-built flows
 * (for example privacy exports) persist the key and authorize every later read
 * before requesting a short-lived presign.
 */
export async function storagePutPrivate(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string }> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: toBody(data),
      ContentType: contentType,
      CacheControl: "no-store",
    }),
  );
  return { key };
}

/**
 * Return a fresh presigned download URL for an existing object.
 */
export async function storageGet(
  relKey: string,
  expiresInSeconds = PRESIGN_TTL_SECONDS,
): Promise<{ key: string; url: string }> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  );
  return { key, url };
}

/**
 * Read a private object's bytes on the server.
 *
 * For flows that must PROVE delivery — privacy exports — the server sends the
 * bytes itself and records delivery only once they were written, rather than
 * handing out a bearer URL whose use it can never observe.
 */
export async function storageReadPrivate(relKey: string): Promise<Buffer> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error("Stored object has no body");
  return Buffer.from(await out.Body.transformToByteArray());
}

/** A tenant's folder holds far fewer objects; a listing this long is refused, not truncated. */
const MAX_LIST_PAGES = 1_000;

/**
 * Every key under a folder prefix, following continuation tokens to the end.
 *
 * The prefix must name a folder — non-empty and ending in "/" — so `org/1/`
 * can never also match `org/12/…`, and no caller can list the bucket. A
 * listing that cannot be completed throws rather than return part of the
 * folder: callers use it to prove a folder is empty.
 *
 * `abortSignal` cancels the request in flight and any further page.
 */
export async function storageListKeys(
  prefix: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<string[]> {
  const folder = normalizeKey(prefix);
  if (folder.length < 2 || !folder.endsWith("/")) throw new Error("storage_list_prefix_invalid");
  const { s3, bucket } = getClient();
  const keys: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    options.abortSignal?.throwIfAborted();
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: folder, ContinuationToken: token }),
      { abortSignal: options.abortSignal }
    );
    for (const item of out.Contents ?? []) if (item.Key?.startsWith(folder)) keys.push(item.Key);
    if (!out.IsTruncated) return keys;
    if (!out.NextContinuationToken || out.NextContinuationToken === token) {
      throw new Error("storage_list_incomplete");
    }
    token = out.NextContinuationToken;
  }
  throw new Error("storage_list_too_large");
}

/**
 * Delete an object. Missing objects are treated as success. `abortSignal`
 * cancels the request in flight.
 */
export async function storageDelete(
  relKey: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<void> {
  const { s3, bucket } = getClient();
  const key = normalizeKey(relKey);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: options.abortSignal,
    });
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 404) return; // already gone
    throw err;
  }
}
