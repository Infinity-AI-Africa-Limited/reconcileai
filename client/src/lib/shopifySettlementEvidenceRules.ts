import type {
  ShopifySettlementEvidenceCommitted,
  ShopifySettlementEvidenceDryRun,
} from "./shopifyAppBridge";
import type { SettlementMapping } from "./shopifySettlementMapping";

/** The merchant-facing file cap for the embedded Scope A evidence workflow. */
export const SHOPIFY_SETTLEMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const SPREADSHEET_FILE = /\.(xlsx|xlsm|xlsb|xls)$/i;

export type SettlementEvidenceFile = Pick<File, "name" | "size" | "text" | "arrayBuffer">;

export function isSettlementSpreadsheet(fileName: string): boolean {
  return SPREADSHEET_FILE.test(fileName);
}

/**
 * Validates the merchant-controlled inputs before file bytes are read or sent.
 * Returns a stable, display-safe message rather than exposing parser details.
 */
export function settlementEvidenceInputError(
  file: SettlementEvidenceFile | null,
  sourceLabel: string,
): string | null {
  if (!file) return "Choose a CSV or Excel settlement export before checking columns.";
  if (!sourceLabel.trim()) return "Enter the source of this merchant-provided settlement evidence before checking columns.";
  if (file.size > SHOPIFY_SETTLEMENT_MAX_FILE_BYTES) {
    return "This file is larger than 10MB. Split it by date range, then try again.";
  }
  return null;
}

export type SettlementEvidenceEligibility = {
  file: SettlementEvidenceFile | null;
  sourceLabel: string;
  busy: boolean;
  preview: ShopifySettlementEvidenceDryRun | null;
  result: ShopifySettlementEvidenceCommitted | null;
  checkedMapping: SettlementMapping | null;
  mappingEdited: boolean;
};

export function canCheckSettlementEvidence(input: SettlementEvidenceEligibility): boolean {
  return !input.busy && settlementEvidenceInputError(input.file, input.sourceLabel) === null;
}

/**
 * Import is deliberately stricter than dry-run: only the exact mapping which
 * the server last confirmed may write evidence. A changed mapping must be
 * checked again, so the client never imports against stale column semantics.
 */
export function canImportSettlementEvidence(input: SettlementEvidenceEligibility): boolean {
  return Boolean(
    !input.busy
      && input.preview
      && input.preview.missingRequired.length === 0
      && input.checkedMapping
      && !input.mappingEdited
      && !input.result,
  );
}

/**
 * What the merchant needs to know about rows that name no Shopify order
 * ReconcileAI has synced, or null when there are none.
 *
 * Before import the answer is still actionable — sync first. After it, it is
 * an explanation: such rows are recorded against the file's own reference and
 * flagged, and importing them again once the order syncs will not re-link
 * them (it counts them as duplicates), so the merchant must hear it first.
 */
export function unalignedRowsNotice(
  report: Pick<ShopifySettlementEvidenceDryRun, "committed" | "unalignedRows">
    | Pick<ShopifySettlementEvidenceCommitted, "committed" | "unalignedRows">,
): string | null {
  const count = report.unalignedRows;
  if (count === null || count === 0) return null;
  if (!report.committed) {
    return count === 1
      ? "1 row names a Shopify order ReconcileAI has not synced. If it is a recent order, refresh order evidence before importing. Otherwise the row will be imported unmatched and flagged as an exception, and importing it again later will not link it to its order."
      : `${count} rows name Shopify orders ReconcileAI has not synced. If they are recent orders, refresh order evidence before importing. Otherwise the rows will be imported unmatched and flagged as exceptions, and importing them again later will not link them to their orders.`;
  }
  return count === 1
    ? "1 imported row names no Shopify order ReconcileAI has synced, so it was flagged as an exception. Importing the file again will not link it to its order."
    : `${count} imported rows name no Shopify order ReconcileAI has synced, so they were flagged as exceptions. Importing the file again will not link them to their orders.`;
}
