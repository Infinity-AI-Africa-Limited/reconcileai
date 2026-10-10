/**
 * Governed daily-control admission: the only path that may claim to execute a
 * governed daily control. Composed into the reconciliation router, so the API
 * path is `reconciliation.createGovernedDailyControl`; kept in its own module so
 * the control path is reviewed on its own (CLAUDE.md §16, the 150-line rule).
 *
 * The caller names only the control period. Everything a run depends on — both
 * channels, the business-day window, and the exact approved batches whose rows
 * it will match — is derived from approved, tenant-scoped evidence immediately
 * before the job exists.
 */
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { governedControlRunInput } from "../controlEvidenceSchema";
import {
  assertGovernedBatchesNotInFlight,
  GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
  GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS,
  GovernedRunInFlightError,
  requireGovernedControlAdmission,
} from "../controlRunAdmission";
import { assertReconciliationQueueAvailable, enqueueReconciliationRun } from "../reconciliationQueue";
import {
  assertModuleAvailable,
  getClientInfo,
  logAuditStrict,
  MAX_NAME_LENGTH,
  operationsProcedure,
  requireOwnedChannels,
  runOwner,
  sanitizeInput,
} from "./shared";

/**
 * Turn a refused claim into the status it deserves.
 *
 * A second Start over batches a run already holds is the caller being early,
 * not the server failing, so it answers 409 naming the run that holds them.
 * Reported as a 500 it would read as a platform fault and invite a retry,
 * which is exactly the thing the claim exists to prevent.
 *
 * Inline at the call site rather than wrapped around it: `moduleScope.test.ts`
 * ratchets that `assertModuleAvailable` appears between this procedure's
 * opening and its literal `db.createReconciliationJob(` call, so moving that
 * call into a helper silently disarmed the guard's own test.
 */
function asGovernedJobError(error: unknown): unknown {
  if (error instanceof GovernedRunInFlightError) {
    return new TRPCError({
      code: "CONFLICT",
      message: `A governed run for these approved batches is already in progress (job ${error.jobId}). Wait for it to finish rather than starting another.`,
      cause: error,
    });
  }
  return error;
}

export const governedDailyControlProcedures = {
  createGovernedDailyControl: operationsProcedure
    .input(governedControlRunInput)
    .mutation(async ({ ctx, input }) => {
      await assertModuleAvailable(ctx, "settlement");
      const tenant = runOwner(ctx.user);
      const admission = await requireGovernedControlAdmission({
        organizationId: tenant,
        controlPeriod: input.controlPeriod,
      });
      const [sourceChannel, targetChannel] = await requireOwnedChannels(tenant, [
        { id: admission.sourceChannelId, notFound: "Approved settlement channel not found" },
        { id: admission.targetChannelId, notFound: "Approved register channel not found" },
      ]);

      try {
        await assertReconciliationQueueAvailable();
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Reconciliation processing is unavailable until the required durable queue is healthy.",
          cause: error,
        });
      }

      const name = sanitizeInput(
        input.name ?? `Daily control — ${input.controlPeriod}`,
        MAX_NAME_LENGTH,
      );
      const engineConfig = {
        amountTolerance: GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
        dateWindowDays: GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS,
        sourceChannel: sourceChannel.code,
        targetChannel: targetChannel.code,
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
      const { ip, ua } = getClientInfo(ctx);
      const jobId = await db.createReconciliationJob(
        {
          userId: ctx.user.id,
          organizationId: tenant,
          name,
          moduleType: "settlement",
          sourceChannelId: admission.sourceChannelId,
          targetChannelId: admission.targetChannelId,
          dateFrom: admission.dateFrom,
          dateTo: admission.dateTo,
          amountTolerance: String(GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE),
          dateWindowDays: GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS,
          engineConfig: JSON.stringify(engineConfig),
          status: "pending",
        },
        {
          // Under the insert's tenant row lock, so two Start requests cannot
          // both admit a run over the same approved batches and both write
          // matches for the same rows.
          beforeInsert: tx =>
            assertGovernedBatchesNotInFlight(tx, tenant, {
              settlement: admission.settlement,
              register: admission.register,
            }),
          // The admission event commits WITH the job, or neither exists. With
          // the lenient logAudit an audit failure was swallowed and the run was
          // queued anyway, admitted with no record in the tenant's trail.
          inTransaction: (tx, newJobId) =>
            logAuditStrict({
              userId: ctx.user.id,
              organizationId: tenant,
              action: "create_governed_daily_control_run",
              entityType: "reconciliation_job",
              entityId: newJobId,
              details: {
                controlPeriod: admission.controlPeriod,
                sourceContractCount: admission.sourceContractCount,
                batchManifestCount: admission.batchManifestCount,
                reconciliationPolicyVersions: admission.reconciliationPolicyVersions,
                settlementManifestId: admission.settlement.manifestId,
                registerManifestId: admission.register.manifestId,
              },
              ipAddress: ip,
              userAgent: ua,
              executor: tx,
            }),
        },
      ).catch(error => {
        throw asGovernedJobError(error);
      });
      if (!jobId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create reconciliation job" });
      }

      try {
        await enqueueReconciliationRun({
          jobId,
          sourceChannelId: admission.sourceChannelId,
          targetChannelId: admission.targetChannelId,
          dateFromIso: admission.dateFrom.toISOString(),
          dateToIso: admission.dateTo.toISOString(),
          config: {
            // The same two values the job row and engineConfig carry: the
            // worker must match on the policy the run was admitted under.
            amountTolerance: engineConfig.amountTolerance,
            dateWindowDays: engineConfig.dateWindowDays,
          },
          userId: ctx.user.id,
        });
      } catch (error) {
        const stopped = await db.abandonUnstartedReconciliationJob(jobId, new Date());
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: stopped
            ? "Failed to queue reconciliation processing. The run was stopped before it started."
            : `Failed to queue reconciliation processing, but job ${jobId} had already been picked up by a worker and is running. Track it rather than retrying.`,
          cause: error,
        });
      }

      return { jobId, controlPeriod: admission.controlPeriod };
    }),
};
