/**
 * Tamper-evident audit log hash-chaining.
 *
 * Each audit entry stores recordHash = SHA-256(canonical(entry) + prevRecordHash),
 * forming a per-organization chain (like a mini blockchain). Altering, removing,
 * or reordering any historical entry changes a hash and breaks the chain, which
 * `verifyChain` detects. This gives tamper-*evidence* at the application layer;
 * true write-once (WORM) storage — revoking UPDATE/DELETE grants or using an
 * immutable store — is an infrastructure follow-up that complements this.
 */
import { contentHashOf } from "./signing";

export interface AuditChainFields {
  sequenceNumber: number;
  userId: number | null;
  organizationId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date | string;
}

/** Whole-second epoch — MySQL TIMESTAMP has no sub-second precision by default,
 *  so we hash at second granularity to keep write/read deterministic. */
function epochSeconds(d: Date | string): number {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Math.floor(t / 1000);
}

/** Deterministic SHA-256 over the entry content + the previous link. */
export function computeRecordHash(fields: AuditChainFields, prevRecordHash: string | null): string {
  return contentHashOf({
    sequenceNumber: fields.sequenceNumber,
    userId: fields.userId ?? null,
    organizationId: fields.organizationId ?? null,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId ?? null,
    details: fields.details ?? null,
    ipAddress: fields.ipAddress ?? null,
    userAgent: fields.userAgent ?? null,
    createdAtEpochSec: epochSeconds(fields.createdAt),
    prevRecordHash: prevRecordHash ?? "",
  });
}

export interface ChainRow extends AuditChainFields {
  id?: number;
  recordHash: string | null;
  prevRecordHash: string | null;
}

export interface ChainVerification {
  valid: boolean;
  totalRows: number;
  signedRows: number;
  unsignedRows: number; // legacy rows written before chaining existed
  firstBrokenSequence: number | null;
  reason: string | null;
}

/**
 * Verify a chain of audit rows (must be passed in ascending sequence order).
 * Legacy rows with no recordHash are tolerated and reported as `unsignedRows`;
 * verification covers the contiguous signed tail.
 */
export function verifyChain(rows: ChainRow[]): ChainVerification {
  const signed = rows.filter((r) => r.recordHash);
  const unsignedRows = rows.length - signed.length;

  let prevHash: string | null = null;
  let started = false;

  for (const row of signed) {
    // Recompute the content hash and compare (detects content tampering).
    const expected = computeRecordHash(row, row.prevRecordHash);
    if (expected !== row.recordHash) {
      return {
        valid: false,
        totalRows: rows.length,
        signedRows: signed.length,
        unsignedRows,
        firstBrokenSequence: row.sequenceNumber,
        reason: `Content hash mismatch at sequence ${row.sequenceNumber} — the entry was altered after it was written.`,
      };
    }
    // Check linkage to the previous signed row (detects removal/reordering).
    if (started && row.prevRecordHash !== prevHash) {
      return {
        valid: false,
        totalRows: rows.length,
        signedRows: signed.length,
        unsignedRows,
        firstBrokenSequence: row.sequenceNumber,
        reason: `Broken link at sequence ${row.sequenceNumber} — a preceding entry was removed or reordered.`,
      };
    }
    prevHash = row.recordHash;
    started = true;
  }

  return {
    valid: true,
    totalRows: rows.length,
    signedRows: signed.length,
    unsignedRows,
    firstBrokenSequence: null,
    reason: null,
  };
}
