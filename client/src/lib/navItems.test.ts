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
  retail_commerce: [
    "/dashboard", "/reconciliation", "/exceptions", "/transactions", "/settlement-monitor",
    "/shopline/sync-status", "/reports", "/audit", "/shopline/connect", "/admin/users",
  ],
} satisfies Record<string, string[]>;

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

  it("should still offer the vertical-agnostic screens", () => {
    // Consolidation must not over-correct into a stripped-down sidebar.
    const merchant = paths(navFor("retail_commerce", "admin"));
    for (const p of ["/dashboard", "/reconciliation", "/exceptions", "/transactions", "/reports", "/audit"]) {
      expect(merchant, `retail lost ${p}`).toContain(p);
    }
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
});

describe("when the segment has not resolved yet", () => {
  it("should hide segment-restricted entries rather than flash them", () => {
    const loading = paths(navFor(null, "admin"));
    expect(loading).not.toContain("/cbn-compliance");
    expect(loading).not.toContain("/distributors");
    expect(loading).not.toContain("/settlement-monitor");
  });

  it("should still render the unrestricted entries, so the sidebar is never empty", () => {
    const loading = paths(navFor(null, "admin"));
    expect(loading).toContain("/dashboard");
    expect(loading.length).toBeGreaterThan(5);
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
