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
 * entry would pass — and further to the eight forks listed by hash, since even
 * before writer 3 a rule let any inserted sibling pass. A row cannot pass as an earlier writer than it was,
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
   * Rows written by two writers at once, before writes were serialised: the
   * LISTED dead sibling of a known fork (KNOWN_CONCURRENT_FORKS) — same
   * sequence number and parent as the row the chain continued from. Reported,
   * never hidden — see verifyChain. No other row can be counted here.
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
 * A concurrent fork that happened, identified exactly: the chain, the sequence
 * number, and the hash of the row the chain did NOT continue from.
 */
export interface KnownConcurrentFork {
  organizationId: number | null;
  sequenceNumber: number;
  deadRecordHash: string;
}

/**
 * Every concurrent fork the unserialised writer left behind — the complete
 * list, measured on production 2026-09-21 (read-only), all in the global chain.
 *
 * Each names the sibling no later entry links to. At 206 the two siblings are
 * the SAME entry written twice — a double-clicked revoke, identical content
 * stored a second apart — so the dead hash is also the live one, and the entry
 * that follows links to it.
 *
 * Why a list rather than a rule: a rule ("a pre-serialisation sibling with the
 * same parent is a fork") accepted ANY such row, so one inserted row — dated
 * into the past, hashed over its own content — would verify intact and be
 * reported as harmless history, without rewriting a single later hash. Review
 * caught it. A list cannot be joined: a forged row would need a SHA-256 match
 * with one of these. No fork can be added to it by new writes, because the
 * serialised writer (3) cannot produce one — so the list is closed.
 */
export const KNOWN_CONCURRENT_FORKS: readonly KnownConcurrentFork[] = [
  { organizationId: null, sequenceNumber: 206, deadRecordHash: "19e4152a4d0d9018b64239f99853598ce55c65c803522cfd63efba744100b03f" },
  { organizationId: null, sequenceNumber: 229, deadRecordHash: "a4b16956b1e99bb31454eced9fb3ff5852169e64f3b7713a4021ed56891b7b47" },
  { organizationId: null, sequenceNumber: 231, deadRecordHash: "d1bc39c2715c86e9090a348004f8e6bdd9339d82a214c67f03dc128b0205101a" },
  { organizationId: null, sequenceNumber: 237, deadRecordHash: "6206b15cca53e415b50dc72bf2d57dd8fec5b47a84b6fb7a55ebca9f25f3f10c" },
  { organizationId: null, sequenceNumber: 246, deadRecordHash: "8af60413191d8ce87a93918adb035fd7ddecc05991e82c5b6aabee9457027f11" },
  { organizationId: null, sequenceNumber: 250, deadRecordHash: "dfb253023dcab221b9a04c37caad2fbc0e084282d62197355d2fe56ca24fd8d2" },
  { organizationId: null, sequenceNumber: 385, deadRecordHash: "1cba4080b8e58f19715a52bb384002ba7ea792ce50cb696c91f250113f360daa" },
  { organizationId: null, sequenceNumber: 393, deadRecordHash: "9acdba9496e2dec5f69298c60c0326d237e5af2966f6d399e9b2aa9d59a4056b" },
];

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
 * A second row at a sequence number is accepted only where `knownForks` names
 * that exact chain and sequence, and only if it is the named dead row: the
 * listed hash, the same parent as its sibling, intact, and written before the
 * serialised writer. It is then set aside and the chain verified as the single
 * line it continued along. Any other duplicate sequence breaks the chain.
 * Accepted rows are counted in `forkedRows`, not hidden.
 *
 * The list is also a presence check. No later entry links to a dead sibling,
 * so deleting one would break no link — the chain would have lost a real event
 * silently. A listed fork missing from the chain it names is reported as a
 * removal.
 *
 * `knownForks` is a parameter for tests only; callers use the default.
 */
export function verifyChain(
  rows: ChainRow[],
  knownForks: readonly KnownConcurrentFork[] = KNOWN_CONCURRENT_FORKS,
): ChainVerification {
  const signed = rows.filter((r) => r.recordHash);
  const unsignedRows = rows.length - signed.length;

  let roundedRows = 0;
  let forkedRows = 0;
  /** The sequence just verified: its row's hash and parent, and whether its listed fork has been set aside. */
  let group: {
    seq: number;
    hash: string;
    parent: string | null;
    writer: AuditWriterVersion;
    fork: KnownConcurrentFork | null;
    forkSeen: boolean;
  } | null = null;
  const chainOrg = signed[0]?.organizationId ?? null;
  const forkAt = (seq: number) =>
    knownForks.find((f) => f.sequenceNumber === seq && (f.organizationId ?? null) === chainOrg) ?? null;

  const broken = (sequence: number, reason: string): ChainVerification => ({
    valid: false,
    totalRows: rows.length,
    signedRows: signed.length,
    unsignedRows,
    roundedRows,
    forkedRows,
    firstBrokenSequence: sequence,
    reason,
  });
  const missingFork = (seq: number) =>
    broken(seq, `Missing entry at sequence ${seq} — one of two entries written there concurrently was removed.`);

  for (const row of signed) {
    // Recompute the content hash and compare (detects content tampering).
    let writer = writerOf(row);
    if (writer === null && matchesRoundedWrite(row)) {
      writer = 1;
      roundedRows++;
    }
    if (writer === null) {
      return broken(row.sequenceNumber, `Content hash mismatch at sequence ${row.sequenceNumber} — the entry was altered after it was written.`);
    }

    const hash = row.recordHash as string;
    if (group !== null && row.sequenceNumber === group.seq) {
      // A second row at the same sequence: accepted only as the LISTED dead
      // sibling of a known fork — same parent, written before serialisation.
      // Either row may come first (ties are ordered by id, not by which the
      // chain continued from), so whichever carries the listed hash is set aside.
      const fork = group.fork;
      if (fork && !group.forkSeen && row.prevRecordHash === group.parent) {
        if (hash === fork.deadRecordHash && writer < 3) {
          forkedRows++;
          group.forkSeen = true;
          continue;
        }
        if (group.hash === fork.deadRecordHash && group.writer < 3) {
          forkedRows++;
          group.forkSeen = true;
          group.hash = hash; // the chain continues from this one
          group.writer = writer;
          continue;
        }
      }
      return broken(row.sequenceNumber, `Duplicate sequence ${row.sequenceNumber} — an entry was inserted beside another.`);
    }

    if (group !== null) {
      if (group.fork && !group.forkSeen) return missingFork(group.seq);
      // Check linkage to the previous sequence (detects removal/reordering).
      if (row.prevRecordHash === null || row.prevRecordHash !== group.hash) {
        return broken(row.sequenceNumber, `Broken link at sequence ${row.sequenceNumber} — a preceding entry was removed or reordered.`);
      }
    }
    group = { seq: row.sequenceNumber, hash, parent: row.prevRecordHash, writer, fork: forkAt(row.sequenceNumber), forkSeen: false };
  }
  if (group !== null && group.fork && !group.forkSeen) return missingFork(group.seq);

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
