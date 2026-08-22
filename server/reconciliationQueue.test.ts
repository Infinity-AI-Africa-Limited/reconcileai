/**
 * Durable reconciliation queue — Unit Tests
 *
 * Uses injected fakes ONLY (makeRunHandler deps) — the local .env points at
 * the live shared TiDB, so nothing here may touch the real database.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRunHandler, type RunHandlerDeps, type ReconciliationRunPayload } from "./reconciliationQueue";

const PAYLOAD: ReconciliationRunPayload = {
  jobId: 7,
  sourceChannelId: 1,
  targetChannelId: 2,
  dateFromIso: "2026-06-01T00:00:00.000Z",
  dateToIso: "2026-06-30T00:00:00.000Z",
  config: { amountTolerance: 0.005, dateWindowDays: 3 },
  userId: 99,
};

function makeDeps(
  overrides: Partial<RunHandlerDeps> & { statuses?: string[]; abandonedAt?: Date | null; claimResult?: boolean } = {},
) {
  const calls = { reset: 0, run: 0, claim: 0, runnerArgs: [] as unknown[] };
  const statuses = overrides.statuses ?? ["pending", "completed"];
  const abandonedAt = overrides.abandonedAt ?? null;
  let statusIdx = 0;
  const deps: RunHandlerDeps = {
    loadJobState:
      overrides.loadJobState ??
      (async () => ({ status: statuses[Math.min(statusIdx++, statuses.length - 1)], abandonedAt })),
    claimJob: overrides.claimJob ?? (async () => { calls.claim += 1; return overrides.claimResult ?? true; }),
    resetArtifacts: overrides.resetArtifacts ?? (async () => { calls.reset += 1; }),
    getRunner: overrides.getRunner ?? (() => async (...args: unknown[]) => {
      calls.run += 1;
      calls.runnerArgs = args;
    }),
  };
  return { deps, calls };
}

describe("makeRunHandler", () => {
  it("resets artifacts, runs the runner with deserialized dates, and finishes cleanly on success", async () => {
    const { deps, calls } = makeDeps({ statuses: ["pending", "completed"] });
    const handle = makeRunHandler(deps);
    await handle({ data: PAYLOAD, attempt: 1 });
    expect(calls.reset).toBe(1);
    expect(calls.run).toBe(1);
    expect(calls.runnerArgs[0]).toBe(7);
    expect(calls.runnerArgs[3]).toBeInstanceOf(Date);
    expect((calls.runnerArgs[3] as Date).toISOString()).toBe(PAYLOAD.dateFromIso);
  });

  it("skips completed jobs entirely (idempotency guard)", async () => {
    const { deps, calls } = makeDeps({ statuses: ["completed"] });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 2 });
    expect(calls.reset).toBe(0);
    expect(calls.run).toBe(0);
  });

  it("skips deleted jobs (status null)", async () => {
    const { deps, calls } = makeDeps({ loadJobState: async () => null });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 });
    expect(calls.run).toBe(0);
  });

  it("throws to trigger a retry when the runner left the job failed (non-final attempt)", async () => {
    const { deps } = makeDeps({ statuses: ["running", "failed"] });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).rejects.toThrow(/retrying/);
  });

  it("does NOT throw on the final attempt — the job stays failed without queue noise", async () => {
    const { deps } = makeDeps({ statuses: ["running", "failed"] });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 3 })).resolves.toBeUndefined();
  });

  it("throws when no runner is registered", async () => {
    const { deps } = makeDeps({ getRunner: () => null });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).rejects.toThrow(/not registered/);
  });

  it("resets artifacts on every attempt, including retries", async () => {
    const { deps, calls } = makeDeps({ statuses: ["failed", "completed"] });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 2 });
    expect(calls.reset).toBe(1);
    expect(calls.run).toBe(1);
  });

  // ── Abandonment guard (a swept job must not be resurrected) ───────────────

  it("refuses a job the recovery sweep abandoned, without resetting its artifacts", async () => {
    // The exact shape of the bug: the sweep marked the row failed but could not
    // delete the durable queue entry, which is then delivered afterwards.
    const { deps, calls } = makeDeps({
      statuses: ["failed"],
      abandonedAt: new Date("2026-08-22T00:00:00.000Z"),
    });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 });
    expect(calls.reset).toBe(0);
    expect(calls.run).toBe(0);
  });

  it("still retries an ordinary runner failure — abandonment must not block the retry contract", async () => {
    const { deps, calls } = makeDeps({ statuses: ["running", "failed"], abandonedAt: null });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).rejects.toThrow(/retrying/);
    expect(calls.run).toBe(1);
  });

  it("does not raise a retry for a job abandoned while it was running", async () => {
    // Sweep landed mid-run: the job comes back failed AND abandoned. Retrying
    // would re-run work already reported as dead, so the handler exits quietly.
    let call = 0;
    const { deps } = makeDeps({
      loadJobState: async () => {
        call += 1;
        return call === 1
          ? { status: "running", abandonedAt: null }
          : { status: "failed", abandonedAt: new Date("2026-08-22T00:00:00.000Z") };
      },
    });
    await expect(makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 })).resolves.toBeUndefined();
  });
});

/**
 * Boot-sweep atomicity.
 *
 * Asserted against the source: the sweep needs a live database and the local
 * .env points at the shared production TiDB, which no test may touch.
 */
