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
import { generateSampleData, type SampleDataConfig } from "./sampleDataGenerator";
import { SUPPORTED_CURRENCIES } from "../drizzle/schema";
import * as crypto from "crypto";
import { trackProgress } from "./jobProgressService";
import { getJobProgress, getAllActiveJobsProgress } from "./jobProgressService";
import {
  calculateNextRun,
  validateScheduleConfig,
  executeScheduledTask,
  startScheduler,
  getFrequencyDescription,
} from "./schedulingEngine";
import {
  sendReconciliationReport,
  checkAndSendAlerts,
} from "./emailReportService";

// ─── Constants ──────────────────────────────────────────────────────

const MAX_UPLOAD_TRANSACTIONS = 10000;
const MAX_SEARCH_LENGTH = 100;
const MAX_NAME_LENGTH = 255;

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
  details?: any,
  ipAddress?: string,
  userAgent?: string
) {
  try {
    await db.createAuditLog({
      userId,
      action,
      entityType,
      entityId,
      details: details ? JSON.stringify(details) : null,
      ipAddress: ipAddress || null,
      userAgent: userAgent ? userAgent.substring(0, 500) : null,
    });
  } catch (err) {
    // Audit logging should never crash the main operation
    console.error("[Audit] Failed to log:", err);
  }
}

function getClientInfo(ctx: any): { ip: string; ua: string } {
  const ip = ctx.req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim()
    || ctx.req?.socket?.remoteAddress
    || "unknown";
  const ua = ctx.req?.headers?.["user-agent"] || "unknown";
  return { ip, ua };
}

function sanitizeInput(input: string, maxLength: number = 255): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim()
    .substring(0, maxLength);
}

// ─── Webhook Dispatcher ─────────────────────────────────────────────

