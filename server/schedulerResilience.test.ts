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
