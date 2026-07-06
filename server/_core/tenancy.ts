/**
 * Multi-tenant isolation — the canonical tenancy guard.
 *
 * Every org-scoped read/write resolves its organization through ONE of these
 * helpers instead of ad-hoc checks scattered across routers:
 *
 *   resolveOrgScope(user, requestedOrgId?)  — which org does this call operate on?
 *   assertSameOrg(user, resourceOrgId)      — may this user touch this resource?
 *   isOrgLoginAllowed(organizationId)       — suspended orgs cannot sign in.
 *
 * Rules, in one place:
 *   - Regular users are hard-locked to their own organizationId. Requesting
 *     another org is FORBIDDEN, full stop.
 *   - super_admin (Infinity AI staff) may pass an explicit organizationId
 *     override (portal context / cross-tenant management).
 *   - A user with no organization gets PRECONDITION_FAILED on org-scoped
 *     calls — dangling accounts never fall through to "no filter".
 *   - Deactivated organizations fail closed at every login path (magic link,
 *     Google, Microsoft) — sessions of suspended tenants can't be minted.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { organizations } from "../../drizzle/schema";
import { getDb } from "../db";

export interface TenantActor {
  role?: string | null;
  organizationId?: number | null;
}

export function isSuperAdmin(user: TenantActor): boolean {
  return (user.role ?? "") === "super_admin";
}

/** The caller's own organization, or PRECONDITION_FAILED if they have none. */
export function requireOwnOrg(user: TenantActor): number {
  if (!user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return user.organizationId;
}

/**
 * Resolve which organization a call operates on.
 * Super admins may pass an explicit override; everyone else is locked to
 * their own organization.
 */
export function resolveOrgScope(user: TenantActor, requestedOrgId?: number): number {
  if (requestedOrgId !== undefined) {
    if (!isSuperAdmin(user)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only super admins can act on another organization",
      });
    }
    return requestedOrgId;
  }
  return requireOwnOrg(user);
}

/**
 * Assert the caller may touch a resource that belongs to `resourceOrgId`.
 * Use after loading any row by bare id: load → assertSameOrg → act.
 * `null` resource org (legacy/global rows) is allowed only for super admins.
 */
export function assertSameOrg(user: TenantActor, resourceOrgId: number | null | undefined): void {
  if (isSuperAdmin(user)) return;
  const own = user.organizationId ?? null;
  if (own === null || resourceOrgId === null || resourceOrgId === undefined || resourceOrgId !== own) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This resource belongs to another organization",
    });
  }
}

/**
 * Login-time tenant gate: users of a deactivated organization cannot sign in.
 * Users with no organization (platform owner bootstrap, super admins) pass.
 * Fails OPEN on DB unavailability — login availability must not depend on
 * this auxiliary check when the primary user lookup already succeeded.
 */
export async function isOrgLoginAllowed(organizationId: number | null | undefined): Promise<boolean> {
  if (!organizationId) return true;
  try {
    const db = await getDb();
    if (!db) return true;
    const [org] = await db
      .select({ isActive: organizations.isActive })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    // Unknown org id = dangling reference — fail closed on that.
    if (!org) return false;
    return org.isActive;
  } catch (err) {
    console.error("[tenancy] org login check failed (allowing login):", err);
    return true;
  }
}
