/**
 * Materialise a reconciliation report for a job that already exists.
 *
 * The Reports screen was the one section no seeder populated. Both demo tenants
 * had completed reconciliation jobs and no report against any of them, so the
 * screen was empty for a reason that had nothing to do with the data: a report
 * is only ever created when someone presses Generate, and nobody ever had.
 *
 * This does what that button does, through the SAME summary builder
 * (`buildReportSummary`), so a seeded report is structurally identical to a
 * user-generated one. A demo report with a different shape would render with
 * missing or differently-named fields, and the difference would surface in front
 * of whoever was being shown it.
 *
 * Kept out of `reportSummary.ts` so that module stays pure and its tests need no
 * database, and out of either seeder so neither owns a copy.
 */
import { and, eq } from "drizzle-orm";
import { exceptions, matches, reconciliationJobs, reconciliationReports } from "../drizzle/schema";
import { getDb } from "./db";
import { buildReportSummary } from "./reportSummary";

type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type SeededReportType = "daily" | "weekly" | "monthly" | "custom";

/**
 * Create one report for `jobId`, or return null if the job is not there.
 *
 * Scoped by organisation as well as id: a seeder is handed a job id it just
 * created, but reading a job by id alone would happily summarise another
 * tenant's job if that id were ever wrong, and write the result into THIS
 * tenant's reports. The extra predicate costs nothing and removes the
 * possibility.
 */
export async function createReportForJob(
  db: DbHandle,
  args: {
    jobId: number;
    organizationId: number;
    userId: number;
    title: string;
    reportType?: SeededReportType;
    generatedBy?: string;
  },
): Promise<number | null> {
  const [job] = await db
    .select()
    .from(reconciliationJobs)
    .where(and(eq(reconciliationJobs.id, args.jobId), eq(reconciliationJobs.organizationId, args.organizationId)))
    .limit(1);
  if (!job) return null;

  // Only the two columns the breakdowns read. Selecting the whole rows would
  // pull every transaction reference and AI narrative for nothing.
  const jobMatches = await db
    .select({ matchType: matches.matchType })
    .from(matches)
    .where(eq(matches.jobId, args.jobId));
  const jobExceptions = await db
    .select({ category: exceptions.category })
    .from(exceptions)
    .where(and(eq(exceptions.jobId, args.jobId), eq(exceptions.organizationId, args.organizationId)));

  const summary = buildReportSummary({
    job,
    matches: jobMatches,
    exceptions: jobExceptions,
    generatedBy: args.generatedBy ?? "ReconcileAI demo seed",
  });

  const inserted = await db.insert(reconciliationReports).values({
    jobId: args.jobId,
    userId: args.userId,
    organizationId: args.organizationId,
    reportType: args.reportType ?? "custom",
    title: args.title,
    summary,
    format: "pdf",
  });

  const id = Number((inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0);
  return id || null;
}