describe("the stale-job sweep", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "reconciliationQueue.ts"), "utf8");

  it("should measure staleness from the last sign of life, not row creation", () => {
    // createdAt alone says nothing about whether a worker is active: a job can
    // sit queued for hours and start seconds ago. Sweeping on creation age
    // declares live runs dead, and abandonment is terminal.
    expect(SOURCE).toContain("COALESCE(${reconciliationJobs.heartbeatAt}, ${reconciliationJobs.startedAt}, ${reconciliationJobs.createdAt})");
    // Both the select and the re-asserting update must use the SAME predicate,
    // or the update stops re-asserting what was actually selected.
    expect(SOURCE.match(/lt\(lastActivity, cutoff\)/g) ?? []).toHaveLength(2);
    expect(SOURCE).not.toContain("lt(reconciliationJobs.createdAt, cutoff)");
  });

  it("should re-assert its selection predicates inside the UPDATE", () => {
    // Selecting ids and then updating by id alone is not atomic. A worker that
    // completes one of those jobs in the gap would have its finished run
    // overwritten as failed AND abandoned — terminal, with artifacts already
    // written and success already reported to the user.
    const update = SOURCE.slice(
      SOURCE.indexOf(".set({ status: \"failed\", completedAt: now, abandonedAt: now })"),
      SOURCE.indexOf("const recovered ="),
    );
    expect(update).toContain("inArray(reconciliationJobs.status,");
    expect(update).toContain("lt(lastActivity, cutoff)");
    expect(update).toContain("isNull(reconciliationJobs.abandonedAt)");
  });

  it("should remove queue entries only for rows it actually abandoned", () => {
    // Never for one that completed in the race window.
    expect(SOURCE).toContain("isNotNull(reconciliationJobs.abandonedAt)");
    expect(SOURCE).toContain("for (const j of abandoned)");
  });

  it("should report only rows the UPDATE actually touched", () => {
    // Falling back to the pre-update count would over-report recoveries.
    expect(SOURCE).toContain("Number((result as any)?.[0]?.affectedRows ?? 0)");
  });
});

describe("when the enqueue outcome was ambiguous", () => {
  it("should refuse to run if it cannot claim the job, and touch nothing", async () => {
    // The router's contended abandonment won the race, so this worker must not
    // reset artifacts or execute — the caller has already been told the run
    // was stopped before it started.
    const { deps, calls } = makeDeps({ statuses: ["pending"], claimResult: false });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 });
    expect(calls.claim).toBe(1);
    expect(calls.reset).toBe(0);
    expect(calls.run).toBe(0);
  });

  it("should claim BEFORE resetting artifacts, never after", async () => {
    // Claiming after the reset would destroy a job's matches and exceptions
    // and only then discover it was not ours to run.
    const order: string[] = [];
    const { deps } = makeDeps({
      statuses: ["pending", "completed"],
      claimJob: async () => { order.push("claim"); return true; },
      resetArtifacts: async () => { order.push("reset"); },
    });
    await makeRunHandler(deps)({ data: PAYLOAD, attempt: 1 });
    expect(order).toEqual(["claim", "reset"]);
  });
});

