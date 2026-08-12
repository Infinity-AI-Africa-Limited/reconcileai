/**
 * Read-path tenancy ratchet.
 *
 * The existing ratchets guard the other half of the problem: `tenancyRatchet`
 * covers id-keyed WRITES in db.ts, `rlsAudit` covers table classification.
 * Neither notices a SELECT that simply omits the organization predicate — which
 * is why `getTransactions` and `getAuditLogs` each survived four tenancy
 * hardening PRs (#25/#31/#32/#34) returning every tenant's rows.
 *
 * The exact shape both had:
 *
 *     const conditions = [];
 *     if (filters.x) conditions.push(...)          // all optional
 *     const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
 *     db.select().from(t).where(whereClause)       // undefined => NO WHERE
 *
 * With no filters supplied the predicate vanishes entirely and the query
 * returns the whole table. `channelScope()` in the same file carries a comment
 * warning about precisely this, which is what makes it worth asserting rather
 * than re-reviewing by eye.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DB_SOURCE = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");

describe("no read path may build a vanishing WHERE clause", () => {
  /**
   * Functions still using the pattern, each with a reason it cannot be fixed
   * yet. Keep this list SHORT — every entry is a table whose reads are
   * unscoped.
   */
  // Empty, and it should stay that way. `getExceptions` was the last entry —
  // exempt only because `exceptions` had no organizationId column. Migration
  // 0078 added it, so the read is scoped like every other and the exemption is
  // deleted rather than re-worded.
  const ALLOWED: Record<string, string> = {};

  it("db.ts contains no unaccounted `: undefined` where-clause fallback", () => {
    const VANISHING = /const whereClause = conditions\.length > 0 \? and\(\.\.\.conditions\) : undefined;/g;

    // Attribute each occurrence to its enclosing `export async function`.
    const offenders: string[] = [];
    for (const match of DB_SOURCE.matchAll(VANISHING)) {
      const before = DB_SOURCE.slice(0, match.index);
      const fnMatches = [...before.matchAll(/export async function (\w+)/g)];
      const fnName = fnMatches.length > 0 ? fnMatches[fnMatches.length - 1][1] : "<unknown>";
      if (!ALLOWED[fnName]) offenders.push(fnName);
    }

    expect(
      offenders,
      `These read paths build a WHERE that disappears when no filter is supplied, ` +
        `returning every tenant's rows: ${offenders.join(", ")}. ` +
        `Add an unconditional organization predicate (see getTransactions), or add the ` +
        `function to ALLOWED with a reason.`,
    ).toEqual([]);
  });

  it("the allow-list is empty and every entry added later carries a reason", () => {
    // Empty is the goal state, reached in migration 0078. This is not a
    // prohibition on ever adding one — it is a requirement that doing so is
    // deliberate and explained, since each entry is a table whose reads are
    // unscoped.
    for (const [fn, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `ALLOWED["${fn}"] needs a real reason`).toBeGreaterThan(30);
    }
    expect(Object.keys(ALLOWED)).toEqual([]);
  });

  it("scans a non-empty db.ts, so the sweep cannot pass vacuously", () => {
    // Guards against the file being moved or the read failing silently.
    expect(DB_SOURCE.length).toBeGreaterThan(1000);
    expect(DB_SOURCE).toMatch(/export async function getExceptions/);
  });
});

/**
 * The second way a WHERE clause vanishes, which the sweep above does not model.
 *
 * `getDashboardStats` leaked every tenant's totals on the main dashboard for as
 * long as it existed, and passed both existing ratchets, because it used neither
 * guarded shape. It did two other things instead:
 *
 *     const jobCondition = !isAdmin ? eq(jobs.userId, userId) : undefined;
 *     db.select({...}).from(reconciliationJobs).where(jobCondition)   // admin => no WHERE
 *     db.select({...}).from(exceptions)                               // no .where() at all
 *
 * The first is the `: undefined` fallback wearing a ternary instead of a
 * `conditions.length` check; the second omits the predicate outright. Both are
 * asserted here against the tenant-scoped tables, so the next one is a test
 * failure rather than a production incident.
 */
