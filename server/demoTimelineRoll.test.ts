/**
 * The hourly demo-timeline roll.
 *
 * It re-dates financial records with nobody watching, so what is pinned here is
 * what makes that safe: it touches only allow-listed demo tenants, it takes the
 * tenant lock BEFORE measuring the shift (the shift is relative — two runners
 * reading the same "newest" would each apply it), it writes nothing when there
 * is nothing to do, and every timestamp in a rolled table is either rolled or
 * exempted for a stated reason.
 *
 * The database is a recording fake: this suite must never reach a real one.
 * The local .env names PRODUCTION, and a roll is a write.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SQL, getTableColumns, getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// No path in this file may reach a real database. `getDb` resolves to null, so
// anything that gets past the environment check stops there; the audit writer
// stays real because every roll passes it the fake transaction.
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: vi.fn(async () => null) };
});
import { getDb } from "./db";
import { DEMO_REPORT_MARKER } from "./demoReportSeed";
import { OPERATOR_ORG_CODE } from "../shared/operatorOrg";
import {
  ACTIVE_JOB_STATUSES,
  DEMO_TIMELINE_TENANTS,
  MAX_BACKWARD_SECONDS,
  MIN_ROLL_SECONDS,
  ROLL_PLAN,
  rollAllDemoTimelines,
  rollDecision,
  rollDemoTimeline,
  rollEligibility,
  rollEnabledHere,
  rollIntervalMinutes,
  startDemoTimelineRoll,
} from "./demoTimelineRoll";

// ─── A recording fake of the drizzle surface the roll uses ──────────────────

type Script = {
  org?: { code: string | null; isDemo: boolean; onboardingChannel: string | null };
  stores?: number;
  newest?: Date | null;
  jobIds?: number[];
  reports?: { id: number; jobId: number; createdAt: Date; summary: unknown }[];
  /** Reconciliation runs pending or running for the tenant. */
  activeRuns?: number;
};

const JOB = {
  id: 5, name: "Globus Daily", organizationId: 1, dateFrom: new Date("2026-06-23T00:00:00Z"), dateTo: new Date("2026-09-21T09:00:00Z"),
  totalSourceTxns: 10, totalTargetTxns: 10, matchedCount: 8, exceptionCount: 2, unmatchedCount: 0, matchRate: "80.00", processingTimeMs: 100,
};

const dialect = new MySqlDialect();

