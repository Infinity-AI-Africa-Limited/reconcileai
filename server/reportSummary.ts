/**
 * The summary a reconciliation report carries.
 *
 * This was written inline inside `reports.generate` and nowhere else, which was
 * fine while a report could only be produced by a user pressing Generate. It
 * stopped being fine the moment anything else needed to produce one: a second
 * writer would have had to restate the breakdown by hand, and a demo report
 * whose shape differs from a real one is not a demo, it is a misrepresentation —
 * the Reports screen would render it with fields missing or named differently
 * and the difference would only surface in front of whoever was being shown it.
 *
 * So the shape lives here once and both callers use it. The parameters are
 * structural `Pick`s of the schema rows rather than the rows themselves, so a
 * caller holding a narrowed query result still fits, while a renamed column
 * still breaks the build.
 */
import type { exceptions, matches, reconciliationJobs } from "../drizzle/schema";

/** Only the job fields the summary actually reads. */
export type ReportSummaryJob = Pick<
  typeof reconciliationJobs.$inferSelect,
  | "name"
  | "dateFrom"
  | "dateTo"
  | "totalSourceTxns"
  | "totalTargetTxns"
  | "matchedCount"
  | "exceptionCount"
  | "unmatchedCount"
  | "matchRate"
  | "processingTimeMs"
>;

export type ReportSummaryMatch = Pick<typeof matches.$inferSelect, "matchType">;
export type ReportSummaryException = Pick<typeof exceptions.$inferSelect, "category">;

/**
 * Every match type the breakdown reports, in the order the Reports screen shows
 * them. Listed explicitly so a type that exists in the schema but is missing
 * here fails the accompanying test rather than silently reporting zero — an
 * undercount reads as "no fuzzy matches", which is a claim, not an absence.
 */
export const REPORTED_MATCH_TYPES = [
  "exact",
  "fuzzy",
  "amount_tolerance",
  "date_window",
  "ai_suggested",
  "manual",
  "reversal",
] as const;

/** Exception categories the breakdown reports, keyed by their summary field. */
export const REPORTED_EXCEPTION_CATEGORIES = {
  missingCounterparty: "missing_counterparty",
  amountMismatch: "amount_mismatch",
  timingDifference: "timing_difference",
  duplicate: "duplicate_transaction",
  unmatched: "unmatched",
  reversalUnmatched: "reversal_unmatched",
  currencyMismatch: "currency_mismatch",
} as const;

export type ReportSummary = {
  jobName: string;
  dateRange: string;
  totalSource: number | null;
  totalTarget: number | null;
  matched: number | null;
  exceptions: number | null;
  unmatched: number | null;
  matchRate: string | number | null;
  processingTimeMs: number | null;
  matchBreakdown: Record<string, number>;
  exceptionBreakdown: Record<string, number>;
  generatedAt: string;
  generatedBy: string;
};

/**
 * Build the summary for one completed job.
 *
 * The counts come from the JOB row, not from the arrays — the job is what the
 * engine recorded, and a report that recounted the rows it happened to fetch
 * would disagree with the job it claims to summarise the moment either side is
 * paged or filtered. The arrays are used only for the breakdowns, which have no
 * equivalent on the job.
 */
export function buildReportSummary(args: {
  job: ReportSummaryJob;
  matches: readonly ReportSummaryMatch[];
  exceptions: readonly ReportSummaryException[];
  generatedBy: string;
  generatedAt?: Date;
}): ReportSummary {
  const { job, matches: jobMatches, exceptions: jobExceptions } = args;

  const matchBreakdown: Record<string, number> = {};
  for (const type of REPORTED_MATCH_TYPES) {
    matchBreakdown[camel(type)] = jobMatches.filter((m) => m.matchType === type).length;
  }

  const exceptionBreakdown: Record<string, number> = {};
  for (const [field, category] of Object.entries(REPORTED_EXCEPTION_CATEGORIES)) {
    exceptionBreakdown[field] = jobExceptions.filter((e) => e.category === category).length;
  }

  return {
    jobName: job.name,
    dateRange: `${job.dateFrom} - ${job.dateTo}`,
    totalSource: job.totalSourceTxns,
    totalTarget: job.totalTargetTxns,
    matched: job.matchedCount,
    exceptions: job.exceptionCount,
    unmatched: job.unmatchedCount,
    matchRate: job.matchRate,
    processingTimeMs: job.processingTimeMs,
    matchBreakdown,
    exceptionBreakdown,
    generatedAt: (args.generatedAt ?? new Date()).toISOString(),
    generatedBy: args.generatedBy,
  };
}

/** `amount_tolerance` → `amountTolerance`, matching the field names shipped before. */
function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
