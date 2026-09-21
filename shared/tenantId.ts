/**
 * Does this id name a real tenant? A positive integer — never null, never
 * undefined, and never the legacy 0.
 *
 * Organisation 0 is not a tenant and never was: CLAUDE.md §19.2 traces rows
 * nobody can reach to exactly that pseudo-tenant. A guard written as
 * `id == null` lets 0 through, and whatever it files there belongs to nobody.
 * Use this wherever a write is about to be owned by an organisation.
 */
export function isTenantId(id: number | null | undefined): id is number {
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}