describe("no SELECT on a tenant-scoped table may omit its predicate", () => {
  /** Tables whose rows belong to exactly one tenant. */
  const TENANT_TABLES = [
    "transactions",
    "exceptions",
    "matches",
    "reconciliationJobs",
    "reconciliationReports",
    "dashboardStatsCache",
    "auditLogs",
    "uploadBatches",
    "apiKeys",
    "sftpCredentials",
  ];

  /** Every `db.select(...)....;` statement in db.ts, with its enclosing function. */
  function selectStatements(): Array<{ fn: string; stmt: string }> {
    const out: Array<{ fn: string; stmt: string }> = [];
    for (const m of DB_SOURCE.matchAll(/\bdb\s*\.\s*select(?:Distinct)?\s*\(/g)) {
      const end = DB_SOURCE.indexOf(";", m.index);
      if (end === -1) continue;
      const before = DB_SOURCE.slice(0, m.index);
      const fns = [...before.matchAll(/export async function (\w+)/g)];
      out.push({
        fn: fns.length > 0 ? fns[fns.length - 1][1] : "<module scope>",
        stmt: DB_SOURCE.slice(m.index, end),
      });
    }
    return out;
  }

  /**
   * Reads that legitimately span tenants. Each is named so adding one is a
   * decision, and each function name already says it crosses tenants.
   */
  const CROSS_TENANT_READS = new Set([
    "getAllChannelsAcrossTenants",
    "getTransactionsByIdsUnscoped",
  ]);

  it("every select from a tenant-scoped table has a .where()", () => {
    const offenders = selectStatements()
      .filter(({ fn }) => !CROSS_TENANT_READS.has(fn))
      .filter(({ stmt }) => TENANT_TABLES.some((t) => new RegExp(`\\.from\\(\\s*${t}\\s*\\)`).test(stmt)))
      .filter(({ stmt }) => !/\.where\s*\(/.test(stmt))
      .map(({ fn }) => fn);

    expect(
      [...new Set(offenders)],
      "These read a tenant-scoped table with no WHERE at all, so they return every " +
        "tenant's rows. Add an orgFilter(<table>.organizationId, organizationId) predicate.",
    ).toEqual([]);
  });

  it("no condition passed to .where() is a ternary that can be undefined", () => {
    // `const x = cond ? eq(...) : undefined;` then `.where(x)` — drizzle treats
    // an undefined predicate as no predicate.
    const offenders: string[] = [];
    for (const m of DB_SOURCE.matchAll(/const (\w+) = [^;]*\?[^;]*:\s*undefined;/g)) {
      const name = m[1];
      const before = DB_SOURCE.slice(0, m.index);
      const fns = [...before.matchAll(/export async function (\w+)/g)];
      const fn = fns.length > 0 ? fns[fns.length - 1][1] : "<module scope>";
      if (new RegExp(`\\.where\\(\\s*${name}\\s*\\)`).test(DB_SOURCE)) offenders.push(`${fn} (${name})`);
    }
    expect(
      offenders,
      "A `cond ? predicate : undefined` variable is passed to .where(). When the " +
        "ternary takes the undefined branch the query loses its WHERE entirely.",
    ).toEqual([]);
  });

  it("getDashboardStats is scoped by organization, not by user+isAdmin", () => {
    // Pinned by name: this is the function the rule was written for. Its old
    // signature made `isAdmin` suppress the only predicate it had, so every bank
    // administrator counted every tenant's rows.
    expect(DB_SOURCE).toContain("export async function getDashboardStats(organizationId: number | null)");
    const body = DB_SOURCE.slice(
      DB_SOURCE.indexOf("export async function getDashboardStats("),
      DB_SOURCE.indexOf("export async function invalidateDashboardStatsCache("),
    );
    expect(body).toMatch(/orgFilter\(transactions\.organizationId/);
    expect(body).toMatch(/orgFilter\(exceptions\.organizationId/);
    expect(body).toMatch(/orgFilter\(reconciliationJobs\.organizationId/);
    expect(body).toMatch(/orgFilter\(dashboardStatsCache\.organizationId/);
    expect(body, "isAdmin must not gate tenancy").not.toContain("isAdmin");
  });

  it("invalidateDashboardStatsCache deletes only the caller's tenant row", () => {
    const body = DB_SOURCE.slice(DB_SOURCE.indexOf("export async function invalidateDashboardStatsCache(")).slice(0, 600);
    expect(body).toContain("organizationId: number | null");
    expect(body).toMatch(/\.delete\(dashboardStatsCache\)\.where\(/);
  });
});

describe("exceptions and matches are scoped by their own organizationId", () => {
  // Migration 0078 gave both tables the column. These assertions are what stop
  // the pre-0078 shape — "derived via the parent job" — from creeping back.
  it("getExceptions requires an organizationId", () => {
    const sig = DB_SOURCE.slice(DB_SOURCE.indexOf("export async function getExceptions(filters: {")).slice(0, 300);
    expect(sig).toContain("organizationId: number | null;");
    expect(sig).not.toContain("organizationId?:");
  });

  it("the id-keyed mutators filter on organizationId, not a bare id", () => {
    for (const fn of ["updateMatchStatus", "updateException"]) {
      const body = DB_SOURCE.slice(DB_SOURCE.indexOf(`export async function ${fn}(`)).slice(0, 900);
      expect(body, `${fn} must take an organizationId`).toContain("organizationId: number | null");
      expect(body, `${fn} must AND it into the WHERE`).toMatch(/orgFilter\(/);
    }
  });

  it("getPendingReviewMatches no longer returns every tenant's review queue", () => {
    const body = DB_SOURCE.slice(DB_SOURCE.indexOf("export async function getPendingReviewMatches(")).slice(0, 600);
    expect(body).toMatch(/orgFilter\(matches\.organizationId/);
  });
});

describe("tenant-scoped readers require an organization", () => {
  // Required, not optional-with-a-default: the compiler then forces every call
  // site to state its tenant instead of inheriting a silent one. That is what
  // surfaced all 12 unscoped call sites when the parameter was introduced.
  for (const fn of ["getTransactions", "getAuditLogs"]) {
    it(`${fn} takes a required organizationId`, () => {
      const signature = DB_SOURCE.slice(
        DB_SOURCE.indexOf(`export async function ${fn}(filters: {`),
      ).slice(0, 400);
      expect(signature).toContain("organizationId: number | null;");
      // `organizationId?:` would make it optional and reopen the hole.
      expect(signature).not.toContain("organizationId?:");
    });
  }

  it("getTransactionsByIds takes a required organizationId", () => {
    expect(DB_SOURCE).toContain(
      "export async function getTransactionsByIds(ids: number[], organizationId: number | null)",
    );
  });

  it("getTransactionsByIds applies the org predicate inside the batch query", () => {
    const body = DB_SOURCE.slice(
      DB_SOURCE.indexOf("export async function getTransactionsByIds("),
      DB_SOURCE.indexOf("export async function getTransactionsByIdsUnscoped("),
    );
    // Filtering the assembled results instead would still fetch every foreign
    // row, and one dropped `.filter()` would restore the leak.
    expect(body).toMatch(/\.where\(and\(inArray\(transactions\.id, batch\), orgPredicate\)\)/);
  });
});

/**
 * The unscoped by-id reader is allowed to exist, but only just.
 *
 * It is legitimate ONLY where the ids were derived server-side, in the same
 * cycle, from a parent the process owns. That is a property of the CALL SITES,
 * not of the function, so the count is pinned: a third call site is a decision
 * someone must make deliberately rather than by autocomplete.
 */
describe("getTransactionsByIdsUnscoped stays confined to the engine", () => {
  const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

  it("is named so the missing scoping is visible at the call site", () => {
    expect(DB_SOURCE).toContain("export async function getTransactionsByIdsUnscoped(ids: number[])");
  });

  it("has exactly the two known internal call sites", () => {
    const uses = [...ROUTERS.matchAll(/getTransactionsByIdsUnscoped\(/g)].length;
    expect(
      uses,
      "A new caller of getTransactionsByIdsUnscoped appeared. This function applies NO " +
        "tenancy filter. It is only valid when the ids were derived server-side from a row " +
        "the process already owns — never from request input. If the ids come from a tRPC " +
        "input, use getTransactionsByIds(ids, organizationId) instead.",
    ).toBe(2);
  });

  it("is not reachable from any tRPC input path", () => {
    // Cheap proxy for the real rule: the unscoped reader must never be handed
    // `input.` anything.
    expect(ROUTERS).not.toMatch(/getTransactionsByIdsUnscoped\(\s*(\[\s*)?input\./);
  });
});
