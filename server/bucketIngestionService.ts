/**
 * Bucket (object-storage) drop ingestion — the S3-compatible sibling of SFTP.
 *
 * Many banks, PSPs and couriers deliver settlement files to a bucket rather
 * than an SFTP host, and several prefer it: IAM-scoped access, no long-lived
 * SSH keys, no host to keep patched. Works against AWS S3, Cloudflare R2 and
 * MinIO — anything speaking the S3 API — via an optional custom endpoint.
 *
 * Everything after "get the bytes" is shared with SFTP and manual upload:
 * `parseTabularFile` (CSV/TSV/XLSX) → `validateParsedRows` → `storeTransactions`.
 * That is deliberate. The money and date coercion is the product; having a
 * second copy of it per transport is how the bank path came to silently invert
 * the sign of refunds (see #27).
 *
 * Idempotency is by CONTENT HASH over the object's bytes, not by key or
 * modified-time. A bank that re-uploads yesterday's file under a new name, or
 * an operator who replays a prefix, must not double-count settlements.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import {
  bucketIngestionSources,
  bucketIngestionLogs,
  uploadBatches,
} from "../drizzle/schema";
import { decryptCredential, encryptCredential } from "./sftpService";
import { validateParsedRows, storeTransactions, calculateFileHash } from "./apiIngestionService";
import { parseTabularFile } from "./ingest/fileParser";

export { encryptCredential, decryptCredential };

type BucketSource = typeof bucketIngestionSources.$inferSelect;

/** Objects larger than this are skipped — a settlement file is never this big,
 *  so it is almost certainly a misconfigured prefix pointing at a data lake. */
const MAX_OBJECT_BYTES = 50 * 1024 * 1024;

const POLLING_CHECK_INTERVAL = 60_000;
let pollingInterval: NodeJS.Timeout | null = null;

