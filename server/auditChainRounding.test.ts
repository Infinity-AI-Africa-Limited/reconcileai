/**
 * The audit chain and the column that stores it must agree on the second.
 *
 * The writer hashed `new Date()` floored to the second and inserted it into a
 * timestamp(0) column, which ROUNDS. Every entry written in the second half of
 * a second was stored one second late and verified as "altered after it was
 * written" — 364 of 760 signed production rows on 2026-09-21, each matching
 * exactly at createdAt − 1 s. These tests pin the writer fix and the narrow
 * rule under which those already-written rows still verify.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { auditTimestamp, computeRecordHash, verifyChain, type AuditChainFields, type ChainRow } from "./auditChain";
import { createAuditLog, type DbExecutor } from "./db";

/** What a timestamp(0) column does to a value on insert. */
const storedByColumn = (d: Date) => new Date(Math.round(d.getTime() / 1000) * 1000);

const fields = (seq: number, createdAt: Date): AuditChainFields => ({
  sequenceNumber: seq, userId: 7, organizationId: 30001, action: "exception_resolved", entityType: "exception",
  entityId: 900 + seq, details: JSON.stringify({ n: seq }), ipAddress: null, userAgent: null, createdAt,
});

/** A chain as the OLD writer produced it: hashed at `hashedAt`, stored as the column rounds it. */
function oldWriterChain(hashedAt: Date[]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string | null = null;
  hashedAt.forEach((t, i) => {
    const f = fields(i + 1, t);
    const recordHash = computeRecordHash(f, prev);
    rows.push({ ...f, createdAt: storedByColumn(t), recordHash, prevRecordHash: prev });
    prev = recordHash;
  });
  return rows;
}

describe("when a new audit entry is timestamped", () => {
  it("should use a whole second, so the column has nothing to round", () => {
    const t = auditTimestamp(new Date("2026-09-21T14:05:25.600Z"));
    expect(t.toISOString()).toBe("2026-09-21T14:05:25.000Z");
    expect(storedByColumn(t).getTime()).toBe(t.getTime());
  });
});

describe("when createAuditLog writes an entry", () => {
  afterEach(() => vi.useRealTimers());

  it("should hash exactly the timestamp it stores, even late in a second", async () => {
    // .600 is the case that broke: floored for the hash, rounded up by the column.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T14:05:25.600Z"));
    const inserted: Record<string, unknown>[] = [];
    const q = { from: () => q, where: () => q, orderBy: () => q, limit: () => q, then: (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r) };
    const executor = {
      select: () => q,
      insert: (t: Parameters<typeof getTableName>[0]) => ({
        values: async (v: Record<string, unknown>) => { expect(getTableName(t)).toBe("audit_logs"); inserted.push(v); },
      }),
    } as unknown as DbExecutor;

    await createAuditLog({ userId: 7, organizationId: 30001, action: "exception_resolved", entityType: "exception", entityId: 901, details: "{}" }, executor);

    expect(inserted).toHaveLength(1);
    const row = inserted[0] as { createdAt: Date; recordHash: string; sequenceNumber: number };
    expect(row.createdAt.getUTCMilliseconds()).toBe(0);
    // Round-trip through the column, then verify strictly — no rounding rule needed.
    const stored: ChainRow = { ...(row as unknown as ChainRow), createdAt: storedByColumn(row.createdAt), ipAddress: null, userAgent: null };
    expect(verifyChain([stored])).toMatchObject({ valid: true, roundedRows: 0 });
  });
});

describe("when verifying rows the old writer stored a second late", () => {
  it("should verify them, and SAY how many needed the rounded-write rule", () => {
    const rows = oldWriterChain([
      new Date("2026-08-01T10:00:00.200Z"), // rounded down: stored as hashed
      new Date("2026-08-01T10:00:05.700Z"), // rounded up: stored one second late
      new Date("2026-08-01T10:00:09.900Z"), // rounded up
    ]);
    expect(verifyChain(rows)).toMatchObject({ valid: true, signedRows: 3, roundedRows: 2 });
  });

  it("should still catch a timestamp moved by anything other than that one second", () => {
    for (const shiftMs of [2000, -1000, 60_000]) {
      const rows = oldWriterChain([new Date("2026-08-01T10:00:00.200Z")]);
      rows[0] = { ...rows[0], createdAt: new Date((rows[0].createdAt as Date).getTime() + shiftMs) };
      expect(verifyChain(rows).valid, `shifted ${shiftMs}ms`).toBe(false);
    }
  });

  it("should still catch any other edit to a row that was stored a second late", () => {
    const rows = oldWriterChain([new Date("2026-08-01T10:00:05.700Z")]);
    rows[0] = { ...rows[0], action: "exception_dismissed" };
    expect(verifyChain(rows)).toMatchObject({ valid: false, firstBrokenSequence: 1 });
  });

  it("should still catch a removed entry", () => {
    const rows = oldWriterChain([
      new Date("2026-08-01T10:00:05.700Z"),
      new Date("2026-08-01T10:00:06.700Z"),
      new Date("2026-08-01T10:00:07.700Z"),
    ]);
    expect(verifyChain([rows[0], rows[2]]).valid).toBe(false);
  });
});
