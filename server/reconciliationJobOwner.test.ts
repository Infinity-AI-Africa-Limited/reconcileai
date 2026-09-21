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
import { readFileSync } from "node:fs";
import path from "node:path";

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
import { runTenant } from "./routers/reconciliation";

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

describe("when a user starts a reconciliation run", () => {
  it("should own it under their organisation", () => {
    expect(runTenant({ organizationId: 30001 })).toBe(30001);
  });

  it("should refuse a user with no organisation rather than create an ownerless run", () => {
    // No organisation is not an unknown tenant; it is no tenant (CLAUDE.md §9C).
    expect(() => runTenant({ organizationId: null })).toThrow(/not linked to an organisation/);
  });
});

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

describe("when a caller names channels for a run or a schedule", () => {
  const read = (f: string) => readFileSync(path.resolve(__dirname, f), "utf8").replace(/\r\n/g, "\n");

  it("should look every one up under the owner, never by id alone", () => {
    // A caller-supplied channel id resolved without the tenant is the
    // cross-tenant read this closes.
    const recon = read("routers/reconciliation.ts");
    expect(recon).not.toMatch(/getChannelById\(/);
    expect(recon.match(/getChannelByIdForOrg\([^)]*tenant\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    const routers = read("routers.ts");
    const start = routers.indexOf("    create: guestProtectedProcedure\n      .input(z.object({\n        name: z.string().min(1).max(MAX_NAME_LENGTH),\n        description");
    expect(start, "schedules.create has moved").toBeGreaterThan(-1);
    const block = routers.slice(start, routers.indexOf("await logAudit(ctx.user.id, \"create_schedule\"", start));
    expect(block).not.toMatch(/getChannelById\(/);
    expect(block).toMatch(/organizationId: tenant/);
  });
});
