/**
 * Dashboard visibility rules per vertical.
 *
 * The failure these guard against is not a crash — it is a screen that renders
 * perfectly while asserting something untrue about the tenant looking at it. A
 * SHOPLINE merchant was shown a CBN compliance badge (a Nigerian banking
 * regulator status they are not subject to), a scorecard grading a distributor
 * registry they will never populate, and an examiner's audit dashboard.
 *
 * The `null` cases matter most: `null` is "segment not resolved yet", and a rule
 * written as a negation would treat that as a positive and flash the wrong
 * surface during load.
 */
import { describe, it, expect } from "vitest";
import {
  showsCbnCompliance,
  showsPilotReadiness,
  showsAuditorView,
  dashboardViewsFor,
  type Segment,
} from "./segmentVisibility";

const ALL: Segment[] = ["financial_services", "corporate_b2b", "retail_commerce", "super_admin"];

describe("CBN compliance badge", () => {
  it("is financial services only", () => {
    expect(showsCbnCompliance("financial_services")).toBe(true);
    for (const s of ALL.filter((x) => x !== "financial_services")) {
      expect(showsCbnCompliance(s), `${s} must not see a CBN badge`).toBe(false);
    }
  });

  it("is hidden for retail — CLAUDE.md §2A scopes CBN to financial services", () => {
    expect(showsCbnCompliance("retail_commerce")).toBe(false);
  });

  it("is hidden while the segment is still unknown", () => {
    // Gated on an explicit match, so a pending lookup cannot flash a regulatory
    // claim at a merchant it does not apply to.
    expect(showsCbnCompliance(null)).toBe(false);
  });
});

describe("Pilot Readiness Scorecard", () => {
  it("is Corporate B2B only — it scores the distributor/FMCG registry", () => {
    expect(showsPilotReadiness("corporate_b2b")).toBe(true);
    for (const s of ALL.filter((x) => x !== "corporate_b2b")) {
      expect(showsPilotReadiness(s), `${s} has no distributor registry`).toBe(false);
    }
  });

  it("is hidden for retail, where it scored a permanent zero", () => {
    expect(showsPilotReadiness("retail_commerce")).toBe(false);
  });

  it("is hidden while the segment is still unknown", () => {
    expect(showsPilotReadiness(null)).toBe(false);
  });
});

describe("dashboard views offered per segment", () => {
  it("drops the Auditor view for retail, keeping CFO and Operations", () => {
    // CFO and Operations are vertical-agnostic: "did the money arrive" and
    // "what is unresolved" are questions a merchant asks daily. An examiner's
    // audit view is not.
    expect(dashboardViewsFor("retail_commerce")).toEqual(["main", "cfo", "operations"]);
  });

  it("keeps all four for the regulated and internal segments", () => {
    for (const s of ["financial_services", "corporate_b2b", "super_admin"] as Segment[]) {
      expect(dashboardViewsFor(s)).toEqual(["main", "cfo", "operations", "auditor"]);
    }
  });

  it("keeps the Auditor view while the segment is unknown", () => {
    // Deliberately the opposite default from the two badges above: hiding a
    // regulatory CLAIM on uncertainty is safe, but hiding a NAVIGATION option
    // from someone entitled to it is a regression. Loading must not remove
    // access — it resolves a moment later.
    expect(showsAuditorView(null)).toBe(true);
    expect(dashboardViewsFor(null)).toContain("auditor");
  });

  it("always offers Main, CFO and Operations to every segment", () => {
    for (const s of [...ALL, null]) {
      expect(dashboardViewsFor(s).slice(0, 3)).toEqual(["main", "cfo", "operations"]);
    }
  });
});
