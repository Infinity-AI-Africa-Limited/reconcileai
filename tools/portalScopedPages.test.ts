/**
 * Pages that follow the super-admin portal must pass `viewAsOrgId` to every
 * tenant-scoped query they make.
 *
 * "Enter Portal" is client state; the server only learns which tenant is on
 * screen when a query passes `viewAsOrgId`. The same defect has now been found
 * THREE times: six sections in PR #133, then Age Tracker and Distributor
 * Registry, each reading Infinity AI's own (empty) organisation inside a
 * tenant's portal and rendering nothing. Every round was a page where one query
 * was forgotten. This makes forgetting fail CI for the pages already fixed.
 *
 * ── What this does NOT yet cover — stated so nobody reads it as more ─────
 *
 *   - Pages not listed below. A scan on 2026-09-21 found roughly fifty
 *     unscoped query call sites across portal-visible pages — Multi-Channel,
 *     Dashboard's distributor card, Audit Trail, Monitor, CBN Reports, Data
 *     Protection and more. They are a known open item, not a pass.
 *   - Mutations. Row-targeted actions on these pages (exceptions.resolve and
 *     friends) still act on the signed-in organisation and are a separate,
 *     known gap.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Pages that follow the portal, and the queries on them that legitimately do not. */
const PORTAL_PAGES: Record<string, string[]> = {
  "client/src/pages/Reconciliation.tsx": [
    // Row-targeted: the job names its own tenant, and the server derives the
    // tenant from the row (canActOnTenant), so no portal id is needed.
    "reconciliation.get",
  ],
  "client/src/pages/Reports.tsx": [],
  "client/src/pages/ExceptionIntelligence.tsx": [],
  "client/src/pages/Exceptions.tsx": [],
  "client/src/pages/ReviewQueue.tsx": [],
  "client/src/pages/Transactions.tsx": [],
  "client/src/pages/AgeTracker.tsx": [],
  "client/src/pages/DistributorRegistry.tsx": [],
  "client/src/components/HiddenExceptionsNotice.tsx": [],
};

/**
 * A source file with line endings normalised. The definition check below keys on
 * a semicolon followed by a newline, and a Windows checkout with core.autocrlf is
 * CRLF — so the verdict could depend on how the file was checked out rather than
 * on the code.
 */
function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
}

/** Every `trpc.<router>.<proc>.useQuery(<args>)` with its full argument text. */
function queries(src: string): { proc: string; args: string }[] {
  const out: { proc: string; args: string }[] = [];
  const re = /trpc\.([a-zA-Z]+)\.([a-zA-Z]+)\.useQuery\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push({ proc: `${m[1]}.${m[2]}`, args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/**
 * Does this argument carry the portal id — directly, or through a local it
 * names (Transactions builds `queryInput` in a useMemo)?
 */
function carriesPortalId(args: string, src: string): boolean {
  if (/\bviewAsOrgId\b/.test(args)) return true;
  const ident = args.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
  if (!ident) return false;
  const def = src.match(new RegExp(`const ${ident}\\s*=([\\s\\S]{0,600}?);\\n`));
  if (!def) return false;
  // Look at the value only, NOT a useMemo dependency array. The first version
  // tested the whole definition, and `[filters, page, viewAsOrgId]` kept the
  // check green after viewAsOrgId was removed from the object itself — a
  // vacuous pass, caught by breaking it on purpose.
  const value = def[1].replace(/\)\s*,\s*\[[^\]]*\]\s*\)\s*$/, ")");
  return /\bviewAsOrgId\b/.test(value);
}

describe("when a page follows the super-admin portal", () => {
  for (const [file, allowed] of Object.entries(PORTAL_PAGES)) {
    it(`should pass viewAsOrgId to every tenant query in ${path.basename(file)}`, () => {
      const src = read(file);
      const found = queries(src);
      expect(found.length, `${file} has no queries — has it moved?`).toBeGreaterThan(0);
      const unscoped = found
        .filter((q) => !allowed.includes(q.proc) && !carriesPortalId(q.args, src))
        .map((q) => q.proc);
      expect(
        unscoped,
        `${file}: these queries answer for the SIGNED-IN organisation, so inside a ` +
          `tenant portal they read Infinity AI's own (empty) data. Pass viewAsOrgId.`,
      ).toEqual([]);
    });
  }

  it("should only exempt queries that exist, so a stale exemption cannot hide a new one", () => {
    for (const [file, allowed] of Object.entries(PORTAL_PAGES)) {
      const procs = queries(read(file)).map((q) => q.proc);
      for (const a of allowed) expect(procs, `${file} exempts ${a}, which it no longer calls`).toContain(a);
    }
  });
});
