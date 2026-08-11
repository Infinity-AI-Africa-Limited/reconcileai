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
import { NAV_ITEMS, inSegment, isStaff } from "./navItems";
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
 * May this viewer open this path?
 *
 * Delegates the comparison to `inSegment`, so the link and the route cannot
 * drift: an entry hidden from a vertical is also unreachable by it, by
 * construction rather than by two lists agreeing.
 *
 * Staff pass everything. A super admin is the platform operator, their sidebar
 * already reflects whichever portal they are in, and the server checks their own
 * organisation's segment on every procedure regardless. Redirecting them away
 * from a URL they typed deliberately would be obstruction, not safety.
 *
 * A null segment refuses a scoped path, matching `inSegment` exactly. Callers
 * must therefore not consult this while the segment is still resolving — see
 * SegmentGuard, which waits.
 */
export function canReachPath(
  path: string,
  segment: Segment | null,
  role: string | undefined,
): boolean {
  if (isStaff(role)) return true;
  const segments = segmentsForPath(path);
  if (!segments) return true;
  return inSegment({ label: "", path, group: "main", segments }, segment);
}
