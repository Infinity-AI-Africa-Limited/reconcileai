/**
 * refresh-demo-recency.ts — make a demo tenant's exceptions span the window a
 * viewer can actually select, and optionally collapse it to a single run.
 *
 *   pnpm demo:recency                                # report only, writes nothing
 *   pnpm demo:recency --commit                       # re-date every demo tenant
 *   pnpm demo:recency --org 1 --commit               # re-date one tenant
 *   pnpm demo:recency --org 30001 --commit --trim    # ...and keep only its newest run
 *
 * --trim without --org is refused: it deletes runs, and must name its tenant.
 *
 * KEEPING IT CURRENT — the server does that now
 *
 * An hourly pass in the server (server/demoTimelineRoll.ts) rolls
 * GLOBUS_DEMO and BRIGHTGOODS_DEMO forward so their newest transaction is
 * always within the hour; step 1 below IS that roll. Run this script when a
 * tenant has been RE-SEEDED, to re-shape its exceptions across the quarter —
 * the hourly roll preserves whatever shape it finds, it does not create one.
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
 *     remove, requires --commit like everything else, and refuses to run
 *     without --org. It removes jobs and what is keyed to them (matches,
 *     exceptions, reports) inside one transaction, and leaves upload batches
 *     and transactions alone — see trimToNewestRun for why.
 */
import "dotenv/config";
import { and, count, desc, eq, gte, inArray, lt, max, min } from "drizzle-orm";
import {
  channels,
  distributors,
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  transactions,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  planExceptionTimeline,
  COUNTRY_TIMEZONES,
  RECENCY_BANDS,
  zonedDayStart,
} from "../server/demoRecency";
import { createReportForJob, isSeededReportSummary } from "../server/demoReportSeed";
import { futureDated, rollDemoTimeline } from "../server/demoTimelineRoll";

