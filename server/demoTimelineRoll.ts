/**
 * Keep the demo tenants' timelines current — on a timer, without anyone
 * running a script.
 *
 * Demo data ages a day every day. Every list screen opens on Today, so the
 * morning after a manual refresh (`pnpm demo:recency`) the demo tenants open
 * empty again. This moves each allow-listed demo tenant's WHOLE timeline
 * forward so its newest transaction sits at now, every hour, preserving every
 * interval between rows: a transaction and its exception stay 40 minutes
 * apart, an exception 12 days old stays 12 days old relative to now, a job's
 * window still contains its transactions.
 *
 * ── Why relative, and why that needs a lock ──────────────────────────────
 *
 * The shift is (now − newest transaction). It is RELATIVE, so two runs that
 * both read the same "newest" would both add the full delta and push the
 * whole tenant an hour into the future. Railway can run more than one
 * instance, and each keeps its own timer. So each roll takes the tenant's
 * `organizations` row FOR UPDATE, then reads "newest" INSIDE that lock: the
 * second runner waits, then reads the already-moved newest and finds nothing
 * to do. Eligibility is re-checked inside the lock too, so a tenant that stops
 * qualifying between the listing and the write is not touched.
 *
 * ── Which tenants: an allow-list, never a predicate ─────────────────────
 *
 * This re-dates financial records automatically, with nobody watching. Run
 * against a real tenant it would silently falsify their books. So it does not
 * select "every isDemo tenant" — `isDemo` is one mutable column, and "demo"
 * is a category, not an identity. It names the tenants it may touch by CODE
 * (DEMO_TIMELINE_TENANTS) and additionally requires, inside the lock:
 *
 *   - `isDemo` is set;
 *   - the tenant is not connected to SHOPLINE, by onboarding channel OR by a
 *     live store row: those rows mirror a real store and must keep its dates.
 *
 * Every condition must hold; any one failing refuses the tenant.
 *
 * ── What moves, and what never does ──────────────────────────────────────
 *
 * Every timestamp in ROLL_PLAN, in one transaction per tenant: all or
 * nothing, since a half-rolled timeline splits matched pairs from their jobs.
 * `server/demoTimelineRoll.test.ts` fails if a rolled table gains a timestamp
 * column that is neither rolled nor exempted with a reason.
 *
 * Audit logs are NOT rolled and must never be: they are a tamper-evident hash
 * chain, and rewriting their timestamps is exactly the tampering it detects.
 */
