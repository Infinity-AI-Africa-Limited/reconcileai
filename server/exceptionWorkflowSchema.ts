import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveOrgScope } from "./_core/tenancy";
import { isStorableTimestamp, STORABLE_TIMESTAMP_MESSAGE } from "./storableTimestamp";

/**
 * A due date as the workspace sends it (a Date through superjson, or ISO text).
 * `dueAt` is a TIMESTAMP column, so a date outside its range is refused here
 * with a reason rather than failing the insert as a masked 500. "In the future"
 * is checked by the service against its own clock.
 */
const workflowDate = z.coerce
  .date()
  .refine(value => Number.isFinite(value.getTime()), {
    message: "A valid workflow due date is required",
  })
  .refine(isStorableTimestamp, { message: STORABLE_TIMESTAMP_MESSAGE });

const boundedText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

export const exceptionWorkflowScopeInput = z.object({
  /** Keeps a portal-view query cache-separated from the signed-in organisation. */
  viewAsOrgId: z.number().int().positive().optional(),
  exceptionId: z.number().int().positive(),
  organizationId: z.number().int().positive().optional(),
});

export const startExceptionWorkflowInput = exceptionWorkflowScopeInput.extend({
  ownerUserId: z.number().int().positive(),
  dueAt: workflowDate,
  approvalRequired: z.boolean().default(true),
});

export const updateExceptionWorkflowOwnershipInput =
  exceptionWorkflowScopeInput.extend({
    ownerUserId: z.number().int().positive(),
    dueAt: workflowDate,
  });

export const escalateExceptionWorkflowInput =
  exceptionWorkflowScopeInput.extend({
    note: boundedText("Escalation note", 2_000),
  });

export const recordExceptionWorkflowDecisionInput =
  exceptionWorkflowScopeInput.extend({
    rationale: boundedText("Decision rationale", 4_000),
    evidenceReference: boundedText("Decision evidence reference", 500),
  });

export const approveExceptionWorkflowDecisionInput =
  exceptionWorkflowScopeInput.extend({
    approvalNote: boundedText("Approval note", 2_000),
  });

export const resolveExceptionWorkflowInput = exceptionWorkflowScopeInput.extend(
  {
    outcome: z.enum(["resolved", "dismissed"]),
    resolutionNotes: boundedText("Resolution notes", 2_000),
    // Required by the service only after the due monitor has recorded an
    // elapsed due date. Optional at the boundary keeps ordinary on-time closes
    // unchanged and makes an ungoverned close impossible to broaden here.
    lateResolutionReason: boundedText("Late-resolution reason", 2_000).optional(),
  }
);

/**
 * Resolves a tenant consistently across all exception-workflow routes. Only
 * platform staff operating outside a tenant portal can name another tenant.
 */
export function resolveExceptionWorkflowScope(
  user: { organizationId: number | null; role: string; isGuest: boolean },
  input: { organizationId?: number; viewAsOrgId?: number },
): number {
  const { organizationId: requestedOrganizationId, viewAsOrgId } = input;
  if (requestedOrganizationId !== undefined && viewAsOrgId !== undefined && requestedOrganizationId !== viewAsOrgId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Conflicting organisation scope was provided." });
  }
  return resolveOrgScope(user, viewAsOrgId ?? requestedOrganizationId);
}
