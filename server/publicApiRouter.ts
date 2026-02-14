/**
 * Public API Router
 * 
 * These endpoints are designed for external integrations and do NOT require
 * user authentication. Instead, they use API key authentication.
 * 
 * Mount this router at /api/v1 in the Express app.
 */

import { router, publicProcedure } from "./_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  processApiUpload,
  getApiIngestionLogs,
  type ApiUploadRequest,
} from "./apiIngestionService";

// ─── Public API Router ──────────────────────────────────────────────

export const publicApiRouter = router({
  // POST /api/v1/transactions/upload
  uploadTransactions: publicProcedure
    .input(
      z.object({
        apiKey: z.string().min(32, "API key must be at least 32 characters"),
        channelId: z.number().int().positive(),
        fileName: z.string().max(500),
        fileContent: z.string().min(1, "File content cannot be empty"),
        encoding: z.enum(["base64", "utf8"]).optional().default("utf8"),
        autoReconcile: z.boolean().optional().default(false),
        reconcileTargetChannelId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Extract IP and User-Agent from request context
      const ipAddress = (ctx as any).req?.ip || (ctx as any).req?.connection?.remoteAddress;
      const userAgent = (ctx as any).req?.headers?.["user-agent"];

      const result = await processApiUpload(input as ApiUploadRequest, ipAddress, userAgent);

      if (!result.success) {
        throw new TRPCError({
          code: result.errors?.[0]?.includes("Unauthorized") ? "UNAUTHORIZED" : "BAD_REQUEST",
          message: result.message,
          cause: result.errors,
        });
      }

      return result;
    }),

  // GET /api/v1/ingestion/logs
  getIngestionLogs: publicProcedure
    .input(
      z.object({
        apiKey: z.string().min(32),
        status: z.enum(["success", "failed", "partial"]).optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      })
    )
    .query(async ({ input }) => {
      // Validate API key first
      const { validateApiKey } = await import("./apiIngestionService");
      const validation = await validateApiKey(input.apiKey);

      if (!validation.valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: validation.error || "Invalid API key",
        });
      }

      const logs = await getApiIngestionLogs({
        organizationId: validation.organizationId,
        apiKeyId: validation.apiKeyId,
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      });

      return logs;
    }),

  // GET /api/v1/health - Public health check endpoint
  health: publicProcedure.query(() => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    };
  }),
});

export type PublicApiRouter = typeof publicApiRouter;
