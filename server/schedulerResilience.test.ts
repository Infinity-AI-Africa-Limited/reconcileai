/**
 * schedulerResilience.test.ts
 * Tests that schedulerTick() recovers from transient DB errors (ECONNRESET, ETIMEDOUT)
 * by calling resetDb() and retrying instead of crashing the scheduler.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the db module ──────────────────────────────────────────────
vi.mock("./db", () => ({
  getDueScheduledTasks: vi.fn(),
  resetDb: vi.fn(),
  // Used by the real executeScheduledTask, so the duplicate-run guard can be
  // exercised through actual behaviour rather than by spying on an internal
  // ESM call (which isn't interceptable).
  getScheduledTaskById: vi.fn(),
  createScheduleRunHistory: vi.fn(),
  updateScheduleRunHistory: vi.fn(),
  createReconciliationJob: vi.fn(),
  updateScheduledTask: vi.fn(),
}));

// ─── Mock executeScheduledTask (internal to schedulingEngine) ────────
// We need to import after mocking so the module picks up our mocks
import * as dbMock from "./db";
import { schedulerTick } from "./schedulingEngine";

// Helper: create an error with a specific code
function makeDbError(code: string): Error {
  const err = new Error(`DB error: ${code}`);
  (err as NodeJS.ErrnoException).code = code;
  return err;
}

// Helper: create a DrizzleQueryError-style error (cause-wrapped)
function makeDrizzleError(code: string): Error {
  const cause = new Error(`read ${code}`);
  (cause as NodeJS.ErrnoException).code = code;
  const err = new Error(`DrizzleQueryError: Failed query`);
  (err as any).cause = cause;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore setTimeout to real implementation for retry delay tests
  vi.useFakeTimers();
});

describe("schedulerTick — DB connection resilience", () => {
  it("succeeds on first attempt when no error", async () => {
    vi.mocked(dbMock.getDueScheduledTasks).mockResolvedValue([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(dbMock.resetDb).not.toHaveBeenCalled();
  });

  it("retries after ECONNRESET and succeeds on second attempt", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDbError("ECONNRESET"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });

  it("retries after ETIMEDOUT and succeeds on second attempt", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDbError("ETIMEDOUT"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });

  it("retries after ECONNREFUSED and succeeds on second attempt", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDbError("ECONNREFUSED"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });

  it("retries after cause-wrapped ECONNRESET (DrizzleQueryError pattern)", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDrizzleError("ECONNRESET"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });

  it("retries after cause-wrapped ETIMEDOUT (DrizzleQueryError pattern)", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDrizzleError("ETIMEDOUT"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });

  it("retries up to MAX_RETRIES (2) times then gives up", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValue(makeDbError("ECONNRESET")); // always fails

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    // 1 initial + 2 retries = 3 total attempts
    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(3);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-transient errors (e.g. SQL syntax error)", async () => {
    const sqlError = new Error("You have an error in your SQL syntax");
    vi.mocked(dbMock.getDueScheduledTasks).mockRejectedValue(sqlError);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    // Only 1 attempt — no retry for non-transient errors
    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(dbMock.resetDb).not.toHaveBeenCalled();
  });

  it("does NOT retry on non-transient errors (e.g. unknown error code)", async () => {
    const unknownErr = makeDbError("SOME_UNKNOWN_CODE");
    vi.mocked(dbMock.getDueScheduledTasks).mockRejectedValue(unknownErr);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(dbMock.resetDb).not.toHaveBeenCalled();
  });

  it("resets DB connection before each retry", async () => {
    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(makeDbError("ECONNRESET"))
      .mockRejectedValueOnce(makeDbError("ETIMEDOUT"))
      .mockResolvedValueOnce([]);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    // 3 attempts total (1 initial + 2 retries), resetDb called before each retry
    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(3);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(2);
  });
});

// ─── Hardening: a retry must not re-run tasks already attempted this tick ────

describe("schedulerTick — duplicate-run guard", () => {
  it("executes a task only once even when its failure path throws mid-outage", async () => {
    // executeScheduledTask handles its own failures, but its FAILURE path also
    // writes to the DB. During the very outage this retry loop exists for,
    // that write throws too and the error escapes — restarting the tick with
    // the task STILL marked due, because neither the success nor the failure
    // write landed. Without the guard the task would run a second time.
    let fetches = 0;
    vi.mocked(dbMock.getDueScheduledTasks).mockImplementation(async () => {
      fetches++;
      return [{ id: 42, name: "shopline-sync-cycle" }] as never;
    });
    vi.mocked(dbMock.getScheduledTaskById).mockResolvedValue({
      id: 42,
      name: "shopline-sync-cycle",
      isActive: true,
      frequency: "daily",
      scheduledTime: "02:00",
      totalRuns: 0,
      failedRuns: 0,
      userId: 1,
    } as never);
    vi.mocked(dbMock.createScheduleRunHistory).mockResolvedValue(1 as never);
    // Job creation fails transiently …
    vi.mocked(dbMock.createReconciliationJob).mockRejectedValue(makeDbError("ECONNRESET"));
    // … and the failure-path write fails too, so the error escapes the task.
    vi.mocked(dbMock.updateScheduledTask).mockRejectedValue(makeDbError("ECONNRESET"));

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(fetches).toBeGreaterThan(1); // the tick did retry …
    // … but the task itself ran exactly once — no duplicate reconciliation job.
    expect(dbMock.createReconciliationJob).toHaveBeenCalledTimes(1);
  });
});

// ─── Hardening: transient codes nested deeper than one `cause` level ─────────

describe("isTransientDbError — deep cause chains", () => {
  it("retries when the transient code is two levels down (Drizzle → mysql2 → socket)", async () => {
    const inner = makeDbError("ECONNRESET");
    const middle = new Error("mysql2 query failed");
    (middle as Error & { cause?: unknown }).cause = inner;
    const outer = new Error("DrizzleQueryError: Failed query");
    (outer as Error & { cause?: unknown }).cause = middle;

    vi.mocked(dbMock.getDueScheduledTasks)
      .mockRejectedValueOnce(outer)
      .mockResolvedValueOnce([] as never);

    const tickPromise = schedulerTick();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(dbMock.getDueScheduledTasks).toHaveBeenCalledTimes(2);
    expect(dbMock.resetDb).toHaveBeenCalledTimes(1);
  });
});
