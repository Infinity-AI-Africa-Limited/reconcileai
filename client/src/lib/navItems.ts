/**
 * The single source of truth for sidebar navigation.
 *
 * Previously there were FOUR lists describing overlapping things: a default set
 * (`menuItems` + `adminMenuItems` + `adminAdvancedItems`, filtered by role) and
 * three curated per-segment lists used only when a super admin ENTERS a tenant
 * portal. They drifted, in both directions:
 *
 *   - The default set carried entries built for other verticals, so a merchant
 *     logging in normally saw "Distributor Registry" and "CBN Reports" (fixed by
 *     annotating `segments`, PR #52).
 *   - The retail portal list carried THREE entries that existed nowhere else —
 *     /settlement-monitor, /shopline/sync-status, /shopline/connect. A real
 *     SHOPLINE merchant therefore never had Settlement Monitor in their sidebar
 *     at all; it was visible only to a super admin viewing their portal.
 *
 * One list fixes both directions at once. Every entry declares who it is for;
 * both the normal sidebar and the portal sidebar are derived from it, so they
 * cannot disagree again.
 *
 * Structure only — no icons. Icons are React components and would make this
 * untestable under the node-environment vitest config, which is also why the
 * rules live here rather than in the component. DashboardLayout maps path →
 * icon, and a test asserts that mapping is complete.
 *
 * NOT AUTHORISATION. Everything here decides what is LINKED, never what is
 * reachable. Routes and procedures must guard themselves — see PR #51, where a
 * nav entry marked `roles: ["admin"]` fronted procedures every tenant's admin
 * could call.
 */
import type { Segment } from "./segments";

/** Where an entry appears in the sidebar. */
export type NavGroup = "main" | "admin" | "advanced" | "superAdmin";

export type NavEntry = {
  label: string;
  path: string;
  group: NavGroup;
  /** Omitted = every role. */
  roles?: string[];
  /** Omitted = every vertical. */
  segments?: Segment[];
  /**
   * An Infinity AI staff tool, keyed on the super_admin ROLE.
   *
   * This is deliberately NOT `segments: ["super_admin"]`, which is how it was
   * first written. A segment describes the ORGANISATION a viewer belongs to,
   * and the two are independently mutable: `admin.updateRole` promotes a tenant
   * user to super_admin without moving them out of their tenant org, and
   * `superAdmin.updateOrganizationSegment` can retype any org — including
   * Infinity AI's own. Either one silently emptied the staff tools out of a real
   * staff member's sidebar, while the Infinity AI group beside them (gated on
   * the role) stayed put. A super_admin with no organizationId at all lost them
   * for a third reason: no org means no segment, and `inSegment` reads null as
   * "no match".
   *
   * The role is also what the SERVER trusts — `superAdminProcedure` checks
   * `ctx.user.role === "super_admin"` and never looks at a segment — so keying
   * on it is what keeps the link and the guard agreeing.
   */
  staffOnly?: boolean;
};

/**
 * `staffOnly` means platform-operator tool, not a tenant feature. Two entries
 * earn it:
 *
 *   /demo-dashboard    — the "BrightGoods FMCG Demo" sales tool. It exposes
 *                        demo.activate/deactivate, which seed fabricated data.
 *                        No paying tenant should be offered that.
 *   /admin/assessments — Infinity AI's own lead pipeline from the public CBN
 *                        readiness tool. PR #51 locks the procedures behind it
 *                        to super_admin; this stops the link contradicting them.
 */
