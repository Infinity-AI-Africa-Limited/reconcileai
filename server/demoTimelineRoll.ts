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
 * Each roll instead APPENDS to that chain — `demo_timeline_rolled`, in the
 * tenant's own trail, inside the roll's transaction — so a timestamp that
 * moved overnight can always be told apart from one a person changed.
 *
 * ── Where it runs ────────────────────────────────────────────────────────
 *
 * Only in the deployed production service (`rollEnabledHere`). Never under
 * `pnpm dev`: the local .env names the production database.
 */
import { and, count, eq, gt, inArray, max, sql, type AnyColumn, type SQL } from "drizzle-orm";
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
import { createAuditLog, getDb } from "./db";
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
    exempt: {
      shopifyUpdatedAt: "Provider-source update timestamp; Shopify-connected tenants are excluded from demo rolling and this must never be rewritten",
      shopifyCancelledAt: "Provider-source cancellation timestamp; Shopify-connected tenants are excluded from demo rolling and this must never be rewritten",
    },
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

/**
 * The furthest a roll will move a timeline BACKWARDS, in seconds.
 *
 * A newest transaction in the future is rolled back to now — the FMCG seeder
 * writes today's rows at 09:00, which is ahead of the clock when it runs
 * earlier that morning, and a forward-only roll then skipped every pass and
 * left the tenant future-dated for good. But a timeline two days ahead is not
 * a seeding artefact; it is a bad row, and dragging a whole tenant back by an
 * outlier's error would be worse than leaving it. Beyond this, the roll
 * refuses and says so.
 */
export const MAX_BACKWARD_SECONDS = 2 * 86_400;

export type RollTrigger = "scheduler" | "operator_cli";

/** Job statuses that mean a run is live: its timestamps are in use, not history. */
export const ACTIVE_JOB_STATUSES = ["pending", "running"] as const;

export type RollResult =
  | { status: "rolled"; seconds: number; ms: number }
  | { status: "skipped"; seconds: number; reason: string }
  | { status: "refused"; reason: string };

/** What a measured shift means: roll it, or why not. Pure, so every branch is tested. */
export function rollDecision(seconds: number | null): { roll: true } | { roll: false; reason: string } {
  if (seconds === null) return { roll: false, reason: "the tenant has no transactions" };
  if (seconds < -MAX_BACKWARD_SECONDS) {
    return {
      roll: false,
      reason: `newest transaction is ${Math.round(-seconds / 3600)}h in the FUTURE — beyond a seeding artefact; investigate the row rather than drag the tenant back`,
    };
  }
  if (Math.abs(seconds) < MIN_ROLL_SECONDS) return { roll: false, reason: `newest transaction is within ${MIN_ROLL_SECONDS}s of now` };
  return { roll: true };
}

/**
 * Roll one tenant's timeline so its newest transaction sits at `now` —
 * forward, or back when it is ahead of the clock (see MAX_BACKWARD_SECONDS).
 *
 * With `commit: false` it only measures, and takes no lock.
 * `allowList: null` is for the operator-run CLI, which names its tenant
 * explicitly and applies its own checks; the scheduler always passes the list.
 */
