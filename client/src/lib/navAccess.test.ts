/**
 * Navigation visibility per role and vertical.
 *
 * The bug this covers: `NavItem.segments` was declared when the four-portal
 * architecture landed and never read, and the curated per-segment navs only
 * apply when a super admin ENTERS a tenant portal. A merchant logging in
 * normally fell through to the default list, filtered by role alone — so a
 * SHOPLINE admin's sidebar offered "Distributor Registry" and "CBN Reports".
 */
import { describe, it, expect } from "vitest";
import { canAccessNav } from "./navAccess";
import type { Segment } from "./segments";

const CBN = { roles: ["admin", "compliance", "cfo"], segments: ["financial_services"] as Segment[] };
const DISTRIBUTORS = { segments: ["corporate_b2b"] as Segment[] };
const REPORTS = {}; // no restrictions — every role, every vertical
const USER_MGMT = { roles: ["admin"] };

describe("when a retail merchant admin opens the sidebar", () => {
  const seg: Segment = "retail_commerce";

  it("should not offer CBN Reports, which is a Nigerian banking-regulator pack", () => {
    expect(canAccessNav(CBN, "admin", seg)).toBe(false);
  });

  it("should not offer the Distributor Registry, which is the FMCG model", () => {
    expect(canAccessNav(DISTRIBUTORS, "admin", seg)).toBe(false);
  });

  it("should still offer entries with no vertical restriction", () => {
    expect(canAccessNav(REPORTS, "admin", seg)).toBe(true);
    expect(canAccessNav(USER_MGMT, "admin", seg)).toBe(true);
  });
});

describe("when a financial services admin opens the sidebar", () => {
  const seg: Segment = "financial_services";

  it("should offer CBN Reports", () => {
    expect(canAccessNav(CBN, "admin", seg)).toBe(true);
  });

  it("should not offer the Distributor Registry", () => {
    expect(canAccessNav(DISTRIBUTORS, "admin", seg)).toBe(false);
  });
});

describe("when the role is insufficient", () => {
  it("should hide the entry regardless of a matching vertical", () => {
    // Both gates must pass; a matching segment never rescues a failing role.
    expect(canAccessNav(CBN, "user", "financial_services")).toBe(false);
    expect(canAccessNav(USER_MGMT, "user", "retail_commerce")).toBe(false);
  });

  it("should hide role-gated entries from an unauthenticated caller", () => {
    expect(canAccessNav(USER_MGMT, undefined, "retail_commerce")).toBe(false);
  });
});

describe("when the caller is Infinity AI staff", () => {
  it("should ignore vertical restrictions, since they support every tenant", () => {
    // A super admin must keep the screens they support customers with.
    expect(canAccessNav(CBN, "super_admin", "retail_commerce")).toBe(true);
    expect(canAccessNav(DISTRIBUTORS, "super_admin", null)).toBe(true);
  });

  it("should still respect entries explicitly scoped to super_admin", () => {
    const platformOnly = { roles: ["super_admin"] };
    expect(canAccessNav(platformOnly, "super_admin", null)).toBe(true);
    expect(canAccessNav(platformOnly, "admin", "financial_services")).toBe(false);
  });
});

describe("when the segment has not resolved yet", () => {
  it("should hide vertical-restricted entries rather than flash them", () => {
    // A merchant must never see "CBN Reports" appear and vanish on load.
    expect(canAccessNav(CBN, "admin", null)).toBe(false);
    expect(canAccessNav(DISTRIBUTORS, "admin", null)).toBe(false);
  });

  it("should keep unrestricted entries visible, so the sidebar is never empty", () => {
    expect(canAccessNav(REPORTS, "admin", null)).toBe(true);
    expect(canAccessNav(USER_MGMT, "admin", null)).toBe(true);
  });
});
