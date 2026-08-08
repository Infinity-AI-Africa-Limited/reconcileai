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

describe("when the tenant is any other vertical", () => {
  // The rule is "not retail", NOT "financial services only", and the difference
  // is load-bearing: the distributor registry's 30 live rows are owned by a
  // FINANCIAL SERVICES organisation. A financial-services-only reading of the
  // docs would have orphaned them.
  it("should keep both features for financial services", () => {
    for (const feature of ALL_VERTICAL_FEATURES) {
      expect(featureAppliesTo(feature, "financial_services")).toBe(true);
    }
  });

  it("should keep both features for corporate B2B", () => {
    for (const feature of ALL_VERTICAL_FEATURES) {
      expect(featureAppliesTo(feature, "corporate_b2b")).toBe(true);
    }
  });

  it("should keep both features for the platform operator", () => {
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

  it("should decide using the shared rule, not a second inline copy", () => {
    expect(SHARED).toMatch(/from "@shared\/verticalFeatures"/);
    expect(SHARED).toMatch(/featureAppliesTo\(feature, segment\)/);
    expect(ROUTERS).not.toMatch(/function featureAppliesTo/);
    expect(CBN).not.toMatch(/function featureAppliesTo/);
  });
});
