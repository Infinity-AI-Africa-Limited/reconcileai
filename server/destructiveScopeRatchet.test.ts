/**
 * A destructive statement on a tenant table must be confined to ONE tenant.
 *
 * `readScopeRatchet` exists for exactly this class and did not catch the defect
 * this file was written for, for two reasons worth stating rather than quietly
 * fixing:
 *
 *   1. It scans `db.ts` ONLY. `wipeDemoData` lives in `demoSeedEngine.ts`, so
 *      its unfiltered `db.select().from(distributors)` — every distributor row
 *      in the database — was invisible to it.
 *   2. It asks whether a statement has a `.where()`, not whether that WHERE
 *      scopes to a tenant. `where(eq(uploadBatches.userId, userId))` passes, and
 *      that predicate spans every organisation the user ever seeded.
 *
 * The cost was real: a wipe run against one tenant deleted a freshly seeded
 * Corporate B2B dataset — 2,000 transactions, 15 distributors, 50 exceptions —
 * out of a different organisation. The agent-memory and channel deletes in the
 * same function were already org-scoped and their rows survived, which is what
 * made the cause legible.
 *
 * A delete by a DERIVED id (`jobId`, `batchId`, a row id) is legitimate — it is
 * how `matches` and `exceptions` are reached at all, since neither carries an
 * organizationId (CLAUDE.md §19.3). But it is only safe if the id set came from
 * a tenant-scoped query, which no regex can see, so each such SITE is listed
 * with the derivation that makes it safe.
 *
 * Exemptions are keyed by file AND table, not by file. Keyed by file alone, an
 * unrelated unscoped delete added to an already-listed file would be exempt
 * automatically and this ratchet would stay green through the next regression —
 * which is the failure it exists to prevent, one level up.
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
 * Sites whose row set is confined to one tenant by a DERIVED id rather than by
 * an `organizationId` predicate in the statement itself.
 *
 * Keyed `file::table`. The value is the derivation that makes it safe — check
 * it, do not take it on trust.
 */