function fakeDb(script: Script) {
  const log: string[] = [];
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const wheres: { table: string; fields: string[]; params: unknown[]; sql?: string }[] = [];
  const sqlLog: { table: string; key: string; sql: string; params: unknown[] }[] = [];
  const select = (fields?: Record<string, unknown>) => {
    let table = "";
    const q = {
      from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; },
      where(cond?: unknown) {
        // Rendered, so a test can see what a query actually filters on.
        if (cond instanceof SQL) wheres.push({ table, fields: Object.keys(fields ?? {}), params: dialect.sqlToQuery(cond).params });
        return q;
      },
      orderBy() { return q; },
      limit() { return q; },
      for(strength: string) { log.push(`lock ${table} ${strength}`); return q; },
      then(resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) {
        log.push(`read ${table}`);
        try {
          return Promise.resolve(rows(table, fields)).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return q;
  };
  const rows = (table: string, fields?: Record<string, unknown>): unknown[] => {
    switch (table) {
      case "organizations": return script.org ? [script.org] : [];
      case "sl_connector_stores": return [{ n: script.stores ?? 0 }];
      case "transactions": return [{ newest: script.newest ?? null }];
      case "reconciliation_jobs":
        // Three shapes: a count of live runs, the tenant's job ids, a full job row.
        if (fields && "n" in fields) return [{ n: script.activeRuns ?? 0 }];
        return fields ? (script.jobIds ?? []).map((id) => ({ id })) : [JOB];
      case "reconciliation_reports": return script.reports ?? [];
      default: return [];
    }
  };
  const db = {
    select,
    update(t: Parameters<typeof getTableName>[0]) {
      const table = getTableName(t);
      return {
        set(s: Record<string, unknown>) {
          // Each rolled key is rendered to SQL, so the log shows WHAT was written:
          // "key" = shifted and clamped to now, "key~" = shifted, not clamped.
          const keys = Object.keys(s).sort().map((k) => {
            const v = s[k];
            if (!(v instanceof SQL)) return k;
            const q = dialect.sqlToQuery(v);
            sqlLog.push({ table, key: k, sql: q.sql, params: q.params });
            return /least\(/i.test(q.sql) ? k : `${k}~`;
          });
          return {
            where: async (cond?: unknown) => {
              log.push(`update ${table} ${keys.join(",")}`);
              if (cond instanceof SQL) {
                const q = dialect.sqlToQuery(cond);
                wheres.push({ table: `update:${table}`, fields: Object.keys(s), params: q.params, sql: q.sql });
              }
            },
          };
        },
      };
    },
    delete(t: Parameters<typeof getTableName>[0]) { log.push(`delete ${getTableName(t)}`); return { where: async () => {} }; },
    insert(t: Parameters<typeof getTableName>[0]) {
      const table = getTableName(t);
      return { values: async (v: Record<string, unknown>) => { log.push(`insert ${table}`); inserts.push({ table, values: v }); } };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) { log.push("begin"); const r = await fn(db); log.push("commit"); return r; },
  };
  return { db: db as unknown as Parameters<typeof rollDemoTimeline>[0], log, sqlLog, inserts, wheres };
}

/** The audit entry a roll wrote, parsed, or undefined. */
function auditOf(inserts: { table: string; values: Record<string, unknown> }[]) {
  const row = inserts.find((i) => i.table === "audit_logs")?.values;
  return row ? { ...row, details: JSON.parse(String(row.details)) as Record<string, unknown> } : undefined;
}

/** The log line a plan step should produce: its keys, `~` on the unclamped ones. */
function expectedUpdate(step: (typeof ROLL_PLAN)[number]): string {
  const future: Record<string, string> = step.mayBeFuture;
  const keys = [...step.roll].sort().map((k) => (k in future ? `${k}~` : k));
  return `update ${getTableName(step.table)} ${keys.join(",")}`;
}

const NOW = new Date("2026-09-21T12:00:00Z");
const HOUR_AGO = new Date("2026-09-21T11:00:00Z");
const globus = { code: "GLOBUS_DEMO", isDemo: true, onboardingChannel: null };
const updates = (log: string[]) => log.filter((l) => l.startsWith("update "));

// ─── Who may be rolled ───────────────────────────────────────────────────────

describe("when deciding whether a tenant may be rolled", () => {
  it("should allow an allow-listed demo tenant with no SHOPLINE connection", () => {
    for (const code of DEMO_TIMELINE_TENANTS) {
      expect(rollEligibility({ code, isDemo: true, onboardingChannel: null }, 0)).toEqual({ ok: true });
    }
  });

  it("should refuse a demo tenant that is not on the allow-list — isDemo alone is not enough", () => {
    // The guest demo is a real demo tenant; the scheduler still may not touch it.
    expect(rollEligibility({ code: "RECONCILEAI_GUEST_DEMO", isDemo: true, onboardingChannel: null }, 0).ok).toBe(false);
    expect(rollEligibility({ code: null, isDemo: true, onboardingChannel: null }, 0).ok).toBe(false);
  });

  it("should refuse an allow-listed code whose tenant is not flagged demo", () => {
    // Both properties are mutable; requiring both means one mis-set field is not enough.
    expect(rollEligibility({ code: "GLOBUS_DEMO", isDemo: false, onboardingChannel: null }, 0).ok).toBe(false);
  });

  it("should refuse a SHOPLINE tenant by onboarding channel OR by a live store row", () => {
    expect(rollEligibility({ ...globus, onboardingChannel: "shopline_app_store" }, 0).ok).toBe(false);
    expect(rollEligibility(globus, 1).ok).toBe(false);
  });

  it("should still refuse non-demo and SHOPLINE tenants when the operator CLI waives the allow-list", () => {
    expect(rollEligibility({ code: "RECONCILEAI_GUEST_DEMO", isDemo: true, onboardingChannel: null }, 0, null)).toEqual({ ok: true });
    expect(rollEligibility({ code: OPERATOR_ORG_CODE, isDemo: false, onboardingChannel: null }, 0, null).ok).toBe(false);
    expect(rollEligibility({ code: "SL_RECONCILEAI_DEV", isDemo: true, onboardingChannel: "shopline_app_store" }, 0, null).ok).toBe(false);
  });
});

// ─── The roll itself ─────────────────────────────────────────────────────────

describe("when an eligible tenant is rolled", () => {
  it("should take the tenant lock before it measures the shift", () => {
    const { db, log } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    return rollDemoTimeline(db, 1, { commit: true, now: NOW }).then((result) => {
      expect(result).toMatchObject({ status: "rolled", seconds: 3600 });
      const lock = log.indexOf("lock organizations update");
      const measure = log.indexOf("read transactions");
      expect(lock, log.join(" | ")).toBeGreaterThan(-1);
      expect(measure).toBeGreaterThan(lock);
      // Every write is inside the transaction and after the lock.
      const firstWrite = log.findIndex((l) => l.startsWith("update "));
      expect(firstWrite).toBeGreaterThan(measure);
      expect(log.indexOf("commit")).toBeGreaterThan(log.lastIndexOf(updates(log).at(-1)!));
    });
  });

  it("should move every table in the plan, with exactly the planned columns", async () => {
    const { db, log } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    for (const step of ROLL_PLAN) {
      expect(log, `${step.name} was not rolled as planned`).toContain(expectedUpdate(step));
    }
  });

  it("should clamp every rolled value to now, except a transaction's value date", async () => {
    // The first live run found BrightGoods ingestion times, match times and a
    // job window up to 12 hours in the future — records made after the newest
    // transaction, carried past now by a pure shift.
    const { db, sqlLog } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    const unclamped = sqlLog.filter((s) => !/least\(/i.test(s.sql)).map((s) => `${s.table}.${s.key}`);
    expect(unclamped).toEqual(["transactions.valueDate"]);
    expect(sqlLog.length).toBeGreaterThan(20); // the positive: the shifts were actually rendered
    // The bound is now, as a UTC literal — never a Date, which the driver would
    // render in the process's own zone.
    const clamped = sqlLog.find((s) => s.table === "reconciliation_jobs" && s.key === "dateTo")!;
    expect(clamped.params).toContain("2026-09-21 12:00:00");
    expect(clamped.params).toContain(3600);
    expect(clamped.params.some((p) => p instanceof Date)).toBe(false);
  });

  it("should skip matches when the tenant has no jobs, rather than run an unscoped update", async () => {
    const { db, log } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    expect(updates(log).some((l) => l.startsWith("update matches"))).toBe(false);
    expect(updates(log).some((l) => l.startsWith("update transactions"))).toBe(true);
  });

  it("should write nothing when the newest transaction is already current", async () => {
    // What a second instance finds after the first has rolled.
    const justNow = new Date(NOW.getTime() - (MIN_ROLL_SECONDS - 1) * 1000);
    const { db, log } = fakeDb({ org: globus, newest: justNow, jobIds: [5] });
    const result = await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    expect(result.status).toBe("skipped");
    expect(updates(log)).toEqual([]);
  });

  it("should write nothing, and not even measure, for a refused tenant", async () => {
    for (const script of [
      { org: { ...globus, isDemo: false } },
      { org: { code: "RECONCILEAI_GUEST_DEMO", isDemo: true, onboardingChannel: null } },
      { org: globus, stores: 1 },
      { org: undefined },
    ] as Script[]) {
      const { db, log } = fakeDb({ newest: HOUR_AGO, jobIds: [5], ...script });
      const result = await rollDemoTimeline(db, 1, { commit: true, now: NOW });
      expect(result.status, JSON.stringify(script)).toBe("refused");
      expect(updates(log)).toEqual([]);
      expect(log).not.toContain("read transactions");
    }
  });

  it("should only measure, without a lock or a write, when not committing", async () => {
    const { db, log, inserts } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    const result = await rollDemoTimeline(db, 1, { commit: false, now: NOW });
    expect(result).toMatchObject({ status: "skipped", seconds: 3600 });
    expect(log.some((l) => l.startsWith("lock"))).toBe(false);
    expect(updates(log)).toEqual([]);
    expect(inserts).toEqual([]);
  });
});

describe("when a roll rewrites a tenant's timestamps", () => {
  it("should record it in that tenant's audit trail, inside the same transaction", async () => {
    // Otherwise a timestamp that moved overnight is indistinguishable from one a
    // person or a source system changed.
    const { db, log, inserts } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW, trigger: "operator_cli" });
    const audit = auditOf(inserts);
    expect(audit).toMatchObject({ organizationId: 1, userId: null, action: "demo_timeline_rolled", entityType: "organization", entityId: 1 });
    expect(audit?.details).toMatchObject({ seconds: 3600, direction: "forward", trigger: "operator_cli", clampedTo: "2026-09-21 12:00:00" });
    // Committed with the rewrite, not after it.
    const at = log.indexOf("insert audit_logs");
    expect(at).toBeGreaterThan(log.indexOf("begin"));
    expect(at).toBeLessThan(log.indexOf("commit"));
  });

  it("should record nothing when nothing was rewritten", async () => {
    const justNow = new Date(NOW.getTime() - 10_000);
    for (const script of [{ org: globus, newest: justNow }, { org: { ...globus, isDemo: false }, newest: HOUR_AGO }] as Script[]) {
      const { db, inserts } = fakeDb({ jobIds: [5], ...script });
      await rollDemoTimeline(db, 1, { commit: true, now: NOW });
      expect(auditOf(inserts), JSON.stringify(script)).toBeUndefined();
    }
  });
});

describe("when the newest transaction is ahead of the clock", () => {
  it("should roll the timeline BACK to now, clamped, rather than skip it forever", () => {
    // The FMCG seeder writes today's rows at 09:00; seeded earlier that morning,
    // the newest transaction is in the future. A forward-only roll measured
    // zero and skipped every pass, so the clamps never ran.
    const threeHoursAhead = new Date(NOW.getTime() + 3 * 3600_000);
    const { db, log, inserts, sqlLog } = fakeDb({ org: globus, newest: threeHoursAhead, jobIds: [5] });
    return rollDemoTimeline(db, 1, { commit: true, now: NOW }).then((result) => {
      expect(result).toMatchObject({ status: "rolled", seconds: -10800 });
      expect(updates(log).length).toBeGreaterThan(5);
      expect(sqlLog.find((s) => s.key === "transactionDate")!.params).toContain(-10800);
      expect(auditOf(inserts)?.details).toMatchObject({ seconds: -10800, direction: "back" });
    });
  });

  it("should refuse to drag a tenant back by more than two days, and say why", async () => {
    // Two days ahead is not a seeding artefact, it is a bad row.
    const { db, log, inserts } = fakeDb({ org: globus, newest: new Date(NOW.getTime() + 3 * 86_400_000), jobIds: [5] });
    const result = await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" ? result.reason : "").toMatch(/FUTURE/);
    expect(updates(log)).toEqual([]);
    expect(inserts).toEqual([]);
  });
});

describe("when a reconciliation run is live for the tenant", () => {
  it("should defer the roll, in either direction, and write nothing", async () => {
    // A backward roll moved a live run's heartbeat days into the past, beyond
    // the stuck-job sweep's two-hour cutoff: a healthy run failed and abandoned.
    for (const newest of [HOUR_AGO, new Date(NOW.getTime() + 3 * 3600_000)]) {
      const { db, log, inserts } = fakeDb({ org: globus, newest, jobIds: [5], activeRuns: 1 });
      const result = await rollDemoTimeline(db, 1, { commit: true, now: NOW });
      expect(result.status).toBe("skipped");
      expect(result.status === "skipped" ? result.reason : "").toMatch(/in progress/);
      expect(updates(log)).toEqual([]);
      expect(inserts).toEqual([]);
      // Decided under the lock, before anything is measured.
      expect(log.indexOf("read reconciliation_jobs")).toBeGreaterThan(log.indexOf("lock organizations update"));
      expect(log).not.toContain("read transactions");
    }
  });

  it("should roll once no run is live — the positive to the deferral", async () => {
    const { db } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5], activeRuns: 0 });
    expect((await rollDemoTimeline(db, 1, { commit: true, now: NOW })).status).toBe("rolled");
  });

  it("should never rewrite a live job, even one that started after the check", async () => {
    // The check can race: job creation does not take the organisations lock,
    // so a run may start after it returns zero. The jobs UPDATE therefore
    // excludes live statuses row by row, and a mid-roll run keeps its heartbeat.
    const { db, wheres } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5], activeRuns: 0 });
    expect((await rollDemoTimeline(db, 1, { commit: true, now: NOW })).status).toBe("rolled");
    const jobsUpdate = wheres.find((w) => w.table === "update:reconciliation_jobs");
    expect(jobsUpdate, "the jobs UPDATE was not issued").toBeDefined();
    expect(jobsUpdate!.sql).toMatch(/not in/i);
    for (const s of ACTIVE_JOB_STATUSES) expect(jobsUpdate!.params).toContain(s);
    expect(jobsUpdate!.params).toContain(1);
    // Only jobs carry that predicate; every other table rolls whole.
    const others = wheres.filter((w) => w.table.startsWith("update:") && w.table !== "update:reconciliation_jobs" && w.table !== "update:reconciliation_reports");
    expect(others.length).toBeGreaterThan(5);
    for (const w of others) expect(w.sql, w.table).not.toMatch(/not in/i);
  });

  it("should count as live exactly the statuses the stuck-job sweep treats as live", async () => {
    // The deferral protects runs FROM the sweep, so the two must agree on what
    // "live" means. Read from the sweep's own source, not restated here.
    const src = readFileSync(path.join(__dirname, "reconciliationQueue.ts"), "utf8").replace(/\r\n/g, "\n");
    const sweep = src.slice(src.indexOf("export async function recoverStuckReconciliationJobs"));
    const listed = /inArray\(reconciliationJobs\.status, \[([^\]]*)\]\)/.exec(sweep)?.[1];
    expect(listed, "the sweep's status list has moved").toBeTruthy();
    const sweepStatuses = [...listed!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect([...ACTIVE_JOB_STATUSES].sort()).toEqual(sweepStatuses);

    // And the query really filters on them — not merely a constant that exists.
    const { db, wheres } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    const live = wheres.find((w) => w.table === "reconciliation_jobs" && w.fields.includes("n"));
    expect(live, "no live-run query was issued").toBeDefined();
    for (const s of sweepStatuses) expect(live!.params).toContain(s);
    expect(live!.params).toContain(1); // scoped to THIS tenant
  });
});

