/**
 * Generic POC tRPC router (public, no-login — same access model as woodcore.*).
 *
 * Powers the self-service company POC pages: a prospect uploads their ledger +
 * bank statement, the system extracts + reconciles, and results are stored and
 * shareable. All procedures are scoped by `pocSlug` so each company's POC is
 * isolated. POC data never touches the real tenant `transactions` table.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../_core/trpc";
import * as poc from "../poc-engine";

// ~20 MB of base64 keeps us safely under the 50 MB Express body limit.
const MAX_BASE64_LEN = 20 * 1024 * 1024;
const pocSlug = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);

export const pocRouter = router({
  // Extract canonical transactions from one uploaded file (AI-powered).
  extract: publicProcedure
    .input(
      z.object({
        pocSlug,
        side: z.enum(["ledger", "statement"]),
        fileName: z.string().max(500).optional(),
        fileType: z.enum(["pdf", "excel", "csv"]),
        contentBase64: z.string().min(1).max(MAX_BASE64_LEN),
      }),
    )
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      let extraction;
      try {
        extraction = await poc.extractTransactions({
          fileType: input.fileType,
          base64: input.contentBase64,
          fileName: input.fileName,
        });
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Could not extract transactions from this file." });
      }

      const { pocUploads } = await import("../../drizzle/poc_schema");
      const inserted = await db.insert(pocUploads).values({
        pocSlug: input.pocSlug,
        side: input.side,
        fileName: input.fileName ?? null,
        fileType: input.fileType,
        rowCount: extraction.rows.length,
        rows: extraction.rows,
        notes: extraction.notes,
      });
      const uploadId = (inserted as any)[0].insertId as number;

      return {
        uploadId,
        rowCount: extraction.rows.length,
        currency: extraction.currency,
        notes: extraction.notes,
        preview: extraction.rows.slice(0, 10), // let the user confirm the AI read it right
      };
    }),

  // Run the 3-layer reconciliation on two previously-extracted uploads.
  run: publicProcedure
    .input(
      z.object({
        pocSlug,
        ledgerUploadId: z.number().int().positive(),
        statementUploadId: z.number().int().positive(),
        amountTolerance: z.number().min(0).max(0.1).default(0.005),
        dateWindowDays: z.number().int().min(0).max(30).default(3),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await poc.runFullPoc({
          pocSlug: input.pocSlug,
          ledgerUploadId: input.ledgerUploadId,
          statementUploadId: input.statementUploadId,
          config: { amountTolerance: input.amountTolerance, dateWindowDays: input.dateWindowDays },
        });
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message || "Reconciliation failed." });
      }
    }),

  getRun: publicProcedure
    .input(z.object({ pocSlug, runId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const run = await poc.getRun(input.runId, input.pocSlug);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      const exceptions = await poc.getRunExceptions(input.runId);
      return { run, exceptions };
    }),

  getExceptions: publicProcedure
    .input(z.object({ runId: z.number().int().positive() }))
    .query(async ({ input }) => poc.getRunExceptions(input.runId)),

  listRuns: publicProcedure
    .input(z.object({ pocSlug }))
    .query(async ({ input }) => poc.listRuns(input.pocSlug)),

  updateExceptionStatus: publicProcedure
    .input(
      z.object({
        exceptionId: z.number().int().positive(),
        reviewStatus: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "ESCALATED"]),
        reviewedBy: z.string().max(100).optional(),
        reviewNote: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { pocExceptions } = await import("../../drizzle/poc_schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(pocExceptions)
        .set({
          reviewStatus: input.reviewStatus,
          reviewedBy: input.reviewedBy ?? null,
          reviewNote: input.reviewNote ?? null,
          reviewedAt: new Date(),
        })
        .where(eq(pocExceptions.id, input.exceptionId));
      return { success: true, exceptionId: input.exceptionId, reviewStatus: input.reviewStatus };
    }),

  createShareToken: publicProcedure
    .input(z.object({ pocSlug, runId: z.number().int().positive(), createdBy: z.string().max(100).optional() }))
    .mutation(async ({ input }) => poc.createShareToken(input.runId, input.pocSlug, input.createdBy)),

  getSharedReport: publicProcedure
    .input(z.object({ token: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const report = await poc.getSharedReport(input.token);
      if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "This shared report link is invalid or has expired." });
      return report;
    }),
});
