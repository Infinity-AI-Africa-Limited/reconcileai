/**
 * Tenancy scoping for CBN deadline submissions.
 *
 * `cbnDeadlineSubmissions` records that an institution filed a given regulatory
 * return for a given period. Two queries against it were unscoped:
 *
 *   - `listDeadlineSubmissions` selected the whole table, so any authenticated
 *     user of any tenant read every institution's submission history, including
 *     the submitter's name and free-text notes.
 *   - the upsert inside `markDeadlineSubmitted` deleted by frameworkCode +
 *     periodLabel alone, so one bank recording "AML_CFT / May 2026" destroyed
 *     every other bank's record for that same framework and period.
 *
 * The delete is the worse of the two. CBN framework codes and period labels are
 * shared vocabulary — every institution files the same returns for the same
 * periods — so the collision happened during ordinary use rather than only under
 * attack, and what it destroyed was the evidence that a filing had been made.
 *
 * Tested through the predicate rather than a mocked `getDb`: module mocking
 * cannot intercept a module's own internal `getDb()` call, so a test built that
 * way passes whether or not the filter is present — worse than no test. Same
 * reasoning as publicApiTenancy.test.ts, which is where that lesson was learned.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deadlineSubmissionScope } from "./routers/cbnCompliance";

/**
 * Summarise a drizzle SQL fragment: the column names, SQL keywords and bound
 * values it references. Walks with a seen-set — drizzle's objects are cyclic (a
 * column points at its table, which points back), so JSON.stringify throws.
 */
function render(fragment: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth = 0): void => {
    if (v === null || v === undefined || depth > 8) return;
    if (typeof v === "string") { parts.push(v); return; }
    // Bound parameters carry the org id; without them two different orgs render
    // identically and the "different predicates" assertion proves nothing.
    if (typeof v === "number" || typeof v === "boolean") { parts.push(String(v)); return; }
    if (typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && o.columnType) { parts.push(o.name); return; }
    for (const key of ["queryChunks", "value", "left", "right", "sql", "chunks", "operator"]) {
      if (key in o) walk(o[key], depth + 1);
    }
    if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
  };
  walk(fragment);
  return parts.join(" ");
}

describe("when scoping CBN deadline submissions to a tenant", () => {
  it("should filter on organizationId for a real organization", () => {
    const scope = deadlineSubmissionScope(7);
    expect(scope).toBeDefined();
    expect(render(scope)).toContain("organizationId");
    expect(render(scope)).toContain("7");
  });

  it("should produce a different predicate for a different organization", () => {
    // If both rendered identically, the org id is not reaching the query and
    // every tenant would share one predicate.
    expect(render(deadlineSubmissionScope(7))).not.toBe(render(deadlineSubmissionScope(8)));
  });

  it("should never return undefined for an org-less caller", () => {
    // The important one. Drizzle treats an undefined WHERE as "no filter", which
    // is exactly the unscoped SELECT and unscoped DELETE being fixed here —
    // failing open on missing data is how one tenant reaches another's rows.
    const scope = deadlineSubmissionScope(null);
    expect(scope).toBeDefined();
    expect(render(scope)).toContain("organizationId");
  });

  it("should use IS NULL rather than = NULL for an org-less caller", () => {
    // Rows are inserted with the caller's organizationId verbatim, so an org-less
    // caller's own rows hold NULL. `= NULL` matches nothing in SQL, which would
    // make their upsert insert a duplicate on every save instead of replacing.
    expect(render(deadlineSubmissionScope(null)).toLowerCase()).toContain("null");
  });

  it("should treat undefined the same as null", () => {
    expect(render(deadlineSubmissionScope(undefined))).toBe(render(deadlineSubmissionScope(null)));
  });
});

describe("when the deadline queries are wired up", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "routers", "cbnCompliance.ts"), "utf8");

  /**
   * Source between two anchors, so "the scope is applied HERE" is checkable. A
   * missing anchor fails rather than yielding an empty slice — otherwise moving
   * a procedure would leave these passing against source that no longer contains
   * it, which is a green ratchet guarding nothing.
   */
  function between(startAnchor: string, endAnchor: string): string {
    const start = SOURCE.indexOf(startAnchor);
    expect(start, `anchor missing: ${startAnchor}`).toBeGreaterThan(-1);
    const end = SOURCE.indexOf(endAnchor, start);
    expect(end, `anchor missing after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("should scope the read", () => {
    expect(between("listDeadlineSubmissions:", ".orderBy(")).toContain("deadlineSubmissionScope(ctx.user.organizationId)");
  });

  it("should scope the upsert's delete", () => {
    // The delete must carry the org predicate INSIDE its where clause, next to
    // frameworkCode and periodLabel — not merely somewhere in the procedure.
    const del = between("db.delete(cbnDeadlineSubmissions)", "db.insert(cbnDeadlineSubmissions)");
    expect(del).toContain("deadlineSubmissionScope(ctx.user.organizationId)");
    expect(del).toContain("frameworkCode");
    expect(del).toContain("periodLabel");
  });
});