export const NAV_ITEMS: NavEntry[] = [
  // ── Main ──────────────────────────────────────────────────────────────────
  //
  // Settlement Monitor is deliberately FIRST, above Dashboard.
  //
  // Array order is sidebar order, and only retail sees this entry — so a
  // merchant opens on the screen that answers their question ("did my payout
  // land, and what is missing") while every other vertical is unaffected and
  // still leads with Dashboard, which answers an operator's question ("how is
  // reconciliation performing"). The same reasoning puts /settlement-monitor at
  // the end of the retail login redirect; see landingPathFor in lib/routeAccess,
  // which must agree with this ordering.
  { label: "Settlement Monitor", path: "/settlement-monitor", group: "main", segments: ["retail_commerce"] },
  { label: "Dashboard", path: "/dashboard", group: "main" },
  { label: "Super Agent", path: "/super-agent", group: "main" },
  { label: "Exception Intelligence", path: "/exception-intelligence", group: "main" },
  { label: "Demo Dashboard", path: "/demo-dashboard", group: "main", staffOnly: true },
  { label: "Distributor Registry", path: "/distributors", group: "main", segments: ["corporate_b2b"] },
  // The remaining retail-only surfaces. These existed ONLY in the portal list
  // before, so a real merchant could not reach the screens the vertical is built
  // around. Secondary to Settlement Monitor, so they stay below the shared entries.
  { label: "Sync Status", path: "/shopline/sync-status", group: "main", segments: ["retail_commerce"] },
  { label: "SHOPLINE Connection", path: "/shopline/connect", group: "main", segments: ["retail_commerce"] },
  { label: "Upload Data", path: "/upload", group: "main", roles: ["admin", "operations"] },
  { label: "Reconciliation", path: "/reconciliation", group: "main", roles: ["admin", "operations"] },
  { label: "Reports", path: "/reports", group: "main" },
  { label: "Schedules", path: "/schedules", group: "main", roles: ["admin", "operations"] },
  { label: "Monitor", path: "/monitor", group: "main" },
  { label: "Documentation", path: "/documentation", group: "main" },

  // ── Admin ─────────────────────────────────────────────────────────────────
  { label: "Multi-Channel", path: "/channels", group: "admin", roles: ["admin", "operations"] },
  { label: "Exceptions", path: "/exceptions", group: "admin", roles: ["admin", "operations"] },
  { label: "Age Tracker", path: "/age-tracker", group: "admin", roles: ["admin", "operations"] },
  { label: "Transactions", path: "/transactions", group: "admin", roles: ["admin", "operations"] },
  { label: "Review Queue", path: "/review", group: "admin", roles: ["admin", "operations"] },
  { label: "Audit Trail", path: "/audit", group: "admin", roles: ["admin", "compliance", "cfo"] },
  // Nigerian data protection: the frameworks on this page are NDPA 2023 and
  // NDPR 2019, and its retention guidance is "aligned with CBN records retention
  // guidelines for financial institutions". A SHOPLINE merchant is governed by
  // none of those. Corporate B2B keeps it — an FMCG supplier in Nigeria is
  // squarely within NDPA.
  { label: "Data Protection", path: "/compliance", group: "admin", roles: ["admin", "compliance"], segments: ["financial_services", "corporate_b2b"] },
  // Nigerian banking-regulator pack — financial services only (CLAUDE.md §2A).
  { label: "CBN Reports", path: "/cbn-compliance", group: "admin", roles: ["admin", "compliance", "cfo"], segments: ["financial_services"] },
  { label: "User Management", path: "/admin/users", group: "admin", roles: ["admin"] },
  // No `roles` alongside `staffOnly`: staffOnly is already the narrower gate, and
  // a second list only invites the two to disagree.
  { label: "Assessments", path: "/admin/assessments", group: "admin", staffOnly: true },
  { label: "Module Configuration", path: "/modules", group: "admin", roles: ["admin"] },
  { label: "Email Settings", path: "/email-settings", group: "admin", roles: ["admin"] },

  // ── Advanced tools ────────────────────────────────────────────────────────
  // Seeds a Nigerian banking / FMCG demo: its channels are core_banking (CBS),
  // nibss (NIP) and bank_statement. Offering that to a SHOPLINE merchant invites
  // them to fill their own tenant with transactions from a vertical they are not
  // in, and none of it would reconcile against their orders.
  { label: "Sample Data", path: "/sample-data", group: "advanced", roles: ["admin"], segments: ["financial_services", "corporate_b2b"] },
  { label: "Integrations", path: "/integrations", group: "advanced", roles: ["admin"] },
  // CBS connectors onboard bank / MFB clients.
  { label: "Core Banking Connector", path: "/woodcore-connector", group: "advanced", roles: ["admin"], segments: ["financial_services"] },
  { label: "API Ingestion", path: "/api-ingestion", group: "advanced", roles: ["admin"] },
  { label: "SFTP Config", path: "/sftp-config", group: "advanced", roles: ["admin"] },
  { label: "Bucket Drops", path: "/bucket-config", group: "advanced", roles: ["admin"] },
  { label: "Email Forwarding", path: "/email-forwarding", group: "advanced", roles: ["admin"] },
  { label: "Anomaly Detection", path: "/anomalies", group: "advanced", roles: ["admin"] },

  // ── Super admin (Infinity AI staff) ───────────────────────────────────────
  { label: "Platform Overview", path: "/admin/super-admin", group: "superAdmin", roles: ["super_admin"] },
  { label: "All Organisations", path: "/admin/super-admin/orgs", group: "superAdmin", roles: ["super_admin"] },
  { label: "All Users", path: "/admin/super-admin/users", group: "superAdmin", roles: ["super_admin"] },
  { label: "Platform Analytics", path: "/admin/super-admin/analytics", group: "superAdmin", roles: ["super_admin"] },
  { label: "POC Hub", path: "/admin/poc", group: "superAdmin", roles: ["super_admin"] },
  { label: "Roadmap Access", path: "/admin/roadmap-access", group: "superAdmin", roles: ["super_admin"] },
];

