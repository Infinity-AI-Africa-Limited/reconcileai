/**
 * The request side of `shoplineConnector.importSettlementFile`: what the
 * procedure accepts, and the operator audit it writes. Kept here so the router
 * module stays wiring (CLAUDE.md §16).
 */
import { z } from "zod";
import { logPlatformEvent } from "../../db";

const SETTLEMENT_FIELD = z.enum(["orderRef", "gatewayRef", "amount", "currency", "settledAt", "fee", "description"]);

/**
 * partialRecord, not record: under zod 4 an enum-keyed `record` is exhaustive
 * and refused a mapping that named fewer than all seven fields.
 */
const COLUMN_MAP = z.partialRecord(SETTLEMENT_FIELD, z.string().max(200)).optional();

export const shoplineSettlementImportInput = z.object({
  fileName: z.string().min(1).max(255),
  /** Super-admin portal context only; checked by resolveOrgScope before any read. */
  organizationId: z.number().int().positive().optional(),
  /** Base64 for spreadsheets, raw text for CSV. */
  content: z.string().min(1).max(14_000_000), // ~10MB decoded
  contentEncoding: z.enum(["utf8", "base64"]).default("utf8"),
  sourceLabel: z.string().min(1).max(80).default("Settlement file"),
  /** Legacy HINTS: detection still fills every field they leave out. */
  columnOverrides: COLUMN_MAP,
  /**
   * The mapping the merchant CONFIRMED in the editor: the whole answer. A field
   * it omits stays unmapped, and a header not in this file is dropped.
   */
  columnMapping: COLUMN_MAP,
  dryRun: z.boolean().default(false),
});

export interface CrossTenantImportAudit {
  actor: { id: number; name?: string | null };
  organizationId: number;
  storeHandle: string;
  fileName: string;
  sourceLabel: string;
  imported: number;
  duplicates: number;
  failed: number;
}

/**
 * Record the operator who wrote a settlement file into ANOTHER tenant's ledger.
 *
 * Portal scope is what makes this necessary: a super admin can create financial
 * transactions in a merchant's ledger, and nothing on those rows says who did.
 *
 * It must never fail the import. It runs after the import's transaction has
 * committed; a failed audit reaching the caller would mark the batch `failed`
 * and report an error for work that succeeded, and the merchant's obvious
 * response is to retry. So a failure is made loud, not fatal: an unattributed
 * write is recoverable from the log line, a ledger that disagrees with its own
 * status is not. The line names the error by type only — a database error's
 * text is its query and parameters.
 */
export async function auditCrossTenantSettlementImport(
  audit: CrossTenantImportAudit,
  deps: { log?: typeof logPlatformEvent } = {},
): Promise<void> {
  try {
    await (deps.log ?? logPlatformEvent)({
      actorId: audit.actor.id,
      actorName: audit.actor.name ?? undefined,
      eventType: "tenant_data_imported",
      targetType: "organization",
      targetId: audit.organizationId,
      targetName: audit.storeHandle,
      newValue: JSON.stringify({
        fileName: audit.fileName,
        sourceLabel: audit.sourceLabel,
        imported: audit.imported,
        duplicates: audit.duplicates,
        failed: audit.failed,
      }),
    });
  } catch (auditError) {
    console.error(
      "[shopline-settlement] AUDIT WRITE FAILED for a committed cross-tenant import — " +
        `actor=${audit.actor.id} targetOrg=${audit.organizationId} store=${audit.storeHandle} ` +
        `file=${audit.fileName} imported=${audit.imported} duplicates=${audit.duplicates} failed=${audit.failed}`,
      { error: auditError instanceof Error ? auditError.name : typeof auditError },
    );
  }
}
