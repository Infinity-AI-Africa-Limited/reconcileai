/**
 * Which verticals may reach the CBN reporting and distributor-registry surfaces.
 *
 * Both were hidden in the client and open on the server: `DashboardLayout` hides
 * the Auditor role from retail and `AuditorDashboard` redirects it away, but
 * `dashboard.auditorCompliance`, `dashboard.auditorTrail`, all of
 * `cbnCompliance.*` and all of `distributor.*` were plain `protectedProcedure`.
 * A hidden nav entry in front of an open procedure is not a boundary.
 *
 * The rule lives in shared/ so the client's hiding and the server's refusal
 * cannot disagree — same reasoning as shared/moduleScope.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  featureAppliesTo,
  featureUnavailableReason,
  ALL_VERTICAL_FEATURES,
} from "../shared/verticalFeatures";
import { appRouter } from "./routers";

/** A caller with no organisation — the case the guard has to refuse. */
function orgLessCaller() {
  return appRouter.createCaller({
    user: { id: 9001, openId: "orgless_test", name: "T", email: "t@t.com", role: "user", organizationId: null, isGuest: false },
    req: { headers: {}, ip: "127.0.0.1", get: () => "localhost", protocol: "http" },
    res: { cookie: () => {}, clearCookie: () => {} },
  } as any);
}

describe("when the tenant is a retail merchant", () => {
  it("should refuse every vertical-scoped feature", () => {
    for (const feature of ALL_VERTICAL_FEATURES) {
      expect(featureAppliesTo(feature, "retail_commerce")).toBe(false);
    }
  });

  it("should explain the CBN refusal without invoking a regulator they answer to", () => {
    const reason = featureUnavailableReason("cbn_regulatory_reporting", "retail_commerce");
    expect(reason).toMatch(/card-scheme/i);
    expect(reason).toMatch(/retail commerce/i);
  });

  it("should explain the registry refusal in terms of what it records", () => {
    const reason = featureUnavailableReason("distributor_registry", "retail_commerce");
    expect(reason).toMatch(/distributor/i);
  });
});

describe("when the tenant is a bank", () => {
  it("should keep CBN regulatory reporting", () => {
    expect(featureAppliesTo("cbn_regulatory_reporting", "financial_services")).toBe(true);
  });

  it("should refuse the distributor registry", () => {
    // Distributors are the corporate B2B sector's concept: the registry records
    // who an FMCG supplier sells through, and a bank does not sell through
    // distributors.
    //
    // An earlier revision allowed this, reasoning from production data — 30
    // distributor rows sit on the financial-services demo tenant. Those rows are
    // misfiled, not evidence: the corporate-B2B tenant that owns the concept has
    // none, and 14 more sit under organizationId 0, which is no tenant at all.
    // The client never made this mistake (navItems scopes the registry to
    // ["corporate_b2b"]).
    expect(featureAppliesTo("distributor_registry", "financial_services")).toBe(false);
  });
});

describe("when the tenant is a corporate B2B supplier", () => {
  it("should keep both features", () => {
    for (const feature of ALL_VERTICAL_FEATURES) {
      expect(featureAppliesTo(feature, "corporate_b2b")).toBe(true);
    }
  });
});

describe("when the tenant is the platform operator", () => {
  it("should keep both features", () => {
    // super_admin supports every tenant, matching shared/moduleScope.
    for (const feature of ALL_VERTICAL_FEATURES) {
      expect(featureAppliesTo(feature, "super_admin")).toBe(true);
    }
  });
});

describe("when the segment is unknown", () => {
  it("should keep the features rather than silently withdrawing them", () => {
    // This rule REMOVES capability from one vertical. Denying on missing data
    // would switch these surfaces off for every legacy org with no segment set,
    // which is the wrong direction to fail.
    for (const unknown of [null, undefined, "", "something_new"]) {
      for (const feature of ALL_VERTICAL_FEATURES) {
        expect(featureAppliesTo(feature, unknown as string | null)).toBe(true);
      }
    }
  });
});

