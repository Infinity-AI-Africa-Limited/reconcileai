/**
 * The governed daily control's job payload, and the one error it can answer.
 *
 * Split out of `server/routers/governedDailyControl.ts` to keep that router
 * inside the 150-line rule (CLAUDE.md §16). Both pieces are policy rather than
 * transport: what a governed run records about the evidence it was admitted
 * under, and what the caller is told when another run already holds that
 * evidence.
 *
 * The INSERT itself deliberately stays in the procedure. `moduleScope.test.ts`
 * ratchets that `assertModuleAvailable` appears between the procedure's
 * opening and its literal `db.createReconciliationJob(` call, so moving that
 * call behind a helper silently disarms the guard's own test — which is how it
 * was found.
 */
import { TRPCError } from "@trpc/server";
import {
  GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
  GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS,
  GovernedRunInFlightError,
  type GovernedControlAdmission,
} from "./controlRunAdmission";

/**
 * The run's own record of the policy and the evidence it was admitted under.
 *
 * Read back by the worker (`governedSidesOf`) to reload exactly the approved
 * batches, so this is the contract between admission and execution — not a log
 * line. Identifiers only: a snapshot that carried rows could drift from the
 * manifests the worker re-proves them against.
 */
export function governedEngineConfig(
  admission: GovernedControlAdmission,
  channels: { source: string; target: string }
) {
  return {
    amountTolerance: GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
    dateWindowDays: GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS,
    sourceChannel: channels.source,
    targetChannel: channels.target,
    governedDailyControl: {
      controlPeriod: admission.controlPeriod,
      assessedAt: admission.assessedAt,
      sourceContractCount: admission.sourceContractCount,
      batchManifestCount: admission.batchManifestCount,
      reconciliationPolicyVersions: admission.reconciliationPolicyVersions,
      // Identifiers only. The worker matches exactly these batches' rows,
      // re-checked against these manifests, never a date window.
      settlement: admission.settlement,
      register: admission.register,
    },
  };
}

/**
 * Turn a refused claim into the status it deserves.
 *
 * A second Start over batches a run already holds is the caller being early,
 * not the server failing, so it answers 409 naming the run that holds them.
 * Reported as a 500 it would read as a platform fault and invite a retry,
 * which is exactly the thing the claim exists to prevent. Anything else is
 * passed through untouched.
 */
export function asGovernedJobError(error: unknown): unknown {
  if (error instanceof GovernedRunInFlightError) {
    return new TRPCError({
      code: "CONFLICT",
      message: `A governed run for these approved batches is already in progress (job ${error.jobId}). Wait for it to finish rather than starting another.`,
      cause: error,
    });
  }
  return error;
}
