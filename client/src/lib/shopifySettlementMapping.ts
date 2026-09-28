import type { ShopifySettlementField } from "./shopifyAppBridge";

export type SettlementMapping = Partial<Record<ShopifySettlementField, string>>;

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

const OFFERED = new Set(SETTLEMENT_MAPPING_FIELDS.map(({ field }) => field));

/** The offered fields that have a column — what is submitted as the confirmed mapping. */
export function confirmedSettlementMapping(mapping: SettlementMapping): SettlementMapping {
  const confirmed: SettlementMapping = {};
  for (const { field } of SETTLEMENT_MAPPING_FIELDS) {
    const header = mapping[field];
    if (header) confirmed[field] = header;
  }
  return confirmed;
}

/**
 * Put a column on a field, or take the field's column away (`null`).
 *
 * A column feeds one field: assigning it moves it off any field that had it, so
 * the order reference and the amount can never silently read the same column.
 */
export function assignSettlementColumn(
  mapping: SettlementMapping,
  field: ShopifySettlementField,
  header: string | null,
): SettlementMapping {
  if (!OFFERED.has(field)) return confirmedSettlementMapping(mapping);
  const next: SettlementMapping = {};
  for (const { field: other } of SETTLEMENT_MAPPING_FIELDS) {
    const current = mapping[other];
    if (other !== field && current && current !== header) next[other] = current;
  }
  if (header) next[field] = header;
  return confirmedSettlementMapping(next);
}

export function missingRequiredSettlementFields(mapping: SettlementMapping): ShopifySettlementField[] {
  return SETTLEMENT_MAPPING_FIELDS.filter(({ field, required }) => required && !mapping[field]).map(
    ({ field }) => field,
  );
}

/**
 * Whether two mappings agree on every offered field. The workspace imports only
 * the mapping the last check confirmed; an edit since then must be checked again.
 */
export function sameSettlementMapping(a: SettlementMapping, b: SettlementMapping): boolean {
  return SETTLEMENT_MAPPING_FIELDS.every(({ field }) => (a[field] ?? null) === (b[field] ?? null));
}
