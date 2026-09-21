/**
 * Every reconciliation run has an owner, and reads only that owner's channels.
 *
 * Both run procedures and the scheduler created jobs with no organisation.
 * runReconciliation refuses such a job, so every run started from the UI or a
 * schedule failed — while the demo tenants, whose runs the seeders insert
 * directly, looked healthy. The same call sites looked channels up by id
 * alone, and the missing owner was the only thing stopping a run over another
 * tenant's channel. These tests pin the owner and the channel scope together.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getScheduledTaskById: vi.fn(),
  createScheduleRunHistory: vi.fn(async () => 1),
  updateScheduleRunHistory: vi.fn(),
  createReconciliationJob: vi.fn(async () => 99),
  updateScheduledTask: vi.fn(),
  getChannelByIdForOrg: vi.fn(async (id: number) => ({ id })),
}));
import * as dbMock from "./db";
import { executeScheduledTask } from "./schedulingEngine";

const task = (over: Record<string, unknown> = {}) =>
  ({
    id: 5, name: "nightly", isActive: true, frequency: "daily", scheduledTime: "02:00", totalRuns: 0, successfulRuns: 0,
    failedRuns: 0, userId: 3, organizationId: 7, sourceChannelId: 11, targetChannelId: 12, lookbackDays: 1,
    amountTolerance: "0.005", dateWindowDays: 3, ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// The run procedures and schedules.create are covered at procedure level in
// server/routers/reconciliationOwner.test.ts. This file covers the scheduler.

describe("when a schedule creates a run", () => {
  it("should create it under the task's own organisation, after checking the task's channels are its own", async () => {
    vi.mocked(dbMock.getScheduledTaskById).mockResolvedValue(task());
    const result = await executeScheduledTask(5);
    expect(result).toMatchObject({ success: true, jobId: 99 });
    expect(dbMock.getChannelByIdForOrg).toHaveBeenCalledWith(11, 7);
    expect(dbMock.getChannelByIdForOrg).toHaveBeenCalledWith(12, 7);
    expect(vi.mocked(dbMock.createReconciliationJob).mock.calls[0][0]).toMatchObject({ organizationId: 7, userId: 3 });
  });

  it("should fail visibly, creating nothing, when the task has no organisation", async () => {
    vi.mocked(dbMock.getScheduledTaskById).mockResolvedValue(task({ organizationId: null }));
    expect((await executeScheduledTask(5)).success).toBe(false);
    expect(dbMock.createReconciliationJob).not.toHaveBeenCalled();
  });

  it("should fail, creating nothing, when a channel is not the task's organisation's", async () => {
    vi.mocked(dbMock.getScheduledTaskById).mockResolvedValue(task());
    vi.mocked(dbMock.getChannelByIdForOrg).mockImplementation(async (id: number) => (id === 12 ? undefined : ({ id }) as never));
    expect((await executeScheduledTask(5)).success).toBe(false);
    expect(dbMock.createReconciliationJob).not.toHaveBeenCalled();
  });
});
