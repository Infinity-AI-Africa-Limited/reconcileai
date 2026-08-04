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
  const ALLOWED: Record<string, string> = {
    getExceptions:
      "the `exceptions` table has NO organizationId column — scoped only via its parent job. " +
      "Adding the column is tracked as finding F1 in docs/security/RLS_AUDIT.md and CLAUDE.md §19.3; " +
      "this entry must be removed once that lands.",
  };

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

  it("still finds the allow-listed function, so the scan cannot silently pass", () => {
    // If getExceptions is ever renamed or refactored away, this fails and the
    // stale ALLOWED entry gets cleaned up rather than quietly protecting nothing.
    expect(DB_SOURCE).toMatch(/export async function getExceptions/);
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
