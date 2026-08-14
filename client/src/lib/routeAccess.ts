/**
 * Where a vertical lands, and which routes it may open.
 *
 * Both answers are derived from NAV_ITEMS rather than restated, because the
 * failure this closes is the two disagreeing: PR #52 annotated `segments` so a
 * merchant stops SEEING entries built for other verticals, but the routes behind
 * them stayed open. Typing /distributors as a retail merchant loaded the page and
 * then filled it with permission errors from the server — guarded, technically,
 * and a broken screen in practice.
 *
 * NOT AUTHORISATION, for the same reason navItems is not: this decides what the
 * client OFFERS. The server refuses independently (`distributorProcedure`,
 * `cbnProcedure`, shared/verticalFeatures). A redirect here is a courtesy — it
 * sends someone to a page that means something to them instead of one that
 * errors. Never the only thing standing between a caller and data.
 */
import { NAV_ITEMS, inSegment, isStaff, passesStaffGate } from "./navItems";
import type { Segment } from "./segments";

/**
 * Where this vertical should land after signing in.
 *
 * A SHOPLINE merchant's question is "did my payout land, and what is missing" —
 * Settlement Monitor answers exactly that. The dashboard answers "how is
 * reconciliation performing", which is an operator's question; it stays in the
 * sidebar as a secondary overview rather than being the first thing a merchant
 * sees. Every other vertical keeps the dashboard, where that framing is right.
 */
export function landingPathFor(segment: Segment | null): string {
  return segment === "retail_commerce" ? "/settlement-monitor" : "/dashboard";
}

/**
 * Segment-scoped routes that are not sidebar entries, so NAV_ITEMS cannot supply
 * their rule.
 *
 * /dashboard/auditor is reached from the RoleSwitcher tabs rather than the
 * sidebar. It is examination-facing — audit-trail volume and a "compliance rate"
 * framed for a supervisor's examiner — and a retail merchant answers to card
 * schemes, not an examiner (CLAUDE.md §2A). Listed as the segments that DO get
 * it, not as "not retail", so it reads the same way as a NAV_ITEMS entry.
 */
const NON_NAV_ROUTE_SEGMENTS: Record<string, Segment[]> = {
  "/dashboard/auditor": ["financial_services", "corporate_b2b", "super_admin"],
  // SHOPLINE install callbacks. Reached from the OAuth redirect rather than any
  // link, and retail through and through — "Store Connected Successfully!", sync
  // schedules, payouts. See canReachCallback for why they need their own gate.
  "/shopline/welcome": ["retail_commerce"],
  "/shopline/error": ["retail_commerce"],
};

/**
 * Match the router's own tolerance, or the guard is trivially bypassed.
 *
 * wouter compiles `/distributors` through regexparam into
 * `/^\/distributors\/?$/i` — a trailing slash is optional and the match is
 * case-INSENSITIVE. So `/distributors/` and `/Distributors` both load the page
 * while an exact-string lookup here finds no entry, reports the route as
 * unscoped, and lets a merchant straight into the screen this guard exists to
 * keep them out of.
 *
 * Anything comparing a path against a route table has to normalise the same way
 * the router does. Verified against regexparam 3.0.0 rather than assumed.
 */