import { and, count, eq, inArray, max, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import type { MySqlTable, MySqlUpdateSetSource } from "drizzle-orm/mysql-core";
import {
  agentActionDrafts,
  agentMemory,
  distributors,
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  transactions,
  uploadBatches,
} from "../drizzle/schema";
import { slConnectorStores } from "../drizzle/connector_schema";
import { getDb } from "./db";
import { rollDeltaMs } from "./demoRecency";
import { DEMO_REPORT_MARKER, isSeededReportSummary } from "./demoReportSeed";
import { buildReportSummary } from "./reportSummary";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The ONLY tenants the scheduled roll may touch, by organisation code — the
 * two demo tenants every screen was checked against (the manual refresh's own
 * defaults). Adding one is a code change and a review, on purpose.
 */
export const DEMO_TIMELINE_TENANTS = ["GLOBUS_DEMO", "BRIGHTGOODS_DEMO"] as const;

/**
 * A roll smaller than this is skipped. It is below anything a viewer could
 * notice, and it is what a second instance finds after the first has rolled.
 */
export const MIN_ROLL_SECONDS = 60;

/**
 * Every table the roll moves, which of its timestamp columns move, and why the
 * rest do not. `scope` says how rows are selected: by organizationId, or — for
 * matches, which carry no usable organisation (CLAUDE.md §19.3) — through the
 * tenant's own jobs.
 */
export const ROLL_PLAN = [
  {
    table: transactions,
    name: "transactions",
    scope: "org",
    roll: ["transactionDate", "valueDate", "createdAt"],
    exempt: {},
    mayBeFuture: { valueDate: "a value date may legitimately follow the transaction (forward-dated settlement)" },
  },
  { table: uploadBatches, name: "uploadBatches", scope: "org", roll: ["createdAt", "completedAt"], exempt: {}, mayBeFuture: {} },
  {
    table: reconciliationJobs,
    name: "reconciliationJobs",
    scope: "org",
    roll: ["dateFrom", "dateTo", "startedAt", "completedAt", "abandonedAt", "heartbeatAt", "createdAt"],
    exempt: {},
    mayBeFuture: {},
  },
  { table: matches, name: "matches", scope: "jobs", roll: ["createdAt", "reviewedAt"], exempt: {}, mayBeFuture: {} },
  { table: reconciliationReports, name: "reconciliationReports", scope: "org", roll: ["createdAt"], exempt: {}, mayBeFuture: {} },
  { table: agentMemory, name: "agentMemory", scope: "org", roll: ["createdAt"], exempt: {}, mayBeFuture: {} },
  {
    table: agentActionDrafts,
    name: "agentActionDrafts",
    scope: "org",
    roll: ["approvedAt", "rejectedAt", "executedAt", "createdAt"],
    exempt: { updatedAt: "ON UPDATE CURRENT_TIMESTAMP — the database sets it to the time of the roll itself" },
    mayBeFuture: {},
  },
  { table: exceptions, name: "exceptions", scope: "org", roll: ["assignedAt", "resolvedAt", "createdAt"], exempt: {}, mayBeFuture: {} },
  {
    table: distributors,
    name: "distributors",
    scope: "org",
    roll: ["lastPaymentAt", "confirmedAt", "createdAt"],
    exempt: { updatedAt: "ON UPDATE CURRENT_TIMESTAMP — the database sets it to the time of the roll itself" },
    mayBeFuture: {},
  },
] as const satisfies readonly {
  table: MySqlTable;
  name: string;
  scope: "org" | "jobs";
  roll: readonly string[];
  exempt: Record<string, string>;
  /**
   * Rolled columns allowed to land after now. Every other rolled column is
   * CLAMPED to now — see `rollDemoTimeline` for why.
   */
  mayBeFuture: Record<string, string>;
}[];

export type RollEligibility = { ok: true } | { ok: false; reason: string };

/**
 * May the roll touch this tenant? Pure, so every refusal is tested. All
 * conditions must hold (see the module header).
 */
export function rollEligibility(
  org: { code: string | null; isDemo: boolean | number | null; onboardingChannel: string | null },
  connectedShoplineStores: number,
  allowList: readonly string[] | null = DEMO_TIMELINE_TENANTS,
): RollEligibility {
  if (allowList !== null && (org.code === null || !allowList.includes(org.code))) {
    return { ok: false, reason: `${org.code ?? "(no code)"} is not on the demo-timeline allow-list` };
  }
  if (!org.isDemo) return { ok: false, reason: `${org.code ?? "(no code)"} is not a demo tenant (isDemo = 0)` };
  if (org.onboardingChannel?.startsWith("shopline")) {
    return { ok: false, reason: `${org.code} is onboarded through SHOPLINE; its rows mirror a real store` };
  }
  if (connectedShoplineStores > 0) {
    return { ok: false, reason: `${org.code} has ${connectedShoplineStores} SHOPLINE store(s); its rows mirror a real store` };
  }
  return { ok: true };
}

/**
 * Minutes between scheduled rolls, from DEMO_TIMELINE_ROLL_MINUTES.
 *
 * Unset → hourly: a viewer opening Today mid-morning sees the morning so far,
 * and the newest row is never more than an hour old. "0" or "off" disables it.
 * Anything under 5 is raised to 5 — each roll rewrites every demo transaction
 * (~81k rows), and more often than that buys nothing a viewer can see.
 */
export function rollIntervalMinutes(raw: string | undefined): number {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return 60;
  if (v === "0" || v === "off" || v === "false") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.max(5, Math.round(n));
}

export type RollResult =
  | { status: "rolled"; seconds: number; ms: number }
  | { status: "skipped"; seconds: number; reason: string }
  | { status: "refused"; reason: string };

/**
 * Roll one tenant's timeline forward so its newest transaction sits at `now`.
 *
 * With `commit: false` it only measures, and takes no lock.
 * `allowList: null` is for the operator-run CLI, which names its tenant
 * explicitly and applies its own checks; the scheduler always passes the list.
 */
export async function rollDemoTimeline(
  db: Db,
  orgId: number,
  opts: { commit: boolean; now?: Date; allowList?: readonly string[] | null },
): Promise<RollResult> {
  const allowList = opts.allowList === undefined ? DEMO_TIMELINE_TENANTS : opts.allowList;

  if (!opts.commit) {
    const verdict = await eligibility(db, orgId, allowList, false);
    if (!verdict.ok) return { status: "refused", reason: verdict.reason };
    const seconds = await deltaSeconds(db, orgId, opts.now ?? new Date());
    return { status: "skipped", seconds, reason: "measured only (commit: false)" };
  }

  const started = Date.now();
  return db.transaction(async (tx) => {
    // Lock FIRST, then decide. See the module header: the delta is relative.
    const verdict = await eligibility(tx, orgId, allowList, true);
    if (!verdict.ok) return { status: "refused", reason: verdict.reason } as const;

    // `now` is taken after the lock is held, so a runner that waited on
    // another measures from the moment it actually gets to act.
    const now = opts.now ?? new Date();
    const seconds = await deltaSeconds(tx, orgId, now);
    if (seconds < MIN_ROLL_SECONDS) {
      return { status: "skipped", seconds, reason: `newest transaction is only ${seconds}s old` } as const;
    }

    const jobIds = (
      await tx.select({ id: reconciliationJobs.id }).from(reconciliationJobs).where(eq(reconciliationJobs.organizationId, orgId))
    ).map((j) => j.id);

    // Column arithmetic has no typed drizzle form, so the SET values use its
    // parameterised `sql` tag; the interval and bound are parameters, never text.
    //
    // The shift is anchored on the newest TRANSACTION, but records made after
    // it — a job run, an upload batch, the moment rows were ingested — can be
    // later still, so a pure shift carries them past now. Measured on the first
    // live run: 1,950 BrightGoods ingestion times, 950 match times and the
    // job's own window up to 12 hours in the future (the seeder's run time,
    // preserved by every roll since). A historical record dated after now is
    // never right, so each rolled value is CLAMPED to now, except the columns a
    // step names in `mayBeFuture`. The bound is a UTC string, not a Date: a
    // Date parameter is rendered in the process's zone by the driver, which on
    // any machine off UTC would put the bound hours out.
    const bound = utcSql(now);
    const shift = (col: AnyColumn): SQL => sql`LEAST(DATE_ADD(${col}, INTERVAL ${seconds} SECOND), ${bound})`;
    const shiftUnclamped = (col: AnyColumn): SQL => sql`DATE_ADD(${col}, INTERVAL ${seconds} SECOND)`;
    for (const step of ROLL_PLAN) {
      const cols = getTableColumns(step.table) as Record<string, AnyColumn>;
      const scopeCol = step.scope === "jobs" ? cols.jobId : cols.organizationId;
      // Refuse rather than run unscoped: an UPDATE with no tenant predicate
      // would re-date every tenant's rows.
      if (!scopeCol) throw new Error(`demo timeline roll: ${step.name} has no ${step.scope === "jobs" ? "jobId" : "organizationId"}`);
      if (step.scope === "jobs" && jobIds.length === 0) continue;
      const where = step.scope === "jobs" ? inArray(scopeCol, jobIds) : eq(scopeCol, orgId);
      const future: Record<string, string> = step.mayBeFuture;
      await rollColumns(tx, step.table, step.roll, where, (col, key) => (key in future ? shiftUnclamped(col) : shift(col)));
    }

    await refreshSeededReportSummary(tx, orgId);
    return { status: "rolled", seconds, ms: Date.now() - started } as const;
  });
}

async function eligibility(
  db: Db | Tx,
  orgId: number,
  allowList: readonly string[] | null,
  lock: boolean,
): Promise<RollEligibility> {
  const query = db
    .select({ code: organizations.code, isDemo: organizations.isDemo, onboardingChannel: organizations.onboardingChannel })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const [org] = lock ? await query.for("update") : await query;
  if (!org) return { ok: false, reason: `organisation ${orgId} does not exist` };
  const [stores] = await db
    .select({ n: count() })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.organizationId, orgId));
  return rollEligibility(org, Number(stores?.n ?? 0), allowList);
}