describe("when deciding what a measured shift means", () => {
  it("should roll either way beyond the minimum, within the backward cap", () => {
    expect(rollDecision(3600)).toEqual({ roll: true });
    expect(rollDecision(-3600)).toEqual({ roll: true });
    expect(rollDecision(-MAX_BACKWARD_SECONDS)).toEqual({ roll: true });
  });

  it("should not roll a tenant with no transactions, a near-zero shift, or one past the cap", () => {
    expect(rollDecision(null).roll).toBe(false);
    expect(rollDecision(MIN_ROLL_SECONDS - 1).roll).toBe(false);
    expect(rollDecision(-(MIN_ROLL_SECONDS - 1)).roll).toBe(false);
    expect(rollDecision(-MAX_BACKWARD_SECONDS - 1).roll).toBe(false);
  });
});

describe("when the tenant has a seeded report", () => {
  const seeded = { id: 9, jobId: 5, createdAt: new Date("2026-09-21T10:00:00Z"), summary: { demoSeedMarker: DEMO_REPORT_MARKER, generatedBy: "ReconcileAI demo seed" } };

  it("should rebuild its summary in place, keeping the report's id, never delete and recreate it", async () => {
    // A shared link names the report id; replacing the row hourly would break it.
    const { db, log } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5], reports: [seeded] });
    await rollDemoTimeline(db, 1, { commit: true, now: NOW });
    expect(log).toContain("update reconciliation_reports summary");
    expect(log).not.toContain("delete reconciliation_reports");
    expect(log).not.toContain("insert reconciliation_reports");
  });

  it("should leave reports alone when which one is current is ambiguous, or none is seeded", async () => {
    for (const reports of [[seeded, { ...seeded, id: 10 }], [{ ...seeded, summary: { jobName: "a user's report" } }]]) {
      const { db, log } = fakeDb({ org: globus, newest: HOUR_AGO, jobIds: [5], reports });
      await rollDemoTimeline(db, 1, { commit: true, now: NOW });
      expect(log).not.toContain("update reconciliation_reports summary");
    }
  });
});

