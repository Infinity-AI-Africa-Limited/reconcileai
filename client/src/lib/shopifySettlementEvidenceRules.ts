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
