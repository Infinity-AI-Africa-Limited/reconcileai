/**
 * Navigation consolidation — a characterization test.
 *
 * Four overlapping nav lists became one. The risk in that refactor is not a
 * crash; it is a segment quietly LOSING a link it had yesterday, which nobody
 * notices until a customer asks where a screen went.
 *
 * So the pre-refactor lists are pinned here verbatim, copied from the source
 * before it was changed, and the derived navigation is asserted to be a
 * superset of each. Additions are allowed and enumerated; removals are not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ITEMS, navFor, navGroup, type NavEntry } from "./navItems";
import { canReachPath } from "./routeAccess";
import type { Segment } from "./segments";

/** Exactly what each portal nav contained before consolidation. */
const BEFORE = {
  financial_services: [
    "/dashboard", "/reconciliation", "/exceptions", "/age-tracker", "/transactions",
    "/channels", "/review", "/reports", "/cbn-compliance", "/audit", "/compliance",
    "/exception-intelligence", "/monitor", "/admin/users", "/modules", "/email-settings",
    "/schedules", "/upload",
  ],
  corporate_b2b: [
    "/dashboard", "/distributors", "/reconciliation", "/exceptions", "/age-tracker",
    "/transactions", "/reports", "/review", "/audit", "/exception-intelligence",
    "/monitor", "/admin/users", "/upload", "/schedules",
  ],
} satisfies Record<string, string[]>;

const APPROVED_RETAIL = [
  "/settlement-monitor",
  "/shopline/sync-status",
  "/shopline/connect",
  "/exceptions",
  "/transactions",
  "/admin/users",
] as const;

const paths = (entries: NavEntry[]) => entries.map((e) => e.path);

describe("when a super admin views a tenant portal", () => {
  for (const [segment, before] of Object.entries(BEFORE)) {
    it(`should not remove any ${segment} entry that existed before consolidation`, () => {
      const after = paths(navFor(segment as Segment, "super_admin", { portal: true }));
      const lost = before.filter((p) => !after.includes(p));
      expect(
        lost,
        `Consolidation dropped ${segment} navigation: ${lost.join(", ")}. ` +
          `Adding entries is fine; removing one takes a screen away from a segment that had it.`,
      ).toEqual([]);
    });
  }

  it("should keep the three retail surfaces that previously existed only here", () => {
    // /settlement-monitor, sync status and connect lived ONLY in the retail
    // portal list, so a real merchant never had them. They are in the shared
    // list now, which is the point of the refactor — but they must still be
    // present for the portal view that already had them.
    const retail = paths(navFor("retail_commerce", "super_admin", { portal: true }));
    expect(retail).toContain("/settlement-monitor");
    expect(retail).toContain("/shopline/sync-status");
    expect(retail).toContain("/shopline/connect");
  });

  it("should show only the approved Shopline merchant surface in a retail portal", () => {
    const retail = paths(navFor("retail_commerce", "super_admin", { portal: true }));
    expect(retail.sort()).toEqual([...APPROVED_RETAIL].sort());
  });
});

describe("when a real merchant signs in directly", () => {
  it("should now offer the retail surfaces they could never reach before", () => {
    // The regression this refactor closes: these were portal-only, so the
    // vertical's central screen was absent from its own merchants' sidebars.
    const merchant = paths(navFor("retail_commerce", "admin"));
    expect(merchant).toContain("/settlement-monitor");
    expect(merchant).toContain("/shopline/sync-status");
    expect(merchant).toContain("/shopline/connect");
  });

  it("should not offer another vertical's surfaces", () => {
    const merchant = paths(navFor("retail_commerce", "admin"));
    expect(merchant).not.toContain("/distributors");
    expect(merchant).not.toContain("/cbn-compliance");
    expect(merchant).not.toContain("/woodcore-connector");
  });

  it("should offer only the approved merchant controls", () => {
    const merchant = paths(navFor("retail_commerce", "admin"));
    expect(merchant.sort()).toEqual([...APPROVED_RETAIL].sort());
  });
});