function normalizePath(path: string): string {
  const trimmed = path.toLowerCase().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The segments a path is built for, or null when it is for everyone. */
export function segmentsForPath(path: string): Segment[] | null {
  const key = normalizePath(path);
  const extra = NON_NAV_ROUTE_SEGMENTS[key];
  if (extra) return extra;
  return NAV_ITEMS.find((e) => normalizePath(e.path) === key)?.segments ?? null;
}

/**
 * Is this path an Infinity AI staff tool?
 *
 * `staffOnly` was honoured by the sidebar and by nothing else, so both entries
 * carrying it were reachable by typing the URL:
 *
 *   /demo-dashboard    — the BrightGoods FMCG sales tool, whose buttons seed
 *                        fabricated transactions, distributors and agent-memory
 *                        records into the CALLER'S OWN tenant. A bank reaching
 *                        this is a data-integrity problem, not a cosmetic one.
 *   /admin/assessments — Infinity AI's own lead pipeline. Its procedures are
 *                        super_admin, so a tenant admin who typed the URL got the
 *                        page and then a screenful of permission errors — the
 *                        "guarded, technically, and a broken screen in practice"
 *                        failure this module was written to end.
 *
 * Derived from NAV_ITEMS like everything else here, so marking a new entry
 * `staffOnly` gates its route in the same edit that hides its link.
 */
export function isStaffPath(path: string): boolean {
  const key = normalizePath(path);
  return NAV_ITEMS.some((e) => normalizePath(e.path) === key && e.staffOnly === true);
}

/**
 * May this viewer open this path?
 *
 * Delegates the comparison to `inSegment`, so the link and the route cannot
 * drift: an entry hidden from a vertical is also unreachable by it, by
 * construction rather than by two lists agreeing.
 *
 * Staff pass everything — EXCEPT inside a portal. That exception is the whole
 * subtlety, and leaving it out made the guard wrong in the one place a super
 * admin actually looks at a tenant's surface. `navFor` has always drawn the same
 * line: entering a portal drops ROLE gating, because staff are looking at the
 * tenant's screens rather than exercising their own permissions, but keeps
 * SEGMENT gating, because seeing what that vertical has IS the point of the
 * portal. A route guard that bypasses on role alone contradicts it: the sidebar
 * correctly omits Distributor Registry from a retail portal, and /distributors
 * loads anyway — a page the tenant could never reach, inside the view that is
 * supposed to represent them. Observed in production on the SHOPLINE dev store.
 *
 * Outside a portal the bypass is right: a super admin on their own account is
 * the platform operator, and redirecting them off a URL they typed deliberately
 * would be obstruction rather than safety.
 *
 * A null segment refuses a scoped path, matching `inSegment` exactly. Callers
 * must therefore not consult this while the segment is still resolving — see
 * SegmentGuard, which waits.
 */
export function canReachPath(
  path: string,
  segment: Segment | null,
  role: string | undefined,
  opts: { portal?: boolean } = {},
): boolean {
  if (isStaff(role) && !opts.portal) return true;
  // Past this line the viewer is not staff (or is inside a portal, where the
  // point is to see the TENANT's surface). Either way a staff tool is refused —
  // `navFor` excludes staffOnly entries from a portal for the same reason.
  if (isStaffPath(path)) return false;
  const segments = segmentsForPath(path);
  if (!segments) return true;
  return inSegment({ label: "", path, group: "main", segments }, segment);
}

/**
 * The same rule for an OAuth callback landing, where "no segment" is the NORMAL
 * case rather than a suspicious one.
 *
 * `/shopline/welcome` is where SHOPLINE sends a merchant after they authorise the
 * install (server/connectors/shopline/routes.ts). No session cookie is set on
 * that redirect, so the merchant arrives signed OUT — and `canReachPath` refuses
 * a scoped path on a null segment, matching how the sidebar hides it. Applying it
 * unchanged would therefore bounce the very merchant the page exists for, and
 * mounting the route through DashboardPage would put it behind the dashboard's
 * authentication, which breaks the same flow more thoroughly.
 *
 * So the exception is granted to viewers with NO SESSION, and to nobody else.
 *
 * It is keyed on `signedIn` rather than on `segment === null`, and that
 * distinction is the whole correctness of this function. A null segment has three
 * causes: no session, a signed-in org with no segment set, and a segment query
 * that FAILED — and `useOrgSegmentStatus` uses `retry: false`, so one failed
 * request keeps the answer null for the life of the page. Treating null as "must
 * be the install flow" hands the retail completion screen to a signed-in bank
 * whose lookup happened to fail. Absence of an answer is not evidence of who is
 * asking.
 *
 * A signed-in viewer whose segment cannot be determined is therefore refused and
 * sent to their own landing page. They have somewhere to go, so failing closed
 * costs them nothing; the signed-out merchant has nowhere, which is why they get
 * the exception.
 *
 * That leaves the page reachable by a signed-out stranger, which is deliberate
 * and costs nothing: it renders static copy, calls no procedure, and reads only
 * an `org` code from the query string that it never looks up.
 */
export function canReachCallback(
  path: string,
  segment: Segment | null,
  role: string | undefined,
  opts: { portal?: boolean; signedIn?: boolean } = {},
): boolean {
  if (!opts.signedIn) return true;
  return canReachPath(path, segment, role, opts);
}
