/**
 * refresh-demo-recency.ts — make a demo tenant's exceptions span the window a
 * viewer can actually select, and optionally collapse it to a single run.
 *
 *   pnpm demo:recency                      # report only, writes nothing
 *   pnpm demo:recency --commit             # re-date exceptions
 *   pnpm demo:recency --commit --trim      # ...and keep only the newest run
 *   pnpm demo:recency --org 1 --commit     # one tenant
 *
 * WHY THIS EXISTS
 *
 * The Exceptions and Review Queue screens open on TODAY, offer Today /
 * Yesterday / Last 7 days, and let a viewer pick any custom range from the
 * calendar. Measured 2026-09-20, neither demo tenant survived that:
 *
 *   Globus Bank      8-30 days held ONE exception
 *   BrightGoods      nothing yesterday, nothing in the 31-90 day band
 *
 * Transactions were already fine — they span every band — so this deliberately
 * touches ONLY exceptions rather than rewriting 79,718 transaction rows for no
 * gain. Verify before widening it: re-dating what is already correct is how a
 * fix becomes an incident.
 *
 * ── Ordering, and why it is not arbitrary ─────────────────────────────────
 *
 * Rows carrying an AI diagnosis are dated FIRST, so they land in the recent
 * band. Globus holds 542 legacy exceptions with no diagnosis alongside 16
 * curated operational cases; spreading them evenly would push the curated cases
 * into August and fill this week with rows that show an empty diagnosis panel.
 * The good cases belong in the window every screen opens on.
 *
 * SAFETY
 *
 *   - Reporting is the DEFAULT. Writing requires --commit.
 *   - Refuses any organisation not flagged `isDemo`.
 *   - Every statement is scoped by organizationId.
 *   - --trim deletes whole runs and is irreversible; it names what it will
 *     remove and requires --commit like everything else.
 */
import "dotenv/config";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  transactions,
  uploadBatches,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { dateForIndex, statusForAge, daysAgoForIndex, RECENCY_BANDS } from "../server/demoRecency";

const COMMIT = process.argv.includes("--commit");
const TRIM = process.argv.includes("--trim");
const orgFlag = process.argv.indexOf("--org");
const TARGETS = orgFlag !== -1 ? [Number(process.argv[orgFlag + 1])] : [1, 30001];

/**
 * `--trim` deletes whole reconciliation runs, so it must name ONE tenant.
 *
 * This is not hypothetical caution. The first run of this script used
 * `--commit --trim` with no `--org`, which applied the trim to BOTH default
 * targets — and removed nine of Globus Bank's ten runs along with their 542
 * exceptions, when only BrightGoods was meant to be trimmed. Re-dating every
 * demo tenant at once is harmless and stays the default; deleting from every
 * demo tenant at once is not, and a destructive flag should never inherit a
 * convenience default.
 */
if (TRIM && orgFlag === -1) {
  console.error(
    "\nREFUSING: --trim deletes whole reconciliation runs, so it must name one tenant.\n" +
      "\n  pnpm demo:recency --commit --trim --org 30001\n" +
      "\nRe-dating (without --trim) still defaults to every demo tenant.\n",
  );
  process.exit(1);
}

let failures = 0;

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log(`\nReconcileAI — demo recency refresh  ${COMMIT ? "(COMMIT)" : "(report only)"}\n`);

  for (const orgId of TARGETS) {
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code, isDemo: organizations.isDemo })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new Error(`Organisation ${orgId} does not exist`);
    if (!org.isDemo) {
      throw new Error(
        `REFUSING: ${org.code ?? orgId} "${org.name}" is not a demo tenant (isDemo = 0). ` +
          `This script re-dates and deletes rows and must never touch a real tenant.`,
      );
    }

    console.log(`${"═".repeat(72)}\n${org.code ?? orgId} — ${org.name}\n${"═".repeat(72)}`);
    await report(db, orgId, "before");

    if (TRIM) await trimToNewestRun(db, orgId);
    await respreadExceptions(db, orgId);

    if (COMMIT) await report(db, orgId, "after");
    console.log();
  }

  // A report-only run must not claim success. It never re-measures, so it has
  // no evidence either way — saying "all bands populated" there would be a
  // green tick standing for nothing, which is the failure this whole exercise
  // started from.
  if (!COMMIT) {
    console.log(
      `\nReport only — nothing was written, and nothing was re-measured.` +
        `\nAny band marked EMPTY above is still empty. Re-run with --commit to fix it.\n`,
    );
    process.exit(0);
  }
  console.log(failures ? `\nFAIL — ${failures} band(s) still empty after the rewrite.\n` : `\nAll bands populated.\n`);
  process.exit(failures ? 1 : 0);
}