describe("when the entry is an Infinity AI staff tool", () => {
  it("should hide the FMCG sales demo from every tenant", () => {
    // /demo-dashboard exposes demo.activate/deactivate, which seed fabricated
    // data. Consolidating without this would have pushed it into every real
    // bank's and merchant's sidebar.
    for (const s of ["financial_services", "corporate_b2b", "retail_commerce"] as Segment[]) {
      expect(paths(navFor(s, "admin")), `${s} must not see the demo tool`).not.toContain("/demo-dashboard");
      expect(paths(navFor(s, "super_admin", { portal: true }))).not.toContain("/demo-dashboard");
    }
  });

  it("should hide the lead pipeline from every tenant", () => {
    // Matches PR #51, which locked the procedures behind it to super_admin.
    // The link must not contradict the guard.
    for (const s of ["financial_services", "corporate_b2b", "retail_commerce"] as Segment[]) {
      expect(paths(navFor(s, "admin")), `${s} must not see the lead pipeline`).not.toContain("/admin/assessments");
    }
  });

  it("should still show both to Infinity AI staff", () => {
    const staff = paths(navFor("super_admin", "super_admin"));
    expect(staff).toContain("/demo-dashboard");
    expect(staff).toContain("/admin/assessments");
  });

  it("should follow the staff role, not whichever org the staff member sits in", () => {
    // These were first gated with `segments: ["super_admin"]`, which reads the
    // ORGANISATION rather than the viewer. The two move independently:
    // admin.updateRole promotes a tenant user to super_admin and leaves them in
    // their tenant org, and superAdmin.updateOrganizationSegment can retype any
    // org including Infinity AI's own. Either one emptied the staff tools out of
    // a real staff member's sidebar — while /admin/super-admin, gated on the
    // role, sat right below them and stayed.
    for (const s of [
      "financial_services",
      "corporate_b2b",
      "retail_commerce",
      "super_admin",
      null,
    ] as (Segment | null)[]) {
      const staff = paths(navFor(s, "super_admin"));
      expect(staff, `staff in a ${s} org lost the demo tool`).toContain("/demo-dashboard");
      expect(staff, `staff in a ${s} org lost the lead pipeline`).toContain("/admin/assessments");
      // The invariant behind the bug: whoever gets the operator's own group gets
      // the operator's own tools. One list must never answer without the other.
      expect(staff, `staff in a ${s} org lost the platform group`).toContain("/admin/super-admin");
    }
  });

  it("should hide staff tools from a non-staff colleague inside Infinity AI's own org", () => {
    // The mirror of the case above, and the reason the gate is not simply
    // "role OR segment": an operations user sitting in the super_admin-segment
    // org is still not staff, and demo.activate seeds fabricated data.
    const colleague = paths(navFor("super_admin", "operations"));
    expect(colleague).not.toContain("/demo-dashboard");
    expect(colleague).not.toContain("/admin/assessments");
  });
});

describe("when the segment has not resolved yet", () => {
  it("should hide segment-restricted entries rather than flash them", () => {
    const loading = paths(navFor(null, "admin"));
    expect(loading).not.toContain("/cbn-compliance");
    expect(loading).not.toContain("/distributors");
    expect(loading).not.toContain("/settlement-monitor");
  });

  it("should not expose a tenant surface before its segment resolves", () => {
    const loading = paths(navFor(null, "admin"));
    expect(loading).toEqual([]);
  });
});

describe("when a portal is opened", () => {
  it("should show the tenant's sidebar, not the operator's", () => {
    const portal = navFor("financial_services", "super_admin", { portal: true });
    expect(portal.some((e) => e.group === "superAdmin")).toBe(false);
  });

  it("should ignore role gating, since staff are viewing the tenant's surface", () => {
    // Entries restricted to admin/operations still appear in a portal view.
    const portal = paths(navFor("financial_services", "super_admin", { portal: true }));
    expect(portal).toContain("/upload");
    expect(portal).toContain("/modules");
  });
});

describe("when roles are applied", () => {
  it("should hide operations-only entries from a plain user", () => {
    const user = paths(navFor("financial_services", "user"));
    expect(user).not.toContain("/upload");
    expect(user).not.toContain("/channels");
    expect(user).toContain("/dashboard");
  });

  it("should give super admins the platform group", () => {
    expect(paths(navGroup("superAdmin", "super_admin", "super_admin"))).toContain("/admin/super-admin");
  });

  it("should give no one else the platform group", () => {
    expect(navGroup("superAdmin", "financial_services", "admin")).toEqual([]);
  });
});