export async function rollDemoTimeline(
  db: Db,
  orgId: number,
  opts: { commit: boolean; now?: Date; allowList?: readonly string[] | null; trigger?: RollTrigger },
): Promise<RollResult> {
  const allowList = opts.allowList === undefined ? DEMO_TIMELINE_TENANTS : opts.allowList;

  if (!opts.commit) {
    const verdict = await eligibility(db, orgId, allowList, false);
    if (!verdict.ok) return { status: "refused", reason: verdict.reason };
    const seconds = await deltaSeconds(db, orgId, opts.now ?? new Date());
    return { status: "skipped", seconds: seconds ?? 0, reason: "measured only (commit: false)" };
  }

  const started = Date.now();
  return db.transaction(async (tx) => {
    // Lock FIRST, then decide. See the module header: the delta is relative.
    const verdict = await eligibility(tx, orgId, allowList, true);
    if (!verdict.ok) return { status: "refused", reason: verdict.reason } as const;

    // Never under a live reconciliation run. The run is writing matches and
    // exceptions against the dates it loaded, and its heartbeat is how the
    // stuck-job sweep tells it is alive: a backward roll moved `heartbeatAt`
    // up to two days into the past, past the sweep's two-hour cutoff, and the
    // sweep would fail a healthy run and abandon it for good. Deferred, not
    // refused — the next pass rolls once the run has finished. Checked under
    // the lock so the answer holds for the rest of this transaction's reads.
    //
    // A LOCKING read, not a plain one. In a TiDB pessimistic transaction a
    // plain SELECT reads the snapshot taken when the transaction BEGAN, so a
    // job committed between BEGIN and the organisations lock would be
    // invisible here. FOR UPDATE reads the latest committed rows. Together
    // with job creation taking the same organisations lock
    // (insertJobUnderTenantLock), no live job can exist that this does not see.
    const live = await tx
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(and(eq(reconciliationJobs.organizationId, orgId), inArray(reconciliationJobs.status, [...ACTIVE_JOB_STATUSES])))
      .for("update");
    const activeRuns = live.length;
    if (activeRuns > 0) {
      return { status: "skipped", seconds: 0, reason: `${activeRuns} reconciliation run(s) in progress — deferred to the next pass` } as const;
    }

    // `now` is taken after the lock is held, so a runner that waited on
    // another measures from the moment it actually gets to act.
    const now = opts.now ?? new Date();
    const measured = await deltaSeconds(tx, orgId, now);
    const decision = rollDecision(measured);
    if (!decision.roll) return { status: "skipped", seconds: measured ?? 0, reason: decision.reason } as const;
    const seconds = measured as number;

    const jobIds = (
      await tx.select({ id: reconciliationJobs.id }).from(reconciliationJobs).where(eq(reconciliationJobs.organizationId, orgId))
    ).map((j) => j.id);

    // Column arithmetic has no typed drizzle form, so the SET values use its
    // parameterised `sql` tag; the interval and bound are parameters, never text.
    // This is drizzle, not a raw query string — the same form the repository
    // already uses for the same job (db.ts, incrementUploadBatchCounts:
    // `sql\`${uploadBatches.validRows} + ${addValid}\``). The alternative, a
    // per-row loop, is ~81,000 round trips and cannot be atomic, and an
    // interrupted relative shift cannot be retried without splitting the
    // timeline.
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
      // Every job is rolled with everything else. No live job can be here: the
      // check above deferred for any it saw, and job creation takes the same
      // organisations lock this transaction holds, so none can appear before
      // commit. (An earlier revision excluded live jobs row by row instead;
      // that left such a job's window unshifted while its transactions moved —
      // it closed one symptom of the race, not the race.)
      const where = step.scope === "jobs" ? inArray(scopeCol, jobIds) : eq(scopeCol, orgId);
      const future: Record<string, string> = step.mayBeFuture;
      await rollColumns(tx, step.table, step.roll, where, (col, key) => (key in future ? shiftUnclamped(col) : shift(col)));
    }

    await refreshSeededReportSummary(tx, orgId);

    // A durable record, in the tenant's own audit trail and in THIS
    // transaction: the rewrite and the evidence of it commit together or not
    // at all. Without it, a roll leaves only a process log line behind, and a
    // timestamp that moved overnight is indistinguishable from one a user or a
    // source system changed. userId null: no person did this.
    await createAuditLog(
      {
        userId: null,
        organizationId: orgId,
        action: "demo_timeline_rolled",
        entityType: "organization",
        entityId: orgId,
        details: JSON.stringify({
          seconds,
          direction: seconds > 0 ? "forward" : "back",
          trigger: opts.trigger ?? "scheduler",
          clampedTo: bound,
          tables: ROLL_PLAN.map((s) => s.name),
        }),
      },
      tx,
    );

    // Last, just before commit: is the tenant STILL not a SHOPLINE store?
    // Provisioning does not take the organisations lock, so a store attached
    // since the first check would have gone unseen. If one exists now, undo
    // everything. That closes the race rather than narrowing it: a store's
    // orders are ingested only after its store row exists, so any row this
    // roll moved that belongs to a store implies a store this read will see.
    const storesNow = await shoplineStores(tx, orgId, true);
    if (storesNow > 0) {
      throw new RollAborted(`a SHOPLINE store was attached during the roll; rolled back — its rows mirror a real store`);
    }
    return { status: "rolled", seconds, ms: Date.now() - started } as const;
  }).catch((err: unknown) => {
    // The transaction has rolled back; report it as the refusal it is.
    if (err instanceof RollAborted) return { status: "refused", reason: err.message } as const;
    throw err;
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
  return rollEligibility(org, await shoplineStores(db, orgId, lock), allowList);
}

/**
 * SHOPLINE stores attached to the tenant. Under the roll's transaction this is
 * a LOCKING read: a plain SELECT would read the snapshot from BEGIN and miss a
 * store attached since — and then re-date a tenant that already mirrors a real
 * store. Store provisioning does not take the organisations lock, so the roll
 * also asks again just before committing (see rollDemoTimeline).
 */
async function shoplineStores(db: Db | Tx, orgId: number, lock: boolean): Promise<number> {
  const query = db.select({ id: slConnectorStores.id }).from(slConnectorStores).where(eq(slConnectorStores.organizationId, orgId));
  return (lock ? await query.for("update") : await query).length;
}

/** Thrown inside the roll's transaction to roll it back; turned into a refusal. */
class RollAborted extends Error {}

/**
 * Whole seconds from the newest transaction to `now` — NEGATIVE when the newest
 * is ahead of the clock — or null when there are no transactions. Signed on
 * purpose: `rollDeltaMs` floors at zero, which is what left a future-dated
 * tenant skipped by every pass.
 */
async function deltaSeconds(db: Db | Tx, orgId: number, now: Date): Promise<number | null> {
  const [row] = await db
    .select({ newest: max(transactions.transactionDate) })
    .from(transactions)
    .where(eq(transactions.organizationId, orgId));
  if (!row?.newest) return null;
  return Math.trunc((now.getTime() - new Date(row.newest).getTime()) / 1000);
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
  for (const step of ROLL_PLAN) {
    const cols = getTableColumns(step.table) as Record<string, AnyColumn>;
    if (step.scope === "jobs" && jobIds.length === 0) continue;
    const scope = step.scope === "jobs" ? inArray(cols.jobId, jobIds) : eq(cols.organizationId, orgId);
    const future: Record<string, string> = step.mayBeFuture;
    for (const key of step.roll) {
      if (key in future) continue;
      // A typed operator: `gt` binds `now` through the column's own encoder,
      // which writes a UTC timestamp — no hand-built literal needed here.
      const [row] = await db
        .select({ n: count() })
        .from(step.table)
        .where(and(scope, gt(cols[key], now)));
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

/**
 * One pass over the allow-list. Never throws; logs one line per tenant.
 *
 * Checks `rollEnabledHere` itself rather than trusting its caller: the timer is
 * one way in, and an exported function is another. A deliberate roll from
 * anywhere else is the operator CLI, which calls `rollDemoTimeline` per tenant.
 */
export async function rollAllDemoTimelines(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const here = rollEnabledHere(env);
  if (!here.enabled) {
    console.warn(`[demo-timeline] pass refused: ${here.reason}`);
    return;
  }
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
        const result = await rollDemoTimeline(db, org.id, { commit: true, trigger: "scheduler" });
        if (result.status === "rolled") {
          console.log(`[demo-timeline] ${code}: rolled ${result.seconds > 0 ? "+" : ""}${result.seconds}s in ${result.ms}ms`);
        } else if (result.status === "refused") {
          console.warn(`[demo-timeline] ${code}: REFUSED — ${result.reason}`);
        } else if (result.reason.includes("FUTURE")) {
          // Every other skip is routine; this one needs a person.
          console.warn(`[demo-timeline] ${code}: NOT ROLLED — ${result.reason}`);
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
 * Where the scheduled roll may run: the deployed production service, and
 * nowhere else. Pure, so every environment is tested.
 *
 * ── An allow-list, and why ────────────────────────────────────────────────
 *
 * The first version refused under test and on-premise and ran EVERYWHERE
 * else — including `pnpm dev` on a laptop, whose `.env` holds the production
 * DATABASE_URL. Starting a dev server would have rewritten production demo
 * tenants a minute later. Review caught it. That is the `db:push` hazard
 * again (CLAUDE.md §12), and the lesson from that one applies: enumerate what
 * is provably safe and refuse the rest, because a list of dangerous places can
 * always be re-spelled.
 *
 * Provably the deployed service means BOTH:
 *   - NODE_ENV=production — set by `pnpm start`, never by `pnpm dev`;
 *   - RAILWAY_ENVIRONMENT_NAME=production — injected by Railway at runtime,
 *     and by nothing on a developer machine. The name, not the variable's
 *     presence: a Railway PR or staging environment copies production's
 *     variables, DATABASE_URL included, and would roll production data from
 *     unmerged code.
 *
 * There is no override. A deliberate manual roll is the operator CLI
 * (`pnpm demo:recency --commit`), which names its tenant and says what it
 * will do before it does it.
 */
export function rollEnabledHere(env: NodeJS.ProcessEnv): { enabled: true; minutes: number } | { enabled: false; reason: string } {
  if (env.VITEST) return { enabled: false, reason: "under test" };
  if ((env.DEPLOYMENT_MODE ?? "cloud").toLowerCase() === "on_premise") {
    // A bank's own install has no demo tenants to keep fresh, and a timer that
    // rewrites rows is not something it asked for.
    return { enabled: false, reason: "on-premise deployment" };
  }
  const railwayEnv = env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT;
  if (env.NODE_ENV !== "production" || railwayEnv !== "production") {
    return {
      enabled: false,
      reason:
        `not the deployed production service (NODE_ENV=${env.NODE_ENV ?? "unset"}, ` +
        `RAILWAY_ENVIRONMENT_NAME=${railwayEnv ?? "unset"}); both must be "production"`,
    };
  }
  const minutes = rollIntervalMinutes(env.DEMO_TIMELINE_ROLL_MINUTES);
  if (minutes === 0) return { enabled: false, reason: "switched off by DEMO_TIMELINE_ROLL_MINUTES" };
  return { enabled: true, minutes };
}

/**
 * Start the scheduled roll. Returns the interval, or null when `rollEnabledHere`
 * says this is not the place — logged, so a deploy that did not start it says why.
 */
export function startDemoTimelineRoll(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  const here = rollEnabledHere(env);
  if (!here.enabled) {
    if (!env.VITEST) console.log(`[demo-timeline] not started: ${here.reason}`);
    return null;
  }
  const minutes = here.minutes;
  console.log(`[demo-timeline] rolling ${DEMO_TIMELINE_TENANTS.join(", ")} every ${minutes} min`);
  // First pass a minute after boot, clear of startup work, so a deploy also
  // brings the demo current rather than waiting up to an hour.
  setTimeout(() => void rollAllDemoTimelines(), 60_000).unref?.();
  const timer = setInterval(() => void rollAllDemoTimelines(), minutes * 60_000);
  timer.unref?.();
  return timer;
}
