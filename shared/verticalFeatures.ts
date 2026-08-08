/**
 * Which whole FEATURES a vertical is offered, as opposed to which reconciliation
 * modules it can run (that is shared/moduleScope).
 *
 * Both rules exist for the same reason: the client hides a surface and the server
 * must refuse it, and those two must not be able to disagree. A hidden nav entry
 * in front of an open procedure is not a boundary — it is a decoration.
 *
 *   cbn_regulatory_reporting — the CBN/BoU return pack, the signed attestation,
 *     the deadline tracker and the examination-facing Auditor dashboard. These
 *     assert a regulatory posture toward a banking supervisor. A SHOPLINE
 *     merchant answers to card schemes and gateway agreements, not the CBN
 *     (CLAUDE.md §2A), so offering them a CBN pack invites them to file a return
 *     to a regulator they have no standing with.
 *
 *   distributor_registry — the distributor identity registry and the Pilot
 *     Readiness scorecard built on it. It grades distributor coverage, payment
 *     references and ERP mapping: the FMCG onboarding model. A retail merchant
 *     has no distributors, so the scorecard sat at a permanent zero and offered
 *     them a distributor CSV import.
 *
 * BOTH rules are "not retail", deliberately, and NOT "financial services only" —
 * which is what the documentation alone would suggest. The registry's 30 live
 * rows are owned by a financial-services organisation, so a financial-services-
 * only rule would have orphaned real data. Written as separate feature keys so
 * that if the two ever need to diverge, that is a change to this table rather
 * than a refactor of every call site.
 */
export type VerticalFeature = "cbn_regulatory_reporting" | "distributor_registry";

export const ALL_VERTICAL_FEATURES: readonly VerticalFeature[] = [
  "cbn_regulatory_reporting",
  "distributor_registry",
];

/** Segment strings as stored on `organizations.segment`. */
export type FeatureSegment = "financial_services" | "corporate_b2b" | "retail_commerce" | "super_admin";

/**
 * `null`/unknown means the segment has not resolved, or a legacy organisation has
 * none set. Both keep the feature, because this rule REMOVES a capability from one
 * vertical: defaulting to "denied" would switch these surfaces off for every
 * organisation whose segment is unset. Taking a capability away on missing data is
 * the wrong direction to fail — the same reasoning as shared/moduleScope.
 */
export function featureAppliesTo(
  feature: VerticalFeature,
  segment: FeatureSegment | string | null | undefined,
): boolean {
  // Currently both features are withheld from exactly one vertical. The feature
  // parameter is still taken so the rule has somewhere to diverge later.
  void feature;
  return segment !== "retail_commerce";
}

/** Why a feature was refused, phrased so the reader can act on it. */
export function featureUnavailableReason(
  feature: VerticalFeature,
  segment: FeatureSegment | string | null | undefined,
): string {
  const who = segment === "retail_commerce" ? "retail commerce" : "this";
  return feature === "cbn_regulatory_reporting"
    ? `CBN regulatory reporting is not available for ${who} organisations. Retail merchants are governed by card-scheme rules and their gateway and courier agreements, not by a banking supervisor.`
    : `The distributor registry is not available for ${who} organisations. It records the distributors an FMCG supplier sells through, which a retail merchant does not have.`;
}
