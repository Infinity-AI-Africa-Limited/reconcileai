import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import {
  approveExceptionWorkflowDecisionInput,
  escalateExceptionWorkflowInput,
  exceptionWorkflowScopeInput,
  recordExceptionWorkflowDecisionInput,
  resolveExceptionWorkflowInput,
  resolveExceptionWorkflowScope,
  startExceptionWorkflowInput,
  updateExceptionWorkflowOwnershipInput,
} from "../exceptionWorkflowSchema";
import {
  approveExceptionWorkflowDecision,
  escalateExceptionWorkflow,
  getExceptionWorkflow,
  listExceptionWorkflowOwners,
  recordExceptionWorkflowDecision,
  resolveExceptionWorkflow,
  startExceptionWorkflow,
  updateExceptionWorkflowOwnership,
} from "../exceptionWorkflow";
import { getClientInfo, operationsProcedure } from "./shared";

function assertWorkflowWriter(user: { role: string; isGuest: boolean }) {
  if (
    user.isGuest ||
    !["super_admin", "admin", "operations"].includes(user.role)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an administrator or operations owner can manage governed exception workflows.",
    });
  }
}

function workflowScope(
  user: { organizationId: number | null; role: string; isGuest: boolean },
  input: { organizationId?: number; viewAsOrgId?: number }
) {
  return resolveExceptionWorkflowScope(user, input.organizationId, input.viewAsOrgId);
}

/**
 * Tenant-scoped workflow controls for material exceptions. This is deliberately
 * separate from the general Exceptions API: enrolling a case here makes the
 * close action fail closed until the stored decision/approval evidence is ready.
 */
export const exceptionWorkflowRouter = router({
  get: protectedProcedure
    .input(exceptionWorkflowScopeInput)
    .query(async ({ ctx, input }) => {
      const organizationId = workflowScope(ctx.user, input);
      return getExceptionWorkflow(organizationId, input.exceptionId);
    }),

  owners: protectedProcedure
    .input(exceptionWorkflowScopeInput.pick({ organizationId: true, viewAsOrgId: true }))
    .query(async ({ ctx, input }) => {
      const organizationId = workflowScope(ctx.user, input);
      return listExceptionWorkflowOwners(organizationId);
    }),

  start: operationsProcedure
    .input(startExceptionWorkflowInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return startExceptionWorkflow({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        ownerUserId: input.ownerUserId,
        dueAt: input.dueAt,
        approvalRequired: input.approvalRequired,
        client: getClientInfo(ctx),
      });
    }),

  updateOwnership: operationsProcedure
    .input(updateExceptionWorkflowOwnershipInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return updateExceptionWorkflowOwnership({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        ownerUserId: input.ownerUserId,
        dueAt: input.dueAt,
        client: getClientInfo(ctx),
      });
    }),

  escalate: operationsProcedure
    .input(escalateExceptionWorkflowInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return escalateExceptionWorkflow({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        note: input.note,
        client: getClientInfo(ctx),
      });
    }),

  recordDecision: operationsProcedure
    .input(recordExceptionWorkflowDecisionInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return recordExceptionWorkflowDecision({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        rationale: input.rationale,
        evidenceReference: input.evidenceReference,
        client: getClientInfo(ctx),
      });
    }),

  approveDecision: operationsProcedure
    .input(approveExceptionWorkflowDecisionInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return approveExceptionWorkflowDecision({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        approvalNote: input.approvalNote,
        client: getClientInfo(ctx),
      });
    }),

  resolve: operationsProcedure
    .input(resolveExceptionWorkflowInput)
    .mutation(async ({ ctx, input }) => {
      assertWorkflowWriter(ctx.user);
      const organizationId = workflowScope(ctx.user, input);
      return resolveExceptionWorkflow({
        actor: ctx.user,
        organizationId,
        exceptionId: input.exceptionId,
        outcome: input.outcome,
        resolutionNotes: input.resolutionNotes,
        client: getClientInfo(ctx),
      });
    }),
});
