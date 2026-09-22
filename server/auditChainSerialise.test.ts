/**
 * Audit-chain appends are serialised per chain, and the forks written before
 * they were are recognised — not hidden, and not allowed to recur.
 *
 * Two writers that read the same head both wrote the next sequence number: 8
 * forks in the global chain on 2026-09-21, every one a clean pair (same parent,
 * both rows intact, the chain continuing from one of them), each breaking
 * verification. The writer now takes a per-chain lock; the verifier accepts a
 * fork only where KNOWN_CONCURRENT_FORKS names it — chain, sequence and hash.
 */
import { describe, it, expect } from "vitest";
import { SQL, getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { KNOWN_CONCURRENT_FORKS, auditTimestamp, computeRecordHash, verifyChain, type AuditChainFields, type AuditWriterVersion, type ChainRow, type KnownConcurrentFork } from "./auditChain";
import { createAuditLog, type DbTransaction } from "./db";

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
  } as unknown as DbTransaction;
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


/** 205 → (206a, 206b siblings) → 207 continuing from `continueFrom`; `dead` is the other sibling. */
function forkedChain(writer: AuditWriterVersion, continueFrom: "a" | "b") {
  const r205 = row(205, "created", 50, null, writer);
  const a = row(206, "revoked", 56, r205.recordHash, writer);
  const b = row(206, "revoked-again", 57, r205.recordHash, writer);
  const live = continueFrom === "a" ? a : b;
  const dead = continueFrom === "a" ? b : a;
  const r207 = row(207, "created", 58, live.recordHash, writer);
  return { rows: [r205, a, b, r207], r205, a, b, live, dead, r207 };
}
const listing = (dead: ChainRow, org: number | null = null): KnownConcurrentFork[] => [
  { organizationId: org, sequenceNumber: dead.sequenceNumber, deadRecordHash: dead.recordHash as string },
];

describe("when a chain holds a LISTED fork written before appends were serialised", () => {
  it("should verify it, and SAY how many rows were forked — whichever sibling comes first", () => {
    for (const writer of [1, 2] as const) {
      for (const from of ["a", "b"] as const) {
        const c = forkedChain(writer, from);
        expect(verifyChain(c.rows, listing(c.dead)), `writer ${writer}, from ${from}`).toMatchObject({ valid: true, forkedRows: 1 });
      }
    }
  });

  it("should accept the same entry written twice — one hash, the chain continuing from it", () => {
    // Sequence 206 in production: a double-clicked revoke, identical content.
    const r205 = row(205, "created", 50, null, 1);
    const once = row(206, "revoked", 56, r205.recordHash, 1);
    const twice = { ...once, createdAt: at(57) }; // stored a second later, hashed at 56
    const r207 = row(207, "created", 58, once.recordHash, 1);
    expect(verifyChain([r205, once, twice, r207], listing(once))).toMatchObject({ valid: true, forkedRows: 1, roundedRows: 1 });
  });
});

describe("when a duplicate sequence is NOT a listed fork", () => {
  it("should break the chain for a same-parent sibling — the forgery the old rule let through", () => {
    // One inserted row, hashed over its own content and dated into the past,
    // with no later hash rewritten: the rule accepted it as history.
    const c = forkedChain(2, "a");
    expect(verifyChain(c.rows, [])).toMatchObject({ valid: false, firstBrokenSequence: 206, forkedRows: 0 });
    expect(verifyChain(c.rows)).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });

  it("should break it for a different row at a listed sequence", () => {
    const c = forkedChain(2, "a");
    const forged = row(206, "forged", 57, c.r205.recordHash, 2);
    expect(verifyChain([c.r205, c.a, forged, c.r207], listing(c.dead))).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });

  it("should break it for a listed hash in a different chain", () => {
    const c = forkedChain(2, "a");
    expect(verifyChain(c.rows, listing(c.dead, 30001))).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });

  it("should break it for a sibling with a different parent", () => {
    const c = forkedChain(2, "a");
    const stray = row(206, "revoked-again", 57, "some-other-hash", 2);
    expect(verifyChain([c.r205, c.a, stray, c.r207], listing(stray))).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });

  it("should break it when the next entry continues from the dead sibling instead", () => {
    const c = forkedChain(2, "a");
    const wrong = row(207, "created", 58, c.dead.recordHash, 2);
    expect(verifyChain([c.r205, c.a, c.b, wrong], listing(c.dead))).toMatchObject({ valid: false, firstBrokenSequence: 207 });
  });
});

describe("when a listed fork's extra entry has been removed", () => {
  it("should report the removal — no later link would have noticed it", () => {
    const c = forkedChain(2, "a");
    const res = verifyChain([c.r205, c.live, c.r207], listing(c.dead));
    expect(res).toMatchObject({ valid: false, firstBrokenSequence: 206 });
    expect(res.reason).toMatch(/Missing entry at sequence 206/);
  });

  it("should report it at the end of the chain too", () => {
    const c = forkedChain(2, "a");
    expect(verifyChain([c.r205, c.live], listing(c.dead))).toMatchObject({ valid: false, firstBrokenSequence: 206 });
  });
});

describe("when the serialised writer is in use", () => {
  it("should never read a duplicate sequence number as a fork, even a listed one — whichever sibling comes first", () => {
    for (const from of ["a", "b"] as const) {
      const c = forkedChain(3, from);
      expect(verifyChain(c.rows, listing(c.dead)), `from ${from}`).toMatchObject({ valid: false, firstBrokenSequence: 206, forkedRows: 0 });
    }
  });

  it("should verify a clean chain with nothing forked or rounded", () => {
    const r1 = row(1, "a", 1, null, 3);
    const r2 = row(2, "b", 2, r1.recordHash, 3);
    expect(verifyChain([r1, r2])).toMatchObject({ valid: true, forkedRows: 0, roundedRows: 0 });
  });
});

describe("when the production list of known forks is read", () => {
  it("should name exactly the eight measured on 2026-09-21, each a full hash in the global chain", () => {
    expect(KNOWN_CONCURRENT_FORKS.map((f) => f.sequenceNumber)).toEqual([206, 229, 231, 237, 246, 250, 385, 393]);
    for (const f of KNOWN_CONCURRENT_FORKS) {
      expect(f.organizationId).toBeNull();
      expect(f.deadRecordHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