/** Does this vertical get the entry at all? */
export function inSegment(entry: NavEntry, segment: Segment | null): boolean {
  if (!entry.segments) return true;
  return segment !== null && entry.segments.includes(segment);
}

/** Does this role get the entry at all? */
export function inRole(entry: NavEntry, role: string | undefined): boolean {
  if (!entry.roles) return true;
  if (!role) return false;
  if (role === "super_admin" && !entry.roles.includes("super_admin")) return true;
  return entry.roles.includes(role);
}

/**
 * Is this viewer Infinity AI staff?
 *
 * Compares the role, and nothing else — the same question, asked the same way,
 * as the server's `superAdminProcedure`.
 */
export function isStaff(role: string | undefined): boolean {
  return role === "super_admin";
}

/** Does this viewer clear the entry's staff gate? Ungated entries always do. */
export function passesStaffGate(entry: NavEntry, role: string | undefined): boolean {
  return !entry.staffOnly || isStaff(role);
}

/**
 * The sidebar for one viewer.
 *
 * `portal` is the super-admin-inside-a-tenant case. There, role gating is
 * dropped — staff are looking at the tenant's surface, not their own
 * permissions — but SEGMENT gating still applies, because the point of the
 * portal is to see what that vertical has. Staff tools and the operator's own
 * group are excluded so the portal shows the tenant's sidebar, not ours.
 */
export function navFor(
  segment: Segment | null,
  role: string | undefined,
  opts: { portal?: boolean } = {},
): NavEntry[] {
  if (opts.portal) {
    return NAV_ITEMS.filter(
      (e) => e.group !== "superAdmin" && !e.staffOnly && inSegment(e, segment),
    );
  }
  return NAV_ITEMS.filter(
    (e) => passesStaffGate(e, role) && inRole(e, role) && inSegment(e, segment),
  );
}

/** Entries in one group, for a viewer. */
export function navGroup(
  group: NavGroup,
  segment: Segment | null,
  role: string | undefined,
  opts: { portal?: boolean } = {},
): NavEntry[] {
  return navFor(segment, role, opts).filter((e) => e.group === group);
}
