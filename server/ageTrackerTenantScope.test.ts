import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Age Tracker tenant scope", () => {
  // Line endings normalised. On a Windows checkout with core.autocrlf the sources
  // are CRLF, so a block boundary written with LF never matched: the Age Tracker
  // block silently became "everything to end of file", and these assertions
  // judged the whole router. They must judge the code, not how it was checked out.
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const dbSource = read("server/db.ts");
  const routerSource = read("server/routers.ts");

  it("requires an organization id for aged-exception reads and applies it in SQL", () => {
    expect(dbSource).toContain("getOpenExceptionsForAging(organizationId: number | null");
    expect(dbSource).toContain("orgFilter(exceptions.organizationId, organizationId)");
  });

  it("passes a tenant into summary, list and bulk escalation flows", () => {
    // Originally pinned `getOpenExceptionsForAging(ctx.user.organizationId ?? null)`
    // three times. The tracker now answers for the tenant ON SCREEN, so staff
    // inside a portal age that tenant's queue instead of Infinity AI's empty
    // one. The property this test exists for is unchanged — no aging read runs
    // without a tenant — and it is asserted below more strictly than before.
    expect(routerSource.split("getOpenExceptionsForAging(tenant)")).toHaveLength(4);
    expect(routerSource).not.toContain("getOpenExceptionsForAging();");
  });

  it("derives that tenant from the one portal gate, and never from the raw column", () => {
    // `tenant` must come from portalScopedOrgId — the single function whose
    // super-admin-only override is tested in portalScope.test.ts — not from a
    // client field used directly, and not from ctx.user.organizationId read in
    // some flows and not others.
    const start = routerSource.indexOf("  ageTracker: router({");
    const end = routerSource.indexOf("\n  }),\n", start);
    const block = routerSource.slice(start, end);
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain("ctx.user.organizationId");
    const derivations = block.match(/const tenant = portalScopedOrgId\(ctx\.user, input\??\.viewAsOrgId\);/g) ?? [];
    expect(derivations.length).toBeGreaterThanOrEqual(3);
    // Every aging read in the whole router file goes through `tenant`: no other
    // argument form may appear.
    const calls = routerSource.match(/getOpenExceptionsForAging\(([^)]*)\)/g) ?? [];
    expect(calls.every((c) => c === "getOpenExceptionsForAging(tenant)"), calls.join(" | ")).toBe(true);
  });

  it("files every Age Tracker audit record under the tenant it changed", () => {
    // logAudit with no organisation writes to the GLOBAL chain, and a tenant's
    // Audit Trail selects `organizationId = tenant` exactly — so an escalation
    // made inside a tenant's portal changed that tenant and appeared in no
    // tenant's trail, export or chain verification.
    const start = routerSource.indexOf("  ageTracker: router({");
    const block = routerSource.slice(start, routerSource.indexOf("\n  }),\n", start));
    const audits = block.match(/await logAudit\([^;]*\);/g) ?? [];
    expect(audits.length).toBe(3);
    for (const a of audits) {
      expect(a, "an Age Tracker audit record omits its tenant").toMatch(/,\s*(tenant|orgId \|\| null)\)\s*;$/);
    }
  });
});
