import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveOrgScope } from "./_core/tenancy";
import type { ControlEvidenceActor } from "./controlEvidenceSchema";

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const dateInput = z
  .string()
  .datetime({ offset: true })
  .transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid ISO date-time" });
      return z.NEVER;
    }
    return date;
  });

export const CONTROL_POLICY_TYPES = ["mapping", "reconciliation"] as const;
export const CONTROL_POLICY_STATUSES = [
  "draft",
  "approved",
  "active",
  "retired",
] as const;
export const CONTROL_POLICY_PAGE_MAX = 200;
export const CONTROL_POLICY_PAGE_DEFAULT = 50;

export const controlPolicyType = z.enum(CONTROL_POLICY_TYPES);
export const controlPolicyStatus = z.enum(CONTROL_POLICY_STATUSES);

/**
 * A policy definition is configuration, not source evidence: it must never
 * contain source-file rows, customer identities, access credentials, or raw
 * webhook payloads. It stays tenant-scoped so approved customer configuration
 * never becomes platform-wide reference data.
 */
const policyDefinition = z
  .record(z.string().trim().min(1).max(120), z.unknown())
  .refine(value => JSON.stringify(value).length <= 50_000, {
    message: "Policy definition must be at most 50 KB when serialized.",
  });

export const createControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyType: controlPolicyType,
    policyKey: nonEmptyText(100),
    version: z.number().int().positive(),
    displayName: nonEmptyText(255),
    description: nonEmptyText(2_000),
    definition: policyDefinition,
    effectiveAt: dateInput,
  })
  .strict();

export const approveControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
    approvalReference: nonEmptyText(255),
  })
  .strict();

export const activateControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
  })
  .strict();

export const retireControlPolicyInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyId: z.number().int().positive(),
    retirementReference: nonEmptyText(255),
    retiredAt: dateInput,
  })
  .strict();

export const controlPolicyScopeInput = z
  .object({
    organizationId: z.number().int().positive().optional(),
    policyType: controlPolicyType.optional(),
    policyKey: nonEmptyText(100).optional(),
    status: controlPolicyStatus.optional(),
    limit: z.number().int().min(1).max(CONTROL_POLICY_PAGE_MAX).optional(),
  })
  .strict();

export type ControlPolicyActor = ControlEvidenceActor;
export type ControlPolicyScope = z.infer<typeof controlPolicyScopeInput>;
export type CreateControlPolicyInput = z.infer<typeof createControlPolicyInput>;
export type ApproveControlPolicyInput = z.infer<
  typeof approveControlPolicyInput
>;
export type ActivateControlPolicyInput = z.infer<
  typeof activateControlPolicyInput
>;
export type RetireControlPolicyInput = z.infer<typeof retireControlPolicyInput>;

export function assertControlPolicyWriter(actor: ControlPolicyActor): void {
  if (
    actor.isGuest ||
    !["super_admin", "admin", "cfo", "operations"].includes(actor.role)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an administrator, CFO, or operations owner can manage control policies.",
    });
  }
}

export function resolveControlPolicyScope(
  actor: ControlPolicyActor,
  requested?: number
): number {
  return resolveOrgScope(actor, requested);
}
