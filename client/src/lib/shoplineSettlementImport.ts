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

// ─── The importer's state ────────────────────────────────────────────────────

export type ShoplineSettlementPreview = {
  committed: boolean;
  headers: string[];
  mapping: ShoplineSettlementMapping;
  missingRequired: string[];
  totalRows: number;
  parseErrors: string[];
};

export type ShoplineSettlementCommitted = ShoplineSettlementPreview & {
  imported: number;
  duplicates: number;
  unverifiableDuplicates?: number;
  unverifiableDuplicatesNote?: string | null;
  failed: number;
  matchedCount: number;
};

export interface ShoplineImportState<F> {
  /**
   * Which file choice this state belongs to. Every request is tagged with the
   * generation it was sent for, and a reply for an earlier one is dropped: a
   * check still running when the merchant picks another file must not confirm
   * its mapping onto the new file.
   */
  generation: number;
  file: F | null;
  sourceLabel: string;
  busy: "checking" | "importing" | null;
  preview: ShoplineSettlementPreview | null;
  result: ShoplineSettlementCommitted | null;
  error: string | null;
  columnMapping: ShoplineSettlementMapping | null;
  checkedMapping: ShoplineSettlementMapping | null;
}

export type ShoplineImportAction<F> =
  | { type: "chooseFile"; file: F | null }
  | { type: "sourceLabel"; value: string }
  | { type: "changeColumn"; field: ShoplineSettlementField; header: string | null }
  | { type: "invalid"; message: string }
  | { type: "started"; generation: number; mode: "checking" | "importing" }
  | { type: "checked"; generation: number; preview: ShoplineSettlementPreview }
  | { type: "imported"; generation: number; result: ShoplineSettlementCommitted }
  | { type: "failed"; generation: number; message: string };

export function initialShoplineImportState<F>(): ShoplineImportState<F> {
  return {
    generation: 0,
    file: null,
    sourceLabel: "",
    busy: null,
    preview: null,
    result: null,
    error: null,
    columnMapping: null,
    checkedMapping: null,
  };
}

export function shoplineImportReducer<F>(
  state: ShoplineImportState<F>,
  action: ShoplineImportAction<F>,
): ShoplineImportState<F> {
  switch (action.type) {
    case "chooseFile":
      // A new generation: anything still in flight now answers for a file that
      // is no longer on screen.
      return { ...initialShoplineImportState<F>(), generation: state.generation + 1, file: action.file, sourceLabel: state.sourceLabel };
    case "sourceLabel":
      return { ...state, sourceLabel: action.value, result: null };
    case "changeColumn":
      return {
        ...state,
        columnMapping: shoplineSettlementMapping.assign(state.columnMapping ?? {}, action.field, action.header),
        result: null,
      };
    case "invalid":
      return { ...state, error: action.message };
    default:
      break;
  }
  if (action.generation !== state.generation) return state; // a reply for a file no longer chosen
  switch (action.type) {
    case "started":
      return { ...state, busy: action.mode, error: null };
    case "checked": {
      const confirmed = shoplineSettlementMapping.confirmed(action.preview.mapping);
      return { ...state, busy: null, preview: action.preview, columnMapping: confirmed, checkedMapping: confirmed };
    }
    case "imported":
      return { ...state, busy: null, result: action.result };
    case "failed":
      return { ...state, busy: null, error: action.message };
  }
}