const DERIVED_ID_DELETES: Record<string, string> = {
  "demoSeedEngine.ts::exceptions": "exceptions.jobId from demoJobIds — jobs read with orgFilter(reconciliationJobs.organizationId, orgId)",
  "demoSeedEngine.ts::matches": "matches.jobId from the same orgFilter-scoped job read",
  "demoSeedEngine.ts::reconciliationJobs": "row ids from the same orgFilter-scoped job read",
  "demoSeedEngine.ts::transactions": "transactions.batchId from demoBatchIds — batches read with orgFilter(uploadBatches.organizationId, orgId)",
  "demoSeedEngine.ts::uploadBatches": "row ids from the same orgFilter-scoped batch read",
  "demoSeedEngine.ts::distributors": "row ids from a read carrying orgFilter(distributors.organizationId, orgId)",
  "demoSeedEngine.ts::agentMemory": "row ids from a read carrying eq(agentMemory.organizationId, orgId)",
  // Two sites, both scoped, neither by the literal word: one deletes the code
  // `<CODE>_ORG${orgId}`, which embeds the tenant; the other deletes only the
  // bare code where `isNull(channels.organizationId)`, i.e. org-less shared
  // rails, so one tenant still cannot remove another's.
  "demoSeedEngine.ts::channels": "channel code embeds _ORG${orgId}, or the delete is restricted to isNull(channels.organizationId)",
  "demoSeedFinServ.ts::exceptions": "exceptionIds derived from selects carrying orgFilter(...)",
  "demoSeedFinServ.ts::matches": "matches.jobId from jobIds derived with orgFilter(reconciliationJobs.organizationId, organizationId)",
  "demoSeedFinServ.ts::transactions": "transactions.batchId from batchIds derived with orgFilter(uploadBatches.organizationId, organizationId)",
  "demoSeedFinServ.ts::uploadBatches": "the same orgFilter-scoped batch ids",
  "demoSeedFinServ.ts::reconciliationJobs": "the same orgFilter-scoped job ids",
  "reconciliationQueue.ts::matches": "matches.jobId for the job being re-run; the job is loaded tenant-scoped before the reset",
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

/**
 * Strip comments before any predicate check.
 *
 * Without this, the prose explaining a tenancy fix satisfies the assertion that
 * the fix is present — so removing the predicate and leaving the comment would
 * keep this green. The comments in `wipeDemoData` say "organizationId" many
 * times over.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * `wipeDemoData`'s body alone.
 *
 * Every assertion about it is scoped here rather than to the file, because the
 * same predicate text lives in other functions: `seedMemoryLayer` carries two
 * copies of `eq(agentMemory.organizationId, orgId)`. A file-wide `toContain`
 * was therefore satisfied by a DIFFERENT function's correctness, and deleting
 * wipeDemoData's tenant scoping left the whole suite green — a ratchet passing
 * on evidence from the wrong place.
 */
function wipeDemoDataBody(): string {
  const src = fs.readFileSync(path.join(SERVER, "demoSeedEngine.ts"), "utf8");
  const start = src.indexOf("export async function wipeDemoData");
  expect(start, "wipeDemoData not found — update this ratchet").toBeGreaterThan(-1);
  const nextExport = src.indexOf(String.fromCharCode(10) + "export ", start + 1);
  return src.slice(start, nextExport === -1 ? undefined : nextExport);
}

type Site = { file: string; line: number; table: string; stmt: string; key: string };

function deleteSites(): Site[] {
  const out: Site[] = [];
  for (const file of walk(SERVER)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(SERVER, file).split(path.sep).join("/");
    for (const m of src.matchAll(/\b(?:db|tx|executor)\s*\.\s*delete\s*\(\s*(\w+)\s*\)/g)) {
      const table = m[1];
      if (!TENANT_TABLES.includes(table)) continue;
      const at = m.index ?? 0;
      const end = src.indexOf(";", at);
      out.push({
        file: rel,
        line: src.slice(0, at).split("\n").length,
        table,
        stmt: withoutComments(src.slice(at, end === -1 ? at + 400 : end)),
        key: `${path.basename(rel)}::${table}`,
      });
    }
  }
  return out;
}

describe("every destructive statement on a tenant table is confined to one tenant", () => {
  it("scopes in the statement, or is listed per SITE with the derivation that makes it safe", () => {
    const offenders = deleteSites()
      .filter((s) => !/organizationId/.test(s.stmt))
      .filter((s) => !(s.key in DERIVED_ID_DELETES))
      .map((s) => `${s.file}:${s.line} deletes ${s.table} with no organizationId predicate (key ${s.key})`);

    expect(
      offenders,
      "A delete on a tenant-scoped table must either carry an organizationId " +
        "predicate, or be listed in DERIVED_ID_DELETES under its own file::table " +
        "key with the derivation that confines its id set to one tenant.",
    ).toEqual([]);
  });

  it("carries no exemption for a site that no longer exists", () => {
    // A stale entry is a hole: it exempts a key a future delete could reoccupy
    // without anyone re-checking the derivation.
    const live = new Set(deleteSites().map((s) => s.key));
    const stale = Object.keys(DERIVED_ID_DELETES).filter((key) => !live.has(key));
    expect(stale, "remove these — the delete they exempted is gone").toEqual([]);
  });

  /**
   * The specific regression. `wipeDemoData` reads three row sets before deleting
   * them; all three were unscoped — two filtered on `userId`, which spans every
   * organisation that user seeded, and one filtered on nothing at all.
   *
   * The predicate is required in the STATEMENT, comments stripped. A byte window
   * around the read would let the prose explaining this very fix satisfy the
   * assertion after the fix itself had been removed.
   */
  it("builds every wipeDemoData row set from a tenant-scoped read", () => {
    const body = wipeDemoDataBody();

    // agentMemory is in this list even though it was already correct, because
    // the main ratchet EXEMPTS its delete (derived row ids), so this assertion
    // is the only thing guarding it. Checked the same way as the rest rather
    // than by a file-wide `toContain`, which is what made the earlier version
    // vacuous — `seedMemoryLayer` holds two copies of the same predicate text,
    // so deleting wipeDemoData's left every test green.
    for (const table of ["uploadBatches", "reconciliationJobs", "distributors", "agentMemory"]) {
      const at = body.indexOf("from(" + table + ")");
      expect(at, `wipeDemoData no longer reads ${table} — update this ratchet`).toBeGreaterThan(-1);
      const end = body.indexOf(";", at);
      expect(end, `unterminated read of ${table}`).toBeGreaterThan(at);
      const statement = withoutComments(body.slice(at, end));
      expect(
        statement.includes("orgFilter(") || statement.includes("organizationId"),
        `wipeDemoData reads ${table} without a tenant predicate, so a wipe in one ` +
          `organisation deletes another's rows. Statement: ${statement.trim()}`,
      ).toBe(true);
    }
  });

  it("scopes both channel deletes inside wipeDemoData, not merely somewhere in the file", () => {
    // Same trap as agentMemory: a file-wide search would be satisfied by the
    // seeder's own channel codes. Both deletes must scope WHERE THEY ARE — one
    // by embedding the tenant in the code, one by restricting to org-less rails.
    const body = withoutComments(wipeDemoDataBody());
    expect(body).toContain("_ORG${orgId}");
    expect(body).toContain("isNull(channels.organizationId)");
  });
});
