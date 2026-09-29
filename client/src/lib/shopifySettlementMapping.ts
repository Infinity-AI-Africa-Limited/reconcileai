import type { ShopifySettlementField } from "./shopifyAppBridge";
import { settlementMappingRules, type SettlementMappingOf } from "./settlementMapping";

export type SettlementMapping = SettlementMappingOf<ShopifySettlementField>;

/**
 * The fields a merchant maps in the Shopify workspace, in display order.
 *
 * `description` is not offered: the import discards free-text descriptions
 * (they can hold a customer's name or address), so asking for one would ask for
 * something that is never kept.
 */
export const SETTLEMENT_MAPPING_FIELDS: ReadonlyArray<{ field: ShopifySettlementField; required: boolean }> = [
  { field: "orderRef", required: true },
  { field: "amount", required: true },
  { field: "gatewayRef", required: false },
  { field: "settledAt", required: false },
  { field: "currency", required: false },
  { field: "fee", required: false },
];

// The shared rules (settlementMapping.ts), bound to the Shopify fields.
const rules = settlementMappingRules(SETTLEMENT_MAPPING_FIELDS);

/** The offered fields that have a column — what is submitted as the confirmed mapping. */
export const confirmedSettlementMapping = rules.confirmed;

/** Put a column on a field, or take the field's column away (`null`). */
export const assignSettlementColumn = rules.assign;

export const missingRequiredSettlementFields = rules.missingRequired;

/** Whether two mappings agree on every offered field. */
export const sameSettlementMapping = rules.same;
