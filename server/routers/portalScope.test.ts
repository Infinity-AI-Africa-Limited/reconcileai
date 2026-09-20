/**
 * The super-admin portal scope.
 *
 * "Enter Portal" is client state — sessionStorage read by the sidebar. The
 * server only hears about it when a query passes `viewAsOrgId`, and only two
 * procedures ever did. Every other tenant-scoped read answered for the signed-in
 * user's OWN organisation, so a super admin inside Globus Bank's portal read
 * Infinity AI's organisation instead: no transactions, no jobs, no reports, no
 * exceptions. Six screens reported nothing while the tenant held tens of
 * thousands of rows.
 *
 * The override is also a tenant boundary, which is why it lives in one function
 * and is pinned here rather than restated at each call site.
 */
import { describe, it, expect } from "vitest";
import { portalScopedOrgId } from "./shared";

const staff = { role: "super_admin", organizationId: 30002 };
const tenantAdmin = { role: "admin", organizationId: 1 };

describe("when a super admin is inside a tenant's portal", () => {
  it("should read the tenant being viewed, not their own organisation", () => {
    // The whole defect: without this, Globus Bank's portal showed Infinity AI's
    // own (empty) organisation.
    expect(portalScopedOrgId(staff, 1)).toBe(1);
    expect(portalScopedOrgId(staff, 30001)).toBe(30001);
  });

  it("should fall back to their own organisation outside a portal", () => {
    expect(portalScopedOrgId(staff, undefined)).toBe(30002);
    expect(portalScopedOrgId(staff, null)).toBe(30002);
  });
});

describe("when anyone who is not a super admin sends the override", () => {
  it("should IGNORE it and answer for their own organisation", () => {
    // The security property. A tenant admin who discovers the field and asks for
    // another organisation gets their own data, unchanged.
    for (const role of ["admin", "operations", "cfo", "compliance", "user"]) {
      const user = { role, organizationId: 1 };
      expect(portalScopedOrgId(user, 30001), `${role} must not cross tenants`).toBe(1);
    }
  });

  it("should ignore rather than throw, so the attempt reveals nothing", () => {
    // A 403 would confirm the organisation exists. There is nothing to tell them.
    expect(() => portalScopedOrgId(tenantAdmin, 999_999)).not.toThrow();
    expect(portalScopedOrgId(tenantAdmin, 999_999)).toBe(1);
  });

  it("should not let a user with no organisation borrow one", () => {
    // No organisation is not "unknown tenant, pick one" — it is no tenant.
    expect(portalScopedOrgId({ role: "admin", organizationId: null }, 1)).toBeNull();
  });
});

describe("when the override is absent or meaningless", () => {
  it("should treat zero as no override rather than as organisation zero", () => {
    // organizationId 0 is not a tenant and never was — CLAUDE.md §19.2 traces 14
    // unreachable rows to exactly that pseudo-tenant.
    expect(portalScopedOrgId(staff, 0)).toBe(30002);
  });

  it("should give an org-less super admin null rather than a borrowed tenant", () => {
    expect(portalScopedOrgId({ role: "super_admin", organizationId: null }, undefined)).toBeNull();
  });
});
