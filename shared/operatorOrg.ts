/**
 * Who the platform OPERATOR is — Infinity AI Africa Limited's own organisation.
 *
 * Several controls need to treat one organisation differently from every tenant:
 * SLA alerting has no promise to keep with itself, and a cross-tenant reviewer
 * link is anchored to it rather than to a customer. Those controls need to name
 * that ONE organisation.
 *
 * ── Why a code and not `segment === "super_admin"` ────────────────────────────
 *
 * Both of them were originally written against the segment, and both were wrong
 * in the same way. A segment is a mutable property of an organisation:
 * `superAdmin.updateOrganizationSegment` can retype any org, a customer's
 * included. So "is this the operator?" answered by segment really asks "is this
 * org currently categorised as internal?" — a question whose answer any admin
 * can change, for any row, at any time.
 *
 * Both failures ran in the unsafe direction:
 *
 *   · SLA alerting excluded `super_admin`-segment orgs, so a customer retyped
 *     that way would silently stop being monitored and their real breaches would
 *     go unreported.
 *   · The reviewer gate refuses a platform-wide link while any real tenant
 *     exists, excluding `super_admin`-segment orgs from that count — so a
 *     customer retyped that way would stop holding the gate shut, leaving an
 *     outstanding cross-tenant link live over their data.
 *
 * A code names one specific organisation instead of a category anything can be
 * moved into. `organizations.code` is unique, set at provisioning, and is
 * already how `SHOPLINE_REVIEW_ORG_CODE` pins the dev store.
 *
 * `client/src/lib/navItems.ts` reached this same conclusion for `staffOnly`, in
 * a comment naming this exact hazard. This module exists so the rule has one
 * home rather than being rediscovered a third time.
 */

/** The operator's own organisation. Verified against production 2026-08-30. */
export const OPERATOR_ORG_CODE = "INFINITY_AI";

/**
 * Is this row the operator's own organisation?
 *
 * A missing code is NOT the operator. That direction matters wherever this
 * decides whether something is a tenant: "we could not tell" has to land on
 * "treat it as a tenant", because the alternative is excluding an organisation
 * from a control because a field happened to be empty.
 */
export function isOperatorOrg(org: { code: string | null | undefined }): boolean {
  return org.code === OPERATOR_ORG_CODE;
}
