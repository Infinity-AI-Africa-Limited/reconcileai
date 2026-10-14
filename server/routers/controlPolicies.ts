import { protectedProcedure, router } from "../_core/trpc";
import {
  activateControlPolicyInput,
  approveControlPolicyInput,
  assertControlPolicyWriter,
  controlPolicyScopeInput,
  createControlPolicyInput,
  getControlPolicyInput,
  resolveControlPolicyScope,
  retireControlPolicyInput,
} from "../controlPolicySchema";
import {
  activateControlPolicy,
  approveControlPolicy,
  createControlPolicy,
  getControlPolicy,
  listControlPolicies,
  retireControlPolicy,
} from "../controlPolicyStore";
import { getClientInfo, operationsProcedure } from "./shared";

/**
 * Immutable, tenant-scoped mapping and reconciliation policy registry.
 * Existing run admission does not consume these records in this increment: a
 * future reviewed release must explicitly bind an admitted run to an active,
 * versioned policy rather than change matching behaviour implicitly.
 *
 * Reads are open to anyone in the tenant. Writes pass `operationsProcedure`
 * (no guests, CFO or compliance) and then the writer allow-list; the tenant is
 * resolved by `resolveOrgScope`, so only staff may name another organisation,
 * and never from inside a different tenant's portal.
 */
export const controlPoliciesRouter = router({
  list: protectedProcedure
    .input(controlPolicyScopeInput)
    .query(async ({ ctx, input }) => {
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return listControlPolicies(organizationId, input);
    }),

  get: protectedProcedure
    .input(getControlPolicyInput)
    .query(async ({ ctx, input }) => {
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return getControlPolicy(organizationId, input.policyId);
    }),

  createDraft: operationsProcedure
    .input(createControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return createControlPolicy({ actor: ctx.user, organizationId, input, client: getClientInfo(ctx) });
    }),

  approve: operationsProcedure
    .input(approveControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return approveControlPolicy({ actor: ctx.user, organizationId, input, client: getClientInfo(ctx) });
    }),

  activate: operationsProcedure
    .input(activateControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return activateControlPolicy({ actor: ctx.user, organizationId, input, client: getClientInfo(ctx) });
    }),

  retire: operationsProcedure
    .input(retireControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(ctx.user, input.organizationId);
      return retireControlPolicy({ actor: ctx.user, organizationId, input, client: getClientInfo(ctx) });
    }),
});