const COMMIT = process.argv.includes("--commit");
const TRIM = process.argv.includes("--trim");
const orgFlag = process.argv.indexOf("--org");
const TARGETS = orgFlag !== -1 ? [Number(process.argv[orgFlag + 1])] : [1, 30001];
const tzFlag = process.argv.indexOf("--tz");
/** Explicit zone for "today"; otherwise each tenant's own, from its country. */
const TZ_OVERRIDE = tzFlag !== -1 ? process.argv[tzFlag + 1] : null;

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
      .select({ id: organizations.id, name: organizations.name, code: organizations.code, isDemo: organizations.isDemo, country: organizations.country, channel: organizations.onboardingChannel })
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
    // A SHOPLINE-connected tenant's transactions mirror real orders in a real
    // store. Moving them would make ReconcileAI disagree with SHOPLINE about the
    // same order — on SL_RECONCILEAI_DEV, the tenant the App Store reviewer is
    // pinned to — and the sync may move them straight back. Its hidden-exception
    // problem is solved on screen instead (HiddenExceptionsNotice).
    if (org.channel?.startsWith("shopline")) {
      throw new Error(
        `REFUSING: ${org.code ?? orgId} is connected to SHOPLINE (${org.channel}); its rows mirror a real store ` +
          `and must keep that store's dates.`,
      );
    }

    // The tenant's own local day. No guessed zone for an unmapped country: a
    // wrong anchor produces exactly the empty Today this exists to prevent.
    const timeZone = TZ_OVERRIDE ?? COUNTRY_TIMEZONES[org.country];
    if (!timeZone) {
      throw new Error(
        `REFUSING: no timezone is mapped for country "${org.country}", so "today" is undefined. ` +
          `Re-run with --tz <IANA zone>, e.g. --tz Africa/Lagos.`,
      );
    }
    console.log(`  "Today" means ${timeZone}${TZ_OVERRIDE ? " (from --tz)" : ` (from country ${org.country})`}`);
    await report(db, orgId, timeZone, "before");

    if (TRIM) await trimToNewestRun(db, orgId);
    await refreshTimeline(db, orgId, timeZone);

    if (COMMIT) await report(db, orgId, timeZone, "after");
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
async function report(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  orgId: number,
  timeZone: string,
  when: string,
) {
  console.log(`  exceptions per band (${when}):`);
  const bands = [
    { label: "Today", from: 0, to: 0 },
    { label: "Yesterday", from: 1, to: 1 },
    ...RECENCY_BANDS.map((b) => ({ label: b.label, from: b.from, to: b.to })),
  ];
  // Band boundaries are computed HERE, in the tenant's zone, from the same
  // `zonedDayStart` the re-dating writes with. They used to be CURDATE() and
  // DATE_SUB in the query, which handed "yesterday" to the database server's
  // session timezone; then UTC, which let the report declare Today populated
  // for a day the tenant's viewers had already left. Measuring in the zone the
  // rows were written for is what makes a PASS here mean something on screen.
  const now = new Date();
  for (const b of bands) {
    const [row] = await db
      .select({ n: count() })
      .from(exceptions)
      .where(and(
        eq(exceptions.organizationId, orgId),
        gte(exceptions.createdAt, zonedDayStart(now, b.to, timeZone)),
        lt(exceptions.createdAt, zonedDayStart(now, b.from - 1, timeZone)),
      ));
    const empty = Number(row?.n ?? 0) === 0;
    if (empty && when === "after") failures++;
    console.log(`    ${b.label.padEnd(38)} ${String(row?.n ?? 0).padStart(6)}${empty ? "   <- EMPTY" : ""}`);
  }

  // Rows dated after this moment still sit inside Today's upper bound, so the
  // band count above would call them healthy. They are not: a 07:40 run wrote
  // every "today" row at 08:00-17:59, and 40 exceptions across the two demo
  // tenants were "created" up to ten hours in the future. Checked separately so
  // that defect fails the run instead of padding the Today count.
  //
  // Across EVERY rolled column, not only exceptions. Checking exceptions alone
  // is how 1,950 BrightGoods ingestion times, 950 match times and a job window
  // sat up to 12 hours in the future through several "all bands populated" runs.
  const ahead = await futureDated(db, orgId, now);
  const future = ahead.reduce((n, f) => n + f.rows, 0);
  if (future > 0 && when === "after") failures++;
  console.log(`    ${"dated in the FUTURE (any column)".padEnd(38)} ${String(future).padStart(6)}${future ? "   <- WRONG" : ""}`);
  for (const f of ahead) console.log(`      ${`${f.table}.${f.column}`.padEnd(36)} ${String(f.rows).padStart(6)}`);

  // The Age Tracker shows an exception's date beside its transaction's. One
  // raised before the transaction it concerns is visibly wrong there — 253 on
  // Globus Bank and 35 on BrightGoods were, before exceptions were anchored.
  // Joined within this tenant only — same rule as the job-window query below.
  const [early] = await db
    .select({ n: count() })
    .from(exceptions)
    .innerJoin(
      transactions,
      and(eq(transactions.id, exceptions.transactionId), eq(transactions.organizationId, orgId)),
    )
    .where(and(eq(exceptions.organizationId, orgId), lt(exceptions.createdAt, transactions.transactionDate)));
  const before = Number(early?.n ?? 0);
  if (before > 0 && when === "after") failures++;
  console.log(`    ${"raised BEFORE their transaction".padEnd(38)} ${String(before).padStart(6)}${before ? "   <- WRONG" : ""}`);

  // Transactions age exactly as exceptions do; the Transactions page shows the
  // newest first, so "today" is what a viewer meets first.
  console.log(`  transactions per band (${when}):`);
  for (const b of bands) {
    const [row] = await db
      .select({ n: count() })
      .from(transactions)
      .where(and(
        eq(transactions.organizationId, orgId),
        gte(transactions.transactionDate, zonedDayStart(now, b.to, timeZone)),
        lt(transactions.transactionDate, zonedDayStart(now, b.from - 1, timeZone)),
      ));
    const n = Number(row?.n ?? 0);
    if (n === 0 && when === "after" && b.label === "Today") failures++;
    console.log(`    ${b.label.padEnd(38)} ${String(n).padStart(6)}${n === 0 ? "   <- EMPTY" : ""}`);
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

  // ── What this deliberately does NOT delete ──────────────────────────────
  //
  // Upload batches and their transactions stay. An earlier version took the
  // newest two batches and deleted the rest, on the assumption that a run owns
  // exactly two — true for the FMCG seeder, false for the financial-services
  // one, which writes EIGHT batches for a single job. Against Globus that would
  // have deleted six batches belonging to the run it was keeping, leaving the
  // retained job's stored counts, matches and exceptions describing
  // transactions that no longer existed.
  //
  // There is no reliable link from a batch to a run — transactions carry a
  // batchId, not a jobId — so attributing them is guesswork, and guesswork is
  // not something a delete should do. Jobs, matches, exceptions and reports ARE
  // keyed by jobId, so those are exactly what this removes. For a genuine
  // from-scratch reset use the seeder's own wipe, which knows its own batches.
  console.log(`  trim: upload batches and transactions are left alone (see comment)`);

  if (!COMMIT) return;

  // One transaction: an interruption partway through used to leave exceptions
  // whose job was already gone, and a retry could not find them because the
  // parent it would have looked them up by no longer existed.
  await db.transaction(async (tx) => {
    await tx.delete(reconciliationReports).where(and(
      eq(reconciliationReports.organizationId, orgId),
      inArray(reconciliationReports.jobId, drop),
    ));
    await tx.delete(exceptions).where(and(
      eq(exceptions.organizationId, orgId),
      inArray(exceptions.jobId, drop),
    ));
    await tx.delete(matches).where(inArray(matches.jobId, drop));
    await tx.delete(reconciliationJobs).where(and(
      eq(reconciliationJobs.organizationId, orgId),
      inArray(reconciliationJobs.id, drop),
    ));
  });
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Bring a tenant's whole timeline up to today, coherently.
 *
 * ── Why a timeline, not a re-date ─────────────────────────────────────────
 *
 * The first version re-dated exceptions on their own. That left the Age Tracker
 * — which shows an exception's date beside its transaction's — with 253 Globus
 * and 35 BrightGoods exceptions raised BEFORE the transaction they concern, up
 * to 85 days early. And it never touched transactions, so the Transactions page
 * went stale a day at a time exactly as exceptions had: on 21 September Globus
 * had 74 transactions "today" and BrightGoods none.
 *
 * So time now flows from transactions, and everything tied to them moves with
 * them:
 *
 *   1. ROLL   the whole timeline forward by one delta, so the newest transaction
 *             sits at now — every table in ROLL_PLAN (server/demoTimelineRoll.ts).
 *             One transaction under a tenant lock, all or nothing: a half-rolled
 *             timeline would leave matched pairs and job windows disagreeing.
 *   2. SPREAD the transactions that carry exceptions across the quarter, so the
 *             7-day, 30-day and quarter views all hold cases. Only those: none is
 *             in a match row (checked, and re-checked at run time), so moving
 *             them cannot split a matched pair.
 *   3. ANCHOR each exception to its own transaction — detected minutes to hours
 *             after it, never before it, never after now.
 *   4. WIDEN  each job's date window to contain the transactions its exceptions
 *             point at, so opening a job never shows a case outside its range.
 *   5. DERIVE distributors' last payment from their actual bank credits.
 *   6. REFRESH the seeded report, whose summary carries the job's date range.
 */
async function refreshTimeline(db: Db, orgId: number, timeZone: string) {
  const now = new Date();
  const jobIds = (
    await db
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.organizationId, orgId))
  ).map((j) => j.id);

  // ── 1. Roll ──────────────────────────────────────────────────────────────
  // The same roll the hourly scheduler runs (server/demoTimelineRoll.ts): one
  // transaction per tenant, under a lock on the tenant's organisations row, so
  // this script and a scheduled pass can never both apply the same relative
  // shift. `allowList: null` because this script names its tenant explicitly
  // and has already applied its own checks above.
  const rolled = await rollDemoTimeline(db, orgId, { commit: COMMIT, now, allowList: null });
  if (rolled.status === "refused") throw new Error(`REFUSING: ${rolled.reason}`);
  const secs = rolled.seconds;
  console.log(
    `  roll: move the timeline forward ${(secs / 3600).toFixed(2)}h` +
      (rolled.status === "rolled" ? ` (done in ${rolled.ms}ms)` : ` — not written: ${rolled.reason}`),
  );

  // ── 2 + 3. Spread exception transactions, anchor exceptions ──────────────
  const rows = await db
    .select({ id: exceptions.id, status: exceptions.status, ai: exceptions.aiAnalysis, txId: exceptions.transactionId })
    .from(exceptions)
    .where(eq(exceptions.organizationId, orgId))
    .orderBy(desc(exceptions.id));
  // Diagnosed first, so the curated cases land in the recent band; then newest.
  rows.sort((a, b) => Number(a.ai == null) - Number(b.ai == null) || b.id - a.id);

  // Re-checked at run time rather than trusted from the 21 September measurement
  // (0 of 608): moving one leg of a matched pair would put its two sides apart.
  const matched = new Set<number>();
  if (jobIds.length) {
    const pairs = await db
      .select({ s: matches.sourceTransactionId, t: matches.targetTransactionId })
      .from(matches)
      .where(inArray(matches.jobId, jobIds));
    for (const m of pairs) {
      if (m.s) matched.add(m.s);
      if (m.t) matched.add(m.t);
    }
  }
  const pinned = rows.filter((r) => r.txId != null && matched.has(r.txId)).length;
  console.log(
    `  spread ${rows.length - pinned} exception transaction(s) across the quarter, anchor ${rows.length} exception(s);` +
      ` ${pinned} left in place (matched)${COMMIT ? "" : " — not written"}`,
  );

  if (COMMIT) {
    // Planned per TRANSACTION, not per exception row — see planExceptionTimeline.
    //
    // Which transactions may MOVE is decided from the transaction rows
    // themselves, loaded by id. An earlier version preloaded only matched
    // transactions and only within this tenant, so one owned by another
    // organisation, or by none — both of which the schema allows — was missed,
    // treated as movable, re-dated in the plan, and then left unchanged by the
    // tenant-scoped update: its exception anchored to a date the transaction
    // does not have. The ids come from THIS tenant's exceptions, so reading
    // their dates widens nothing; writing is still tenant-scoped, and only a
    // transaction this tenant owns and no match references is ever moved.
    const referenced = [...new Set(rows.map((r) => r.txId).filter((t): t is number => t != null))];
    const txRows = referenced.length
      ? await db
          .select({ id: transactions.id, org: transactions.organizationId, d: transactions.transactionDate })
          .from(transactions)
          .where(inArray(transactions.id, referenced))
      : [];
    const found = new Map(txRows.map((t) => [t.id, t]));
    const pinned = new Map<number, Date>();
    for (const t of txRows) {
      if (t.org !== orgId || matched.has(t.id)) pinned.set(t.id, new Date(t.d));
    }
    const missing = referenced.filter((id) => !found.has(id)).length;
    if (pinned.size || missing) {
      console.log(`  kept in place: ${pinned.size} transaction(s) not owned here or matched; ${missing} referenced but missing (their exceptions are left as they are)`);
    }
    const plan = planExceptionTimeline(
      // An exception whose transaction does not exist has nothing to anchor to.
      rows.map((r) => ({ id: r.id, txId: r.txId != null && found.has(r.txId) ? r.txId : null, status: r.status as string })),
      now,
      timeZone,
      pinned,
    );
    // Autocommitted per row, deliberately: the plan derives from a stable
    // ordering and from `now`, never from a row's current date, so an
    // interrupted run is repaired by re-running it — it converges.
    for (const [txId, txDate] of plan.transactionDates) {
      await db
        .update(transactions)
        .set({ transactionDate: txDate, valueDate: txDate, createdAt: txDate })
        .where(and(eq(transactions.organizationId, orgId), eq(transactions.id, txId)));
    }
    for (const e of plan.exceptions) {
      await db
        .update(exceptions)
        .set({
          createdAt: e.createdAt,
          status: e.status as typeof exceptions.$inferInsert.status,
          resolvedAt: e.resolvedAt,
        })
        .where(and(eq(exceptions.organizationId, orgId), eq(exceptions.id, e.id)));
    }
  }

  // ── 4. Widen job windows ─────────────────────────────────────────────────
  if (COMMIT) {
    for (const jobId of jobIds) {
      const [span] = await db
        .select({ lo: min(transactions.transactionDate), hi: max(transactions.transactionDate) })
        .from(exceptions)
        // Ownership on the transaction side too. An exception may reference a
        // transaction another organisation owns; joining on id alone would copy
        // that organisation's dates into this tenant's job window and into the
        // report regenerated from it. The pinning read above may look at such a
        // row, because it only decides what NOT to move; persisting its dates
        // into this tenant is a different thing, and is not done.
        .innerJoin(
          transactions,
          and(eq(transactions.id, exceptions.transactionId), eq(transactions.organizationId, orgId)),
        )
        .where(and(eq(exceptions.organizationId, orgId), eq(exceptions.jobId, jobId)));
      if (!span?.lo || !span?.hi) continue;
      const [job] = await db
        .select({ from: reconciliationJobs.dateFrom, to: reconciliationJobs.dateTo })
        .from(reconciliationJobs)
        .where(and(eq(reconciliationJobs.organizationId, orgId), eq(reconciliationJobs.id, jobId)))
        .limit(1);
      if (!job) continue;
      const lo = new Date(span.lo);
      const hi = new Date(span.hi);
      const from = job.from && new Date(job.from) <= lo ? new Date(job.from) : zonedDayStart(lo, 0, timeZone);
      const to = job.to && new Date(job.to) >= hi ? new Date(job.to) : hi;
      await db
        .update(reconciliationJobs)
        .set({ dateFrom: from, dateTo: to })
        .where(and(eq(reconciliationJobs.organizationId, orgId), eq(reconciliationJobs.id, jobId)));
    }
  }

  // ── 5. Distributors' last payment ────────────────────────────────────────
  const dists = await db
    .select({ id: distributors.id, name: distributors.canonicalName, variants: distributors.nameVariants })
    .from(distributors)
    .where(eq(distributors.organizationId, orgId));
  if (dists.length) {
    // "Payment" is money arriving: the bank-statement side, channelType
    // bank_core — not the ERP side, which carries the invoices being paid.
    const bank = (
      await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.organizationId, orgId), eq(channels.channelType, "bank_core")))
    ).map((c) => c.id);
    let derived = 0;
    for (const d of dists) {
      const variants = Array.isArray(d.variants) ? (d.variants as string[]) : [];
      const names = [d.name, ...variants].filter(Boolean);
      if (!bank.length || !names.length) continue;
      const [last] = await db
        .select({ at: max(transactions.transactionDate) })
        .from(transactions)
        .where(and(
          eq(transactions.organizationId, orgId),
          inArray(transactions.channelId, bank),
          inArray(transactions.counterparty, names),
        ));
      if (!last?.at) continue;
      derived++;
      if (COMMIT) {
        await db
          .update(distributors)
          .set({ lastPaymentAt: new Date(last.at) })
          .where(and(eq(distributors.organizationId, orgId), eq(distributors.id, d.id)));
      }
    }
    console.log(
      `  distributors: last payment derived for ${derived} of ${dists.length} from their bank credits` +
        `${COMMIT ? "" : " — not written"}`,
    );
  }

  // ── 6. Refresh the seeded report ─────────────────────────────────────────
  // Filtered in TypeScript rather than with JSON_EXTRACT: a tenant has a handful
  // of reports, drizzle already returns `summary` parsed, and the typed read
  // keeps this inside the repository's data-access convention.
  const seeded = (
    await db
      .select({
        jobId: reconciliationReports.jobId,
        userId: reconciliationReports.userId,
        title: reconciliationReports.title,
        summary: reconciliationReports.summary,
      })
      .from(reconciliationReports)
      .where(eq(reconciliationReports.organizationId, orgId))
  ).filter((r) => isSeededReportSummary(r.summary));
  if (seeded.length === 1) {
    if (COMMIT) {
      await createReportForJob(db, {
        jobId: seeded[0].jobId,
        organizationId: orgId,
        userId: seeded[0].userId,
        title: seeded[0].title,
      });
    }
    console.log(`  report: seeded report regenerated so its date range matches the job${COMMIT ? "" : " — not written"}`);
  } else if (seeded.length > 1) {
    console.log(`  report: ${seeded.length} seeded reports — not regenerating; which one is current is ambiguous`);
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
