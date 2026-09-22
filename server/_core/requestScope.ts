/**
 * Per-request facts that deep helpers need but are not handed.
 *
 * `logAudit` has 81 call sites and takes a user id, not a context. When a
 * super admin acts inside a tenant's portal, the audit entry must name that
 * tenant — the portal write rule (routers/shared.ts, portalScopedOrgId) permits
 * such a write only if its record lands in the trail of the organisation it
 * changed. Threading the tenant through 81 calls would be the same "fix each
 * site" approach that left fifty reads unscoped. Instead the tRPC base
 * procedure opens this scope for every call, and the audit helper reads it.
 *
 * AsyncLocalStorage carries the scope through every await in the procedure.
 * Outside a tRPC call (background jobs, webhooks) there is no scope and the
 * helpers behave exactly as before.
 *
 * Two kinds of reader, and they need DIFFERENT facts — which is why the scope
 * holds two fields rather than one:
 *
 *   - the by-id gates that narrow STAFF reach to the tenant on screen
 *     (canActOnTenant, assertCanManageUsers, tenancy.assertSameOrg) read the
 *     portal. Outside a portal staff reach every tenant, so this must stay null
 *     there — it is not "the caller's organisation".
 *   - the audit default (logAudit) reads the organisation the request acts for:
 *     a tenant user's own organisation, or the portal tenant for staff. Keyed
 *     on the portal alone, it filed every ordinary user's action — a bank's own
 *     staff resolving exceptions, approving matches, uploading files — in the
 *     GLOBAL chain, which no tenant's Audit Trail, export or verification reads.
 *
 * Platform procedures (superAdminProcedure) re-bind both to null, because they
 * act for the platform whatever tenant happens to be open in the tab.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isTenantId } from "@shared/tenantId";

interface RequestScope {
  /** The tenant a super admin is viewing through the portal, or null. */
  portalOrganizationId: number | null;
  /** The tenant this request's audit records belong to by default, or null for the global chain. */
  auditOrganizationId: number | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The portal tenant of the current tRPC call, or null (not in a portal, or not in a call). */
export function currentPortalOrganizationId(): number | null {
  return storage.getStore()?.portalOrganizationId ?? null;
}

/** The tenant an audit record written now belongs to by default, or null (global chain, or not in a call). */
export function currentAuditOrganizationId(): number | null {
  return storage.getStore()?.auditOrganizationId ?? null;
}

/**
 * The tenant a request acts for, for its audit records.
 *
 *   - staff inside a portal → the tenant on screen (the portal already made it
 *     `organizationId`, but only a portal says staff are acting FOR a tenant);
 *   - staff outside a portal → null. They act for the platform: its dashboards,
 *     cross-tenant user management and settings. Where such an action is about
 *     one tenant's row, the call site names that tenant — the default cannot;
 *   - everyone else → their own organisation, if it is a tenant. Organisation
 *     0 or none means NO tenant, and the record joins the global chain rather
 *     than a pseudo-tenant nobody can read (CLAUDE.md §9C).
 */
export function auditOrganizationFor(
  user: { role: string; organizationId: number | null } | null | undefined,
  viewingAs: number | null | undefined,
): number | null {
  if (!user) return null;
  if (user.role === "super_admin") return isTenantId(viewingAs) ? viewingAs : null;
  return isTenantId(user.organizationId) ? user.organizationId : null;
}
