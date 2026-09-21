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
import { readFileSync } from "node:fs";
import path from "node:path";
import { canActOnTenant, channelListScope, portalScopedOrgId, transactionOwnerFilter } from "./shared";

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

describe("when a procedure acts on a row the client named by id", () => {
  // reports.generate and reconciliation.get loaded a job by id alone and then
  // read its exceptions under the CALLER's organisation. The row names its own
  // tenant; the caller only decides whether they may touch it.

  it("should let staff act on any tenant's row, since the portal exists for that", () => {
    expect(canActOnTenant(staff, 1)).toBe(true);
    expect(canActOnTenant(staff, 30001)).toBe(true);
  });

  it("should let a tenant user act on their own tenant's row", () => {
    expect(canActOnTenant(tenantAdmin, 1)).toBe(true);
  });

  it("should refuse a tenant user another tenant's row", () => {
    // The cross-tenant read this closes: any caller could summarise any job by
    // guessing its id, because getReconciliationJob selects by id alone.
    for (const role of ["admin", "operations", "cfo", "compliance", "user"]) {
      expect(canActOnTenant({ role, organizationId: 1 }, 30001), `${role} crossed tenants`).toBe(false);
    }
  });

  it("should refuse a caller with no organisation, even against a row with none", () => {
    // null === null would pool every org-less account into one pseudo-tenant.
    // No organisation is no tenant, not a wildcard (CLAUDE.md §9C).
    expect(canActOnTenant({ role: "admin", organizationId: null }, null)).toBe(false);
    expect(canActOnTenant({ role: "admin", organizationId: null }, 1)).toBe(false);
  });

  it("should refuse a tenant user a row that has no tenant", () => {
    expect(canActOnTenant(tenantAdmin, null)).toBe(false);
  });
});

describe("when the channel list is requested", () => {
  it("should give staff the whole estate only OUTSIDE a portal", () => {
    expect(channelListScope(staff, undefined)).toBe("all");
    expect(channelListScope(staff, null)).toBe("all");
  });

  it("should give staff the viewed tenant's channels INSIDE a portal", () => {
    // The cross-tenant list reached the Reconciliation job form, so a super
    // admin in Globus Bank's portal could build a run across two tenants.
    expect(channelListScope(staff, 1)).toBe(1);
  });

  it("should use the portal tenant from the request context when the page passes none", () => {
    // The request context now carries the portal tenant (ctx.viewingAs) for
    // every call. This function keys on ROLE, so the organisation override
    // alone would still hand a super admin in a portal the whole estate.
    expect(channelListScope(staff, undefined, 30001)).toBe(30001);
    expect(channelListScope(staff, 1, 30001)).toBe(1);
    // Never for a tenant user, whatever the context says.
    expect(channelListScope({ role: "admin", organizationId: 1 }, undefined, 30001)).toBe(1);
  });

  it("should never give a tenant user the whole estate or another tenant", () => {
    for (const role of ["admin", "operations", "cfo", "compliance", "user"]) {
      const scope = channelListScope({ role, organizationId: 1 }, 30001);
      expect(scope, `${role} got the cross-tenant list`).not.toBe("all");
      expect(scope, `${role} got another tenant's channels`).toBe(1);
    }
  });
});

describe("when a tenant member lists transactions", () => {
  it("should see the organisation's rows, not only the ones they uploaded", () => {
    // Every role but `admin` used to be narrowed to its own uploads, so a super
    // admin in the Globus portal saw 0 of 1,191 transactions for the day and a
    // SHOPLINE order (user 0) was invisible to everyone but an admin.
    for (const role of ["operations", "cfo", "compliance", "super_admin", "admin", "user"]) {
      expect(transactionOwnerFilter({ id: 42, isGuest: false }), role).toBeUndefined();
    }
    expect(transactionOwnerFilter({ id: 42 })).toBeUndefined();
    expect(transactionOwnerFilter({ id: 42, isGuest: null })).toBeUndefined();
  });

  it("should still narrow a guest to their own uploads, since guests share one tenant", () => {
    expect(transactionOwnerFilter({ id: 42, isGuest: true })).toBe(42);
  });
});

describe("when transactions.list builds its query", () => {
  // The unit above proves the rule; this proves the procedure uses it. The old
  // code passed `userId: ctx.user.id` with an admin-only bypass, and keeping
  // that shape while adding the helper elsewhere would leave the defect in place.
  const src = readFileSync(path.join(__dirname, "..", "routers.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("  transactions: router({");
  const block = src.slice(start, src.indexOf("\n  }),", start));

  it("should narrow by the owner filter, never by the caller's id directly", () => {
    expect(start, "transactions router not found — has it moved?").toBeGreaterThan(-1);
    expect(block).toContain("userId: transactionOwnerFilter(ctx.user)");
    expect(block).not.toMatch(/userId: ctx[.]user[.]id/);
  });
});
