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

  it("should never produce an undefined filter", () => {
    // Drizzle treats an undefined WHERE as "no filter", which is exactly the
    // unscoped SELECT and unscoped DELETE being fixed here — failing open is how
    // one tenant reaches another's rows.
    expect(deadlineSubmissionScope(1)).toBeDefined();
  });

  it("should not accept an org-less caller at all", () => {
    // The signature takes a required number, so null cannot reach the predicate.
    // An earlier revision accepted null and mapped it to IS NULL: safe against
    // the original bug, but it pooled every account without an organisation into
    // one shared pseudo-tenant that could read and overwrite each other's
    // filings. 21 non-guest accounts currently have a null organizationId, so
    // that was a live grouping, not a hypothetical one. Callers refuse instead.
    // @ts-expect-error null is not an organisation
    expect(() => deadlineSubmissionScope(null)).toBeDefined();
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
    expect(between("listDeadlineSubmissions:", ".orderBy(")).toContain("deadlineSubmissionScope(organizationId)");
  });

  it("should scope the upsert's delete", () => {
    // The delete must carry the org predicate INSIDE its where clause, next to
    // frameworkCode and periodLabel — not merely somewhere in the procedure.
    const del = between("db.delete(cbnDeadlineSubmissions)", "db.insert(cbnDeadlineSubmissions)");
    expect(del).toContain("deadlineSubmissionScope(organizationId)");
    expect(del).toContain("frameworkCode");
    expect(del).toContain("periodLabel");
  });

  it("should refuse an org-less caller on both procedures", () => {
    // Without these, an org-less caller falls back to whatever the predicate does
    // with null — which is how the shared pseudo-tenant appears.
    expect(between("listDeadlineSubmissions:", ".orderBy(")).toContain("organizationId == null");
    expect(between("markDeadlineSubmitted:", "db.delete(cbnDeadlineSubmissions)")).toContain("PRECONDITION_FAILED");
  });

  it("should write the same organisation it filters on", () => {
    // The insert previously wrote `ctx.user.organizationId ?? null`. If the write
    // and the scope disagree, a row can be created that its own author cannot
    // read back — and the upsert stops replacing, silently duplicating instead.
    const ins = between("db.insert(cbnDeadlineSubmissions)", "writeAuditLog");
    expect(ins).toContain("organizationId,");
    expect(ins).not.toContain("organizationId: ctx.user.organizationId ?? null");
  });
});
