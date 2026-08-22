/**
 * Tenancy ratchet — a build-time guard against the vulnerability class that
 * appeared four times in one day (#25 channels, #31 public upload API, #32 SFTP
 * credentials, and the sweep this file accompanies).
 *
 * The shape is always identical: a `db.ts` mutator keyed on a bare `id`, called
 * from a tRPC procedure with an id supplied by the caller and no proof of
 * ownership. Reviewing for it by eye has already failed repeatedly, so it is
 * asserted here instead.
 *
 * WHEN THIS TEST FAILS you have added an id-keyed write without an organization
 * (or user) in its predicate. Either:
 *   1. add `organizationId` to the WHERE — the right answer nearly always; or
 *   2. add the function to ALLOWED below WITH a comment saying why it is safe.
 * Do not silence it by widening the regex.
 *
 * Mirrors the RLS classification ratchet in rlsAudit.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * Mutators that legitimately key on a bare id. Each entry needs a reason.
 * Keep this list SHORT — every addition is a deliberate exception.
 */
const ALLOWED: Record<string, string> = {
  // Internal-only: the id comes from a row this process just selected or
  // inserted, never from a request.
  updateUploadBatch: "batch id is minted by the caller in the same request/cycle; never client-supplied",
  incrementUploadBatchCounts: "same batch the caller just created; appendBatch verifies batch.userId first",
  updateScheduleRunHistory: "run-history id is created by the scheduling engine itself",
  updateReconciliationJob: "job id originates from the caller's own reconciliation run",
  // Same provenance as updateReconciliationJob above: the job id comes from the
  // run this process is executing, never from a request. Scoping either by
  // organizationId would be ceremony rather than protection — the only org
  // available is read from this very row, so the predicate is tautological, and
  // a mismatch would silently lose a completed run's results.
  completeReconciliationJobClearingAbandonment: "job id comes from the run this process is executing",
  // touchReconciliationJobHeartbeat is deliberately NOT here: its predicate is
  // compound (`AND abandonedAt IS NULL`), so the detector does not flag it and
  // the staleness check below would reject a needless entry.

  // updateMatchStatus and updateException were here because `matches` and
  // `exceptions` had no organizationId to filter on. Migration 0078 added it to
  // both, and both now take a required organizationId — so the exemptions are
  // gone rather than merely re-justified. Do not re-add them.
  updateTransactionStatus: "bulk status write driven by the engine over rows it already selected",

  // Unused today; retained rather than deleted.
  updateWebhook: "no callers — dead code",
  updateApiKeyLastUsed: "no callers — dead code (validateApiKey writes lastUsedAt inline)",
};

/** Exported async functions in db.ts that perform a write keyed on a bare id. */
function findUnscopedIdWrites(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let name: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!name) return;
    const body = buf.join("\n");
    const isWrite = /db\s*\.\s*(update|delete|insert)\s*\(/.test(body);
    // `.where(eq(<table>.id, id))` with nothing else in the predicate.
    const bareId = /where\(\s*eq\(\s*\w+\.id,\s*id\s*\)\s*\)/.test(body);
    const scoped = /organizationId|userId/.test(body);
    if (isWrite && bareId && !scoped) out.push(name);
    name = null;
    buf = [];
  };

  for (const l of lines) {
    const m = l.match(/^export async function (\w+)\(/);
    if (m) { flush(); name = m[1]; }
    if (name) {
      buf.push(l);
      // End the body at its closing brace rather than at the next function.
      // Without this, everything between one function and the next — blank
      // lines, and crucially the NEXT function's doc comment — is attributed to
      // the previous one. A comment that happens to mention `userId` or
      // `organizationId` then makes an unscoped mutator read as scoped, which is
      // a false NEGATIVE in a test whose whole job is catching those.
      if (l === "}") flush();
    }
  }
  flush();
  return out;
}

describe("tenancy ratchet — no new unscoped id-keyed writes", () => {
  const source = fs.readFileSync("server/db.ts", "utf8");

  it("every id-keyed mutator is either org-scoped or explicitly allow-listed", () => {
    const unscoped = findUnscopedIdWrites(source);
    const unexpected = unscoped.filter((fn) => !(fn in ALLOWED));
    expect(
      unexpected,
      `Unscoped id-keyed write(s) found in server/db.ts: ${unexpected.join(", ")}.\n` +
        "Add organizationId to the WHERE clause, or allow-list it with a reason.",
    ).toEqual([]);
  });

  it("the allow-list has not gone stale", () => {
    // An entry that no longer matches is either fixed (remove it) or renamed
    // (update it). Either way the list should not silently rot.
    const unscoped = new Set(findUnscopedIdWrites(source));
    const stale = Object.keys(ALLOWED).filter((fn) => !unscoped.has(fn));
    expect(
      stale,
      `Allow-listed but no longer unscoped (remove from ALLOWED): ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("every allow-list entry carries a justification", () => {
    for (const [fn, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${fn} needs a real reason`).toBeGreaterThan(20);
    }
  });

  // Guards the detector itself: if the regex stopped matching anything, the
  // ratchet would pass vacuously forever.
  it("the detector still recognises the vulnerable shape", () => {
    const sample = `
export async function updateThing(id: number, data: Partial<Thing>) {
  const db = await getDb();
  await db.update(things).set(data).where(eq(things.id, id));
}`;
    expect(findUnscopedIdWrites(sample)).toEqual(["updateThing"]);
  });

  it("the detector accepts an org-scoped write", () => {
    const sample = `
export async function updateThing(id: number, organizationId: number, data: Partial<Thing>) {
  const db = await getDb();
  await db.update(things).set(data)
    .where(and(eq(things.id, id), eq(things.organizationId, organizationId)));
}`;
    expect(findUnscopedIdWrites(sample)).toEqual([]);
  });
});
