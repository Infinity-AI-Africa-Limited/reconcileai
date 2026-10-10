import { TRPCError } from "@trpc/server";
import {
  assessPersistedControlRun,
  businessDayWindow,
  type PersistedControlRunAssessment,
} from "./controlRunReadiness";

/**
 * The first governed control pack uses the product's existing sub-cent tolerance.
 * It is deliberately not caller-supplied: a policy-versioned configuration record
 * will replace this value in the next control-kernel increment.
 */
export const GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE = 0.005;

/**
 * Immutable, non-payload snapshot attached to a reconciliation job that was
 * admitted through the governed daily-control path.
 *
 * It proves the precondition evaluated for the run without copying source rows,
 * raw transaction data, monetary values, or credentials into job configuration.
 */
export type GovernedControlAdmission = {
  controlPeriod: string;
  assessedAt: string;
  sourceChannelId: number;
  targetChannelId: number;
  dateFrom: Date;
  dateTo: Date;
  sourceContractCount: number;
  batchManifestCount: number;
  reconciliationPolicyVersions: string[];
};

/**
 * Refuse a governed reconciliation unless the persisted evidence preflight is
 * explicitly ready. This is the execution boundary for the daily-control path:
 * callers cannot turn a ready-looking UI state into a job without re-evaluating
 * the tenant-scoped contracts and immutable manifests immediately before job
 * admission.
 */
export async function requireGovernedControlAdmission(params: {
  organizationId: number;
  controlPeriod: string;
}): Promise<GovernedControlAdmission> {
  const assessment = await assessPersistedControlRun(params);
  return admissionFromAssessment(assessment);
}

/** Exported so the safety policy is unit-testable without a database. */
export function admissionFromAssessment(
  assessment: PersistedControlRunAssessment
): GovernedControlAdmission {
  if (!assessment.canReconcile || assessment.status !== "ready_to_reconcile") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      // Deliberately stable and payload-free. Daily Control shows the authorised
      // owner the tenant-scoped reasons; an admission endpoint must not disclose
      // source details in an error or turn an incomplete population into a run.
      message: "Daily control is not ready for reconciliation.",
    });
  }

  const settlement = assessment.sourceContractBindings.filter(
    binding => binding.role === "settlement"
  );
  const register = assessment.sourceContractBindings.filter(
    binding => binding.role === "internal_register"
  );
  const sourceChannelId = settlement[0]?.channelId;
  const targetChannelId = register[0]?.channelId;
  if (
    settlement.length !== 1 ||
    register.length !== 1 ||
    !isPositiveChannelId(sourceChannelId) ||
    !isPositiveChannelId(targetChannelId) ||
    sourceChannelId === targetChannelId
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Daily control is not ready for reconciliation.",
    });
  }

  const timeZones = new Set(
    assessment.sourceContractBindings.map(binding => binding.timeZone)
  );
  const [timeZone] = [...timeZones];
  const window =
    timeZones.size === 1 && typeof timeZone === "string"
      ? businessDayWindow(assessment.controlPeriod, timeZone)
      : null;
  if (!window) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Daily control is not ready for reconciliation.",
    });
  }

  return {
    controlPeriod: assessment.controlPeriod,
    assessedAt: assessment.evaluatedAt.toISOString(),
    sourceChannelId,
    targetChannelId,
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
    sourceContractCount: assessment.sourceContractCount,
    batchManifestCount: assessment.batchManifestCount,
    reconciliationPolicyVersions: assessment.reconciliationPolicyVersions,
  };
}

function isPositiveChannelId(
  value: number | null | undefined
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