// ─── The plan covers every timestamp ─────────────────────────────────────────

describe("when a rolled table has timestamp columns", () => {
  it("should roll or explicitly exempt every one, so a new column cannot be left behind", () => {
    // A timestamp left behind splits the timeline: e.g. an exception's
    // assignedAt a day before the exception it belongs to.
    for (const step of ROLL_PLAN) {
      const cols = getTableColumns(step.table) as Record<string, { columnType: string }>;
      const stamps = Object.entries(cols).filter(([, c]) => /Timestamp|DateTime/.test(c.columnType)).map(([k]) => k);
      const classified = new Set<string>([...step.roll, ...Object.keys(step.exempt)]);
      const missing = stamps.filter((k) => !classified.has(k));
      expect(missing, `${step.name}: roll these, or exempt them with a reason`).toEqual([]);
      for (const k of classified) expect(Object.keys(cols), `${step.name}.${k} is not a column`).toContain(k);
      // A future-allowed column must be one that is rolled, or the exemption is decoration.
      const roll: readonly string[] = step.roll;
      for (const k of Object.keys(step.mayBeFuture)) expect(roll, `${step.name}.${k} allowed future but not rolled`).toContain(k);
    }
  });

  it("should never roll the audit log, whose timestamps are part of a tamper-evident chain", () => {
    expect(ROLL_PLAN.map((s) => getTableName(s.table))).not.toContain("audit_logs");
  });
});