describe("when an entry is added to the shared list", () => {
  // The icons live in DashboardLayout because they are React components and
  // this module has to stay importable under the node-environment vitest
  // config. That split is only safe if the two cannot drift, so the map is
  // checked from source rather than imported.
  const layout = readFileSync(
    join(__dirname, "..", "components", "DashboardLayout.tsx"),
    "utf8",
  );
  const iconMap = layout.slice(
    layout.indexOf("const NAV_ICONS"),
    layout.indexOf("function withIcon"),
  );
  const mapped = new Set([...iconMap.matchAll(/"([^"]+)":/g)].map((m) => m[1]));

  it("should have an icon for every path", () => {
    const missing = NAV_ITEMS.map((e) => e.path).filter((p) => !mapped.has(p));
    expect(
      missing,
      `These nav entries have no icon in DashboardLayout's NAV_ICONS: ${missing.join(", ")}. ` +
        `They would silently fall back to the dashboard icon.`,
    ).toEqual([]);
  });

  it("should not map icons for paths that no longer exist", () => {
    const known = new Set(NAV_ITEMS.map((e) => e.path));
    const orphans = [...mapped].filter((p) => !known.has(p));
    expect(orphans, `NAV_ICONS maps paths that are not nav entries: ${orphans.join(", ")}`).toEqual([]);
  });
});

/**
 * Found live, mid-demo: "the CBN compliance page is missing".
 *
 * Infinity AI's own organisation has segment `super_admin`, so `inSegment`
 * matched none of the vertical-scoped entries and a signed-in super admin lost
 * CBN Reports, Data Protection, Sample Data, Core Banking Connector, Distributor
 * Registry and the retail entries from their sidebar.
 *
 * The page was never broken. /cbn-compliance loaded fine if you typed the URL,
 * because `canReachPath` passes staff, and `cbnProcedure` answered, because
 * shared/verticalFeatures lists `super_admin` under cbn_regulatory_reporting.
 * Only the way in was missing — a hidden link in front of an open route and an
 * open procedure, which is the same class of defect as the reverse.
 */
describe("when Infinity AI staff use their own account", () => {
  // The real shape of the operator's account: super_admin ROLE, and an
  // organisation whose SEGMENT is also super_admin. The two are independently
  // mutable, which is why nothing here may key on the segment.
  const staffNav = navFor("super_admin", "super_admin").map((e) => e.path);

  it("should show CBN Reports", () => {
    expect(staffNav).toContain("/cbn-compliance");
  });

  it("should show every vertical-scoped entry, not only the unscoped ones", () => {
    for (const entry of NAV_ITEMS.filter((e) => e.segments && !e.staffOnly && e.group !== "superAdmin")) {
      expect(staffNav, `${entry.label} (${entry.path}) missing for staff`).toContain(entry.path);
    }
  });

  it("should still show the operator's own tools", () => {
    expect(staffNav).toContain("/admin/super-admin");
    expect(staffNav).toContain("/demo-dashboard");
  });

  it("should agree with the route guard on every path", () => {
    // The invariant that was broken. If a staff member can OPEN it, they must be
    // able to SEE it — otherwise the only way in is knowing the URL.
    for (const entry of NAV_ITEMS) {
      if (entry.group === "superAdmin") continue;
      const reachable = canReachPath(entry.path, "super_admin", "super_admin");
      expect(
        staffNav.includes(entry.path),
        `${entry.path}: route says reachable=${reachable}, sidebar says linked=${staffNav.includes(entry.path)}`,
      ).toBe(reachable);
    }
  });

  it("should not depend on the operator org's segment being anything in particular", () => {
    // `superAdmin.updateOrganizationSegment` can retype any org including
    // Infinity AI's own, and a super_admin may have no organisation at all.
    // Neither may empty the sidebar.
    for (const seg of ["super_admin", "financial_services", "retail_commerce", null] as const) {
      expect(navFor(seg, "super_admin").map((e) => e.path), `segment=${seg}`).toContain("/cbn-compliance");
    }
  });
});

describe("when staff enter a tenant's portal", () => {
  it("should still show only that tenant's vertical", () => {
    // The bypass above is scoped to the operator's OWN account. Inside a portal
    // the point is to see what the tenant has, so segment gating must survive.
    const retailPortal = navFor("retail_commerce", "super_admin", { portal: true }).map((e) => e.path);
    expect(retailPortal).toContain("/settlement-monitor");
    expect(retailPortal).not.toContain("/cbn-compliance");
    expect(retailPortal).not.toContain("/distributors");
  });

  it("should show CBN Reports inside a financial-services portal", () => {
    const bankPortal = navFor("financial_services", "super_admin", { portal: true }).map((e) => e.path);
    expect(bankPortal).toContain("/cbn-compliance");
    expect(bankPortal).not.toContain("/settlement-monitor");
  });
});

describe("a bank's own users keep CBN Reports", () => {
  // The demo path that must never regress, independent of the staff bypass.
  for (const role of ["admin", "compliance", "cfo"]) {
    it(`should show it to a ${role}`, () => {
      expect(navFor("financial_services", role).map((e) => e.path)).toContain("/cbn-compliance");
    });
  }

  it("should keep it away from a retail merchant", () => {
    expect(navFor("retail_commerce", "admin").map((e) => e.path)).not.toContain("/cbn-compliance");
  });

  it("should keep it away from an operations user", () => {
    // Not in its roles list — CBN filing is admin/compliance/cfo work.
    expect(navFor("financial_services", "operations").map((e) => e.path)).not.toContain("/cbn-compliance");
  });
});

describe("the list itself", () => {
  it("should have no duplicate paths", () => {
    const all = NAV_ITEMS.map((e) => e.path);
    expect(all.length).toBe(new Set(all).size);
  });

  it("should give every entry a label and a group", () => {
    for (const e of NAV_ITEMS) {
      expect(e.label.length, `${e.path} has no label`).toBeGreaterThan(0);
      expect(["main", "admin", "advanced", "superAdmin"]).toContain(e.group);
    }
  });
});