describe("when the sweep abandons a run that is still executing", () => {
  // The sweep has no cancellation channel and cannot see inside a synchronous
  // matching pass, so a healthy long run CAN be declared dead. What matters is
  // what happens when that run then finishes.
  const RUNNER = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
  const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");

  it("should treat completion as proof the sweep was wrong, and clear the abandonment", () => {
    expect(RUNNER).toContain("const { wasAbandoned } = await db.completeReconciliationJobClearingAbandonment(jobId, {");
    const fn = DB.slice(DB.indexOf("export async function completeReconciliationJobClearingAbandonment"));
    expect(fn.slice(0, 900)).toContain("abandonedAt: null");
  });

  it("should KEEP the run's artifacts — losing computed results is worse than a wrong status", () => {
    // An earlier revision discarded them. Matches and exceptions are real
    // financial output; destroying them to protect a status field is the wrong
    // trade, especially when the verdict that triggered it is a guess.
    const tail = RUNNER.slice(RUNNER.indexOf("completeReconciliationJobClearingAbandonment"));
    expect(tail.slice(0, 1500)).not.toContain("resetJobArtifacts");
  });

  it("should report the wrong verdict loudly, since it means the window is too tight", () => {
    expect(RUNNER).toContain("the sweep's verdict was wrong and has been cleared");
  });

  it("should still refuse to START an abandoned job — the terminal guarantee is unchanged", () => {
    // Clearing abandonedAt on completion is about finishing, not starting.
    const QUEUE = fs.readFileSync(path.join(__dirname, "reconciliationQueue.ts"), "utf8");
    expect(QUEUE).toContain("if (state.abandonedAt != null) {");
  });
});

describe("the liveness heartbeat", () => {
  const RUNNER = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
  const DB = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
  const QUEUE = fs.readFileSync(path.join(__dirname, "reconciliationQueue.ts"), "utf8");

  it("should bracket the synchronous matching pass, which no timer can cover", () => {
    // runMatchingEngine blocks the event loop, so the interval cannot fire
    // during it. Bracketing means the window need only cover ONE pass.
    const around = RUNNER.slice(
      RUNNER.indexOf("Beat immediately before and after the matching pass"),
      RUNNER.indexOf("await trackProgress(jobId, \"pass3_tolerance_match\""),
    );
    expect(around.match(/touchReconciliationJobHeartbeat\(jobId\)/g) ?? []).toHaveLength(2);
  });

  it("should beat far more often than the staleness window", () => {
    // A heartbeat slower than the window would let a live run be declared dead
    // between beats — the exact failure it exists to prevent.
    const beat = Number(/RECONCILIATION_HEARTBEAT_MS = (\d+) \* (\d+) \* (\d+)/.exec(RUNNER)!
      .slice(1).reduce((a, b) => String(Number(a) * Number(b))));
    const window = Number(/STUCK_JOB_MAX_AGE_MS = (\d+) \* (\d+) \* (\d+) \* (\d+)/.exec(QUEUE)!
      .slice(1).reduce((a, b) => String(Number(a) * Number(b))));
    expect(beat).toBeLessThan(window / 10);
  });

  it("should run for the whole lifetime of the job and be cleared on every exit", () => {
    // Including the early return when the run was abandoned mid-flight: a
    // heartbeat outliving its run would keep a dead job looking alive.
    expect(RUNNER).toContain("const heartbeat = setInterval(");
    expect(RUNNER).toContain("clearInterval(heartbeat);");
    expect(RUNNER).toMatch(/finally \{[^}]*clearInterval\(heartbeat\);/s);
  });

  it("should never hold the process open", () => {
    expect(RUNNER).toContain('if (typeof heartbeat.unref === "function") heartbeat.unref();');
  });

  it("should not be able to revive a job the sweep already declared dead", () => {
    // Guarded on abandonedAt IS NULL, so the marker stays terminal.
    const fn = DB.slice(DB.indexOf("export async function touchReconciliationJobHeartbeat"));
    expect(fn.slice(0, 500)).toContain("isNull(reconciliationJobs.abandonedAt)");
  });

  it("should leave startedAt alone, so run duration stays truthful", () => {
    const fn = DB.slice(DB.indexOf("export async function touchReconciliationJobHeartbeat"));
    expect(fn.slice(0, 500)).toContain("heartbeatAt: new Date()");
    expect(fn.slice(0, 500)).not.toContain("startedAt");
  });
});
