/**
 * The column-mapping rules every settlement importer's editor follows — one
 * definition, bound to each importer's own list of fields.
 *
 * The SHOPLINE and Shopify importers accept different fields (Shopify discards a
 * free-text description; SHOPLINE keeps it), but a column assigned twice, a
 * required field left empty, or an import run against a mapping nobody checked
 * mean the same thing in both. So the rules live here once, and each importer
 * binds them to its fields rather than keeping a copy that can drift.
 */
export type SettlementMappingField<F extends string> = { field: F; required: boolean };

export type SettlementMappingOf<F extends string> = Partial<Record<F, string>>;

export interface SettlementMappingRules<F extends string> {
  /** The offered fields, in display order. */
  fields: ReadonlyArray<SettlementMappingField<F>>;
  /** The offered fields that have a column — what is submitted as the confirmed mapping. */
  confirmed(mapping: SettlementMappingOf<F>): SettlementMappingOf<F>;
  /**
   * Put a column on a field, or take the field's column away (`null`). A column
   * feeds one field: assigning it moves it off any field that had it, so the
   * order reference and the amount can never silently read the same column.
   */
  assign(mapping: SettlementMappingOf<F>, field: F, header: string | null): SettlementMappingOf<F>;
  missingRequired(mapping: SettlementMappingOf<F>): F[];
  /**
   * Whether two mappings agree on every offered field. An import runs only the
   * mapping the last check confirmed; an edit since then must be checked again.
   */
  same(a: SettlementMappingOf<F>, b: SettlementMappingOf<F>): boolean;
}

export function settlementMappingRules<F extends string>(
  fields: ReadonlyArray<SettlementMappingField<F>>,
): SettlementMappingRules<F> {
  const offered = new Set<F>(fields.map(({ field }) => field));

  const confirmed = (mapping: SettlementMappingOf<F>): SettlementMappingOf<F> => {
    const result: SettlementMappingOf<F> = {};
    for (const { field } of fields) {
      const header = mapping[field];
      if (header) result[field] = header;
    }
    return result;
  };

  return {
    fields,
    confirmed,
    assign(mapping, field, header) {
      if (!offered.has(field)) return confirmed(mapping);
      const next: SettlementMappingOf<F> = {};
      for (const { field: other } of fields) {
        const current = mapping[other];
        if (other !== field && current && current !== header) next[other] = current;
      }
      if (header) next[field] = header;
      return confirmed(next);
    },
    missingRequired(mapping) {
      return fields.filter(({ field, required }) => required && !mapping[field]).map(({ field }) => field);
    },
    same(a, b) {
      return fields.every(({ field }) => (a[field] ?? null) === (b[field] ?? null));
    },
  };
}
