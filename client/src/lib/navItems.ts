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
  /**
   * The default wording, used by every vertical that does not override it in
   * `labels`. Pick the term the majority of verticals actually use, so an
   * override is the exception rather than the rule.
   */
  label: string;
  /**
   * Per-vertical wording for the SAME destination.
   *
   * One surface, different vocabulary: a bank and an FMCG supplier reconcile
   * "Transactions", while a SHOPLINE merchant has "Orders & Payments" — two legs
   * with different names, which is the merchant's own language and the wording
   * the retail screens already use.
   *
   * This is a label, never a second entry. Splitting it into two entries with
   * one path would duplicate the `segments` and `roles` rules that decide who
   * may reach it, and the two copies would drift — which is the exact failure
   * this module was created to end. Resolved in `navFor`, where the segment is
   * already known, so no call site has to remember.
   */
  labels?: Partial<Record<Segment, string>>;
  path: string;
  group: NavGroup;
  /** Omitted = every role. */
  roles?: string[];
  /** Omitted = every vertical. */
  segments?: Segment[];
  /**
   * The entry is meaningful only inside its declared tenant segment, including
   * for Infinity AI staff. This prevents a staff own-account shortcut from
   * mounting a page whose server procedure requires a customer tenant.
   */
  strictSegment?: boolean;
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
  { label: "Dashboard", path: "/dashboard", group: "main", segments: ["retail_commerce", "financial_services", "corporate_b2b", "super_admin"] },
  { label: "Control Fit Brief", path: "/control-fit", group: "main", roles: ["admin", "cfo", "operations"], segments: ["retail_commerce", "financial_services", "corporate_b2b"], strictSegment: true },
  // Corporate B2B pilots run no-write and AI-off by default. Their operators use
  // the governed exception and approval queues below; agent-assisted diagnosis is
  // deliberately not offered until the customer has recorded an approved private
  // AI boundary in Pilot Controls.
  { label: "Super Agent", path: "/super-agent", group: "main", segments: ["financial_services", "super_admin"] },
  { label: "Exception Intelligence", path: "/exception-intelligence", group: "main", segments: ["financial_services", "super_admin"] },
  { label: "Demo Dashboard", path: "/demo-dashboard", group: "main", staffOnly: true },
  { label: "Distributor Registry", path: "/distributors", group: "main", segments: ["corporate_b2b"] },
  { label: "Pilot Controls", path: "/corporate-pilot-controls", group: "main", roles: ["admin", "cfo"], segments: ["corporate_b2b"], strictSegment: true },
  // The remaining retail-only surfaces. These existed ONLY in the portal list
  // before, so a real merchant could not reach the screens the vertical is built
  // around. Secondary to Settlement Monitor, so they stay below the shared entries.
  { label: "Sync Status", path: "/shopline/sync-status", group: "main", segments: ["retail_commerce"] },
  { label: "SHOPLINE Connection", path: "/shopline/connect", group: "main", segments: ["retail_commerce"] },
  { label: "Upload Data", path: "/upload", group: "main", roles: ["admin", "operations"], segments: ["financial_services", "corporate_b2b", "super_admin"] },
  { label: "Reconciliation", path: "/reconciliation", group: "main", roles: ["admin", "operations"], segments: ["financial_services", "corporate_b2b", "super_admin"] },
  { label: "Reports", path: "/reports", group: "main", segments: ["financial_services", "corporate_b2b", "super_admin"] },
  // Scheduled pulls and fleet monitoring are introduced only after the pilot has
  // passed the manual-evidence and recovery gates in Pilot Controls.
  { label: "Schedules", path: "/schedules", group: "main", roles: ["admin", "operations"], segments: ["financial_services", "super_admin"] },
  { label: "Monitor", path: "/monitor", group: "main", segments: ["financial_services", "super_admin"] },
  { label: "Documentation", path: "/documentation", group: "main", segments: ["financial_services", "super_admin"] },

  // ── Admin ─────────────────────────────────────────────────────────────────
  { label: "Multi-Channel", path: "/channels", group: "admin", roles: ["admin", "operations"], segments: ["financial_services", "super_admin"] },
  { label: "Payment Exceptions", path: "/exceptions", group: "admin", roles: ["admin", "operations"], segments: ["retail_commerce", "financial_services", "corporate_b2b", "super_admin"] },
  { label: "Age Tracker", path: "/age-tracker", group: "admin", roles: ["admin", "operations"], segments: ["financial_services", "super_admin"] },
  // One destination, three vocabularies. A bank and an FMCG supplier both call
  // these Transactions; a SHOPLINE merchant reconciles an order leg against a
  // payment leg and calls them Orders & Payments, which is what the retail
  // screens already say.
  //
  // Corporate B2B was added here on 2026-09-20 (owner instruction). It had been
  // excluded from the controlled-pilot surface, and deliberately so — the
  // exclusion was asserted twice in navItems.test.ts, including as an explicit
  // by-URL refusal. Widening it is a pilot-scope decision, not a typo fix, and
  // it is recorded as one. Because `canReachPath` reads this same list, the link
  // and the route grant together; there is no second place to update.
  { label: "Transactions", labels: { retail_commerce: "Orders & Payments" }, path: "/transactions", group: "admin", roles: ["admin", "operations"], segments: ["retail_commerce", "financial_services", "corporate_b2b", "super_admin"] },
  { label: "Review Queue", path: "/review", group: "admin", roles: ["admin", "operations"], segments: ["financial_services", "corporate_b2b", "super_admin"] },
  { label: "Audit Trail", path: "/audit", group: "admin", roles: ["admin", "compliance", "cfo"], segments: ["financial_services", "corporate_b2b", "super_admin"] },
  // Nigerian data protection: the frameworks on this page are NDPA 2023 and
  // NDPR 2019, and its retention guidance is "aligned with CBN records retention
  // guidelines for financial institutions". A SHOPLINE merchant is governed by
  // none of those. Corporate B2B keeps it — an FMCG supplier in Nigeria is
  // squarely within NDPA.
  { label: "Data Protection", path: "/compliance", group: "admin", roles: ["admin", "compliance"], segments: ["financial_services", "corporate_b2b"] },
  // Nigerian banking-regulator pack — financial services only (CLAUDE.md §2A).
  { label: "CBN Reports", path: "/cbn-compliance", group: "admin", roles: ["admin", "compliance", "cfo"], segments: ["financial_services"] },
  { label: "Team Access", path: "/admin/users", group: "admin", roles: ["admin"], segments: ["retail_commerce", "financial_services", "corporate_b2b", "super_admin"] },
  // No `roles` alongside `staffOnly`: staffOnly is already the narrower gate, and
  // a second list only invites the two to disagree.
  { label: "Assessments", path: "/admin/assessments", group: "admin", staffOnly: true },
  { label: "Module Configuration", path: "/modules", group: "admin", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  { label: "Email Settings", path: "/email-settings", group: "admin", roles: ["admin"], segments: ["financial_services", "super_admin"] },

  // ── Advanced tools ────────────────────────────────────────────────────────
  // Seeds a Nigerian banking / FMCG demo: its channels are core_banking (CBS),
  // nibss (NIP) and bank_statement. Offering that to a SHOPLINE merchant invites
  // them to fill their own tenant with transactions from a vertical they are not
  // in, and none of it would reconcile against their orders.
  { label: "Sample Data", path: "/sample-data", group: "advanced", roles: ["admin"], segments: ["financial_services"] },
  { label: "Integrations", path: "/integrations", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  // CBS connectors onboard bank / MFB clients.
  { label: "Core Banking Connector", path: "/woodcore-connector", group: "advanced", roles: ["admin"], segments: ["financial_services"] },
  { label: "API Ingestion", path: "/api-ingestion", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  { label: "SFTP Config", path: "/sftp-config", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  { label: "Bucket Drops", path: "/bucket-config", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  { label: "Email Forwarding", path: "/email-forwarding", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },
  { label: "Anomaly Detection", path: "/anomalies", group: "advanced", roles: ["admin"], segments: ["financial_services", "super_admin"] },

  // ── Super admin (Infinity AI staff) ───────────────────────────────────────
  { label: "Platform Overview", path: "/admin/super-admin", group: "superAdmin", roles: ["super_admin"] },
  { label: "All Organisations", path: "/admin/super-admin/orgs", group: "superAdmin", roles: ["super_admin"] },
  { label: "All Users", path: "/admin/super-admin/users", group: "superAdmin", roles: ["super_admin"] },
  { label: "Platform Analytics", path: "/admin/super-admin/analytics", group: "superAdmin", roles: ["super_admin"] },
  { label: "POC Hub", path: "/admin/poc", group: "superAdmin", roles: ["super_admin"] },
  { label: "Roadmap Access", path: "/admin/roadmap-access", group: "superAdmin", roles: ["super_admin"] },
];

/**
 * What this vertical calls the entry.
 *
 * Falls back to `label` for a vertical with no override, and for a null segment
 * — an unresolved segment must not flash a vertical's private wording at
 * someone who may turn out not to be in it.
 */
export function labelFor(entry: NavEntry, segment: Segment | null): string {
  if (!entry.labels || segment === null) return entry.label;
  return entry.labels[segment] ?? entry.label;
}

/**
 * What this vertical calls the surface at `path` — for the PAGE to use, so its
 * heading and its sidebar entry cannot disagree.
 *
 * Without this a page hardcodes its own title, and a merchant clicks
 * "Orders & Payments" to arrive somewhere headed "Transactions". That was the
 * state before 2026-09-20. Returns undefined for a path with no nav entry, so a
 * caller that mistypes gets nothing rather than a plausible-looking default.
 */
export function labelForPath(path: string, segment: Segment | null): string | undefined {
  const entry = NAV_ITEMS.find((e) => e.path === path);
  return entry ? labelFor(entry, segment) : undefined;
}

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
 *
 * OUTSIDE a portal, staff bypass the segment gate too, and that is the case this
 * function got wrong. Infinity AI's own organisation has segment `super_admin`,
 * so `inSegment` matched none of the vertical-scoped entries and a signed-in
 * super admin lost CBN Reports, Data Protection, Sample Data, Core Banking
 * Connector, Distributor Registry and the retail entries from their sidebar.
 *
 * Every other layer already granted it, which is what made this a disagreement
 * rather than a policy:
 *
 *   shared/verticalFeatures  cbn_regulatory_reporting: [..., "super_admin"]
 *   lib/routeAccess          if (isStaff(role) && !opts.portal) return true
 *   THIS FILE                link hidden
 *
 * So /cbn-compliance loaded perfectly if you typed the URL, and the only thing
 * missing was the way in. A hidden link in front of an open route and an open
 * procedure is the same class of defect as an open route behind a hidden link —
 * this module's own docstring says the two must not be able to disagree.
 *
 * Keyed on the ROLE, like `passesStaffGate` and `canReachPath`, never on the
 * organisation's segment: the two are independently mutable, and reading the
 * segment is precisely how this broke.
 */
export function navFor(
  segment: Segment | null,
  role: string | undefined,
  opts: { portal?: boolean } = {},
): NavEntry[] {
  if (opts.portal) {
    return NAV_ITEMS.filter(
      (e) => e.group !== "superAdmin" && !e.staffOnly && inSegment(e, segment),
    ).map((e) => resolveLabel(e, segment));
  }
  const staff = isStaff(role);
  return NAV_ITEMS.filter(
    (e) => passesStaffGate(e, role) && inRole(e, role) && (e.strictSegment ? inSegment(e, segment) : staff || inSegment(e, segment)),
  ).map((e) => resolveLabel(e, segment));
}

/**
 * Return the entry with `label` already set to this vertical's wording.
 *
 * Done HERE rather than at each call site, for the reason this module exists:
 * the sidebar, the portal sidebar, the mobile header and the page title all read
 * `.label`, and any one of them could forget. `navFor` is the single gate they
 * all pass through, so resolving here means a vertical's wording cannot be right
 * in one place and wrong in another.
 *
 * Returns the entry untouched when there is no override, so entries without
 * `labels` keep their identity and no copy is made for nothing.
 */
function resolveLabel(entry: NavEntry, segment: Segment | null): NavEntry {
  const label = labelFor(entry, segment);
  return label === entry.label ? entry : { ...entry, label };
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
