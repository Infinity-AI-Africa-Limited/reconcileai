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
 *     Readiness scorecard built on it. Distributors belong to the CORPORATE B2B
 *     sector and to no other: the registry records the distributors an FMCG
 *     supplier sells through. A bank does not sell through distributors and a
 *     retail merchant does not have any.
 *
 * The rules are written as explicit allow-lists per feature rather than as one
 * "not retail" exclusion, because they genuinely differ and a shared exclusion
 * hid that.
 *
 * A correction worth recording, because the mistake is easy to repeat. An
 * earlier revision made distributor_registry available to financial services,
 * reasoning from production data: 30 distributor rows are owned by a
 * financial-services organisation. That was misfiled data being read as
 * authority. The corporate-B2B demo tenant — the one that legitimately owns the
 * concept — holds ZERO distributor rows, and a further 14 sit under
 * organizationId 0, which is no tenant at all. The client had it right the whole
 * time: navItems.ts scopes Distributor Registry to ["corporate_b2b"], and
 * useDashboardVisibility gates Pilot Readiness on isCorporateB2B. Data describes
 * what happened; it does not define what is correct.
 */
export type VerticalFeature = "cbn_regulatory_reporting" | "distributor_registry";

export const ALL_VERTICAL_FEATURES: readonly VerticalFeature[] = [
  "cbn_regulatory_reporting",
  "distributor_registry",
];

/** Segment strings as stored on `organizations.segment`. */
export type FeatureSegment = "financial_services" | "corporate_b2b" | "retail_commerce" | "super_admin";

export const ALL_FEATURE_SEGMENTS: readonly FeatureSegment[] = [
  "financial_services",
  "corporate_b2b",
  "retail_commerce",
  "super_admin",
];

/**
 * Which segments each feature is FOR. Allow-lists, so adding a vertical is a
 * deliberate entry here rather than an accident of how an exclusion was phrased.
 *
 * `super_admin` appears in both because the platform operator supports every
 * tenant, matching how shared/moduleScope treats it.
 */
const FEATURE_SEGMENTS: Record<VerticalFeature, readonly FeatureSegment[]> = {
  // Regulatory returns to a supervisor. Not retail — a merchant answers to card
  // schemes and its gateway agreements, not to a banking regulator.
  cbn_regulatory_reporting: ["financial_services", "corporate_b2b", "super_admin"],
  // Corporate B2B only. Distributors are that sector's concept and no other's.
  distributor_registry: ["corporate_b2b", "super_admin"],
};

/**
 * `null`/unknown means the segment has not resolved, or a legacy organisation has
 * none set. Both keep the feature, because this rule REMOVES a capability from
 * some verticals: defaulting to "denied" would switch these surfaces off for every
 * organisation whose segment is unset. Taking a capability away on missing data is
 * the wrong direction to fail — the same reasoning as shared/moduleScope.
 *
 * Note this is about an unknown SEGMENT, not an absent ORGANISATION. A caller with
 * no organisation at all is refused before this is consulted (see
 * verticalFeatureProcedure) — the two are different questions and sharing a branch
 * between them let org-less accounts through once already.
 */
export function featureAppliesTo(
  feature: VerticalFeature,
  segment: FeatureSegment | string | null | undefined,
): boolean {
  if (!segment || !ALL_FEATURE_SEGMENTS.includes(segment as FeatureSegment)) return true;
  return FEATURE_SEGMENTS[feature].includes(segment as FeatureSegment);
}

/**
 * The same rule for code that CREATES rows, where the default must be inverted.
 *
 * `featureAppliesTo` fails OPEN on an unknown segment, deliberately: withdrawing
 * a capability because data is missing is the wrong direction for a read. Applied
 * to a write, that same default manufactures rows — an absent organisation yields
 * an absent segment, the check passes, and the row is filed against a tenant that
 * does not exist. That is how 14 distributor rows came to sit under
 * organizationId 0, reachable by nobody, and re-deriving the check inline is how
 * the same mistake kept coming back in three different files.
 *
 * So this one demands a positive match: an organisation that exists, whose
 * segment is known, and whose segment carries the feature. Unknown means NO.
 */
export function featureStrictlyAppliesTo(
  feature: VerticalFeature,
  segment: FeatureSegment | string | null | undefined,
): boolean {
  if (!segment || !ALL_FEATURE_SEGMENTS.includes(segment as FeatureSegment)) return false;
  return FEATURE_SEGMENTS[feature].includes(segment as FeatureSegment);
}

/** Why a feature was refused, phrased so the reader can act on it. */
export function featureUnavailableReason(
  feature: VerticalFeature,
  segment: FeatureSegment | string | null | undefined,
): string {
  const who =
    segment === "retail_commerce" ? "retail commerce"
    : segment === "financial_services" ? "financial services"
    : segment === "corporate_b2b" ? "corporate B2B"
    : "this";
  return feature === "cbn_regulatory_reporting"
    ? `CBN regulatory reporting is not available for ${who} organisations. Retail merchants are governed by card-scheme rules and their gateway and courier agreements, not by a banking supervisor.`
    : `The distributor registry is not available for ${who} organisations. It records the distributors an FMCG supplier sells through, and belongs to the corporate B2B sector only.`;
}
