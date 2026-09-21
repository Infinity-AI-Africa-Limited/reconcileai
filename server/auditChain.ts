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

/**
 * The timestamp to WRITE on a new audit entry: `now` cut to a whole second.
 *
 * ── Why this exists: half the chain verified as tampered ──────────────────
 *
 * The writer used `new Date()`, hashed it floored to the second, and inserted
 * it into a `timestamp(0)` column — which ROUNDS. Any entry written in the
 * second half of a second was stored one second later than it was hashed, and
 * failed verification as "altered after it was written". Measured 2026-09-21:
 * 364 of 760 signed production rows, every one of them matching exactly at
 * createdAt − 1 s, with no other mismatch of any kind. The chain was intact;
 * the writer disagreed with the column.
 *
 * Writing a whole second means the value hashed IS the value stored: there is
 * nothing left for the column to round.
 */
export function auditTimestamp(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / 1000) * 1000);
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
  /**
   * Signed rows that verified only under the ROUNDED-WRITE rule: their stored
   * time is exactly one second after the time they were hashed at. Reported,
   * never hidden — see `matchesRoundedWrite`.
   */
  roundedRows: number;
  firstBrokenSequence: number | null;
  reason: string | null;
}

/**
 * Did this row's writer hash it one second EARLIER than the column stored it?
 *
 * That is the signature of the pre-`auditTimestamp` writer (see above): the
 * hash took the floored second, the `timestamp(0)` column rounded up. Such a
 * row was not altered; its evidence is intact at the second it was hashed.
 *
 * Deliberately narrow. Exactly one second, exactly earlier, and only the
 * timestamp: every other field must match as written. Re-signing those rows
 * instead was rejected — rewriting the hashes of an audit chain is precisely
 * what a tamper-evident chain exists to make detectable. What this admits is
 * that a row's time could be moved forward by one second unnoticed; an edit
 * to anything else, or any other time, still breaks the chain.
 */
function matchesRoundedWrite(row: ChainRow): boolean {
  const t = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
  return computeRecordHash({ ...row, createdAt: new Date(t - 1000) }, row.prevRecordHash) === row.recordHash;
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
  let roundedRows = 0;

  for (const row of signed) {
    // Recompute the content hash and compare (detects content tampering).
    const expected = computeRecordHash(row, row.prevRecordHash);
    if (expected !== row.recordHash) {
      if (matchesRoundedWrite(row)) {
        roundedRows++;
      } else {
        return {
          valid: false,
          totalRows: rows.length,
          signedRows: signed.length,
          unsignedRows,
          roundedRows,
          firstBrokenSequence: row.sequenceNumber,
          reason: `Content hash mismatch at sequence ${row.sequenceNumber} — the entry was altered after it was written.`,
        };
      }
    }
    // Check linkage to the previous signed row (detects removal/reordering).
    if (started && row.prevRecordHash !== prevHash) {
      return {
        valid: false,
        totalRows: rows.length,
        signedRows: signed.length,
        unsignedRows,
        roundedRows,
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
    roundedRows,
    firstBrokenSequence: null,
    reason: null,
  };
}