// ─── The timer ───────────────────────────────────────────────────────────────

describe("when choosing how often to roll", () => {
  it("should default to hourly, allow it to be switched off, and refuse a thrashing interval", () => {
    expect(rollIntervalMinutes(undefined)).toBe(60);
    expect(rollIntervalMinutes("")).toBe(60);
    expect(rollIntervalMinutes("0")).toBe(0);
    expect(rollIntervalMinutes("off")).toBe(0);
    expect(rollIntervalMinutes("30")).toBe(30);
    expect(rollIntervalMinutes("1")).toBe(5);
    expect(rollIntervalMinutes("nonsense")).toBe(60);
    expect(rollIntervalMinutes("-5")).toBe(60);
  });
});

describe("when the server starts", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const PROD = { NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "production" };

  it("should run in the deployed production service", () => {
    expect(rollEnabledHere(PROD)).toEqual({ enabled: true, minutes: 60 });
    expect(rollEnabledHere({ ...PROD, DEMO_TIMELINE_ROLL_MINUTES: "30" })).toEqual({ enabled: true, minutes: 30 });
    // Railway's older name for the same variable.
    expect(rollEnabledHere({ NODE_ENV: "production", RAILWAY_ENVIRONMENT: "production" }).enabled).toBe(true);
  });

  it("should never run from a developer's machine, whose .env may name production", () => {
    // The finding: `pnpm dev` is NODE_ENV=development, VITEST unset, cloud mode —
    // and the first version started the timer there.
    expect(rollEnabledHere({ NODE_ENV: "development" }).enabled).toBe(false);
    expect(rollEnabledHere({}).enabled).toBe(false);
    // `pnpm start` on a laptop is production mode, but not Railway.
    expect(rollEnabledHere({ NODE_ENV: "production" }).enabled).toBe(false);
    // Railway variables with a dev server (e.g. `railway run pnpm dev`).
    expect(rollEnabledHere({ NODE_ENV: "development", RAILWAY_ENVIRONMENT_NAME: "production" }).enabled).toBe(false);
  });

  it("should never run in a Railway PR or staging environment, which copies production's DATABASE_URL", () => {
    for (const name of ["staging", "pr-138", "Production ", ""]) {
      expect(rollEnabledHere({ NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: name }).enabled, name).toBe(false);
    }
  });

  it("should not run under test, on-premise, or when switched off — even in production", () => {
    expect(rollEnabledHere({ ...PROD, VITEST: "true" }).enabled).toBe(false);
    expect(rollEnabledHere({ ...PROD, DEPLOYMENT_MODE: "on_premise" }).enabled).toBe(false);
    expect(rollEnabledHere({ ...PROD, DEPLOYMENT_MODE: "ON_PREMISE" }).enabled).toBe(false);
    expect(rollEnabledHere({ ...PROD, DEMO_TIMELINE_ROLL_MINUTES: "off" }).enabled).toBe(false);
  });

  it("should not start a timer anywhere it may not run", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const env of [{ VITEST: "true" }, { NODE_ENV: "development" }, { ...PROD, DEPLOYMENT_MODE: "on_premise" }]) {
      expect(startDemoTimelineRoll(env), JSON.stringify(env)).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should refuse a pass called directly from anywhere it may not run, before touching the database", async () => {
    // The timer is one way in; the exported function is another.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getDb).mockClear();
    await rollAllDemoTimelines({ NODE_ENV: "development" });
    await rollAllDemoTimelines({ NODE_ENV: "production" });
    expect(getDb).not.toHaveBeenCalled();
    // The positive: in production the pass does reach for the database.
    await rollAllDemoTimelines(PROD);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("should start in the deployed production service", () => {
    // Fake timers: nothing fires, so no pass can reach a database.
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(startDemoTimelineRoll(PROD)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(2); // the first pass after boot, and the interval
  });
});
