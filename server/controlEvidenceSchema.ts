import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CONTROL_SOURCE_CONTRACT_STATUSES } from "./controlManifest";
import { resolveOrgScope } from "./_core/tenancy";
import { isControlPeriod } from "../shared/controlPeriod";

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => nonEmptyText(max).nullable();
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
const nullableCurrency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform(value => value.toUpperCase())
  .nullable();
const decimal = z.string().trim().min(1).max(40);

/**
 * The most rows one `controlEvidence.get` may return per collection.
 *
 * Evidence accrues one manifest per source per control period, so a tenant
 * running a handful of daily sources passes any fixed ceiling within months.
 * A page is therefore a page: it is bounded, it says whether more exists, and
 * it hands back the cursor that reaches the rest.
 */
export const CONTROL_EVIDENCE_PAGE_MAX = 200;
export const CONTROL_EVIDENCE_PAGE_DEFAULT = 50;

/**
 * A keyset cursor. It names the last row of the page just read, so the next
 * page starts strictly after it — stable while new evidence is being recorded,
 * which OFFSET is not: an insert ahead of the window shifts every later row and
 * silently skips one.
 *
 * It is not opaque, deliberately: a forged cursor can only move the window
 * within the caller's own organisation, which the query scopes regardless, and
 * an operator reading a support transcript can see where a page began.
 */
/**
 * A cursor's position, as either form a caller can hold it in.
 *
 * `get` hands `nextCursor` back as an ISO string so it round-trips through
 * plain JSON as well as through superjson. But superjson is this API's
 * transformer, so a caller who builds a cursor from a returned ROW holds a real
 * `Date` — and the first version of this schema took `z.string()` only, which
 * answered BAD_REQUEST to exactly that. Both are accepted; both arrive as a
 * Date.
 */
const cursorPosition = z.union([z.date(), dateInput]);

const contractCursorInput = z
  .object({ effectiveAt: cursorPosition, id: z.number().int().positive() })
  .strict();
const manifestCursorInput = z
  .object({ receivedAt: cursorPosition, id: z.number().int().positive() })
  .strict();

export const controlEvidenceScopeInput = z.object({
  organizationId: z.number().int().positive().optional(),
  /** Index-backed by `idx_control_batch_manifest_org_period`. */
  controlPeriod: nonEmptyText(64).optional(),
  sourceContractId: z.number().int().positive().optional(),
  sourceKey: nonEmptyText(100).optional(),
  limit: z.number().int().min(1).max(CONTROL_EVIDENCE_PAGE_MAX).optional(),
  contractCursor: contractCursorInput.optional(),
  manifestCursor: manifestCursorInput.optional(),
});

export type ControlEvidenceScope = z.infer<typeof controlEvidenceScopeInput>;

/**
 * A governed daily control is assessed against a customer-defined local
 * business day. Unlike the general evidence filter (which preserves legacy
 * customer period labels), the readiness gate accepts only an ISO calendar day
 * so it can derive a source contract's approved local cut-off without guessing.
 */
// The same rule the Daily Control page applies before it asks
// (shared/controlPeriod.ts), so the page never sends a day the API refuses.
const dailyControlPeriod = z
  .string()
  .refine(isControlPeriod, "Control period must be a real ISO calendar day.");

export const controlRunReadinessInput = z.object({
  organizationId: z.number().int().positive().optional(),
  controlPeriod: dailyControlPeriod,
});

export const controlSourceContractInput = z.object({
  organizationId: z.number().int().positive().optional(),
  sourceKey: nonEmptyText(100),
  version: z.number().int().positive(),
  role: z.enum(["settlement", "internal_register", "bank_or_gl"]),
  displayName: nonEmptyText(255),
  systemName: nonEmptyText(255),
  controlPurpose: nonEmptyText(2_000),
  accountableOwner: nonEmptyText(255),
  escalationOwner: nonEmptyText(255),
  deliveryRoute: nonEmptyText(64),
  timeZone: nonEmptyText(64),
  cutoffMinutes: z.number().int().min(0).max(1_439),
  schemaVersion: nonEmptyText(128),
  controlTotalRequired: z.boolean(),
  expectedCurrency: nullableCurrency,
  status: z.enum(CONTROL_SOURCE_CONTRACT_STATUSES),
  approvalReference: nullableText(255),
  effectiveAt: dateInput,
});

export const controlBatchManifestInput = z.object({
  organizationId: z.number().int().positive().optional(),
  sourceContractId: z.number().int().positive(),
  controlPeriod: nonEmptyText(64),
  deliveryIdentity: nonEmptyText(255),
  uploadBatchId: z.number().int().positive().nullable(),
  receivedAt: dateInput,
  mappingVersion: nonEmptyText(128),
  reconciliationPolicyVersion: nonEmptyText(128),
  schemaState: z.enum(["accepted", "rejected", "unknown"]),
  duplicateDelivery: z.enum(["none", "deduplicated", "rejected"]),
  invalidRowCount: z.number().int().min(0),
  expectedRecordCount: z.number().int().min(0).nullable(),
  expectedMonetaryTotal: decimal.nullable(),
  expectedCurrency: nullableCurrency,
  receivedRecordCount: z.number().int().min(0),
  receivedMonetaryTotal: decimal,
  receivedCurrency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform(value => value.toUpperCase()),
});

export type ControlEvidenceActor = {
  id: number;
  role: string;
  organizationId: number | null;
  isGuest?: boolean | null;
};

export function assertControlEvidenceWriter(actor: ControlEvidenceActor): void {
  if (
    actor.isGuest ||
    !["super_admin", "admin", "cfo", "operations"].includes(actor.role)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an administrator, CFO, or operations owner can record control evidence.",
    });
  }
}

export function resolveControlEvidenceScope(
  actor: ControlEvidenceActor,
  requested?: number
): number {
  return resolveOrgScope(actor, requested);
}
