/**
 * CBN compliance health, derived from reconciliation stats.
 *
 * These thresholds are a regulatory judgement, not presentation, so they live
 * here rather than inline in the dashboard: a page that computes "is this
 * institution compliant" is holding business logic, and the numbers below are
 * the kind that get revised by someone who will never think to look in a JSX
 * file.
 */

/** Thresholds a Nigerian institution is assessed against on the dashboard badge. */
export const CBN_THRESHOLDS = {
  minMatchRatePct: 95,
  maxExceptionRatioPct: 5,
  maxOpenExceptions: 50,
} as const;

export type CbnHealthInput = {
  totalTransactions: number;
  matchedTransactions: number;
  openExceptions: number;
};

export type CbnHealth = {
  /** False when there is nothing to assess — no transactions means no verdict. */
  hasData: boolean;
  matchRatePct: number;
  exceptionRatioPct: number;
  compliant: boolean;
};

export function evaluateCbnHealth(input: CbnHealthInput): CbnHealth {
  const { totalTransactions, matchedTransactions, openExceptions } = input;
  const hasData = totalTransactions > 0;

  // Guard the division rather than letting it produce NaN: NaN >= 95 is false,
  // so an empty tenant would silently read as "At Risk" instead of "no verdict".
  const matchRatePct = hasData ? (matchedTransactions / totalTransactions) * 100 : 0;
  const exceptionRatioPct = hasData ? (openExceptions / totalTransactions) * 100 : 0;

  return {
    hasData,
    matchRatePct,
    exceptionRatioPct,
    compliant:
      matchRatePct >= CBN_THRESHOLDS.minMatchRatePct &&
      exceptionRatioPct <= CBN_THRESHOLDS.maxExceptionRatioPct &&
      openExceptions <= CBN_THRESHOLDS.maxOpenExceptions,
  };
}