async function deltaSeconds(db: Db | Tx, orgId: number, now: Date): Promise<number> {
  const [row] = await db
    .select({ newest: max(transactions.transactionDate) })
    .from(transactions)
    .where(eq(transactions.organizationId, orgId));
  const newest = row?.newest ? new Date(row.newest) : null;
  return rollDeltaMs(newest, now) / 1000;
}

/** One UPDATE moving `keys` of `table` by `shift`, for the rows `where` selects. */
async function rollColumns<T extends MySqlTable>(
  tx: Tx,
  table: T,
  keys: readonly string[],
  where: SQL,
  shift: (col: AnyColumn, key: string) => SQL,
) {
  const cols = getTableColumns(table) as Record<string, AnyColumn>;
  const set: Record<string, SQL> = {};
  for (const key of keys) {
    const col = cols[key];
    // A name that is not a column would otherwise be dropped silently by the
    // update builder, leaving that timestamp behind while the rest moved.
    if (!col) throw new Error(`demo timeline roll: ${key} is not a column of this table`);
    set[key] = shift(col, key);
  }
  await tx.update(table).set(set as MySqlUpdateSetSource<T>).where(where);
}

/** A UTC `YYYY-MM-DD HH:MM:SS` literal — the form drizzle itself writes timestamps in. */
export function utcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Rolled values dated after `now`, per column — the check that would have
 * caught the 12-hour-future rows above. Used by the operator CLI's report.
 * Columns in `mayBeFuture` are excluded: a future value there is legitimate.
 */
