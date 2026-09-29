/**
 * The rules behind the SHOPLINE settlement-file importer's editor.
 *
 * The page renders; these decide. They bind the shared mapping rules
 * (settlementMapping.ts) to the fields the SHOPLINE import accepts, and say when
 * an import may run.
 */
import { settlementMappingRules, type SettlementMappingOf } from "./settlementMapping";

export type ShoplineSettlementField =
  | "orderRef"
  | "amount"
  | "gatewayRef"
  | "settledAt"
  | "currency"
  | "fee"
  | "description";

export type ShoplineSettlementMapping = SettlementMappingOf<ShoplineSettlementField>;

/**
 * The fields a merchant maps, in display order. `description` is offered, unlike
 * in the Shopify workspace, because the SHOPLINE import stores it — and offering
 * it is also how a merchant takes away a free-text column that detection mapped.
 */
export const SHOPLINE_SETTLEMENT_FIELDS: ReadonlyArray<{ field: ShoplineSettlementField; required: boolean }> = [
  { field: "orderRef", required: true },
  { field: "amount", required: true },
  { field: "gatewayRef", required: false },
  { field: "settledAt", required: false },
  { field: "currency", required: false },
  { field: "fee", required: false },
  { field: "description", required: false },
];

/** Field → what to call it for a non-technical merchant. */
export const SHOPLINE_SETTLEMENT_FIELD_LABELS: Record<ShoplineSettlementField, string> = {
  orderRef: "Order reference (match key)",
  amount: "Settled amount",
  gatewayRef: "Gateway transaction ID",
  settledAt: "Settlement date",
  currency: "Currency",
  fee: "Fee",
  description: "Description",
};

export const shoplineSettlementMapping = settlementMappingRules(SHOPLINE_SETTLEMENT_FIELDS);

export const SHOPLINE_SETTLEMENT_MAX_BYTES = 10 * 1024 * 1024;

/** What the merchant chose, checked before any bytes are read or sent. Null when fine. */
export function shoplineSettlementFileError(file: { size: number } | null): string | null {
  if (!file) return "Choose a CSV or Excel settlement file first.";
  if (file.size > SHOPLINE_SETTLEMENT_MAX_BYTES) {
    return `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 10MB. Split it by date range.`;
  }
  return null;
}

export interface ShoplineImportEligibility {
  busy: boolean;
  /** The last check's result; null before any check. */
  preview: { committed: boolean; missingRequired: string[] } | null;
  /** The mapping the last check confirmed. */
  checkedMapping: ShoplineSettlementMapping | null;
  /** The mapping on screen now. */
  columnMapping: ShoplineSettlementMapping | null;
}

/** Whether the mapping on screen differs from the one the last check confirmed. */
export function shoplineMappingEdited(input: Pick<ShoplineImportEligibility, "checkedMapping" | "columnMapping">): boolean {
  return (
    input.columnMapping !== null &&
    input.checkedMapping !== null &&
    !shoplineSettlementMapping.same(input.columnMapping, input.checkedMapping)
  );
}

/**
 * Import runs only the exact mapping the server last confirmed, and only once:
 * an edit since the check must be checked again, so rows are never written
 * against column meanings nobody looked at.
 */
export function canImportShoplineSettlement(input: ShoplineImportEligibility): boolean {
  return Boolean(
    !input.busy &&
      input.preview &&
      !input.preview.committed &&
      input.preview.missingRequired.length === 0 &&
      input.checkedMapping &&
      shoplineSettlementMapping.missingRequired(input.checkedMapping).length === 0 &&
      !shoplineMappingEdited(input),
  );
}
