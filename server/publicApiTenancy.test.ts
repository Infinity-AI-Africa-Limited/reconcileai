/**
 * Tenancy scoping for channel access.
 *
 * `publicApi.uploadTransactions` takes a caller-supplied `channelId` over the
 * internet-facing API, authenticated only by an API key. An API key belongs to
 * exactly one organization, so without an ownership check an integration key
 * issued to one bank could push transactions straight into another bank's
 * channel — a cross-tenant WRITE on the most exposed surface in the platform.
 *
 * `channelScope` is the predicate every channel accessor must apply. It is
 * tested directly rather than through a mocked `getDb`: module mocking cannot
 * intercept a module's own internal `getDb()` call, so a test built that way
 * passes whether or not the filter is present — worse than no test.
 */
import { describe, it, expect } from "vitest";
import { channelScope } from "./db";

/**
 * Summarise a drizzle SQL fragment: the column names and SQL keywords it
 * references. Walks with a seen-set — drizzle's objects are cyclic (a column
 * points at its table, which points back), so JSON.stringify throws on them.
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
    // A drizzle column carries its own name; record it rather than recursing
    // into its table (which is what creates the cycle).
    if (typeof o.name === "string" && o.columnType) { parts.push(o.name); return; }
    for (const key of ["queryChunks", "value", "left", "right", "sql", "chunks"]) {
      if (key in o) walk(o[key], depth + 1);
    }
    if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
  };
  walk(fragment);
  return parts.join(" ");
}

describe("channelScope", () => {
  it("produces a predicate for a real organization", () => {
    const s = channelScope(7);
    expect(s).toBeDefined();
    expect(render(s)).toContain("organizationId");
  });

  // The important one. An earlier draft of this returned `undefined` for null,
  // which drizzle treats as "no WHERE clause" — silently handing an org-less
  // caller every tenant's channels, the exact bug being fixed.
  it("never returns undefined for a null organization", () => {
    const s = channelScope(null);
    expect(s).toBeDefined();
    expect(s).not.toBeUndefined();
  });

  it("restricts a null organization to the shared rails", () => {
    const rendered = render(channelScope(null));
    expect(rendered).toContain("organizationId");
    // Shared rails are the rows with a NULL organizationId.
    expect(rendered.toLowerCase()).toContain("null");
  });

  it("scopes different organizations to different predicates", () => {
    // Guards against a constant-folded predicate that ignores its argument.
    expect(render(channelScope(7))).not.toBe(render(channelScope(8)));
  });

  it("an org predicate differs from the shared-rails-only predicate", () => {
    expect(render(channelScope(7))).not.toBe(render(channelScope(null)));
  });
});
