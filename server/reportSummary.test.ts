/**
 * The report summary is the payload the Reports screen renders and the shared
 * report link serves. It was extracted from `reports.generate` so the demo
 * seeders could produce the same shape; these pin that the extraction changed
 * nothing, and that the breakdowns cannot quietly undercount.
 */
import { describe, it, expect } from "vitest";
import {
  buildReportSummary,
  REPORTED_MATCH_TYPES,
  REPORTED_EXCEPTION_CATEGORIES,
  type ReportSummaryJob,
} from "./reportSummary";

const job: ReportSummaryJob = {
  name: "Card Payments vs Core Banking",
  dateFrom: "2026-09-01" as unknown as ReportSummaryJob["dateFrom"],
  dateTo: "2026-09-20" as unknown as ReportSummaryJob["dateTo"],
  totalSourceTxns: 320,
  totalTargetTxns: 320,
  matchedCount: 304,
  exceptionCount: 16,
  unmatchedCount: 16,
  matchRate: "95.00",
  processingTimeMs: 1840,
};

describe("when a report is generated for a completed job", () => {
  it("should carry exactly the fields the Reports screen shipped with", () => {
    // The screen reads these names. Renaming one silently empties a card rather
    // than failing, so the contract is pinned rather than trusted.
    const summary = buildReportSummary({ job, matches: [], exceptions: [], generatedBy: "Ada" });
    expect(Object.keys(summary).sort()).toEqual(
      [
        "jobName", "dateRange", "totalSource", "totalTarget", "matched", "exceptions",
        "unmatched", "matchRate", "processingTimeMs", "matchBreakdown",
        "exceptionBreakdown", "generatedAt", "generatedBy",
      ].sort(),
    );
    expect(Object.keys(summary.matchBreakdown).sort()).toEqual(
      ["exact", "fuzzy", "amountTolerance", "dateWindow", "aiSuggested", "manual", "reversal"].sort(),
    );
    expect(Object.keys(summary.exceptionBreakdown).sort()).toEqual(
      Object.keys(REPORTED_EXCEPTION_CATEGORIES).sort(),
    );
  });

  it("should take the headline counts from the JOB, not from the rows it was handed", () => {
    // A report that recounted the arrays would disagree with the job it claims
    // to summarise as soon as either side is paged or filtered.
    const summary = buildReportSummary({
      job,
      matches: [{ matchType: "exact" }],
      exceptions: [{ category: "amount_mismatch" }],
      generatedBy: "Ada",
    });
    expect(summary.matched).toBe(304);
    expect(summary.exceptions).toBe(16);
    expect(summary.matchBreakdown.exact).toBe(1); // breakdowns DO come from the rows
  });

  it("should count every match type it claims to report", () => {
    const matches = REPORTED_MATCH_TYPES.map((matchType) => ({ matchType }));
    const summary = buildReportSummary({ job, matches, exceptions: [], generatedBy: "Ada" });
    for (const value of Object.values(summary.matchBreakdown)) {
      expect(value, `a reported match type counted 0 with one of each present`).toBe(1);
    }
  });

  it("should count every exception category it claims to report", () => {
    const exceptions = Object.values(REPORTED_EXCEPTION_CATEGORIES).map((category) => ({ category }));
    const summary = buildReportSummary({ job, matches: [], exceptions, generatedBy: "Ada" });
    for (const [field, value] of Object.entries(summary.exceptionBreakdown)) {
      expect(value, `${field} counted 0 with one of each present`).toBe(1);
    }
  });

  it("should render the date range the way the screen expects", () => {
    const summary = buildReportSummary({ job, matches: [], exceptions: [], generatedBy: "Ada" });
    expect(summary.dateRange).toBe("2026-09-01 - 2026-09-20");
  });

  it("should record who generated it", () => {
    // A shared report carries this to the recipient; "Unknown" is the router's
    // fallback, never this function's business.
    const summary = buildReportSummary({ job, matches: [], exceptions: [], generatedBy: "Demo Seeder" });
    expect(summary.generatedBy).toBe("Demo Seeder");
  });
});
