/**
 * S3 CSV Export Cleanup Service
 *
 * Tracks every CSV file uploaded to S3 in the `s3_csv_exports` table.
 * A scheduled job (Heartbeat) calls `purgeExpiredCsvExports()` daily to
 * delete files whose age exceeds their configured `retentionDays` window.
 *
 * Default retention: 7 days (configurable per record at insert time).
 * The `storageDelete` helper is used for the actual S3 deletion.
 */

import { getDb } from "./db";
import { s3CsvExports } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { storagePut, storageDelete } from "./storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackCsvExportInput {
  userId: number;
  organizationId: number | null;
  filename: string;
  csvContent: string;
  sourceModule: "cbn" | "cfo" | "reconciliation";
  sourceId?: number;
  /** Retention window in days. Defaults to 7. */
  retentionDays?: number;
}

export interface CsvExportRecord {
  id: number;
  s3Key: string;
  s3Url: string;
  filename: string;
  sourceModule: string;
  retentionDays: number;
  createdAt: Date;
}

// ─── Upload & Track ───────────────────────────────────────────────────────────

/**
 * Upload a CSV string to S3 and record it in `s3_csv_exports`.
 * Returns the public S3 URL so the caller can redirect the browser to it.
 */
export async function trackAndUploadCsvExport(
  input: TrackCsvExportInput
): Promise<{ s3Url: string; s3Key: string }> {
  const {
    userId,
    organizationId,
    filename,
    csvContent,
    sourceModule,
    sourceId,
    retentionDays = 7,
  } = input;

  // Build a unique S3 key: csv-exports/<module>/<userId>/<timestamp>-<filename>
  const ts = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key = `csv-exports/${sourceModule}/${userId}/${ts}-${safeFilename}`;

  const { url: s3Url } = await storagePut(
    s3Key,
    Buffer.from(csvContent, "utf-8"),
    "text/csv"
  );

  const sizeBytes = Buffer.byteLength(csvContent, "utf-8");

  const drizzle = await getDb();
  if (drizzle) {
    await drizzle.insert(s3CsvExports).values({
      userId,
      organizationId: organizationId ?? null,
      s3Key,
      s3Url,
      filename,
      sourceModule,
      sourceId: sourceId ?? null,
      sizeBytes,
      retentionDays,
      deleted: false,
    });
  }

  return { s3Url, s3Key };
}

// ─── Cleanup Job ──────────────────────────────────────────────────────────────

export interface PurgeResult {
  checked: number;
  deleted: number;
  failed: number;
  errors: string[];
}

/**
 * Delete all S3 CSV exports whose age exceeds their `retentionDays` window.
 * Marks each record as deleted in the DB after a successful S3 deletion.
 * Safe to call multiple times — already-deleted records are skipped.
 *
 * Designed to be called from a Heartbeat daily scheduled handler.
 */
export async function purgeExpiredCsvExports(): Promise<PurgeResult> {
  const result: PurgeResult = { checked: 0, deleted: 0, failed: 0, errors: [] };

  const drizzle = await getDb();
  if (!drizzle) {
    result.errors.push("DB unavailable — skipping purge");
    return result;
  }

  // Fetch all non-deleted exports
  const candidates = await drizzle
    .select()
    .from(s3CsvExports)
    .where(eq(s3CsvExports.deleted, false));

  result.checked = candidates.length;

  const now = Date.now();

  for (const record of candidates) {
    const ageMs = now - new Date(record.createdAt).getTime();
    const retentionMs = record.retentionDays * 24 * 60 * 60 * 1000;

    if (ageMs < retentionMs) continue; // Not yet expired

    try {
      await storageDelete(record.s3Key);

      await drizzle
        .update(s3CsvExports)
        .set({ deleted: true, deletedAt: new Date() })
        .where(eq(s3CsvExports.id, record.id));

      result.deleted++;
      console.log(
        `[S3 Cleanup] Deleted expired CSV export: ${record.s3Key} (age: ${Math.round(ageMs / 86400000)}d, retention: ${record.retentionDays}d)`
      );
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to delete ${record.s3Key}: ${msg}`);
      console.error(`[S3 Cleanup] Error deleting ${record.s3Key}:`, err);
    }
  }

  console.log(
    `[S3 Cleanup] Purge complete — checked: ${result.checked}, deleted: ${result.deleted}, failed: ${result.failed}`
  );
  return result;
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

/**
 * List recent CSV exports for a user/org (for a management UI).
 */
export async function listCsvExports(
  userId: number,
  organizationId: number | null,
  limit = 50
): Promise<CsvExportRecord[]> {
  const drizzle = await getDb();
  if (!drizzle) return [];

  const rows = await drizzle
    .select({
      id: s3CsvExports.id,
      s3Key: s3CsvExports.s3Key,
      s3Url: s3CsvExports.s3Url,
      filename: s3CsvExports.filename,
      sourceModule: s3CsvExports.sourceModule,
      retentionDays: s3CsvExports.retentionDays,
      createdAt: s3CsvExports.createdAt,
    })
    .from(s3CsvExports)
    .where(
      and(
        eq(s3CsvExports.userId, userId),
        eq(s3CsvExports.deleted, false)
      )
    )
    .orderBy(s3CsvExports.createdAt)
    .limit(limit);

  return rows as CsvExportRecord[];
}
