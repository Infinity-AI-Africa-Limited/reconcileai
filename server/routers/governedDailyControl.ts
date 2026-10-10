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
  GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
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
        dateWindowDays: 0,
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
          dateWindowDays: 0,
          engineConfig: JSON.stringify(engineConfig),
          status: "pending",
        },
        {
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
      );
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
            amountTolerance: GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE,
            dateWindowDays: 0,
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
