/**
 * `shoplineConnector.importSettlementFile` — reconcile against ANY payment system
 * (CLAUDE.md §2C). Its own module, spread into shoplineConnectorRouter so the
 * path is unchanged (CLAUDE.md §16). Declared as a property of a plain object —
 * the shape the portal-scope roster in shoplinePortalScope.test.ts scans for.
 *
 * This is wiring: authorise, parse, resolve the mapping, commit, audit. The
 * work lives in connectors/shopline: settlementImportRequest.ts (input, audit)
 * and settlementFileCommit.ts (the one-transaction commit).
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { slConnectorStores } from "../../drizzle/connector_schema";
import { protectedProcedure } from "../_core/trpc";
import { resolveOrgScope } from "../_core/tenancy";
import { createUploadBatch, getDb, updateUploadBatch } from "../db";
import { mapSettlementRows, parseSettlementFile, resolveImportColumns } from "../connectors/shopline/settlementFileImport";
import { resolveChannelIds } from "../connectors/shopline/syncOrchestrator";
import { commitShoplineSettlementFile, unverifiableDuplicatesNote } from "../connectors/shopline/settlementFileCommit";
import {
  auditCrossTenantSettlementImport,
  shoplineSettlementImportInput,
} from "../connectors/shopline/settlementImportRequest";

export const shoplineSettlementImportProcedures = {
  /**
   * Import a settlement / payout file from ANY payment system: merchants on a
   * third-party gateway or Cash on Delivery have no automatic payment leg.
   *
   * Tenancy: the target channel is resolved SERVER-SIDE from the caller's
   * organisation, never from a client-supplied channel code.
   *
   * `dryRun` returns the mapping and a preview without writing, so the merchant
   * confirms — or corrects — the columns before anything is committed.
   */
  importSettlementFile: protectedProcedure
    .input(shoplineSettlementImportInput)
    .mutation(async ({ ctx, input }) => {
      // Reject a tenant-supplied portal override before any database access.
      const orgId = resolveOrgScope(ctx.user, input.organizationId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [store] = await db
        .select()
        .from(slConnectorStores)
        .where(and(eq(slConnectorStores.organizationId, orgId), eq(slConnectorStores.status, "active")))
        .limit(1);
      if (!store) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active SHOPLINE store for this organisation" });
      }

      const raw = input.contentEncoding === "base64" ? Buffer.from(input.content, "base64") : input.content;
      const parsed = await parseSettlementFile(raw, input.fileName).catch((err: unknown) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not read the file" });
      });
      const { mapping, missingRequired } = resolveImportColumns(parsed.headers, input);
      const summary = { headers: parsed.headers, mapping, totalRows: parsed.rows.length, parseErrors: parsed.parseErrors };

      // A preview, or a file we cannot map: write nothing, show what was read.
      if (input.dryRun || missingRequired.length > 0) {
        return { dryRun: true, committed: false, ...summary, missingRequired, sampleRows: parsed.rows.slice(0, 5) };
      }

      const { ordersChannelId, paymentsChannelId } = await resolveChannelIds(db, orgId, store.storeHandle);
      const batchId = await createUploadBatch({
        userId: ctx.user.id,
        organizationId: orgId,
        channelId: paymentsChannelId,
        fileName: `settlement_import_${input.fileName}`,
        fileHash: null,
        detectedFormat: "settlement_file",
        totalRows: parsed.rows.length,
        validRows: 0,
        invalidRows: 0,
        status: "processing",
      });
      if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create upload batch" });

      try {
        const { rows, failures: mappingFailures } = mapSettlementRows(parsed.rows, mapping, {
          organizationId: orgId,
          paymentsChannelId,
          batchId,
          userId: ctx.user.id,
          defaultCurrency: store.currency ?? "USD",
          sourceLabel: input.sourceLabel,
        });
        // One transaction, one writer per store: dedupe, insert, scoped
        // reconciliation and the batch's close commit together or not at all.
        const committed = await commitShoplineSettlementFile(db, {
          organizationId: orgId,
          storeId: store.id,
          ordersChannelId,
          paymentsChannelId,
          batchId,
          rows,
          mappingFailures,
          currency: store.currency ?? "USD",
        });
        const { imported, duplicates, unverifiableDuplicates, failures } = committed;

        // Committed. Now record an operator writing into ANOTHER tenant's
        // ledger — never a dry run, never a merchant's own routine import. The
        // audit cannot fail the import (see auditCrossTenantSettlementImport).
        if (input.organizationId !== undefined && orgId !== ctx.user.organizationId) {
          await auditCrossTenantSettlementImport({
            actor: { id: ctx.user.id, name: ctx.user.name },
            organizationId: orgId,
            storeHandle: store.storeHandle,
            fileName: input.fileName,
            sourceLabel: input.sourceLabel,
            imported,
            duplicates,
            failed: failures.length,
          });
        }

        return {
          dryRun: false,
          committed: true,
          ...summary,
          missingRequired: [] as string[],
          imported,
          duplicates,
          unverifiableDuplicates,
          unverifiableDuplicatesNote: unverifiableDuplicatesNote(unverifiableDuplicates),
          failed: failures.length,
          sampleFailures: failures.slice(0, 5),
          matchedCount: committed.matchedCount,
          exceptionCount: committed.exceptionCount,
        };
      } catch (err) {
        // One transaction, so a failure wrote nothing; the batch says so in words
        // a merchant can read — never a database error's query and parameters.
        await updateUploadBatch(batchId, {
          status: "failed",
          errorMessage:
            err instanceof TRPCError ? err.message.slice(0, 2000) : "The import failed and nothing was written. Try again.",
          completedAt: new Date(),
        });
        throw err;
      }
    }),
};