/** Count exceptions per selectable band, and flag any that are empty. */
async function report(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, orgId: number, when: string) {
  console.log(`  exceptions per band (${when}):`);
  const bands = [
    { label: "Today", from: 0, to: 0 },
    { label: "Yesterday", from: 1, to: 1 },
    ...RECENCY_BANDS.map((b) => ({ label: b.label, from: b.from, to: b.to })),
  ];
  for (const b of bands) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(exceptions)
      .where(and(
        eq(exceptions.organizationId, orgId),
        sql`${exceptions.createdAt} >= DATE_SUB(CURDATE(), INTERVAL ${b.to} DAY)`,
        sql`${exceptions.createdAt} < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL ${b.from} DAY), INTERVAL 1 DAY)`,
      ));
    const empty = Number(row?.n ?? 0) === 0;
    if (empty && when === "after") failures++;
    console.log(`    ${b.label.padEnd(38)} ${String(row?.n ?? 0).padStart(6)}${empty ? "   <- EMPTY" : ""}`);
  }
}

/**
 * Keep the newest reconciliation run and delete the rest, with everything that
 * hangs off them. The FMCG seeder appends on re-run, so a tenant seeded several
 * times carries several identical runs.
 */
async function trimToNewestRun(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, orgId: number) {
  const jobs = await db
    .select({ id: reconciliationJobs.id, name: reconciliationJobs.name })
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.organizationId, orgId))
    .orderBy(desc(reconciliationJobs.id));
  if (jobs.length <= 1) {
    console.log(`  trim: ${jobs.length} run(s) — nothing to remove`);
    return;
  }
  const keep = jobs[0];
  const drop = jobs.slice(1).map((j) => j.id);
  console.log(`  trim: keeping #${keep.id}, removing ${drop.length} older run(s): ${drop.join(", ")}`);

  // Batches are matched by the demo seeders' own filename prefixes, so an upload
  // a person made is never caught, and scoped by tenant like everything else.
  //
  // The first version hardcoded 'BrightGoods\_%'. On any other tenant that
  // matched nothing, so the script reported "trimmed to one run" while leaving
  // every transaction in place — a claim that was simply false. Each prefix
  // belongs to one seeder; add one when a seeder is added.
  const batches = await db
    .select({ id: uploadBatches.id })
    .from(uploadBatches)
    .where(and(
      eq(uploadBatches.organizationId, orgId),
      sql`(${uploadBatches.fileName} LIKE 'BrightGoods\\_%'
        OR ${uploadBatches.fileName} LIKE 'FinServ\\_Demo\\_%')`,
    ))
    .orderBy(desc(uploadBatches.id));
  // Each run writes two batches; keep the newest pair, drop the rest.
  const dropBatches = batches.slice(2).map((b) => b.id);
  console.log(`  trim: removing ${dropBatches.length} older upload batch(es) and their transactions`);

  if (!COMMIT) return;
  await db.delete(reconciliationReports).where(and(
    eq(reconciliationReports.organizationId, orgId),
    inArray(reconciliationReports.jobId, drop),
  ));
  await db.delete(exceptions).where(and(
    eq(exceptions.organizationId, orgId),
    inArray(exceptions.jobId, drop),
  ));
  await db.delete(matches).where(inArray(matches.jobId, drop));
  await db.delete(reconciliationJobs).where(and(
    eq(reconciliationJobs.organizationId, orgId),
    inArray(reconciliationJobs.id, drop),
  ));
  if (dropBatches.length) {
    await db.delete(transactions).where(and(
      eq(transactions.organizationId, orgId),
      inArray(transactions.batchId, dropBatches),
    ));
    await db.delete(uploadBatches).where(and(
      eq(uploadBatches.organizationId, orgId),
      inArray(uploadBatches.id, dropBatches),
    ));
  }
}

/** Re-date this tenant's exceptions across the selectable window. */
async function respreadExceptions(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, orgId: number) {
  // Diagnosed rows first, so the curated cases land in the recent band.
  const rows = await db
    .select({ id: exceptions.id, status: exceptions.status, ai: exceptions.aiAnalysis })
    .from(exceptions)
    .where(eq(exceptions.organizationId, orgId))
    .orderBy(sql`(${exceptions.aiAnalysis} IS NULL)`, desc(exceptions.id));

  console.log(`  re-dating ${rows.length} exception(s)${COMMIT ? "" : " (not written)"}`);
  if (!COMMIT || rows.length === 0) return;

  const now = new Date();
  for (let i = 0; i < rows.length; i++) {
    const when = dateForIndex(i, rows.length, now);
    const status = statusForAge(daysAgoForIndex(i, rows.length), rows[i].status as string);
    await db
      .update(exceptions)
      .set({ createdAt: when, status: status as typeof exceptions.$inferInsert.status })
      .where(and(eq(exceptions.organizationId, orgId), eq(exceptions.id, rows[i].id)));
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
