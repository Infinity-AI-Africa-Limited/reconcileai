import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { storagePut } from "./storage";
import {
  runMatchingEngine,
  categorizeException,
  getAIAnalysis,
} from "./reconciliationEngine";

// ─── Admin Procedure ─────────────────────────────────────────────────

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function logAudit(
  userId: number | null,
  action: string,
  entityType: string,
  entityId?: number,
  details?: any
) {
  await db.createAuditLog({
    userId,
    action,
    entityType,
    entityId,
    details: details ? JSON.stringify(details) : null,
  });
}

// ─── Router ──────────────────────────────────────────────────────────

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Channels ────────────────────────────────────────────────────

  channels: router({
    list: protectedProcedure.query(async () => {
      return db.getChannels();
    }),
  }),

  // ─── Upload & Ingestion ──────────────────────────────────────────

  upload: router({
    createBatch: protectedProcedure
      .input(
        z.object({
          channelCode: z.string(),
          fileName: z.string(),
          transactions: z.array(
            z.object({
              transactionRef: z.string().optional(),
              externalRef: z.string().optional(),
              description: z.string().optional(),
              amount: z.string(),
              currency: z.string().default("NGN"),
              transactionDate: z.string(),
              valueDate: z.string().optional(),
              debitCredit: z.enum(["debit", "credit"]),
              counterparty: z.string().optional(),
              rawData: z.any().optional(),
            })
          ),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelByCode(input.channelCode);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Channel '${input.channelCode}' not found` });
        }

        const batchId = await db.createUploadBatch({
          userId: ctx.user.id,
          channelId: channel.id,
          fileName: input.fileName,
          totalRows: input.transactions.length,
          validRows: 0,
          invalidRows: 0,
          status: "processing",
        });

        if (!batchId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create upload batch" });
        }

        let validRows = 0;
        let invalidRows = 0;
        const validTxns: any[] = [];

        for (const txn of input.transactions) {
          try {
            const amount = parseFloat(txn.amount);
            if (isNaN(amount)) {
              invalidRows++;
              continue;
            }
            const txnDate = new Date(txn.transactionDate);
            if (isNaN(txnDate.getTime())) {
              invalidRows++;
              continue;
            }
            validTxns.push({
              batchId,
              channelId: channel.id,
              userId: ctx.user.id,
              transactionRef: txn.transactionRef || null,
              externalRef: txn.externalRef || null,
              description: txn.description || null,
              amount: txn.amount,
              currency: txn.currency,
              transactionDate: txnDate,
              valueDate: txn.valueDate ? new Date(txn.valueDate) : null,
              debitCredit: txn.debitCredit,
              counterparty: txn.counterparty || null,
              rawData: txn.rawData ? JSON.stringify(txn.rawData) : null,
            });
            validRows++;
          } catch {
            invalidRows++;
          }
        }

        if (validTxns.length > 0) {
          await db.insertTransactions(validTxns);
        }

        await db.updateUploadBatch(batchId, {
          validRows,
          invalidRows,
          status: "completed",
          completedAt: new Date(),
        });

        await logAudit(ctx.user.id, "upload_batch", "upload_batch", batchId, {
          channel: input.channelCode,
          fileName: input.fileName,
          totalRows: input.transactions.length,
          validRows,
          invalidRows,
        });

        return { batchId, validRows, invalidRows, totalRows: input.transactions.length };
      }),

    history: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getUploadBatches(ctx.user.id, isAdmin);
    }),
  }),

  // ─── Transactions ────────────────────────────────────────────────

  transactions: router({
    list: protectedProcedure
      .input(
        z.object({
          channelId: z.number().optional(),
          status: z.string().optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          amountMin: z.number().optional(),
          amountMax: z.number().optional(),
          search: z.string().optional(),
          limit: z.number().default(50),
          offset: z.number().default(0),
        })
      )
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        return db.getTransactions({
          userId: ctx.user.id,
          isAdmin,
          channelId: input.channelId,
          status: input.status,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
          amountMin: input.amountMin,
          amountMax: input.amountMax,
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        });
      }),
  }),

  // ─── Reconciliation ─────────────────────────────────────────────

  reconciliation: router({
    create: protectedProcedure
      .input(
        z.object({
          name: z.string(),
          sourceChannelId: z.number(),
          targetChannelId: z.number(),
          dateFrom: z.string(),
          dateTo: z.string(),
          amountTolerance: z.number().default(0.005),
          dateWindowDays: z.number().default(3),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const jobId = await db.createReconciliationJob({
          userId: ctx.user.id,
          name: input.name,
          sourceChannelId: input.sourceChannelId,
          targetChannelId: input.targetChannelId,
          dateFrom: new Date(input.dateFrom),
          dateTo: new Date(input.dateTo),
          amountTolerance: String(input.amountTolerance),
          dateWindowDays: input.dateWindowDays,
          status: "pending",
        });

        if (!jobId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create reconciliation job" });
        }

        await logAudit(ctx.user.id, "create_reconciliation_job", "reconciliation_job", jobId, input);

        // Run reconciliation asynchronously
        runReconciliation(jobId, input.sourceChannelId, input.targetChannelId,
          new Date(input.dateFrom), new Date(input.dateTo),
          { amountTolerance: input.amountTolerance, dateWindowDays: input.dateWindowDays },
          ctx.user.id
        ).catch(err => console.error("[Reconciliation] Job failed:", err));

        return { jobId };
      }),

    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getReconciliationJobs(ctx.user.id, isAdmin);
    }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const job = await db.getReconciliationJob(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND" });
        const jobMatches = await db.getMatchesByJob(input.id);
        const { data: jobExceptions } = await db.getExceptions({ jobId: input.id });
        return { job, matches: jobMatches, exceptions: jobExceptions };
      }),
  }),

  // ─── Exceptions ──────────────────────────────────────────────────

  exceptions: router({
    list: protectedProcedure
      .input(
        z.object({
          jobId: z.number().optional(),
          status: z.string().optional(),
          category: z.string().optional(),
          severity: z.string().optional(),
          limit: z.number().default(50),
          offset: z.number().default(0),
        })
      )
      .query(async ({ input }) => {
        return db.getExceptions(input);
      }),

    resolve: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["resolved", "dismissed"]),
          resolutionNotes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await db.updateException(input.id, {
          status: input.status,
          resolvedBy: ctx.user.id,
          resolvedAt: new Date(),
          resolutionNotes: input.resolutionNotes || null,
        });
        await logAudit(ctx.user.id, "resolve_exception", "exception", input.id, {
          status: input.status,
          notes: input.resolutionNotes,
        });
        return { success: true };
      }),

    assign: protectedProcedure
      .input(z.object({ id: z.number(), assignedTo: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await db.updateException(input.id, {
          assignedTo: input.assignedTo,
          status: "in_review",
        });
        await logAudit(ctx.user.id, "assign_exception", "exception", input.id, {
          assignedTo: input.assignedTo,
        });
        return { success: true };
      }),
  }),

  // ─── Review Queue (Matches) ──────────────────────────────────────

  review: router({
    pending: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getPendingReviewMatches(ctx.user.id, isAdmin);
    }),

    approve: protectedProcedure
      .input(z.object({ matchId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await db.updateMatchStatus(input.matchId, "confirmed", ctx.user.id);
        await logAudit(ctx.user.id, "approve_match", "match", input.matchId);
        return { success: true };
      }),

    reject: protectedProcedure
      .input(z.object({ matchId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await db.updateMatchStatus(input.matchId, "rejected", ctx.user.id);
        await logAudit(ctx.user.id, "reject_match", "match", input.matchId);
        return { success: true };
      }),
  }),

  // ─── Audit Trail ─────────────────────────────────────────────────

  audit: router({
    list: protectedProcedure
      .input(
        z.object({
          entityType: z.string().optional(),
          entityId: z.number().optional(),
          limit: z.number().default(50),
          offset: z.number().default(0),
        })
      )
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        return db.getAuditLogs({
          ...input,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),
  }),

  // ─── Reports ─────────────────────────────────────────────────────

  reports: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getReports(ctx.user.id, isAdmin);
    }),

    generate: protectedProcedure
      .input(
        z.object({
          jobId: z.number(),
          reportType: z.enum(["daily", "weekly", "monthly", "custom"]),
          title: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const job = await db.getReconciliationJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

        const jobMatches = await db.getMatchesByJob(input.jobId);
        const { data: jobExceptions } = await db.getExceptions({ jobId: input.jobId });

        const summary = {
          jobName: job.name,
          dateRange: `${job.dateFrom} - ${job.dateTo}`,
          totalSource: job.totalSourceTxns,
          totalTarget: job.totalTargetTxns,
          matched: job.matchedCount,
          exceptions: job.exceptionCount,
          unmatched: job.unmatchedCount,
          matchRate: job.matchRate,
          matchBreakdown: {
            exact: jobMatches.filter((m) => m.matchType === "exact").length,
            fuzzy: jobMatches.filter((m) => m.matchType === "fuzzy").length,
            amountTolerance: jobMatches.filter((m) => m.matchType === "amount_tolerance").length,
            dateWindow: jobMatches.filter((m) => m.matchType === "date_window").length,
            aiSuggested: jobMatches.filter((m) => m.matchType === "ai_suggested").length,
            manual: jobMatches.filter((m) => m.matchType === "manual").length,
          },
          exceptionBreakdown: {
            missingCounterparty: jobExceptions.filter((e) => e.category === "missing_counterparty").length,
            amountMismatch: jobExceptions.filter((e) => e.category === "amount_mismatch").length,
            timingDifference: jobExceptions.filter((e) => e.category === "timing_difference").length,
            duplicate: jobExceptions.filter((e) => e.category === "duplicate_transaction").length,
            unmatched: jobExceptions.filter((e) => e.category === "unmatched").length,
          },
          generatedAt: new Date().toISOString(),
          generatedBy: ctx.user.name || ctx.user.email || "Unknown",
        };

        const reportId = await db.createReport({
          jobId: input.jobId,
          userId: ctx.user.id,
          reportType: input.reportType,
          title: input.title,
          summary: JSON.stringify(summary),
          format: "pdf",
        });

        await logAudit(ctx.user.id, "generate_report", "report", reportId || undefined, {
          jobId: input.jobId,
          reportType: input.reportType,
        });

        return { reportId, summary };
      }),
  }),

  // ─── Dashboard ───────────────────────────────────────────────────

  dashboard: router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getDashboardStats(ctx.user.id, isAdmin);
    }),
  }),

  // ─── Admin ───────────────────────────────────────────────────────

  admin: router({
    users: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),

    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ ctx, input }) => {
        await db.updateUserRole(input.userId, input.role);
        await logAudit(ctx.user.id, "update_user_role", "user", input.userId, {
          newRole: input.role,
        });
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;

// ─── Background Reconciliation Runner ────────────────────────────────

async function runReconciliation(
  jobId: number,
  sourceChannelId: number,
  targetChannelId: number,
  dateFrom: Date,
  dateTo: Date,
  config: { amountTolerance: number; dateWindowDays: number },
  userId: number
) {
  try {
    await db.updateReconciliationJob(jobId, { status: "running", startedAt: new Date() });

    const sourceTxns = await db.getTransactionsForReconciliation(sourceChannelId, dateFrom, dateTo);
    const targetTxns = await db.getTransactionsForReconciliation(targetChannelId, dateFrom, dateTo);

    await db.updateReconciliationJob(jobId, {
      totalSourceTxns: sourceTxns.length,
      totalTargetTxns: targetTxns.length,
    });

    const result = runMatchingEngine(sourceTxns, targetTxns, config);

    // Insert matches
    let matchedCount = 0;
    for (const match of result.matches) {
      const status = match.confidenceScore >= 85 ? "confirmed" : "pending_review";
      const matchId = await db.insertMatch({
        jobId,
        sourceTransactionId: match.sourceId,
        targetTransactionId: match.targetId,
        matchType: match.matchType,
        confidenceScore: String(match.confidenceScore),
        amountDifference: String(match.amountDifference),
        dateDifference: Math.round(match.dateDifference),
        matchReason: match.matchReason,
        status,
      });

      if (matchId) {
        const txnStatus = status === "confirmed" ? "matched" : "exception";
        await db.updateTransactionStatus(match.sourceId, txnStatus, matchId);
        await db.updateTransactionStatus(match.targetId, txnStatus, matchId);
        if (status === "confirmed") matchedCount++;
      }
    }

    // Process unmatched source transactions as exceptions
    let exceptionCount = 0;
    const allUnmatched = [...result.unmatchedSource, ...result.unmatchedTarget];
    const unmatchedTxns = await db.getTransactionsByIds(allUnmatched);

    for (const txn of unmatchedTxns) {
      const exceptionInfo = categorizeException(txn, targetTxns, config);

      let aiAnalysis: string | undefined;
      if (exceptionInfo.severity === "high" || exceptionInfo.severity === "critical") {
        aiAnalysis = await getAIAnalysis(exceptionInfo, txn);
      }

      await db.insertException({
        jobId,
        transactionId: txn.id,
        category: exceptionInfo.category,
        severity: exceptionInfo.severity,
        description: exceptionInfo.description,
        suggestedResolution: exceptionInfo.suggestedResolution,
        aiAnalysis: aiAnalysis || null,
        status: "open",
      });

      await db.updateTransactionStatus(txn.id, "exception");
      exceptionCount++;
    }

    const totalTxns = sourceTxns.length + targetTxns.length;
    const matchRate = totalTxns > 0 ? ((matchedCount * 2) / totalTxns * 100) : 0;

    await db.updateReconciliationJob(jobId, {
      status: "completed",
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: String(Math.round(matchRate * 100) / 100),
      completedAt: new Date(),
    });

    await logAudit(userId, "complete_reconciliation", "reconciliation_job", jobId, {
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: `${matchRate.toFixed(2)}%`,
    });
  } catch (error) {
    console.error("[Reconciliation] Job failed:", error);
    await db.updateReconciliationJob(jobId, {
      status: "failed",
      completedAt: new Date(),
    });
  }
}