export async function futureDated(
  db: Db,
  orgId: number,
  now: Date,
): Promise<{ table: string; column: string; rows: number }[]> {
  const jobIds = (
    await db.select({ id: reconciliationJobs.id }).from(reconciliationJobs).where(eq(reconciliationJobs.organizationId, orgId))
  ).map((j) => j.id);
  const out: { table: string; column: string; rows: number }[] = [];
  const bound = utcSql(now);
  for (const step of ROLL_PLAN) {
    const cols = getTableColumns(step.table) as Record<string, AnyColumn>;
    if (step.scope === "jobs" && jobIds.length === 0) continue;
    const scope = step.scope === "jobs" ? inArray(cols.jobId, jobIds) : eq(cols.organizationId, orgId);
    const future: Record<string, string> = step.mayBeFuture;
    for (const key of step.roll) {
      if (key in future) continue;
      const [row] = await db
        .select({ n: count() })
        .from(step.table)
        .where(and(scope, sql`${cols[key]} > ${bound}`));
      const rows = Number(row?.n ?? 0);
      if (rows > 0) out.push({ table: step.name, column: key, rows });
    }
  }
  return out;
}

/**
 * The seeded report's summary carries its job's date range as TEXT, so after a
 * roll it would describe dates the job no longer has. Rebuilt IN PLACE — same
 * row, same id — so a shared link to it keeps working; deleting and recreating
 * it (as the manual refresh does) would change its id every hour.
 *
 * Only when exactly one seeded report exists: with several, which one is
 * current is ambiguous, and guessing is how a user's report gets rewritten.
 */
