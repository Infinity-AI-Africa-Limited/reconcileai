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
 *   3  the SERIALISED writer: takes the chain's lock (audit_chain_locks)
 *      before reading the head, so no two writers can append the same
 *      sequence number. Its canonical form carries `writer: 3`.
 *
 * Why it matters: each allowance below must apply only to the rows whose
 * writer had the flaw. The rounded-write allowance is for writer-1 rows —
 * applied to every row, it would let anyone move a new entry's time forward a
 * second undetected, which review caught. The concurrent-fork allowance is for
 * rows before writer 3 — applied after it, an inserted "sibling" of a real
 * entry would pass. A row cannot pass as an earlier writer than it was,
 * because its hash was taken over different content; forging that needs the
 * chain re-hashed, which the links expose.
 */
export type AuditWriterVersion = 1 | 2 | 3;
export const AUDIT_WRITER_VERSION: AuditWriterVersion = 3;

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
  /**
   * Rows written by two writers at once, before writes were serialised: a
   * second row with the same sequence number and the same parent as its
   * sibling, the chain continuing from one of them. Reported, never hidden —
   * see verifyChain. Rows from the serialised writer are never counted here.
   */
  forkedRows: number;
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

/** Which writer's canonical form the row verifies under exactly, or null. */
function writerOf(row: ChainRow): AuditWriterVersion | null {
  for (const w of [3, 2, 1] as const) {
    if (computeRecordHash(row, row.prevRecordHash, w) === row.recordHash) return w;
  }
  return null;
}

/**
 * Verify a chain of audit rows (must be passed in ascending sequence order,
 * ties by id). Legacy rows with no recordHash are tolerated and reported as
 * `unsignedRows`; verification covers the contiguous signed tail.
 *
 * ── Concurrent forks ──────────────────────────────────────────────────
 *
 * Before writes were serialised, two writers could read the same head and both
 * append the next sequence number — measured 2026-09-21: 8 such pairs in the
 * global chain, every one with the same parent, both rows intact, and the
 * chain continuing from exactly one of them. Those rows were not altered; the
 * writer let them collide.
 *
 * So a second row at the same sequence number is accepted as a fork sibling
 * when — and only when — it shares its sibling's parent and was written
 * before the serialised writer (writer < 3). The next sequence may continue
 * from any sibling. Siblings are counted in `forkedRows`, not hidden.
 *
 * What that admits, for pre-serialisation rows only: an extra row inserted
 * beside an existing one, with a valid hash over its own content, would be
 * read as a fork. Anyone able to write such a row can already recompute any
 * hash — this chain is tamper-EVIDENCE at the application layer, and WORM
 * storage is the stated follow-up (header of this file). After writer 3 no
 * allowance applies: a duplicate sequence number there breaks the chain.
 */
export function verifyChain(rows: ChainRow[]): ChainVerification {
  const signed = rows.filter((r) => r.recordHash);
  const unsignedRows = rows.length - signed.length;

  let roundedRows = 0;
  let forkedRows = 0;
  /** The sequence just verified: its number, its rows' hashes, and their shared parent. */
  let group: { seq: number; hashes: Set<string>; parent: string | null } | null = null;

  const broken = (row: ChainRow, reason: string): ChainVerification => ({
    valid: false,
    totalRows: rows.length,
    signedRows: signed.length,
    unsignedRows,
    roundedRows,
    forkedRows,
    firstBrokenSequence: row.sequenceNumber,
    reason,
  });

  for (const row of signed) {
    // Recompute the content hash and compare (detects content tampering).
    let writer = writerOf(row);
    if (writer === null && matchesRoundedWrite(row)) {
      writer = 1;
      roundedRows++;
    }
    if (writer === null) {
      return broken(row, `Content hash mismatch at sequence ${row.sequenceNumber} — the entry was altered after it was written.`);
    }

    const hash = row.recordHash as string;
    if (group === null) {
      group = { seq: row.sequenceNumber, hashes: new Set([hash]), parent: row.prevRecordHash };
      continue;
    }

    if (row.sequenceNumber === group.seq) {
      // A second row at the same sequence: a concurrent fork only if written
      // before the serialised writer, and from the same parent as its sibling.
      if (writer < 3 && row.prevRecordHash === group.parent) {
        forkedRows++;
        group.hashes.add(hash);
        continue;
      }
      return broken(row, `Duplicate sequence ${row.sequenceNumber} — an entry was inserted beside another.`);
    }

    // Check linkage to the previous sequence (detects removal/reordering).
    if (row.prevRecordHash === null || !group.hashes.has(row.prevRecordHash)) {
      return broken(row, `Broken link at sequence ${row.sequenceNumber} — a preceding entry was removed or reordered.`);
    }
    group = { seq: row.sequenceNumber, hashes: new Set([hash]), parent: row.prevRecordHash };
  }

  return {
    valid: true,
    totalRows: rows.length,
    signedRows: signed.length,
    unsignedRows,
    roundedRows,
    forkedRows,
    firstBrokenSequence: null,
    reason: null,
  };
}