/** Build an S3 client for a source. Endpoint is required for R2/MinIO. */
export function buildS3Client(src: {
  region: string;
  endpoint?: string | null;
  accessKeyIdEncrypted?: string | null;
  secretAccessKeyEncrypted?: string | null;
}): S3Client {
  const accessKeyId = src.accessKeyIdEncrypted ? decryptCredential(src.accessKeyIdEncrypted) : undefined;
  const secretAccessKey = src.secretAccessKeyEncrypted
    ? decryptCredential(src.secretAccessKeyEncrypted)
    : undefined;
  return new S3Client({
    region: src.region || "auto",
    ...(src.endpoint ? { endpoint: src.endpoint, forcePathStyle: true } : {}),
    // Omitting credentials lets the SDK fall back to the instance role, which
    // is the right answer when the bucket is our own rather than the bank's.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

/** Glob → RegExp, matching the SFTP poller's `filePattern` semantics. */
export function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** The object's name without its prefix — what `filePattern` matches against. */
export function baseName(key: string): string {
  const i = key.lastIndexOf("/");
  return i === -1 ? key : key.slice(i + 1);
}

export interface BucketTestResult {
  success: boolean;
  matchedCount?: number;
  sample?: string[];
  error?: string;
}

/**
 * Verify a source's credentials and prefix without ingesting anything.
 * Mirrors `testSftpConnection` so the two transports feel identical to set up.
 */
export async function testBucketConnection(src: {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string | null;
  filePattern: string;
  accessKeyIdEncrypted?: string | null;
  secretAccessKeyEncrypted?: string | null;
}): Promise<BucketTestResult> {
  try {
    const s3 = buildS3Client(src);
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: src.bucket, Prefix: src.prefix || undefined, MaxKeys: 50 }),
    );
    const re = patternToRegExp(src.filePattern);
    const matched = (out.Contents ?? [])
      .map((o) => o.Key ?? "")
      .filter((k) => k && !k.endsWith("/") && re.test(baseName(k)));
    return { success: true, matchedCount: matched.length, sample: matched.slice(0, 5) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List objects under the source's prefix that match its file pattern. */
export async function listBucketFiles(
  sourceId: number,
): Promise<{ success: boolean; files?: Array<{ key: string; size: number }>; error?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [src] = await db
    .select()
    .from(bucketIngestionSources)
    .where(eq(bucketIngestionSources.id, sourceId))
    .limit(1);
  if (!src) return { success: false, error: "Source not found" };

  try {
    const s3 = buildS3Client(src);
    const re = patternToRegExp(src.filePattern);
    const files: Array<{ key: string; size: number }> = [];
    let token: string | undefined;
    // Paginate: a busy prefix can exceed the 1000-key page size.
    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: src.bucket,
          Prefix: src.prefix || undefined,
          ContinuationToken: token,
        }),
      );
      for (const o of out.Contents ?? []) {
        const key = o.Key ?? "";
        if (!key || key.endsWith("/")) continue;
        if (!re.test(baseName(key))) continue;
        files.push({ key, size: o.Size ?? 0 });
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return { success: true, files };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readObject(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof body?.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  // Node stream fallback for SDK variants without the helper.
  const chunks: Buffer[] = [];
  for await (const c of out.Body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export interface BucketProcessResult {
  success: boolean;
  uploadBatchId?: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Download one object and run it through the shared ingestion pipeline.
 * Never throws — every outcome is recorded on `bucket_ingestion_logs` so a
 * failing source is diagnosable from the product rather than the host's logs.
 */
export async function downloadAndProcessBucketObject(
  sourceId: number,
  objectKey: string,
): Promise<BucketProcessResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [src] = await db
    .select()
    .from(bucketIngestionSources)
    .where(eq(bucketIngestionSources.id, sourceId))
    .limit(1);
  if (!src) return { success: false, error: "Source not found" };

  const startedAt = Date.now();
  const log = (fields: Partial<typeof bucketIngestionLogs.$inferInsert>) =>
    db.insert(bucketIngestionLogs).values({
      bucketSourceId: src.id,
      organizationId: src.organizationId,
      channelId: src.channelId,
      objectKey,
      processingTimeMs: Date.now() - startedAt,
      status: "failed",
      ...fields,
    } as typeof bucketIngestionLogs.$inferInsert);

  try {
    const s3 = buildS3Client(src);
    const bytes = await readObject(s3, src.bucket, objectKey);

    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      await log({ status: "skipped", fileSize: bytes.byteLength, errorMessage: `Object exceeds ${MAX_OBJECT_BYTES} bytes` });
      return { success: false, skipped: true, error: "Object too large" };
    }

    // Content-hash idempotency: a re-uploaded or renamed file is not new data.
    const fileHash = calculateFileHash(bytes);
    const [seen] = await db
      .select()
      .from(bucketIngestionLogs)
      .where(and(eq(bucketIngestionLogs.bucketSourceId, src.id), eq(bucketIngestionLogs.fileHash, fileHash)))
      .limit(1);
    if (seen) {
      return { success: true, skipped: true, uploadBatchId: seen.uploadBatchId ?? undefined };
    }

    let parsed;
    try {
      parsed = await parseTabularFile(bytes, objectKey);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      await log({ fileSize: bytes.byteLength, fileHash, errorMessage: message });
      return { success: false, error: message };
    }

    const { valid, invalid, totalRows } = validateParsedRows(parsed.rows);
    if (valid.length === 0) {
      await log({
        fileSize: bytes.byteLength, fileHash, totalRows, validRows: 0, invalidRows: invalid.length,
        errorMessage: "No valid rows found in file",
      });
      return { success: false, error: "No valid rows found in file" };
    }

    const [batch] = await db.insert(uploadBatches).values({
      userId: 0, // system
      channelId: src.channelId,
      organizationId: src.organizationId,
      fileName: objectKey,
      fileHash,
      detectedFormat: "bucket_drop",
      totalRows,
      validRows: valid.length,
      invalidRows: invalid.length,
      status: "processing",
    });
    const uploadBatchId = batch.insertId;

    await storeTransactions(valid, uploadBatchId, src.channelId, src.organizationId);
    await db
      .update(uploadBatches)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(uploadBatches.id, uploadBatchId));

    // Archive or delete only AFTER a durable write, so a crash mid-ingest
    // leaves the object in place to be retried rather than losing it.
    let archivedKey: string | null = null;
    try {
      if (src.archivePrefix) {
        archivedKey = `${src.archivePrefix.replace(/\/$/, "")}/${baseName(objectKey)}`;
        await s3.send(new CopyObjectCommand({
          Bucket: src.bucket, CopySource: `${src.bucket}/${objectKey}`, Key: archivedKey,
        }));
        await s3.send(new DeleteObjectCommand({ Bucket: src.bucket, Key: objectKey }));
      } else if (src.deleteAfterProcess) {
        await s3.send(new DeleteObjectCommand({ Bucket: src.bucket, Key: objectKey }));
      }
    } catch (moveErr) {
      // Non-fatal: the data is already ingested and hash-deduped, so leaving the
      // object in place cannot double-count. Record it and move on.
      console.warn(`[bucketIngestion] Ingested ${objectKey} but could not archive/delete:`, moveErr);
    }

    await log({
      status: invalid.length > 0 ? "partial" : "success",
      fileSize: bytes.byteLength, fileHash, totalRows,
      validRows: valid.length, invalidRows: invalid.length,
      uploadBatchId, archivedKey, errorMessage: null,
    });

    await db.update(bucketIngestionSources).set({
      lastSuccessAt: new Date(),
      lastErrorAt: null,
      lastErrorMessage: null,
      totalFilesProcessed: src.totalFilesProcessed + 1,
    }).where(eq(bucketIngestionSources.id, src.id));

    return { success: true, uploadBatchId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ errorMessage: message }).catch(() => {});
    await db.update(bucketIngestionSources).set({
      lastErrorAt: new Date(), lastErrorMessage: message.slice(0, 2000),
    }).where(eq(bucketIngestionSources.id, src.id)).catch(() => {});
    return { success: false, error: message };
  }
}

/** Poll every active source whose interval has elapsed. Never throws. */
export async function pollBucketSources(): Promise<{ polled: number; ingested: number }> {
  const db = await getDb();
  if (!db) return { polled: 0, ingested: 0 };
  let polled = 0;
  let ingested = 0;

  try {
    const sources = await db
      .select()
      .from(bucketIngestionSources)
      .where(and(eq(bucketIngestionSources.isActive, true), eq(bucketIngestionSources.pollingEnabled, true)));

    const now = Date.now();
    for (const src of sources as BucketSource[]) {
      const dueAt = src.lastPolledAt
        ? src.lastPolledAt.getTime() + src.pollingIntervalMinutes * 60_000
        : 0;
      if (now < dueAt) continue;

      polled++;
      await db.update(bucketIngestionSources)
        .set({ lastPolledAt: new Date() })
        .where(eq(bucketIngestionSources.id, src.id));

      const listing = await listBucketFiles(src.id);
      if (!listing.success || !listing.files) {
        await db.update(bucketIngestionSources).set({
          lastErrorAt: new Date(), lastErrorMessage: (listing.error ?? "list failed").slice(0, 2000),
        }).where(eq(bucketIngestionSources.id, src.id));
        continue;
      }
      for (const f of listing.files) {
        const r = await downloadAndProcessBucketObject(src.id, f.key);
        if (r.success && !r.skipped) ingested++;
      }
    }
  } catch (err) {
    console.error("[bucketIngestion] poll cycle failed:", err);
  }
  return { polled, ingested };
}

export function startBucketPolling(): void {
  if (pollingInterval) return;
  console.info("[BucketIngestion] Starting with 60000ms interval");
  pollingInterval = setInterval(() => {
    void pollBucketSources();
  }, POLLING_CHECK_INTERVAL);
  pollingInterval.unref?.();
}

export function stopBucketPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
