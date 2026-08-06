/**
 * Everything the dashboard needs to decide WHAT to render, resolved here so the
 * page only renders.
 *
 * The page previously computed CBN compliance inline — match-rate thresholds,
 * exception ratios — and then decided visibility from it. That is business
 * logic living in JSX: hard to test, and easy to miss when the rule changes.
 *
 * Each flag is named for the surface it controls, while the underlying checks
 * stay generic comparisons in lib/segments, so the reason a thing is hidden
 * reads here rather than being encoded in a helper's name.
 */
import { useOrgSegment } from "@/hooks/useOrgSegment";
import { isCorporateB2B, isFinancialServices } from "@/lib/segments";
import { evaluateCbnHealth } from "@/lib/cbnHealth";

/** Null as well as undefined: the query returns null when there is no data yet. */
type DashboardStats = {
  transactions: { total: number; matched: number };
  exceptions: { open: number };
} | null | undefined;

export type DashboardVisibility = {
  /** Null means "do not render the badge" — either not a bank, or no data yet. */
  cbnBadge: { compliant: boolean } | null;
  showPilotReadiness: boolean;
};

export function useDashboardVisibility(stats: DashboardStats): DashboardVisibility {
  const segment = useOrgSegment();

  // Financial services only. A SHOPLINE merchant is governed by card-scheme and
  // gateway agreements, not the CBN (CLAUDE.md §2A), so this badge would assert
  // a regulatory status that does not apply to them and link into a report pack
  // for another vertical.
  const showCbnBadge = isFinancialServices(segment);

  // The Pilot Readiness Scorecard grades the DISTRIBUTOR registry, payment
  // references and ERP coverage — the Corporate B2B / FMCG onboarding model. A
  // retail merchant has no distributors, so it scored a permanent zero and
  // offered them a distributor CSV import.
  const showPilotReadiness = isCorporateB2B(segment);

  const health = evaluateCbnHealth({
    totalTransactions: stats?.transactions.total ?? 0,
    matchedTransactions: stats?.transactions.matched ?? 0,
    openExceptions: stats?.exceptions.open ?? 0,
  });

  return {
    cbnBadge: showCbnBadge && health.hasData ? { compliant: health.compliant } : null,
    showPilotReadiness,
  };
}
