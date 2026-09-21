/**
 * Audit-chain appends are serialised per chain, and the forks written before
 * they were are recognised — not hidden, and not allowed to recur.
 *
 * Two writers that read the same head both wrote the next sequence number: 8
 * forks in the global chain on 2026-09-21, every one a clean pair (same parent,
 * both rows intact, the chain continuing from one of them), each breaking
 * verification. The writer now takes a per-chain lock; the verifier accepts a
 * fork only from rows written before that (writer < 3).
 */
import { describe, it, expect } from "vitest";
import { SQL, getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditTimestamp, computeRecordHash, verifyChain, type AuditChainFields, type AuditWriterVersion, type ChainRow } from "./auditChain";
import { createAuditLog, type DbExecutor } from "./db";

// ─── The writer ─────────────────────────────────────────────────────────────

const dialect = new MySqlDialect();

function recordingExecutor(head: { seq: number; hash: string } | null) {
  const log: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  /** The WHERE parameters of each read, by table — so a test can see WHICH row was locked. */
  const whereParams: Record<string, unknown[]> = {};
  const select = () => {
    let table = "";
    const q = {
      from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; },
      where(cond?: unknown) {
        if (cond instanceof SQL) whereParams[table] = dialect.sqlToQuery(cond).params;
        return q;
      },
      orderBy() { return q; },
      limit() { return q; },
      for(strength: string) { log.push(`lock-read ${table} ${strength}`); return q; },
      then(resolve: (rows: unknown[]) => unknown) {
        log.push(`read ${table}`);
        return Promise.resolve(table === "audit_logs" && head ? [head] : []).then(resolve);
      },
    };
    return q;
  };
  const executor = {
    select,
    insert: (t: Parameters<typeof getTableName>[0]) => ({
      ignore: () => ({ values: async (v: Record<string, unknown>) => { log.push(`insert-ignore ${getTableName(t)} ${JSON.stringify(v)}`); } }),
      values: async (v: Record<string, unknown>) => { log.push(`insert ${getTableName(t)}`); inserted.push(v); },
    }),
  } as unknown as DbExecutor;
  return { executor, log, inserted, whereParams };
}

describe("when an audit entry is appended", () => {
  it("should take the chain's lock, then read the head with a LOCKING read, then append", async () => {
    const { executor, log, inserted, whereParams } = recordingExecutor({ seq: 41, hash: "h41" });
    await createAuditLog({ userId: 7, organizationId: 30001, action: "a", entityType: "e" }, executor);
    // The lock taken is THIS chain's row, not merely some row.
    expect(whereParams.audit_chain_locks).toEqual([30001]);
    expect(log).toEqual([
      'insert-ignore audit_chain_locks {"chainKey":30001}',
      "lock-read audit_chain_locks update",
      "read audit_chain_locks",
      "lock-read audit_logs update",
      "read audit_logs",
      "insert audit_logs",
    ]);
    expect(inserted[0]).toMatchObject({ sequenceNumber: 42, prevRecordHash: "h41" });
  });

  it("should lock the global chain under key 0, since it has no organisation row", async () => {
    const { executor, log } = recordingExecutor(null);
    await createAuditLog({ userId: 7, organizationId: null, action: "a", entityType: "e" }, executor);
    expect(log[0]).toBe('insert-ignore audit_chain_locks {"chainKey":0}');
  });

  it("should sign the entry as the serialised writer, so no old allowance can apply to it", async () => {
    const { executor, inserted } = recordingExecutor({ seq: 1, hash: "h1" });
    await createAuditLog({ userId: 7, organizationId: 5, action: "a", entityType: "e", details: "{}" }, executor);
    const row = inserted[0] as unknown as ChainRow;
    const fields = { ...row, userId: 7, organizationId: 5, entityId: null, ipAddress: null, userAgent: null } as ChainRow;
    expect(computeRecordHash(fields, "h1", 3)).toBe(row.recordHash);
    expect(computeRecordHash(fields, "h1", 2)).not.toBe(row.recordHash);
  });
});

// ─── The verifier ───────────────────────────────────────────────────────────

const at = (s: number) => auditTimestamp(new Date(Date.UTC(2026, 6, 18, 7, 57, s)));
const fields = (seq: number, action: string, s: number): AuditChainFields => ({
  sequenceNumber: seq, userId: 1, organizationId: null, action, entityType: "link", entityId: null,
  details: "{}", ipAddress: null, userAgent: null, createdAt: at(s),
});
function row(seq: number, action: string, s: number, prev: string | null, writer: AuditWriterVersion): ChainRow {
  const f = fields(seq, action, s);
  return { ...f, prevRecordHash: prev, recordHash: computeRecordHash(f, prev, writer) };
}

/** 205 → (206a, 206b siblings) → 207 continuing from `continueFrom`. */
function forkedChain(writer: AuditWriterVersion, continueFrom: "a" | "b") {
  const r205 = row(205, "created", 50, null, writer);
  const a = row(206, "revoked", 56, r205.recordHash, writer);
  const b = row(206, "revoked-again", 57, r205.recordHash, writer);
  const r207 = row(207, "created", 58, (continueFrom === "a" ? a : b).recordHash, writer);
  return [r205, a, b, r207];
}

describe("when a chain holds a fork written before appends were serialised", () => {
  it("should verify it, and SAY how many rows were forked", () => {
    // The production shape: the chain continued from the later sibling.
    for (const writer of [1, 2] as const) {
      expect(verifyChain(forkedChain(writer, "b")), `writer ${writer}`).toMatchObject({ valid: true, forkedRows: 1 });
      expect(verifyChain(forkedChain(writer, "a")), `writer ${writer}`).toMatchObject({ valid: true, forkedRows: 1 });
    }
  });

  it("should still catch a sibling with a different parent — that is an insertion, not a fork", () => {
    const [r205, a, , r207] = forkedChain(2, "a");
    const stray = row(206, "inserted", 57, "some-other-hash", 2);
    expect(verifyChain([r205, a, stray, r207])).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });

  it("should still catch a next entry that links to neither sibling", () => {
    const [r205, a, b] = forkedChain(2, "a");
    const orphan = row(207, "created", 58, "not-a-sibling", 2);
    expect(verifyChain([r205, a, b, orphan])).toMatchObject({ valid: false, firstBrokenSequence: 207 });
  });
});

describe("when the serialised writer is in use", () => {
  it("should never read a duplicate sequence number as a fork", () => {
    // After writer 3 no two appends can collide, so a duplicate is an insertion.
    expect(verifyChain(forkedChain(3, "a"))).toMatchObject({ valid: false, firstBrokenSequence: 206, forkedRows: 0 });
  });

  it("should verify a clean chain with nothing forked or rounded", () => {
    const r1 = row(1, "a", 1, null, 3);
    const r2 = row(2, "b", 2, r1.recordHash, 3);
    expect(verifyChain([r1, r2])).toMatchObject({ valid: true, forkedRows: 0, roundedRows: 0 });
  });
});
