import { protectedProcedure, router } from "../_core/trpc";
import {
  activateControlPolicyInput,
  approveControlPolicyInput,
  assertControlPolicyWriter,
  controlPolicyScopeInput,
  createControlPolicyInput,
  resolveControlPolicyScope,
  retireControlPolicyInput,
} from "../controlPolicySchema";
import {
  activateControlPolicy,
  approveControlPolicy,
  createControlPolicy,
  listControlPolicies,
  retireControlPolicy,
} from "../controlPolicyStore";
import { getClientInfo, operationsProcedure } from "./shared";

/**
 * Immutable, tenant-scoped mapping and reconciliation policy registry.
 * Existing run admission does not consume these records in this increment: a
 * future reviewed release must explicitly bind an admitted run to an active,
 * versioned policy rather than change matching behaviour implicitly.
 */
export const controlPoliciesRouter = router({
  list: protectedProcedure
    .input(controlPolicyScopeInput)
    .query(async ({ ctx, input }) => {
      const organizationId = resolveControlPolicyScope(
        ctx.user,
        input.organizationId
      );
      return listControlPolicies(organizationId, input);
    }),

  createDraft: operationsProcedure
    .input(createControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(
        ctx.user,
        input.organizationId
      );
      return createControlPolicy({
        actor: ctx.user,
        organizationId,
        input,
        client: getClientInfo(ctx),
      });
    }),

  approve: operationsProcedure
    .input(approveControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(
        ctx.user,
        input.organizationId
      );
      return approveControlPolicy({
        actor: ctx.user,
        organizationId,
        input,
        client: getClientInfo(ctx),
      });
    }),

  activate: operationsProcedure
    .input(activateControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(
        ctx.user,
        input.organizationId
      );
      return activateControlPolicy({
        actor: ctx.user,
        organizationId,
        input,
        client: getClientInfo(ctx),
      });
    }),

  retire: operationsProcedure
    .input(retireControlPolicyInput)
    .mutation(async ({ ctx, input }) => {
      assertControlPolicyWriter(ctx.user);
      const organizationId = resolveControlPolicyScope(
        ctx.user,
        input.organizationId
      );
      return retireControlPolicy({
        actor: ctx.user,
        organizationId,
        input,
        client: getClientInfo(ctx),
      });
    }),
});