describe("when the caller has no organisation", () => {
  // Behavioural rather than structural: the refusal happens before any database
  // access, so this runs with no DB and proves the procedure actually rejects
  // rather than merely that the source contains a check.
  it("should refuse the CBN surfaces", async () => {
    const caller = orgLessCaller();
    await expect(caller.cbnCompliance.listDeadlineSubmissions()).rejects.toThrow(/not linked to an organisation/i);
    await expect(caller.dashboard.auditorCompliance()).rejects.toThrow(/not linked to an organisation/i);
  });

  it("should refuse the distributor registry", async () => {
    await expect(orgLessCaller().distributor.stats()).rejects.toThrow(/not linked to an organisation/i);
  });
});

describe("when the guard is enforced server-side", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  const CBN = read("routers/cbnCompliance.ts");
  const ROUTERS = read("routers.ts");
  const SHARED = read("routers/shared.ts");

  function between(source: string, startAnchor: string, endAnchor: string): string {
    const start = source.indexOf(startAnchor);
    expect(start, `anchor missing: ${startAnchor}`).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start);
    expect(end, `anchor missing after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("should gate every CBN procedure, leaving no ungated one behind", () => {
    // Asserted as an ABSENCE rather than a count: the gate is applied by the
    // procedure builder, so a new procedure added to this router inherits it —
    // unless someone reaches for protectedProcedure, which is what this catches.
    expect(CBN).not.toMatch(/:\s*protectedProcedure/);
    expect(CBN).toMatch(/:\s*cbnProcedure/);
  });

  it("should gate every distributor procedure", () => {
    const registry = between(ROUTERS, "const distributorRouter = router({", "\n});");
    expect(registry).not.toMatch(/:\s*protectedProcedure/);
    expect(registry).toMatch(/:\s*distributorProcedure/);
  });

  it("should gate the examination-facing auditor procedures", () => {
    // These feed the CBN pack, so they carry the same rule as the pack itself.
    expect(ROUTERS).toMatch(/auditorCompliance:\s*cbnProcedure/);
    expect(ROUTERS).toMatch(/auditorTrail:\s*cbnProcedure/);
  });

  it("should refuse an org-less caller before the segment is even looked up", () => {
    // Distinct from the unknown-segment case below, which deliberately ALLOWS.
    // An account with no organisation is not "segment not yet resolved" — it has
    // no institution at all, and several CBN handlers fall back to
    // `organizationId ?? 0`, which would pool every such account into one shared
    // pseudo-tenant. The check must sit ahead of segmentOf so that fallback is
    // never reached.
    const guard = between(SHARED, "export function verticalFeatureProcedure", "const segment = await segmentOf");
    expect(guard).toContain("ctx.user.organizationId");
    expect(guard).toContain("PRECONDITION_FAILED");
  });

  it("should decide using the shared rule, not a second inline copy", () => {
    expect(SHARED).toMatch(/from "@shared\/verticalFeatures"/);
    expect(SHARED).toMatch(/featureAppliesTo\(feature, segment\)/);
    expect(ROUTERS).not.toMatch(/function featureAppliesTo/);
    expect(CBN).not.toMatch(/function featureAppliesTo/);
  });

  it("should agree with the client about who the registry is for", () => {
    // The whole reason this rule lives in shared/ is that the client's hiding and
    // the server's refusal must not disagree. The client scopes the registry nav
    // to corporate_b2b; if someone widens one side, this fails.
    const NAV = fs.readFileSync(path.join(__dirname, "..", "client", "src", "lib", "navItems.ts"), "utf8");
    expect(NAV).toMatch(/Distributor Registry.*segments: \["corporate_b2b"\]/);
    expect(featureAppliesTo("distributor_registry", "corporate_b2b")).toBe(true);
    for (const other of ["financial_services", "retail_commerce"]) {
      expect(featureAppliesTo("distributor_registry", other)).toBe(false);
    }
  });
});

describe("when demo data is seeded", () => {
  const SEED = fs.readFileSync(path.join(__dirname, "demoSeedEngine.ts"), "utf8");

  it("should not file distributors against a non-B2B tenant", () => {
    // The seeder ran with whatever organisation the caller had, which is how 30
    // distributor rows came to sit on a bank and 14 under organizationId 0. The
    // guard has to be here as well as on the read path, or the next demo seed
    // recreates the contradiction this PR is fixing.
    expect(SEED).toMatch(/featureAppliesTo\("distributor_registry"/);
  });
});
