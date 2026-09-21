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

/**
 * Which writer signed a row — recorded INSIDE the hashed content, so a row
 * proves its own writer and no column (or migration) is needed to know it.
 *
 *   1  the original writer: hashed the floored second, which the column then
 *      rounded. Its canonical form carries no version field, so every row it
 *      wrote still hashes exactly as it was signed.
 *   2  `auditTimestamp`: a whole second, stored as hashed. Its canonical form
 *      carries `writer: 2`.
 *
 * Why it matters: the rounded-write allowance below must apply ONLY to
 * writer-1 rows. Applied to every row, it would let anyone move a new entry's
 * time forward a second undetected — review caught exactly that. A writer-2
 * row cannot pass as writer-1, because its hash was taken over different
 * content; forging that needs the chain re-hashed, which the links expose.
 */
export type AuditWriterVersion = 1 | 2;
export const AUDIT_WRITER_VERSION: AuditWriterVersion = 2;

/** Deterministic SHA-256 over the entry content + the previous link. */
export function computeRecordHash(
  fields: AuditChainFields,
  prevRecordHash: string | null,
  writer: AuditWriterVersion = AUDIT_WRITER_VERSION,
): string {
  const content = {
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
  };
  // Writer 1 is the form every existing row was signed with — unchanged, key for key.
  return contentHashOf(writer === 1 ? content : { ...content, writer });
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
   * Writer-1 rows that verified only under the ROUNDED-WRITE rule: their
   * stored time is exactly one second after the time they were hashed at.
   * Reported, never hidden — see `matchesRoundedWrite`. Writer-2 rows are never
   * counted here; they verify exactly or not at all.
   */
  roundedRows: number;
  firstBrokenSequence: number | null;
  reason: string | null;
}

/**
 * Was this a WRITER-1 row that the column stored one second later than it was
 * hashed?
 *
 * That is the signature of the pre-`auditTimestamp` writer (see above): the
 * hash took the floored second, the `timestamp(0)` column rounded up. Such a
 * row was not altered; its evidence is intact at the second it was hashed.
 *
 * Deliberately narrow. Writer 1 only — a writer-2 row never needs it, and
 * allowing it there would blind the chain to a one-second edit on every new
 * entry. Exactly one second, exactly earlier, and only the timestamp: every
 * other field must match as written. Re-signing those rows instead was
 * rejected — rewriting the hashes of an audit chain is precisely what a
 * tamper-evident chain exists to make detectable. What this admits, for
 * writer-1 rows only, is that a time could have moved forward one second.
 */
function matchesRoundedWrite(row: ChainRow): boolean {
  const t = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
  return computeRecordHash({ ...row, createdAt: new Date(t - 1000) }, row.prevRecordHash, 1) === row.recordHash;
}

/** Does the row verify exactly as written, by either writer? */
function matchesAsWritten(row: ChainRow): boolean {
  return (
    computeRecordHash(row, row.prevRecordHash, 2) === row.recordHash ||
    computeRecordHash(row, row.prevRecordHash, 1) === row.recordHash
  );
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
    if (!matchesAsWritten(row)) {
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
