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
import { and, eq, inArray } from "drizzle-orm";
import { exceptions, matches, reconciliationJobs, reconciliationReports } from "../drizzle/schema";
import { getDb } from "./db";
import { buildReportSummary } from "./reportSummary";

type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type SeededReportType = "daily" | "weekly" | "monthly" | "custom";

/**
 * Provenance marker written into a seeded report's summary, and the ONLY thing
 * that identifies one for replacement.
 *
 * An earlier revision matched on the title instead. Review pointed out the hole
 * and it is real: the Reports screen AUTO-FILLS the title from the selected job,
 * so a user generating a report against a seeded job lands on a title that can
 * equal the seeded one — and the next activation would have deleted their report
 * without a word. A user cannot produce this field at all: `buildReportSummary`
 * never emits it, and it is added here after the summary is built, so nothing
 * reachable from `reports.generate` can set it.
 *
 * Versioned so a future change of meaning does not silently adopt rows written
 * under the old one.
 */
export const DEMO_REPORT_MARKER = "reconcileai-demo-seed-v1";

/** Does a stored report summary carry the seed marker? Pure, so both callers agree. */
export function isSeededReportSummary(summary: unknown): boolean {
  return (
    typeof summary === "object" &&
    summary !== null &&
    (summary as { demoSeedMarker?: unknown }).demoSeedMarker === DEMO_REPORT_MARKER
  );
}

/**
 * Create THE demo report for `jobId`, replacing any earlier SEEDED report in the
 * same tenant (identified by DEMO_REPORT_MARKER, never by title). Returns null
 * if the job is not there.
 *
 * Scoped by organisation as well as id: a seeder is handed a job id it just
 * created, but reading a job by id alone would happily summarise another
 * tenant's job if that id were ever wrong, and write the result into THIS
 * tenant's reports. The extra predicate costs nothing and removes the
 * possibility.
 *
 * ── Why it replaces rather than appends ───────────────────────────────────
 *
 * The two seeders differ, and the difference leaked. The financial-services
 * seeder wipes its prior demo data before reseeding, so it naturally holds one
 * report. The FMCG seeder appends on purpose — a re-run adds a further batch and
 * job rather than duplicating the distributor roster — so a report per run would
 * accumulate near-identical rows on the Reports screen, and `demo.activate` is a
 * button someone can press repeatedly.
 *
 * Keyed on `DEMO_REPORT_MARKER`, a value only this function writes — NOT on the
 * title, which the Reports screen auto-fills from the job and a user can
 * therefore share. The alternative — skip if any report exists — would leave the
 * report describing the PREVIOUS run's job while the current job is the one on
 * screen, which is worse than a duplicate: wrong rather than merely repeated.
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

  // Replace the previous SEEDED report, identified by a marker no user-created
  // report can carry. Title is deliberately NOT part of this: the Reports screen
  // auto-fills the title from the job, so a user's report can share it, and
  // matching on it would delete their work.
  //
  // The marker is read in TypeScript, not with JSON_EXTRACT: a tenant holds a
  // handful of reports, drizzle returns `summary` already parsed, and the
  // delete that follows is a typed, tenant-scoped statement over explicit ids.
  const prior = (
    await db
      .select({ id: reconciliationReports.id, summary: reconciliationReports.summary })
      .from(reconciliationReports)
      .where(eq(reconciliationReports.organizationId, args.organizationId))
  )
    .filter((r) => isSeededReportSummary(r.summary))
    .map((r) => r.id);
  if (prior.length) {
    await db.delete(reconciliationReports).where(and(
      eq(reconciliationReports.organizationId, args.organizationId),
      inArray(reconciliationReports.id, prior),
    ));
  }

  const inserted = await db.insert(reconciliationReports).values({
    jobId: args.jobId,
    userId: args.userId,
    organizationId: args.organizationId,
    reportType: args.reportType ?? "custom",
    title: args.title,
    // Marker added AFTER the shared builder, so `buildReportSummary` keeps the
    // exact contract `reports.generate` ships and nothing a user can reach adds
    // this field.
    summary: { ...summary, demoSeedMarker: DEMO_REPORT_MARKER },
    format: "pdf",
  });

  const id = Number((inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0);
  return id || null;
}
