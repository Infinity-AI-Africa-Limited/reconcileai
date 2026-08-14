/**
 * Which reconciliation modules a vertical can actually use.
 *
 * There are two modules (CLAUDE.md §9):
 *
 *   settlement     — bulk settlement amounts vs detailed transaction reports.
 *                    Every vertical does this. A bank against NIBSS, an FMCG
 *                    distributor against its ERP, a merchant against a gateway
 *                    payout file — same shape, different counterparty.
 *
 *   account_level  — GL-to-CBS balance reconciliation at account and product
 *                    level. CBS is a Core Banking System. This is the Woodcore
 *                    POC's core, and it presupposes a general ledger wired to a
 *                    core banking platform.
 *
 * A SHOPLINE merchant has neither. Their money moves order -> gateway -> payout;
 * there is no GL to tie back to and no core banking system to tie it to. The
 * module page nonetheless offered them account_level, described as delivering
 * "100% audit trail completeness for CBN compliance" and "zero licence
 * revocations" — a promise about a regulator they do not answer to and a licence
 * they do not hold. Worse, `provisionTenantBaseline` switched it ON for every
 * new tenant, so every SHOPLINE merchant was provisioned with it enabled.
 *
 * Corporate B2B keeps both: an FMCG distributor does run a general ledger and
 * reconciles bank accounts against it. Only the retail vertical is narrowed.
 */
export type ModuleType = "settlement" | "account_level";

export const ALL_MODULE_TYPES: readonly ModuleType[] = ["settlement", "account_level"];

/**
 * Segment strings as stored on `organizations.segment`. Kept as a loose string
 * union rather than importing the client's Segment type, so this stays usable
 * from the server without dragging UI types across the boundary.
 */
export type ModuleSegment = "financial_services" | "corporate_b2b" | "retail_commerce" | "super_admin";

/**
 * `null` means the segment is unknown — a legacy org with no segment set, or a
 * lookup that has not resolved. Both modules are returned in that case, because
 * this rule REMOVES an option from one vertical; defaulting to the narrow set
 * would silently disable account_level for every org whose segment is unset.
 * Taking a capability away on missing data is the wrong direction.
 */
export function modulesForSegment(segment: ModuleSegment | string | null | undefined): ModuleType[] {
  return segment === "retail_commerce" ? ["settlement"] : [...ALL_MODULE_TYPES];
}

/** Is this module meaningful for this vertical? */
export function moduleAppliesTo(
  moduleType: ModuleType,
  segment: ModuleSegment | string | null | undefined,
): boolean {
  return modulesForSegment(segment).includes(moduleType);
}

/**
 * Drop rows for modules this vertical cannot use.
 *
 * Provisioning decides what a tenant is BORN with, and it only runs once. Two
 * things escape it. A tenant provisioned before the scope rule existed still
 * carries its `account_level` row — both SHOPLINE merchants in production do,
 * still flagged enabled — and an organisation retyped to `retail_commerce`
 * afterwards (superAdmin.updateOrganizationSegment) was never re-provisioned at
 * all. Neither is reachable by a one-off backfill: the second case can happen
 * again tomorrow.
 *
 * So the read is scoped instead, which makes the stored row inert rather than
 * merely tidy — the toggle and both job-creation paths already refuse it via
 * `assertModuleAvailable`, and this stops it being listed as available in the
 * first place. Scoping the read also self-heals whenever a segment changes.
 *
 * Fails OPEN on an unknown segment, because `moduleAppliesTo` does: this rule
 * REMOVES a module from one vertical, so an unrecognised segment must keep
 * everything rather than silently strip a tenant of a module it uses.
 */
export function scopeModuleRows<T extends { moduleType: string }>(
  rows: readonly T[],
  segment: ModuleSegment | string | null | undefined,
): T[] {
  return rows.filter((row) => moduleAppliesTo(row.moduleType as ModuleType, segment));
}

/** Why a module was refused, for an error a user can act on. */
export function moduleUnavailableReason(moduleType: ModuleType, segment: string | null | undefined): string {
  return `The ${moduleType === "account_level" ? "Account-Level" : "Settlement"} Reconciliation module is not available for ${
    segment === "retail_commerce" ? "retail commerce" : "this"
  } organisations. Account-Level reconciliation matches a general ledger against a core banking system, which retail merchants do not operate.`;
}
