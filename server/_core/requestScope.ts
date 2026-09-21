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
 * Two kinds of reader: the audit default (logAudit), and the by-id gates that
 * narrow staff reach to the tenant on screen (canActOnTenant,
 * assertCanManageUsers, tenancy.assertSameOrg). Platform procedures
 * (superAdminProcedure) re-bind the scope to "no portal", because they act for
 * the platform whatever tenant happens to be open in the tab.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestScope {
  /** The tenant a super admin is viewing through the portal, or null. */
  portalOrganizationId: number | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The portal tenant of the current tRPC call, or null (not in a portal, or not in a call). */
export function currentPortalOrganizationId(): number | null {
  return storage.getStore()?.portalOrganizationId ?? null;
}