async function refreshSeededReportSummary(tx: Tx, orgId: number) {
  const seeded = (
    await tx
      .select({
        id: reconciliationReports.id,
        jobId: reconciliationReports.jobId,
        createdAt: reconciliationReports.createdAt,
        summary: reconciliationReports.summary,
      })
      .from(reconciliationReports)
      .where(eq(reconciliationReports.organizationId, orgId))
  ).filter((r) => isSeededReportSummary(r.summary));
  if (seeded.length !== 1) return;
  const report = seeded[0];

  const [job] = await tx
    .select()
    .from(reconciliationJobs)
    .where(and(eq(reconciliationJobs.id, report.jobId), eq(reconciliationJobs.organizationId, orgId)))
    .limit(1);
  if (!job) return;
  const jobMatches = await tx.select({ matchType: matches.matchType }).from(matches).where(eq(matches.jobId, job.id));
  const jobExceptions = await tx
    .select({ category: exceptions.category })
    .from(exceptions)
    .where(and(eq(exceptions.jobId, job.id), eq(exceptions.organizationId, orgId)));

  const previous = report.summary as { generatedBy?: unknown };
  const summary = buildReportSummary({
    job,
    matches: jobMatches,
    exceptions: jobExceptions,
    generatedBy: typeof previous.generatedBy === "string" ? previous.generatedBy : "ReconcileAI demo seed",
    // The report's own (rolled) creation time, not now: rolling moves when it
    // was generated, it does not regenerate it.
    generatedAt: report.createdAt,
  });
  await tx
    .update(reconciliationReports)
    .set({ summary: { ...summary, demoSeedMarker: DEMO_REPORT_MARKER } })
    .where(and(eq(reconciliationReports.id, report.id), eq(reconciliationReports.organizationId, orgId)));
}

// ─── The timer ──────────────────────────────────────────────────────────────

let running = false;

/** One pass over the allow-list. Never throws; logs one line per tenant. */
export async function rollAllDemoTimelines(): Promise<void> {
  if (running) {
    console.warn("[demo-timeline] previous pass still running — skipping this tick");
    return;
  }
  running = true;
  try {
    const db = await getDb();
    if (!db) return;
    for (const code of DEMO_TIMELINE_TENANTS) {
      try {
        const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.code, code)).limit(1);
        if (!org) {
          console.log(`[demo-timeline] ${code}: not present here — nothing to roll`);
          continue;
        }
        const result = await rollDemoTimeline(db, org.id, { commit: true });
        if (result.status === "rolled") {
          console.log(`[demo-timeline] ${code}: rolled +${result.seconds}s in ${result.ms}ms`);
        } else if (result.status === "refused") {
          console.warn(`[demo-timeline] ${code}: REFUSED — ${result.reason}`);
        }
      } catch (err) {
        console.error(`[demo-timeline] ${code}: failed —`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Start the hourly roll. Returns the interval, or null when it is not started:
 * under test, in an on-premise deployment (a bank's own install has no demo
 * tenants to keep fresh, and a timer that rewrites rows is not something it
 * asked for), or when DEMO_TIMELINE_ROLL_MINUTES disables it.
 */
export function startDemoTimelineRoll(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  if (env.VITEST) return null;
  if ((env.DEPLOYMENT_MODE ?? "cloud").toLowerCase() === "on_premise") return null;
  const minutes = rollIntervalMinutes(env.DEMO_TIMELINE_ROLL_MINUTES);
  if (minutes === 0) {
    console.log("[demo-timeline] disabled (DEMO_TIMELINE_ROLL_MINUTES)");
    return null;
  }
  console.log(`[demo-timeline] rolling ${DEMO_TIMELINE_TENANTS.join(", ")} every ${minutes} min`);
  // First pass a minute after boot, clear of startup work, so a deploy also
  // brings the demo current rather than waiting up to an hour.
  setTimeout(() => void rollAllDemoTimelines(), 60_000).unref?.();
  const timer = setInterval(() => void rollAllDemoTimelines(), minutes * 60_000);
  timer.unref?.();
  return timer;
}
