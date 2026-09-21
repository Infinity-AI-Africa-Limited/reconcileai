/**
 * The super-admin portal, decided ONCE per request.
 *
 * "Enter Portal" lets Infinity AI staff see the app as a tenant sees it. It was
 * client state only: the server heard about it solely when a procedure accepted
 * a `viewAsOrgId` input and passed it through `portalScopedOrgId`. Six sections
 * were fixed that way, then two more, and roughly fifty query sites still read
 * the super admin's OWN organisation — Infinity AI's, which holds nothing — so
 * those screens rendered empty inside a tenant's portal. Every round of fixes
 * was a page where one query had been forgotten.
 *
 * So the rule now lives at the one gate every tRPC call crosses: context
 * creation. The browser sends the portal tenant in a header on every request;
 * for a super admin, that tenant becomes the request's EFFECTIVE organisation
 * (`ctx.user.organizationId`). Every existing read, write and tenancy helper
 * that already keys on the caller's organisation now answers for the tenant on
 * screen, including ones written after this.
 *
 * ── The security property ─────────────────────────────────────────────
 *
 * Only `super_admin` may view as another organisation. For anyone else the
 * header is ignored outright — they read and write their own organisation
 * exactly as before, so a tenant user who forges the header learns nothing.
 *
 * ── Failing closed ─────────────────────────────────────────────────────
 *
 * A super admin whose header names a tenant that does not exist (deleted while
 * they were viewing it, or a malformed value) gets NO organisation for that
 * request, not their own. Falling back to Infinity AI would let a write meant
 * for the tenant on screen land in the operator's organisation, with the UI
 * still showing the tenant's name — a control that says "saved" about a
 * different tenant is worse than one that refuses. Org-scoped writes refuse a
 * caller with no organisation (runOwner, requireOrg).
 *
 * `actor` is the account as it signed in, unchanged; `auth.me` returns it.
 */
import type { User } from "../../drizzle/schema";

/** The request header that carries the portal tenant's organisation id. */
export const PORTAL_ORG_HEADER = "x-portal-org";

/** A positive integer organisation id from the header, or null. */
export function parsePortalOrgHeader(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export interface PortalView {
  /** The user procedures see: the actor, with the portal tenant as their organisation. */
  user: User | null;
  /** The account as it signed in. */
  actor: User | null;
  /** The tenant being viewed, or null outside a portal. */
  viewingAs: number | null;
}

/**
 * Apply the portal header to an authenticated user. `orgExists` is injected so
 * the rule is testable without a database.
 */
export async function applyPortalView(
  actor: User | null,
  header: string | string[] | undefined,
  orgExists: (id: number) => Promise<boolean>,
): Promise<PortalView> {
  const present = Array.isArray(header) ? header.length > 0 : header !== undefined && header !== "";
  if (!actor || actor.role !== "super_admin" || !present) return { user: actor, actor, viewingAs: null };

  const orgId = parsePortalOrgHeader(header);
  if (orgId === null || !(await orgExists(orgId))) {
    // Fail closed: no organisation, never the operator's own. See header.
    return { user: { ...actor, organizationId: null }, actor, viewingAs: null };
  }
  return { user: { ...actor, organizationId: orgId }, actor, viewingAs: orgId };
}