async function dispatchWebhook(event: string, payload: any) {
  try {
    const webhookList = await db.getActiveWebhooksByEvent(event);
    for (const webhook of webhookList) {
      const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
      const signature = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");

      fetch(webhook.url as string, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReconcileAI-Signature": signature,
          "X-ReconcileAI-Event": event,
        },
        body,
        signal: AbortSignal.timeout(10000), // 10s timeout
      }).catch((err) => {
        console.error(`[Webhook] Failed to deliver to ${webhook.url}:`, err);
        db.updateWebhook(webhook.id, { failureCount: webhook.failureCount + 1 });
      });
    }
  } catch (err) {
    console.error("[Webhook] Dispatch error:", err);
  }
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

    update: adminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        matchingConfig: z.record(z.string(), z.any()).optional(),
        fileFormat: z.record(z.string(), z.any()).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateChannel(input.id, {
          matchingConfig: input.matchingConfig ? JSON.stringify(input.matchingConfig) : undefined,
          fileFormat: input.fileFormat ? JSON.stringify(input.fileFormat) : undefined,
          isActive: input.isActive,
        });
        await logAudit(ctx.user.id, "update_channel", "channel", input.id, input, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Upload & Ingestion ──────────────────────────────────────────

  upload: router({
    createBatch: protectedProcedure
      .input(
        z.object({
          channelCode: z.string().min(1).max(50),
          fileName: z.string().min(1).max(500),
          fileHash: z.string().max(64).optional(),
          transactions: z.array(
            z.object({
              transactionRef: z.string().max(255).optional(),
              externalRef: z.string().max(255).optional(),
              description: z.string().max(1000).optional(),
              amount: z.string().min(1).max(30),
              currency: z.string().length(3).default("NGN"),
              transactionDate: z.string().min(1),
              valueDate: z.string().optional(),
              debitCredit: z.enum(["debit", "credit"]),
              counterparty: z.string().max(255).optional(),
              rawData: z.any().optional(),
            })
          ).max(MAX_UPLOAD_TRANSACTIONS, {
            message: `Maximum ${MAX_UPLOAD_TRANSACTIONS} transactions per upload`,
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const channel = await db.getChannelByCode(input.channelCode);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Channel '${sanitizeInput(input.channelCode, 50)}' not found` });
        }

        // Idempotency check: if fileHash provided, check for duplicate upload
        if (input.fileHash) {
          const existing = await db.getUploadBatchByHash(input.fileHash);
          if (existing) {
            return {
              batchId: existing.id,
              validRows: existing.validRows,
              invalidRows: existing.invalidRows,
              totalRows: existing.totalRows,
              deduplicated: true,
            };
          }
        }

        const batchId = await db.createUploadBatch({
          userId: ctx.user.id,
          channelId: channel.id,
          fileName: sanitizeInput(input.fileName, 500),
          fileHash: input.fileHash || null,
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
        const errors: string[] = [];

        for (let i = 0; i < input.transactions.length; i++) {
          const txn = input.transactions[i];
          try {
            const amount = parseFloat(txn.amount);
            if (isNaN(amount) || !isFinite(amount)) {
              invalidRows++;
              errors.push(`Row ${i + 1}: Invalid amount '${txn.amount}'`);
              continue;
            }
            if (amount < 0) {
              invalidRows++;
              errors.push(`Row ${i + 1}: Negative amount not allowed`);
              continue;
            }
            if (amount > 999999999999.99) {
              invalidRows++;
              errors.push(`Row ${i + 1}: Amount exceeds maximum`);
              continue;
            }
            const txnDate = new Date(txn.transactionDate);
            if (isNaN(txnDate.getTime())) {
              invalidRows++;
              errors.push(`Row ${i + 1}: Invalid date '${txn.transactionDate}'`);
              continue;
            }
            // Validate currency
            if (txn.currency && !(SUPPORTED_CURRENCIES as readonly string[]).includes(txn.currency)) {
              invalidRows++;
              errors.push(`Row ${i + 1}: Unsupported currency '${txn.currency}'`);
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
            errors.push(`Row ${i + 1}: Unexpected parsing error`);
          }
        }

        if (validTxns.length > 0) {
          await db.insertTransactions(validTxns);
        }

        await db.updateUploadBatch(batchId, {
          validRows,
          invalidRows,
          status: validRows > 0 ? "completed" : "failed",
          errorMessage: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
          completedAt: new Date(),
        });

        await logAudit(ctx.user.id, "upload_batch", "upload_batch", batchId, {
          channel: input.channelCode,
          fileName: input.fileName,
          totalRows: input.transactions.length,
          validRows,
          invalidRows,
        }, ip, ua);

        // Dispatch webhook
        dispatchWebhook("upload.completed", {
          batchId,
          channel: input.channelCode,
          validRows,
          invalidRows,
        });

        return {
          batchId,
          validRows,
          invalidRows,
          totalRows: input.transactions.length,
          errors: errors.slice(0, 20),
          deduplicated: false,
        };
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
          channelId: z.number().int().positive().optional(),
          status: z.string().max(30).optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          amountMin: z.number().min(0).optional(),
          amountMax: z.number().max(999999999999.99).optional(),
          search: z.string().max(MAX_SEARCH_LENGTH).optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
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
          name: z.string().min(1).max(MAX_NAME_LENGTH),
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

        const jobId = await db.createReconciliationJob({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
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

        // Run reconciliation asynchronously
        runReconciliation(jobId, input.sourceChannelId, input.targetChannelId,
          dateFrom, dateTo,
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
      .input(z.object({ id: z.number().int().positive() }))
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
          jobId: z.number().int().positive().optional(),
          status: z.string().max(30).optional(),
          category: z.string().max(50).optional(),
          severity: z.string().max(20).optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
      )
      .query(async ({ input }) => {
        return db.getExceptions(input);
      }),

    resolve: protectedProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          status: z.enum(["resolved", "dismissed"]),
          resolutionNotes: z.string().max(2000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, {
          status: input.status,
          resolvedBy: ctx.user.id,
          resolvedAt: new Date(),
          resolutionNotes: input.resolutionNotes ? sanitizeInput(input.resolutionNotes, 2000) : null,
        });
        await logAudit(ctx.user.id, "resolve_exception", "exception", input.id, {
          status: input.status,
          notes: input.resolutionNotes,
        }, ip, ua);

        dispatchWebhook("exception.resolved", { exceptionId: input.id, status: input.status });
        return { success: true };
      }),

    assign: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        assignedTo: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, {
          assignedTo: input.assignedTo,
          status: "in_review",
        });
        await logAudit(ctx.user.id, "assign_exception", "exception", input.id, {
          assignedTo: input.assignedTo,
        }, ip, ua);
        return { success: true };
      }),

    escalate: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, {
          status: "escalated",
          resolutionNotes: input.notes ? sanitizeInput(input.notes, 2000) : null,
        });
        await logAudit(ctx.user.id, "escalate_exception", "exception", input.id, {
          notes: input.notes,
        }, ip, ua);

        dispatchWebhook("exception.escalated", { exceptionId: input.id });
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
      .input(z.object({ matchId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateMatchStatus(input.matchId, "confirmed", ctx.user.id);
        await logAudit(ctx.user.id, "approve_match", "match", input.matchId, {}, ip, ua);
        return { success: true };
      }),

    reject: protectedProcedure
      .input(z.object({ matchId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateMatchStatus(input.matchId, "rejected", ctx.user.id);
        await logAudit(ctx.user.id, "reject_match", "match", input.matchId, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Audit Trail ─────────────────────────────────────────────────

  audit: router({
    list: protectedProcedure
      .input(
        z.object({
          entityType: z.string().max(50).optional(),
          entityId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
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
          jobId: z.number().int().positive(),
          reportType: z.enum(["daily", "weekly", "monthly", "custom"]),
          title: z.string().min(1).max(MAX_NAME_LENGTH),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
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
          processingTimeMs: job.processingTimeMs,
          matchBreakdown: {
            exact: jobMatches.filter((m) => m.matchType === "exact").length,
            fuzzy: jobMatches.filter((m) => m.matchType === "fuzzy").length,
            amountTolerance: jobMatches.filter((m) => m.matchType === "amount_tolerance").length,
            dateWindow: jobMatches.filter((m) => m.matchType === "date_window").length,
            aiSuggested: jobMatches.filter((m) => m.matchType === "ai_suggested").length,
            manual: jobMatches.filter((m) => m.matchType === "manual").length,
            reversal: jobMatches.filter((m) => m.matchType === "reversal").length,
          },
          exceptionBreakdown: {
            missingCounterparty: jobExceptions.filter((e) => e.category === "missing_counterparty").length,
            amountMismatch: jobExceptions.filter((e) => e.category === "amount_mismatch").length,
            timingDifference: jobExceptions.filter((e) => e.category === "timing_difference").length,
            duplicate: jobExceptions.filter((e) => e.category === "duplicate_transaction").length,
            unmatched: jobExceptions.filter((e) => e.category === "unmatched").length,
            reversalUnmatched: jobExceptions.filter((e) => e.category === "reversal_unmatched").length,
            currencyMismatch: jobExceptions.filter((e) => e.category === "currency_mismatch").length,
          },
          generatedAt: new Date().toISOString(),
          generatedBy: ctx.user.name || ctx.user.email || "Unknown",
        };

        const reportId = await db.createReport({
          jobId: input.jobId,
          userId: ctx.user.id,
          reportType: input.reportType,
          title: sanitizeInput(input.title, MAX_NAME_LENGTH),
          summary: JSON.stringify(summary),
          format: "pdf",
        });

        await logAudit(ctx.user.id, "generate_report", "report", reportId || undefined, {
          jobId: input.jobId,
          reportType: input.reportType,
        }, ip, ua);

        return { reportId, summary };
      }),
  }),

  // ─── Export ──────────────────────────────────────────────────────

  export: router({
    csv: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive(),
        type: z.enum(["matches", "exceptions", "transactions", "full"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const report = await db.getFullReconciliationReport(input.jobId);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

        let csvContent = "";
        const job = report.job;

        if (input.type === "matches" || input.type === "full") {
          csvContent += "=== MATCHES ===\n";
          csvContent += "Match ID,Source Txn ID,Target Txn ID,Match Type,Confidence,Amount Diff,Date Diff,Reason,Status\n";
          for (const m of report.matches) {
            csvContent += `${m.id},${m.sourceTransactionId},${m.targetTransactionId},${m.matchType},${m.confidenceScore},${m.amountDifference || 0},${m.dateDifference || 0},"${(m.matchReason || "").replace(/"/g, '""')}",${m.status}\n`;
          }
        }

        if (input.type === "exceptions" || input.type === "full") {
          if (csvContent) csvContent += "\n";
          csvContent += "=== EXCEPTIONS ===\n";
          csvContent += "Exception ID,Transaction ID,Category,Severity,Description,Status\n";
          for (const e of report.exceptions) {
            csvContent += `${e.id},${e.transactionId},${e.category},${e.severity},"${(e.description || "").replace(/"/g, '""')}",${e.status}\n`;
          }
        }

        if (input.type === "transactions" || input.type === "full") {
          if (csvContent) csvContent += "\n";
          csvContent += "=== TRANSACTIONS ===\n";
          csvContent += "ID,Reference,External Ref,Amount,Currency,Date,Direction,Counterparty,Status,Channel ID\n";
          for (const t of report.transactions) {
            csvContent += `${t.id},${t.transactionRef || ""},${t.externalRef || ""},${t.amount},${t.currency},${new Date(t.transactionDate).toISOString()},${t.debitCredit},"${(t.counterparty || "").replace(/"/g, '""')}",${t.status},${t.channelId}\n`;
          }
        }

        // Upload CSV to storage
        const fileName = `reconciliation-export-${input.jobId}-${input.type}-${Date.now()}.csv`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(csvContent, "utf-8"),
          "text/csv"
        );

        await logAudit(ctx.user.id, "export_csv", "reconciliation_job", input.jobId, {
          type: input.type,
          fileName,
        }, ip, ua);

        return { url, fileName, rowCount: csvContent.split("\n").length - 1 };
      }),
  }),

  // ─── Dashboard ───────────────────────────────────────────────────

  dashboard: router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getDashboardStats(ctx.user.id, isAdmin);
    }),
  }),

  // ─── Sample Data Generator ──────────────────────────────────────

  sampleData: router({
    generate: protectedProcedure
      .input(
        z.object({
          transactionCount: z.number().int().min(10).max(500).default(50),
          matchRate: z.number().min(0).max(100).default(75),
          sourceChannel: z.string().min(1).max(50).default("nibss"),
          targetChannel: z.string().min(1).max(50).default("bank_transfer"),
          dateRangeStart: z.string().min(1),
          dateRangeEnd: z.string().min(1),
          includeAmountMismatches: z.boolean().default(true),
          includeTimingDifferences: z.boolean().default(true),
          includeMissingCounterparties: z.boolean().default(true),
          includeDuplicates: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const result = generateSampleData(input as SampleDataConfig);

        await logAudit(ctx.user.id, "generate_sample_data", "sample_data", undefined, {
          transactionCount: input.transactionCount,
          matchRate: input.matchRate,
          sourceChannel: input.sourceChannel,
          targetChannel: input.targetChannel,
          summary: result.summary,
        }, ip, ua);

        return result;
      }),
  }),

  // ─── Webhooks ───────────────────────────────────────────────────

  webhooks: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getWebhooks(ctx.user.id);
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        url: z.string().url().max(2000),
        events: z.array(z.string().max(50)).min(1).max(20),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const secret = crypto.randomBytes(32).toString("hex");
        const id = await db.createWebhook({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          url: input.url,
          secret,
          events: JSON.stringify(input.events),
          isActive: true,
        });
        await logAudit(ctx.user.id, "create_webhook", "webhook", id || undefined, {
          name: input.name,
          events: input.events,
        }, ip, ua);
        return { id, secret }; // Return secret only on creation
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.deleteWebhook(input.id);
        await logAudit(ctx.user.id, "delete_webhook", "webhook", input.id, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── API Keys ───────────────────────────────────────────────────

  apiKeys: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getApiKeys(ctx.user.id);
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        permissions: z.array(z.string().max(50)).min(1).max(20),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const rawKey = `rai_${crypto.randomBytes(32).toString("hex")}`;
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const keyPrefix = rawKey.substring(0, 12);

        const id = await db.createApiKey({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          keyHash,
          keyPrefix,
          permissions: JSON.stringify(input.permissions),
          isActive: true,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86400000)
            : null,
        });

        await logAudit(ctx.user.id, "create_api_key", "api_key", id || undefined, {
          name: input.name,
          permissions: input.permissions,
        }, ip, ua);

        return { id, key: rawKey, prefix: keyPrefix }; // Return raw key only on creation
      }),

    revoke: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.revokeApiKey(input.id);
        await logAudit(ctx.user.id, "revoke_api_key", "api_key", input.id, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Scheduled Tasks ─────────────────────────────────────────────

  schedules: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const tasks = await db.getScheduledTasks(ctx.user.id, isAdmin);
      return tasks.map((t) => ({
        ...t,
        frequencyDescription: getFrequencyDescription(
          t.frequency, t.scheduledTime, t.scheduledDayOfWeek, t.scheduledDayOfMonth
        ),
      }));
    }),

    get: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(async ({ input }) => {
        const task = await db.getScheduledTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND" });
        const history = await db.getScheduleRunHistoryByTask(input.id, 20);
        return {
          ...task,
          frequencyDescription: getFrequencyDescription(
            task.frequency, task.scheduledTime, task.scheduledDayOfWeek, task.scheduledDayOfMonth
          ),
          history,
        };
      }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        description: z.string().max(1000).optional(),
        sourceChannelId: z.number().int().positive(),
        targetChannelId: z.number().int().positive(),
        frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
        scheduledTime: z.string().regex(/^\d{2}:\d{2}$/),
        scheduledDayOfWeek: z.number().int().min(0).max(6).optional(),
        scheduledDayOfMonth: z.number().int().min(1).max(31).optional(),
        timezone: z.string().max(64).default("Africa/Lagos"),
        amountTolerance: z.number().min(0).max(0.1).default(0.005),
        dateWindowDays: z.number().int().min(0).max(30).default(3),
        lookbackDays: z.number().int().min(1).max(90).default(1),
        sendEmailReport: z.boolean().default(true),
        emailRecipients: z.array(z.string().email()).max(10).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);

        // Validate channels
        const source = await db.getChannelById(input.sourceChannelId);
        const target = await db.getChannelById(input.targetChannelId);
        if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source channel not found" });
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Target channel not found" });
        if (input.sourceChannelId === input.targetChannelId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Source and target channels must be different" });
        }

        const nextRun = calculateNextRun(input.frequency, input.scheduledTime, {
          scheduledDayOfWeek: input.scheduledDayOfWeek,
          scheduledDayOfMonth: input.scheduledDayOfMonth,
          timezone: input.timezone,
        });

        const id = await db.createScheduledTask({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          description: input.description ? sanitizeInput(input.description, 1000) : null,
          sourceChannelId: input.sourceChannelId,
          targetChannelId: input.targetChannelId,
          frequency: input.frequency,
          scheduledTime: input.scheduledTime,
          scheduledDayOfWeek: input.scheduledDayOfWeek ?? null,
          scheduledDayOfMonth: input.scheduledDayOfMonth ?? null,
          timezone: input.timezone,
          amountTolerance: String(input.amountTolerance),
          dateWindowDays: input.dateWindowDays,
          lookbackDays: input.lookbackDays,
          sendEmailReport: input.sendEmailReport,
          emailRecipients: input.emailRecipients ? JSON.stringify(input.emailRecipients) : null,
          isActive: true,
          nextRunAt: nextRun,
        });

        await logAudit(ctx.user.id, "create_schedule", "scheduled_task", id || undefined, input, ip, ua);
        return { id, nextRun };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
        description: z.string().max(1000).optional(),
        frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]).optional(),
        scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        scheduledDayOfWeek: z.number().int().min(0).max(6).optional(),
        scheduledDayOfMonth: z.number().int().min(1).max(31).optional(),
        amountTolerance: z.number().min(0).max(0.1).optional(),
        dateWindowDays: z.number().int().min(0).max(30).optional(),
        lookbackDays: z.number().int().min(1).max(90).optional(),
        sendEmailReport: z.boolean().optional(),
        emailRecipients: z.array(z.string().email()).max(10).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const task = await db.getScheduledTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND" });

        const updateData: any = {};
        if (input.name) updateData.name = sanitizeInput(input.name, MAX_NAME_LENGTH);
        if (input.description !== undefined) updateData.description = input.description ? sanitizeInput(input.description, 1000) : null;
        if (input.frequency) updateData.frequency = input.frequency;
        if (input.scheduledTime) updateData.scheduledTime = input.scheduledTime;
        if (input.scheduledDayOfWeek !== undefined) updateData.scheduledDayOfWeek = input.scheduledDayOfWeek;
        if (input.scheduledDayOfMonth !== undefined) updateData.scheduledDayOfMonth = input.scheduledDayOfMonth;
        if (input.amountTolerance !== undefined) updateData.amountTolerance = String(input.amountTolerance);
        if (input.dateWindowDays !== undefined) updateData.dateWindowDays = input.dateWindowDays;
        if (input.lookbackDays !== undefined) updateData.lookbackDays = input.lookbackDays;
        if (input.sendEmailReport !== undefined) updateData.sendEmailReport = input.sendEmailReport;
        if (input.emailRecipients) updateData.emailRecipients = JSON.stringify(input.emailRecipients);
        if (input.isActive !== undefined) updateData.isActive = input.isActive;

        // Recalculate next run if schedule changed
        const freq = input.frequency || task.frequency;
        const time = input.scheduledTime || task.scheduledTime;
        updateData.nextRunAt = calculateNextRun(freq, time, {
          scheduledDayOfWeek: input.scheduledDayOfWeek ?? task.scheduledDayOfWeek,
          scheduledDayOfMonth: input.scheduledDayOfMonth ?? task.scheduledDayOfMonth,
        });

        await db.updateScheduledTask(input.id, updateData);
        await logAudit(ctx.user.id, "update_schedule", "scheduled_task", input.id, input, ip, ua);
        return { success: true, nextRun: updateData.nextRunAt };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.deleteScheduledTask(input.id);
        await logAudit(ctx.user.id, "delete_schedule", "scheduled_task", input.id, {}, ip, ua);
        return { success: true };
      }),

    runNow: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const result = await executeScheduledTask(input.id);
        await logAudit(ctx.user.id, "manual_run_schedule", "scheduled_task", input.id, result, ip, ua);
        if (!result.success) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
        }
        return { jobId: result.jobId };
      }),

    history: protectedProcedure
      .input(z.object({ taskId: z.number().int().positive() }))
      .query(async ({ input }) => {
        return db.getScheduleRunHistoryByTask(input.taskId, 50);
      }),
  }),

  // ─── Email Preferences ──────────────────────────────────────────────

  emailPreferences: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const prefs = await db.getEmailPreferences(ctx.user.id);
      return prefs || {
        emailEnabled: true,
        defaultRecipients: [],
        includeMatchBreakdown: true,
        includeExceptionDetails: true,
        includeChannelPerformance: true,
        includeTrendAnalysis: false,
        notifyOnCompletion: true,
        notifyOnFailure: true,
        notifyOnHighExceptions: true,
        highExceptionThreshold: 10,
        lowMatchRateThreshold: "80.00",
      };
    }),

    update: protectedProcedure
      .input(z.object({
        emailEnabled: z.boolean().optional(),
        defaultRecipients: z.array(z.string().email()).max(20).optional(),
        includeMatchBreakdown: z.boolean().optional(),
        includeExceptionDetails: z.boolean().optional(),
        includeChannelPerformance: z.boolean().optional(),
        includeTrendAnalysis: z.boolean().optional(),
        notifyOnCompletion: z.boolean().optional(),
        notifyOnFailure: z.boolean().optional(),
        notifyOnHighExceptions: z.boolean().optional(),
        highExceptionThreshold: z.number().int().min(1).max(1000).optional(),
        lowMatchRateThreshold: z.number().min(0).max(100).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const updateData: any = { ...input };
        if (input.defaultRecipients) {
          updateData.defaultRecipients = JSON.stringify(input.defaultRecipients);
        }
        if (input.lowMatchRateThreshold !== undefined) {
          updateData.lowMatchRateThreshold = String(input.lowMatchRateThreshold);
        }
        await db.upsertEmailPreferences(ctx.user.id, updateData);
        await logAudit(ctx.user.id, "update_email_prefs", "email_preferences", undefined, input, ip, ua);
        return { success: true };
      }),

    sendReport: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const prefs = await db.getEmailPreferences(ctx.user.id);
        const result = await sendReconciliationReport(input.jobId, {
          includeMatchBreakdown: prefs?.includeMatchBreakdown ?? true,
          includeExceptionDetails: prefs?.includeExceptionDetails ?? true,
          includeChannelPerformance: prefs?.includeChannelPerformance ?? true,
          includeTrendAnalysis: prefs?.includeTrendAnalysis ?? false,
        });
        await logAudit(ctx.user.id, "send_email_report", "reconciliation_job", input.jobId, result, ip, ua);
        if (!result.success) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error || "Failed to send report" });
        }
        return result;
      }),
  }),

  // ─── Job Monitoring ─────────────────────────────────────────────────

  monitoring: router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getMonitoringStats(ctx.user.id, isAdmin);
    }),

    activeJobs: protectedProcedure.query(async () => {
      return getAllActiveJobsProgress();
    }),

    jobProgress: protectedProcedure
      .input(z.object({ jobId: z.number().int().positive() }))
      .query(async ({ input }) => {
        const progress = await getJobProgress(input.jobId);
        if (!progress) throw new TRPCError({ code: "NOT_FOUND" });
        return progress;
      }),

    recentActivity: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        const jobCondition = !isAdmin ? ctx.user.id : undefined;
        // Get recent completed/failed jobs
        const jobs = await db.getReconciliationJobs(ctx.user.id, isAdmin);
        return jobs.slice(0, input.limit).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          matchRate: j.matchRate,
          matchedCount: j.matchedCount,
          exceptionCount: j.exceptionCount,
          processingTimeMs: j.processingTimeMs,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        }));
      }),
  }),

  // ─── Admin ───────────────────────────────────────────────────────

  admin: router({
    users: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),

    updateRole: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        role: z.enum(["user", "admin"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateUserRole(input.userId, input.role);
        await logAudit(ctx.user.id, "update_user_role", "user", input.userId, {
          newRole: input.role,
        }, ip, ua);
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
  const startTime = Date.now();
  try {
    await db.updateReconciliationJob(jobId, { status: "running", startedAt: new Date() });
    await trackProgress(jobId, "queued", { message: "Job queued for processing" });

    await trackProgress(jobId, "loading_data", { message: "Loading transaction data from channels" });
    const sourceTxns = await db.getTransactionsForReconciliation(sourceChannelId, dateFrom, dateTo);
    const targetTxns = await db.getTransactionsForReconciliation(targetChannelId, dateFrom, dateTo);

    await db.updateReconciliationJob(jobId, {
      totalSourceTxns: sourceTxns.length,
      totalTargetTxns: targetTxns.length,
    });

    await trackProgress(jobId, "pass1_exact_match", {
      message: `Processing ${sourceTxns.length} source and ${targetTxns.length} target transactions`,
      totalCount: sourceTxns.length + targetTxns.length,
    });
    const result = runMatchingEngine(sourceTxns, targetTxns, config);
    await trackProgress(jobId, "pass3_tolerance_match", {
      message: `Matching complete: ${result.matches.length} matches found`,
      processedCount: result.matches.length,
      totalCount: sourceTxns.length,
    });

    // Insert matches
    await trackProgress(jobId, "duplicate_detection", {
      message: `Processing ${result.duplicates.length} duplicate groups`,
    });
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

    await trackProgress(jobId, "exception_categorization", {
      message: `Categorizing ${result.unmatchedSource.length + result.unmatchedTarget.length} unmatched transactions`,
      totalCount: result.unmatchedSource.length + result.unmatchedTarget.length,
    });
    // Process unmatched transactions as exceptions
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

    // Create exceptions for detected duplicates
    for (const dupGroup of result.duplicates) {
      for (const txnId of dupGroup.transactionIds) {
        await db.insertException({
          jobId,
          transactionId: txnId,
          category: "duplicate_transaction",
          severity: "medium",
          description: dupGroup.reason,
          suggestedResolution: "Review and remove duplicate transactions. Verify with the source system whether these are genuine separate transactions or data entry errors.",
          status: "open",
        });
        exceptionCount++;
      }
    }

    await trackProgress(jobId, "finalizing", { message: "Finalizing reconciliation results" });
    const totalTxns = sourceTxns.length + targetTxns.length;
    const matchRate = totalTxns > 0 ? ((matchedCount * 2) / totalTxns * 100) : 0;
    const processingTimeMs = Date.now() - startTime;

    await db.updateReconciliationJob(jobId, {
      status: "completed",
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: String(Math.round(matchRate * 100) / 100),
      processingTimeMs,
      completedAt: new Date(),
    });

    await logAudit(userId, "complete_reconciliation", "reconciliation_job", jobId, {
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: `${matchRate.toFixed(2)}%`,
      processingTimeMs,
      engineStats: result.stats,
    });

    await trackProgress(jobId, "completed", {
      message: `Completed: ${matchedCount} matched, ${exceptionCount} exceptions, ${matchRate.toFixed(1)}% match rate`,
      processedCount: matchedCount,
      totalCount: totalTxns,
    });

    // Dispatch webhook
    dispatchWebhook("reconciliation.completed", {
      jobId,
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: Math.round(matchRate * 100) / 100,
      processingTimeMs,
    });

    // Send email alerts based on user preferences
    checkAndSendAlerts(jobId, userId).catch((err) =>
      console.error("[EmailReport] Alert check failed:", err)
    );

  } catch (error) {
    console.error("[Reconciliation] Job failed:", error);
    await db.updateReconciliationJob(jobId, {
      status: "failed",
      completedAt: new Date(),
    });

    await trackProgress(jobId, "failed", { message: `Failed: ${String(error)}` });
    dispatchWebhook("reconciliation.failed", { jobId, error: String(error) });
  }
}

// ─── Start Scheduler on Server Boot ─────────────────────────────────
// Check for due tasks every 60 seconds
startScheduler(60000);
