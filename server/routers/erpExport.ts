/**
 * ERP export domain router (gap-closure plan WS-7).
 *
 * First domain router created under the split plan (docs/ROUTERS_SPLIT_PLAN.md):
 * imports its building blocks from ./shared, business logic lives in
 * server/erpExport.ts.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { operationsProcedure, logAudit, getClientInfo } from "./shared";
import {
  ERP_TARGETS,
  ERP_LABELS,
  loadJournalEntriesForJob,
  renderErpExport,
  DEFAULT_GL_MAPPING,
  RECON_CONTROL_ACCOUNT,
} from "../erpExport";
import { storagePut, orgScopedKey } from "../storage";
import { getDb } from "../db";

export const erpExportRouter = router({
  /** Targets + the placeholder GL mapping (UI dropdown + mapping display). */
  targets: protectedProcedure.query(() => ({
    targets: ERP_TARGETS.map((t) => ({ id: t, label: ERP_LABELS[t] })),
    glMapping: DEFAULT_GL_MAPPING,
    controlAccount: RECON_CONTROL_ACCOUNT,
  })),

  /**
   * Generate natively-importable journal-entry files for a completed job's
   * resolved exceptions. Files are stored under the org-scoped key convention
   * (WS-2 ACL) and recorded in s3_csv_exports; download via the authenticated
   * storage proxy.
   */
  generate: operationsProcedure
    .input(z.object({
      jobId: z.number().int().positive(),
      target: z.enum(ERP_TARGETS),
    }))
    .mutation(async ({ ctx, input }) => {
      const loaded = await loadJournalEntriesForJob(input.jobId, ctx.user.organizationId ?? null);
      if (!loaded) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

      if (loaded.entries.length === 0) {
        return {
          entryCount: 0,
          files: [] as Array<{ filename: string; downloadPath: string }>,
          message: "No resolved exceptions to export — resolve exceptions first; dismissed exceptions post nothing.",
        };
      }

      const rendered = renderErpExport(input.target, loaded.entries, input.jobId);
      const orgId = ctx.user.organizationId;
      const db = await getDb();
      const files: Array<{ filename: string; downloadPath: string }> = [];

      for (const f of rendered) {
        const relKey = `erp-exports/job${input.jobId}/${f.filename}`;
        const key = orgId ? orgScopedKey(orgId, relKey) : relKey;
        const { url } = await storagePut(key, Buffer.from(f.content, "utf-8"), "text/csv");
        if (db) {
          const { s3CsvExports } = await import("../../drizzle/schema");
          await db.insert(s3CsvExports).values({
            userId: ctx.user.id,
            organizationId: orgId ?? null,
            s3Key: key,
            s3Url: url,
            filename: f.filename,
            sourceModule: "erp",
            sourceId: input.jobId,
            sizeBytes: Buffer.byteLength(f.content, "utf-8"),
            retentionDays: 30,
            deleted: false,
          });
        }
        // Serve through the authenticated, org-ACL'd proxy — never the raw URL.
        files.push({ filename: f.filename, downloadPath: `/manus-storage/${key}` });
      }

      const { ip, ua } = getClientInfo(ctx);
      await logAudit(ctx.user.id, "erp_export_generated", "reconciliation_job", input.jobId, {
        target: input.target,
        entryCount: loaded.entries.length,
        files: files.map((f) => f.filename),
      }, ip, ua);

      return { entryCount: loaded.entries.length, files, message: null };
    }),
});
