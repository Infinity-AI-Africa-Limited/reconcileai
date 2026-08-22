/**
 * Reconciliation domain router (routers.ts split — docs/ROUTERS_SPLIT_PLAN.md).
 *
 * Job creation, the multi-channel fan-out, and job reads. Moved out of
 * server/routers.ts verbatim; building blocks come from ./shared, matching
 * every other domain router.
 *
 * Note for anyone changing the two create paths: `moduleType` arrives straight
 * from the caller and is never checked against `moduleConfigurations`, so
 * `assertModuleAvailable` is the only thing standing between a retail tenant
 * and a GL-to-CBS run. The public API (POST /api/v1/reconciliation/runs in
 * server/api/gateway.ts) calls `reconciliation.create` too, so the guard has to
 * live on the procedure rather than on the UI that fronts it.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as crypto from "crypto";
import { router, protectedProcedure } from "../_core/trpc";
import {
  operationsProcedure,
  logAudit,
  getClientInfo,
  sanitizeInput,
  assertModuleAvailable,
  MAX_NAME_LENGTH,
} from "./shared";
import * as db from "../db";
import { assertReconciliationQueueAvailable, enqueueReconciliationRun } from "../reconciliationQueue";

export const reconciliationRouter = router({
  create: operationsProcedure
    .input(
      z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        moduleType: z.enum(["settlement", "account_level"]).default("settlement"),
        sourceChannelId: z.number().int().positive(),
        targetChannelId: z.number().int().positive(),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
        amountTolerance: z.number().min(0).max(0.1).default(0.005),
        dateWindowDays: z.number().int().min(0).max(30).default(3),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);

      // The module page is not the gate. moduleType arrives straight from the
      // caller here — and from the public API, which funnels into this same
      // procedure — so a retail tenant could run account_level without ever
      // having it enabled. Refuse before anything is persisted or enqueued.
      await assertModuleAvailable(ctx, input.moduleType);

      // Validate channels exist
      const sourceChannel = await db.getChannelById(input.sourceChannelId);
      const targetChannel = await db.getChannelById(input.targetChannelId);
      if (!sourceChannel) throw new TRPCError({ code: "NOT_FOUND", message: "Source channel not found" });
      if (!targetChannel) throw new TRPCError({ code: "NOT_FOUND", message: "Target channel not found" });

      // Validate date range
      const dateFrom = new Date(input.dateFrom);
      const dateTo = new Date(input.dateTo);
      if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid date range" });
      }
      if (dateFrom > dateTo) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
      }

      try {
        await assertReconciliationQueueAvailable();
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Reconciliation processing is unavailable until the required durable queue is healthy.",
          cause: error,
        });
      }

      const jobId = await db.createReconciliationJob({
        userId: ctx.user.id,
        name: sanitizeInput(input.name, MAX_NAME_LENGTH),
        moduleType: input.moduleType,
        sourceChannelId: input.sourceChannelId,
        targetChannelId: input.targetChannelId,
        dateFrom,
        dateTo,
        amountTolerance: String(input.amountTolerance),
        dateWindowDays: input.dateWindowDays,
        engineConfig: JSON.stringify({
          amountTolerance: input.amountTolerance,
          dateWindowDays: input.dateWindowDays,
          sourceChannel: sourceChannel.code,
          targetChannel: targetChannel.code,
        }),
        status: "pending",
      });

      if (!jobId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create reconciliation job" });
      }

      await logAudit(ctx.user.id, "create_reconciliation_job", "reconciliation_job", jobId, input, ip, ua);

      // Run asynchronously through the durable queue (BullMQ when REDIS_URL
      // is set, in-process otherwise) — retried with a clean artifact reset
      // per attempt; never lost silently on restart under BullMQ.
      try {
        await enqueueReconciliationRun({
          jobId,
          sourceChannelId: input.sourceChannelId,
          targetChannelId: input.targetChannelId,
          dateFromIso: dateFrom.toISOString(),
          dateToIso: dateTo.toISOString(),
          config: { amountTolerance: input.amountTolerance, dateWindowDays: input.dateWindowDays },
          userId: ctx.user.id,
        });
      } catch (error) {
        await db.updateReconciliationJob(jobId, { status: "failed", completedAt: new Date() });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to queue reconciliation processing.", cause: error });
      }

      return { jobId };
    }),

  // ── Multi-channel single run ──────────────────────────────────────────
  // Reconcile one source against MANY target channels in a single action.
  // Fans out to one child job per target (sharing a multiRunId) so results
  // aggregate into a single combined report — "reconcile across all of the
  // institution's channels in one run".
  createMultiChannel: operationsProcedure
    .input(
      z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        moduleType: z.enum(["settlement", "account_level"]).default("settlement"),
        sourceChannelId: z.number().int().positive(),
        // Explicit target channels, or omit + set allActiveTargets to use every
        // other active channel.
        targetChannelIds: z.array(z.number().int().positive()).max(50).optional(),
        allActiveTargets: z.boolean().default(false),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
        amountTolerance: z.number().min(0).max(0.1).default(0.005),
        dateWindowDays: z.number().int().min(0).max(30).default(3),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);

      // Same gate as the single-channel run — fanning out to N targets must
      // not become a way around it.
      await assertModuleAvailable(ctx, input.moduleType);

      const sourceChannel = await db.getChannelById(input.sourceChannelId);
      if (!sourceChannel) throw new TRPCError({ code: "NOT_FOUND", message: "Source channel not found" });

      const dateFrom = new Date(input.dateFrom);
      const dateTo = new Date(input.dateTo);
      if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid date range" });
      }
      if (dateFrom > dateTo) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
      }

      try {
        await assertReconciliationQueueAvailable();
      } catch (error) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Reconciliation processing is unavailable until the required durable queue is healthy.",
          cause: error,
        });
      }

      // Resolve the target set.
      let targets: { id: number; name: string; code: string }[] = [];
      if (input.allActiveTargets) {
        const all = await db.getChannels(ctx.user.organizationId ?? null);
        targets = all.filter((c) => c.isActive && c.id !== input.sourceChannelId);
      } else {
        const ids = (input.targetChannelIds ?? []).filter((id) => id !== input.sourceChannelId);
        if (ids.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Provide at least one target channel (or set allActiveTargets)" });
        }
        for (const id of ids) {
          const ch = await db.getChannelById(id);
          if (!ch) throw new TRPCError({ code: "NOT_FOUND", message: `Target channel ${id} not found` });
          targets.push(ch);
        }
      }
      if (targets.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No eligible target channels for this run" });
      }

      const multiRunId = crypto.randomUUID();
      const jobIds: number[] = [];

      for (const target of targets) {
        const jobId = await db.createReconciliationJob({
          userId: ctx.user.id,
          name: sanitizeInput(`${input.name} — ${target.name}`, MAX_NAME_LENGTH),
          moduleType: input.moduleType,
          sourceChannelId: input.sourceChannelId,
          targetChannelId: target.id,
          dateFrom,
          dateTo,
          amountTolerance: String(input.amountTolerance),
          dateWindowDays: input.dateWindowDays,
          multiRunId,
          engineConfig: JSON.stringify({
            amountTolerance: input.amountTolerance,
            dateWindowDays: input.dateWindowDays,
            sourceChannel: sourceChannel.code,
            targetChannel: target.code,
            multiRunId,
          }),
          status: "pending",
        });
        if (jobId) {
          jobIds.push(jobId);
          try {
            await enqueueReconciliationRun({
              jobId,
              sourceChannelId: input.sourceChannelId,
              targetChannelId: target.id,
              dateFromIso: dateFrom.toISOString(),
              dateToIso: dateTo.toISOString(),
              config: { amountTolerance: input.amountTolerance, dateWindowDays: input.dateWindowDays },
              userId: ctx.user.id,
            });
          } catch (error) {
            await db.updateReconciliationJob(jobId, { status: "failed", completedAt: new Date() });
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to queue multi-channel reconciliation processing.", cause: error });
          }
        }
      }

      await logAudit(ctx.user.id, "create_multichannel_reconciliation", "reconciliation_job", jobIds[0] ?? 0,
        { multiRunId, source: sourceChannel.code, targetCount: targets.length }, ip, ua);

      return { multiRunId, jobIds, targetCount: targets.length };
    }),

  // Aggregate a multi-channel run into one combined view.
  getMultiRun: protectedProcedure
    .input(z.object({ multiRunId: z.string().min(1).max(36) }))
    .query(async ({ ctx, input }) => {
      const jobs = await db.getReconciliationJobsByMultiRun(input.multiRunId);
      if (jobs.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Multi-channel run not found" });
      }
      const channels = await db.getChannels(ctx.user.organizationId ?? null);
      const nameFor = (id: number) => channels.find((c) => c.id === id)?.name ?? `Channel ${id}`;

      const totals = jobs.reduce(
        (acc, j) => {
          acc.totalSourceTxns += j.totalSourceTxns;
          acc.totalTargetTxns += j.totalTargetTxns;
          acc.matchedCount += j.matchedCount;
          acc.exceptionCount += j.exceptionCount;
          acc.unmatchedCount += j.unmatchedCount;
          return acc;
        },
        { totalSourceTxns: 0, totalTargetTxns: 0, matchedCount: 0, exceptionCount: 0, unmatchedCount: 0 },
      );
      const denom = totals.matchedCount + totals.exceptionCount + totals.unmatchedCount;
      const overallMatchRate = denom > 0 ? parseFloat(((totals.matchedCount / denom) * 100).toFixed(2)) : 0;

      const allDone = jobs.every((j) => j.status === "completed");
      const anyFailed = jobs.some((j) => j.status === "failed");
      const anyRunning = jobs.some((j) => j.status === "pending" || j.status === "running");
      const status = anyRunning ? "running" : allDone ? "completed" : anyFailed ? "completed_with_failures" : "completed";

      return {
        multiRunId: input.multiRunId,
        status,
        jobCount: jobs.length,
        completedCount: jobs.filter((j) => j.status === "completed").length,
        ...totals,
        overallMatchRate,
        channels: jobs.map((j) => ({
          jobId: j.id,
          channel: nameFor(j.targetChannelId),
          status: j.status,
          matchedCount: j.matchedCount,
          exceptionCount: j.exceptionCount,
          unmatchedCount: j.unmatchedCount,
          matchRate: j.matchRate,
        })),
      };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return db.getReconciliationJobs(ctx.user.organizationId ?? null);
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const job = await db.getReconciliationJob(input.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      const jobMatches = await db.getMatchesByJob(input.id);
      const { data: jobExceptions } = await db.getExceptions({
        organizationId: ctx.user.organizationId ?? null,
        jobId: input.id,
      });
      // Audit: log data access event
      const { ip, ua } = getClientInfo(ctx);
      await logAudit(ctx.user.id, "view_reconciliation_job", "reconciliation_job", input.id, { jobName: job.name }, ip, ua);
      return { job, matches: jobMatches, exceptions: jobExceptions };
    }),
});
