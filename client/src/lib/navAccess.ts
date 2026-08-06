/**
 * Who sees which navigation entry.
 *
 * Two independent gates, and they answer different questions:
 *
 *   roles    — "is this person allowed to do it?"      (admin / operations / …)
 *   segments — "does this exist in their vertical?"    (CBN reports, distributors)
 *
 * `NavItem.segments` was declared when the four-portal architecture landed and
 * then never read. The consequence was not cosmetic: the segment-specific navs
 * (`retailCommerceMenuItems` and friends) are only selected when a super admin
 * ENTERS a tenant portal, so a merchant logging in normally fell through to the
 * default list — filtered by role alone. A SHOPLINE admin's sidebar therefore
 * offered "Distributor Registry" (an FMCG registry they have no rows in) and
 * "CBN Reports" (a Nigerian banking-regulator pack they are not subject to).
 *
 * IMPORTANT: this is presentation, not authorisation. Hiding an entry removes a
 * link, never access — the route and its procedures remain reachable. Anything
 * that must be denied has to be denied server-side; see the assessment lead
 * pipeline, which looked gated because its nav entry was `roles: ["admin"]`
 * while the procedures behind it were reachable by every tenant's admin.
 */
import type { Segment } from "./segments";

export type NavAccessItem = {
  roles?: string[];
  /** Verticals this entry exists in. Omitted = every vertical. */
  segments?: Segment[];
};

/**
 * `segment` may be null while the lookup is in flight. An entry with a segment
 * restriction stays HIDDEN until the segment is known, so a merchant never sees
 * "CBN Reports" flash into the sidebar and disappear. Unrestricted entries are
 * unaffected, so the sidebar is never empty while loading.
 */
export function canAccessNav(
  item: NavAccessItem,
  userRole: string | undefined,
  segment: Segment | null,
): boolean {
  if (!passesRole(item, userRole)) return false;
  return passesSegment(item, userRole, segment);
}

function passesRole(item: NavAccessItem, userRole: string | undefined): boolean {
  if (!item.roles) return true;
  if (!userRole) return false;
  // super_admin sees everything except entries explicitly scoped to super_admin,
  // which are gated by the role list itself.
  if (userRole === "super_admin" && !item.roles.includes("super_admin")) return true;
  return item.roles.includes(userRole);
}

function passesSegment(
  item: NavAccessItem,
  userRole: string | undefined,
  segment: Segment | null,
): boolean {
  if (!item.segments) return true;
  // Infinity AI staff work across every tenant, so segment restrictions do not
  // apply to them — otherwise the platform operator would lose the very screens
  // they support customers with.
  if (userRole === "super_admin") return true;
  return segment !== null && item.segments.includes(segment);
}
