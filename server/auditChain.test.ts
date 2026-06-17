import { describe, it, expect } from "vitest";
import { computeRecordHash, verifyChain, type ChainRow, type AuditChainFields } from "./auditChain";

const base = (seq: number, action: string): AuditChainFields => ({
  sequenceNumber: seq,
  userId: 1,
  organizationId: 10,
  action,
  entityType: "transaction",
  entityId: seq,
  details: { foo: "bar", n: seq },
  ipAddress: "10.0.0.1",
  userAgent: "test",
  createdAt: new Date("2026-06-17T10:00:00Z"),
});

/** Build a valid signed chain from a list of (seq, action). */
function buildChain(specs: Array<[number, string]>): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string | null = null;
  for (const [seq, action] of specs) {
    const fields = base(seq, action);
    const recordHash = computeRecordHash(fields, prev);
    rows.push({ ...fields, recordHash, prevRecordHash: prev });
    prev = recordHash;
  }
  return rows;
}

describe("audit hash chain", () => {
  it("verifies an intact chain", () => {
    const rows = buildChain([[1, "create"], [2, "update"], [3, "resolve"]]);
    const result = verifyChain(rows);
    expect(result.valid).toBe(true);
    expect(result.signedRows).toBe(3);
    expect(result.firstBrokenSequence).toBeNull();
  });

  it("detects content tampering (a row was edited after the fact)", () => {
    const rows = buildChain([[1, "create"], [2, "update"], [3, "resolve"]]);
    // Tamper with row 2's action without recomputing its hash.
    rows[1].action = "delete";
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(2);
    expect(result.reason).toMatch(/altered/i);
  });

  it("detects a removed/reordered entry (broken link)", () => {
    const rows = buildChain([[1, "create"], [2, "update"], [3, "resolve"]]);
    // Remove the middle row — row 3 still links to row 2's hash, which is now absent.
    const tampered = [rows[0], rows[2]];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(3);
    expect(result.reason).toMatch(/removed or reordered/i);
  });

  it("tolerates legacy unsigned rows and verifies the signed tail", () => {
    const signed = buildChain([[3, "create"], [4, "update"]]);
    const legacy: ChainRow[] = [
      { ...base(1, "old"), recordHash: null, prevRecordHash: null },
      { ...base(2, "old"), recordHash: null, prevRecordHash: null },
    ];
    const result = verifyChain([...legacy, ...signed]);
    expect(result.valid).toBe(true);
    expect(result.unsignedRows).toBe(2);
    expect(result.signedRows).toBe(2);
  });

  it("is deterministic regardless of details key order", () => {
    const a = computeRecordHash({ ...base(1, "x"), details: { a: 1, b: 2 } }, null);
    const b = computeRecordHash({ ...base(1, "x"), details: { b: 2, a: 1 } }, null);
    expect(a).toBe(b);
  });
});
