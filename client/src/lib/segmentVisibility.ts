/**
 * Which dashboard surfaces each vertical actually sees.
 *
 * Pure policy, deliberately separated from the React hook that reads the
 * segment, so the rules are testable and stated in one place. Before this, the
 * dashboard rendered every surface to every segment, which meant a SHOPLINE
 * merchant was shown:
 *
 *   - a **CBN compliance badge** asserting a Nigerian banking-regulator status
 *     that does not apply to them (CLAUDE.md §2A scopes the CBN engine to
 *     financial services), linking into a report pack for another vertical;
 *   - a **Pilot Readiness Scorecard** grading "Distributor Name Consistency"
 *     off `distributor.stats` — the Corporate B2B / FMCG registry. A retail
 *     merchant has no distributors, so it scored 0 permanently and offered a
 *     distributor CSV import;
 *   - an **Auditor dashboard** built for an examiner of a regulated
 *     institution.
 *
 * None of these were broken; each was confidently wrong, which is worse on a
 * screen a merchant is meant to trust.
 *
 * `null` means "not resolved yet". Every predicate here gates on an EXPLICIT
 * match rather than a negation, so a pending lookup hides a surface briefly
 * instead of flashing one the tenant should never see.
 */
export type Segment = "financial_services" | "corporate_b2b" | "retail_commerce" | "super_admin";

/** CBN reporting is a Nigerian banking-regulator obligation. Retail is governed
 *  by card-scheme rules and gateway agreements instead. */
export function showsCbnCompliance(segment: Segment | null): boolean {
  return segment === "financial_services";
}

/** Scores the distributor registry + ERP coverage — the FMCG onboarding model. */
export function showsPilotReadiness(segment: Segment | null): boolean {
  return segment === "corporate_b2b";
}

/**
 * The Auditor view reports audit-trail volume and an examiner-framed
 * "compliance rate", and its server-side sibling feeds the CBN pack. A retail
 * merchant has no examiner, so there is nothing for the view to mean.
 *
 * CFO and Operations DO carry over: "did the money arrive, and what is it worth"
 * and "what is unresolved, and who is working it" are vertical-agnostic
 * questions a SHOPLINE merchant asks daily.
 */
export function showsAuditorView(segment: Segment | null): boolean {
  return segment !== "retail_commerce";
}

export type DashboardViewKey = "main" | "cfo" | "operations" | "auditor";

/** The dashboard views offered to a segment, in display order. */
export function dashboardViewsFor(segment: Segment | null): DashboardViewKey[] {
  const views: DashboardViewKey[] = ["main", "cfo", "operations"];
  if (showsAuditorView(segment)) views.push("auditor");
  return views;
}
