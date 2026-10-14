import { TRPCError } from "@trpc/server";
import { canManageExceptionWorkflows } from "@shared/exceptionWorkflowRules";
import { protectedProcedure, router } from "../_core/trpc";
import { afterExceptionClosed } from "../exceptionClosureEffects";
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

/**
 * Every write passes `operationsProcedure` (no guests, CFO or compliance) and
 * then the shared writer rule, which the workspace also reads to decide what
 * to offer. A builder, so a write procedure added later cannot forget it.
 */
const workflowWriteProcedure = operationsProcedure.use(({ ctx, next }) => {
  if (!canManageExceptionWorkflows(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only an administrator or operations owner can manage governed exception workflows.",
    });
  }
  return next();
});

/**
 * Tenant-scoped workflow controls for material exceptions. Separate from the
 * general Exceptions API: enrolling a case here makes closing it fail closed
 * until the stored decision (and any required approval) is ready.
 */
export const exceptionWorkflowRouter = router({
  get: protectedProcedure.input(exceptionWorkflowScopeInput).query(({ ctx, input }) =>
    getExceptionWorkflow(resolveExceptionWorkflowScope(ctx.user, input), input.exceptionId)
  ),

  // Writers only: it lists colleagues with their email addresses, to choose an owner.
  owners: workflowWriteProcedure
    .input(exceptionWorkflowScopeInput.pick({ organizationId: true, viewAsOrgId: true }))
    .query(({ ctx, input }) => listExceptionWorkflowOwners(resolveExceptionWorkflowScope(ctx.user, input))),

  start: workflowWriteProcedure.input(startExceptionWorkflowInput).mutation(({ ctx, input }) =>
    startExceptionWorkflow({
      actor: ctx.user,
      organizationId: resolveExceptionWorkflowScope(ctx.user, input),
      exceptionId: input.exceptionId,
      ownerUserId: input.ownerUserId,
      dueAt: input.dueAt,
      approvalRequired: input.approvalRequired,
      client: getClientInfo(ctx),
    })
  ),

  updateOwnership: workflowWriteProcedure.input(updateExceptionWorkflowOwnershipInput).mutation(({ ctx, input }) =>
    updateExceptionWorkflowOwnership({
      actor: ctx.user,
      organizationId: resolveExceptionWorkflowScope(ctx.user, input),
      exceptionId: input.exceptionId,
      ownerUserId: input.ownerUserId,
      dueAt: input.dueAt,
      client: getClientInfo(ctx),
    })
  ),

  escalate: workflowWriteProcedure.input(escalateExceptionWorkflowInput).mutation(({ ctx, input }) =>
    escalateExceptionWorkflow({
      actor: ctx.user,
      organizationId: resolveExceptionWorkflowScope(ctx.user, input),
      exceptionId: input.exceptionId,
      note: input.note,
      client: getClientInfo(ctx),
    })
  ),

  recordDecision: workflowWriteProcedure.input(recordExceptionWorkflowDecisionInput).mutation(({ ctx, input }) =>
    recordExceptionWorkflowDecision({
      actor: ctx.user,
      organizationId: resolveExceptionWorkflowScope(ctx.user, input),
      exceptionId: input.exceptionId,
      rationale: input.rationale,
      evidenceReference: input.evidenceReference,
      client: getClientInfo(ctx),
    })
  ),

  approveDecision: workflowWriteProcedure.input(approveExceptionWorkflowDecisionInput).mutation(({ ctx, input }) =>
    approveExceptionWorkflowDecision({
      actor: ctx.user,
      organizationId: resolveExceptionWorkflowScope(ctx.user, input),
      exceptionId: input.exceptionId,
      approvalNote: input.approvalNote,
      client: getClientInfo(ctx),
    })
  ),

  resolve: workflowWriteProcedure.input(resolveExceptionWorkflowInput).mutation(async ({ ctx, input }) => {
    const organizationId = resolveExceptionWorkflowScope(ctx.user, input);
    const closed = await resolveExceptionWorkflow({
      actor: ctx.user,
      organizationId,
      exceptionId: input.exceptionId,
      outcome: input.outcome,
      resolutionNotes: input.resolutionNotes,
      client: getClientInfo(ctx),
    });
    // After the commit: the same learning and webhook as any other closure.
    void afterExceptionClosed({
      organizationId,
      exceptionId: input.exceptionId,
      userId: ctx.user.id,
      outcome: input.outcome,
      resolutionNotes: input.resolutionNotes,
    });
    return closed;
  }),
});
