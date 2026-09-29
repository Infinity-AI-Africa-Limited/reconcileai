/**
 * `shoplineConnector.importSettlementFile` — reconcile against ANY payment system
 * (CLAUDE.md §2C).
 *
 * Split out of shoplineConnector.ts (CLAUDE.md §16: routers over 150 lines are
 * split) and spread back into that router, so the tRPC path is unchanged. The
 * procedures are declared as properties of a plain object, which is also the
 * shape the portal-scope roster in shoplinePortalScope.test.ts scans for.
 *
 * The committing work lives in connectors/shopline/settlementFileCommit.ts; this
 * file is the procedure: authorise, parse, resolve the mapping, commit, audit.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { slConnectorStores } from "../../drizzle/connector_schema";
import { protectedProcedure } from "../_core/trpc";
import { resolveOrgScope } from "../_core/tenancy";
import { createUploadBatch, getDb, logPlatformEvent, updateUploadBatch } from "../db";
import {
  mapSettlementRows,
  parseSettlementFile,
  resolveImportColumns,
} from "../connectors/shopline/settlementFileImport";
import { resolveChannelIds } from "../connectors/shopline/syncOrchestrator";
import {
  commitShoplineSettlementFile,
  unverifiableDuplicatesNote,
} from "../connectors/shopline/settlementFileCommit";

export const shoplineSettlementImportProcedures = {
  /**
   * Import a settlement / payout file from ANY payment system.
   *
   * SHOPLINE Payments is opt-in; merchants on third-party gateways or Cash on
   * Delivery have no automatic payment leg (see bestEffortLeg). This lets them
   * supply the gateway's or courier's own CSV/XLSX export so reconciliation can
   * complete. Auto-detects the columns and accepts explicit overrides, so an
   * unfamiliar provider is still importable.
   *
   * Tenancy: the target channel is resolved SERVER-SIDE from the caller's own
   * organization. It is deliberately not a client-supplied channel code —
   * `channels.list` / `upload.createBatch` are not org-scoped, and a
   * merchant-facing upload must not be able to name another tenant's channel.
   *
   * `dryRun` returns the detected mapping and a preview without writing, so the
   * UI can have the merchant confirm the column mapping before committing.
   */
  importSettlementFile: protectedProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        /** Super-admin portal context only; validated by resolveOrgId below. */
        organizationId: z.number().int().positive().optional(),
        /** Base64 for spreadsheets, raw text for CSV. */
        content: z.string().min(1).max(14_000_000), // ~10MB decoded
        contentEncoding: z.enum(["utf8", "base64"]).default("utf8"),
        sourceLabel: z.string().min(1).max(80).default("Settlement file"),
        // partialRecord: under zod 4 an enum-keyed `record` is exhaustive and
        // refused any override that named fewer than all seven fields.
        // Legacy HINTS: detection still fills every field they leave out.
        columnOverrides: z
          .partialRecord(
            z.enum(["orderRef", "gatewayRef", "amount", "currency", "settledAt", "fee", "description"]),
            z.string().max(200),
          )
          .optional(),
        // The mapping the merchant CONFIRMED in the editor: the whole answer. A
        // field it omits stays unmapped, so a wrongly detected optional column
        // can be taken away, and a header not in this file is dropped.
        columnMapping: z
          .partialRecord(
            z.enum(["orderRef", "gatewayRef", "amount", "currency", "settledAt", "fee", "description"]),
            z.string().max(200),
          )
          .optional(),
        dryRun: z.boolean().default(false),
      }),
    )
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

      const raw =
        input.contentEncoding === "base64" ? Buffer.from(input.content, "base64") : input.content;

      let parsed;
      try {
        parsed = await parseSettlementFile(raw, input.fileName);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Could not read the file",
        });
      }

      const { mapping, missingRequired } = resolveImportColumns(parsed.headers, {
        columnMapping: input.columnMapping,
        columnOverrides: input.columnOverrides,
      });

      // Preview, or a file we cannot map — either way, write nothing and tell
      // the caller exactly what was detected so they can correct it.
      if (input.dryRun || missingRequired.length > 0) {
        return {
          dryRun: true,
          committed: false,
          headers: parsed.headers,
          mapping,
          missingRequired,
          totalRows: parsed.rows.length,
          parseErrors: parsed.parseErrors,
          sampleRows: parsed.rows.slice(0, 5),
        };
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

        // One transaction, one writer per store: the event-level dedupe, the
        // insert, the scoped reconciliation and the batch's close commit
        // together or not at all. See settlementFileCommit.ts.
        const { imported, duplicates, unverifiableDuplicates, failures, matchedCount, exceptionCount } = await commitShoplineSettlementFile(db, {
          organizationId: orgId,
          storeId: store.id,
          ordersChannelId,
          paymentsChannelId,
          batchId,
          rows,
          mappingFailures,
          currency: store.currency ?? "USD",
        });

        // Record the operator who wrote into this tenant.
        //
        // Portal scope is what makes this necessary: before it, an import could
        // only land in the caller's OWN organisation, so the rows identified
        // their author. A super admin can now create financial transactions in
        // a merchant's ledger, and nothing on those rows says who did.
        //
        // Only on the committing path — a dry run writes nothing — and only for
        // a cross-tenant write, so a merchant importing their own settlements
        // does not fill the operator log with routine activity.
        if (input.organizationId !== undefined && orgId !== ctx.user.organizationId) {
          // The audit must not be able to fail the import.
          //
          // By this line the settlement rows and the reconciliation results are
          // already committed, in a transaction that has closed. Letting a
          // failed audit insert reach the enclosing catch would mark the upload
          // batch `failed` and return an error for work that actually
          // succeeded — the merchant is told nothing imported while their
          // ledger says otherwise, and the obvious response is to retry.
          //
          // So the failure is made loud rather than fatal: an unattributed
          // write is recoverable from this log line, a ledger that disagrees
          // with its own status is not.
          try {
            await logPlatformEvent({
              actorId: ctx.user.id,
              actorName: ctx.user.name ?? undefined,
              eventType: "tenant_data_imported",
              targetType: "organization",
              targetId: orgId,
              targetName: store.storeHandle,
              newValue: JSON.stringify({
                fileName: input.fileName,
                sourceLabel: input.sourceLabel,
                imported,
                duplicates,
                failed: failures.length,
              }),
            });
          } catch (auditErr) {
            console.error(
              "[shopline-settlement] AUDIT WRITE FAILED for a committed cross-tenant import — " +
                `actor=${ctx.user.id} targetOrg=${orgId} store=${store.storeHandle} ` +
                `file=${input.fileName} imported=${imported} duplicates=${duplicates} failed=${failures.length}`,
              auditErr,
            );
          }
        }

        return {
          dryRun: false,
          committed: true,
          headers: parsed.headers,
          mapping,
          missingRequired: [] as string[],
          totalRows: parsed.rows.length,
          imported,
          duplicates,
          unverifiableDuplicates,
          unverifiableDuplicatesNote: unverifiableDuplicatesNote(unverifiableDuplicates),
          failed: failures.length,
          parseErrors: parsed.parseErrors,
          sampleFailures: failures.slice(0, 5),
          matchedCount,
          exceptionCount,
        };
      } catch (err) {
        // The commit is one transaction, so a failure wrote nothing. The batch
        // says so in words a merchant can read: a database error's own text is
        // the failed query and its parameters, never shown to a tenant.
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
