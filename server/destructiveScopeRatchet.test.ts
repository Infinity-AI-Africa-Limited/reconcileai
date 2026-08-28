/**
 * A destructive statement on a tenant table must be scoped to ONE tenant.
 *
 * `readScopeRatchet` exists for exactly this class and did not catch it, for two
 * reasons worth stating rather than quietly fixing:
 *
 *   1. It scans `db.ts` ONLY. `wipeDemoData` lives in `demoSeedEngine.ts`, so
 *      its unfiltered `db.select().from(distributors)` — every distributor row
 *      in the database — was invisible to it.
 *   2. It asks whether a statement has a `.where()`, not whether that WHERE
 *      scopes to a tenant. `where(eq(uploadBatches.userId, userId))` passes,
 *      and that predicate spans every organisation the user ever seeded.
 *
 * The cost was real: a wipe run against one tenant deleted a freshly seeded
 * Corporate B2B dataset — 2,000 transactions, 15 distributors, 50 exceptions —
 * out of a different organisation. The agent-memory and channel deletes in the
 * same function were already org-scoped and their rows survived, which is what
 * made the cause legible.
 *
 * So this ratchet asks the harder question, across the whole server: for every
 * DELETE on a tenant-scoped table, is the row set it removes provably confined
 * to one tenant?
 *
 * A delete by a DERIVED id (`jobId`, `batchId`, a row id) is legitimate — that
 * is how `matches` and `exceptions` are reached at all, since neither carries an
 * organizationId (CLAUDE.md §19.3). But it is only safe if the id set came from
 * a tenant-scoped query, which a regex cannot see. So each such site is listed
 * here with the derivation that makes it safe, and adding one is a decision
 * somebody writes down.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SERVER = __dirname;

/** Tables whose rows belong to exactly one tenant. Keep WIDE. */
const TENANT_TABLES = [
  "transactions", "exceptions", "matches", "reconciliationJobs", "uploadBatches",
  "distributors", "channels", "agentMemory", "resolutionTemplates", "anomalyScores",
  "detectionRules", "apiKeys", "sftpCredentials", "scheduledTasks",
  "reconciliationReports", "webhooks", "cfoReportSchedules",
];

/**
 * Deletes whose row set is confined to one tenant by a DERIVED id rather than by
 * an `organizationId` predicate in the statement itself. The value is the
 * derivation that makes it safe — check it, do not take it on trust.
 */
const DERIVED_ID_DELETES: Record<string, string> = {
  "demoSeedEngine.ts": "jobId/batchId/row ids derived from selects that now carry orgFilter(...); agentMemory and channels scope in-statement",
  "demoSeedFinServ.ts": "exceptionIds/jobIds/batchIds derived from selects carrying orgFilter(uploadBatches.organizationId, organizationId)",
  "reconciliationQueue.ts": "matches.jobId for the job being re-run; the job is loaded tenant-scoped before the reset",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

type Site = { file: string; line: number; table: string; stmt: string };

function deleteSites(): Site[] {
  const out: Site[] = [];
  for (const file of walk(SERVER)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:db|tx|executor)\s*\.\s*delete\s*\(\s*(\w+)\s*\)/g)) {
      const table = m[1];
      if (!TENANT_TABLES.includes(table)) continue;
      const at = m.index ?? 0;
      const end = src.indexOf(";", at);
      out.push({
        file: path.relative(SERVER, file).split(path.sep).join("/"),
        line: src.slice(0, at).split("\n").length,
        table,
        stmt: src.slice(at, end === -1 ? at + 400 : end),
      });
    }
  }
  return out;
}

describe("every destructive statement on a tenant table is confined to one tenant", () => {
  it("scopes in the statement, or is listed with the derivation that makes it safe", () => {
    const offenders = deleteSites()
      .filter((s) => !/organizationId/.test(s.stmt))
      .filter((s) => !(s.file in DERIVED_ID_DELETES))
      .map((s) => `${s.file}:${s.line} deletes ${s.table} with no organizationId predicate`);

    expect(
      offenders,
      "A delete on a tenant-scoped table must either carry an organizationId " +
        "predicate, or be listed in DERIVED_ID_DELETES with the derivation that " +
        "confines its id set to one tenant.",
    ).toEqual([]);
  });

  /**
   * The specific regression. `wipeDemoData` reads three row sets before deleting
   * them, and all three were unscoped; two filtered on `userId`, which spans
   * every organisation that user seeded, and one filtered on nothing at all.
   */
  it("builds every wipeDemoData row set from a tenant-scoped read", () => {
    const src = fs.readFileSync(path.join(SERVER, "demoSeedEngine.ts"), "utf8");
    const start = src.indexOf("export async function wipeDemoData");
    expect(start, "wipeDemoData not found — update this ratchet").toBeGreaterThan(-1);
    // To the next top-level export, or end of file. Slicing at the first nested
    // closing brace stops before the reads this checks.
    const nextExport = src.indexOf(String.fromCharCode(10) + "export ", start + 1);
    const body = src.slice(start, nextExport === -1 ? undefined : nextExport);

    for (const table of ["uploadBatches", "reconciliationJobs", "distributors"]) {
      // indexOf, not a regex: a backslash-escaped pattern written through a
      // heredoc collapses inside a template literal, and the silently-broken
      // regex then matches nothing and the ratchet passes vacuously.
      const at = body.indexOf("from(" + table + ")");
      expect(at, `wipeDemoData no longer reads ${table} — update this ratchet`).toBeGreaterThan(-1);
      const read = body.slice(at, at + 240);
      expect(
        read.includes("orgFilter") || read.includes("organizationId"),
        `wipeDemoData reads ${table} without a tenant predicate, so a wipe in one ` +
          `organisation deletes another's rows`,
      ).toBe(true);
    }
  });

  it("still scopes the two that were already correct, so the fix did not trade one for another", () => {
    const src = fs.readFileSync(path.join(SERVER, "demoSeedEngine.ts"), "utf8");
    expect(src).toContain("eq(agentMemory.organizationId, orgId)");
    expect(src).toContain("`${code}_ORG${orgId}`");
  });
});
