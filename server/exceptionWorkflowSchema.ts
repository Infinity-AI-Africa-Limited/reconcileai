import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveOrgScope } from "./_core/tenancy";

const workflowDate = z.coerce
  .date()
  .refine(value => Number.isFinite(value.getTime()), {
    message: "A valid workflow due date is required",
  });

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
  }
);

/**
 * Resolves a tenant consistently across all exception-workflow routes. Only
 * platform staff operating outside a tenant portal can name another tenant.
 */
export function resolveExceptionWorkflowScope(
  user: { organizationId: number | null; role: string; isGuest: boolean },
  requestedOrganizationId?: number,
  viewAsOrgId?: number,
): number {
  if (requestedOrganizationId !== undefined && viewAsOrgId !== undefined && requestedOrganizationId !== viewAsOrgId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Conflicting organisation scope was provided." });
  }
  return resolveOrgScope(user, viewAsOrgId ?? requestedOrganizationId);
}
