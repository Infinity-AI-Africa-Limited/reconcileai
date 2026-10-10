import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
  getChannelByIdForOrg: vi.fn(),
  createReconciliationJob: vi.fn(),
  abandonUnstartedReconciliationJob: vi.fn(),
}));
vi.mock("../reconciliationQueue", () => ({
  assertReconciliationQueueAvailable: vi.fn(async () => {}),
  enqueueReconciliationRun: vi.fn(async () => {}),
}));
vi.mock("../controlRunAdmission", () => ({
  GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE: 0.005,
  requireGovernedControlAdmission: vi.fn(async () => ({
    controlPeriod: "2026-10-09",
    assessedAt: "2026-10-10T08:00:00.000Z",
    sourceChannelId: 11,
    targetChannelId: 12,
    dateFrom: new Date("2026-10-08T23:00:00.000Z"),
    dateTo: new Date("2026-10-09T22:59:59.999Z"),
    sourceContractCount: 2,
    batchManifestCount: 2,
    reconciliationPolicyVersions: ["settlement-ledger-v1"],
    settlement: { channelId: 11, manifestId: 701, uploadBatchId: 901 },
    register: { channelId: 12, manifestId: 702, uploadBatchId: 902 },
  })),
}));
vi.mock("./shared", async importOriginal => ({
  ...(await importOriginal<typeof import("./shared")>()),
  assertModuleAvailable: vi.fn(async () => {}),
  logAudit: vi.fn(async () => {}),
  logAuditStrict: vi.fn(async () => {}),
}));

import * as db from "../db";
import { requireGovernedControlAdmission } from "../controlRunAdmission";
import { enqueueReconciliationRun } from "../reconciliationQueue";
import { reconciliationRouter } from "./reconciliation";
import { logAudit, logAuditStrict } from "./shared";

const TENANT = 30001;
const caller = () =>
  reconciliationRouter.createCaller({
    user: {
      id: 7,
      role: "operations",
      organizationId: TENANT,
      isGuest: false,
      isReadOnly: false,
      openId: "t",
      name: "t",
      email: "t@t",
    },
    req: { headers: {}, socket: {} },
    res: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getChannelByIdForOrg).mockImplementation(
    async (id: number, organizationId: number | null) =>
      organizationId === TENANT && (id === 11 || id === 12)
        ? ({
            id,
            code: `C${id}`,
            name: `Channel ${id}`,
            isActive: true,
          } as never)
        : undefined
  );
  vi.mocked(db.createReconciliationJob).mockImplementation(async (_data, options) => {
    await options?.inTransaction?.(FAKE_TX as never, 501);
    return 501;
  });
});

/** Stands in for the job insert's transaction, so the audit's executor can be identified. */
const FAKE_TX = { name: "job-insert-transaction" };

describe("when a ready daily control is admitted", () => {
  it("should derive the channels and the business-day window from readiness evidence", async () => {
    await expect(
      caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" })
    ).resolves.toEqual({ jobId: 501, controlPeriod: "2026-10-09" });

    expect(requireGovernedControlAdmission).toHaveBeenCalledWith({
      organizationId: TENANT,
      controlPeriod: "2026-10-09",
    });
    expect(db.getChannelByIdForOrg).toHaveBeenCalledWith(11, TENANT);
    expect(db.getChannelByIdForOrg).toHaveBeenCalledWith(12, TENANT);
    expect(
      vi.mocked(db.createReconciliationJob).mock.calls[0]?.[0]
    ).toMatchObject({
      organizationId: TENANT,
      sourceChannelId: 11,
      targetChannelId: 12,
      dateWindowDays: 0,
      dateFrom: new Date("2026-10-08T23:00:00.000Z"),
      dateTo: new Date("2026-10-09T22:59:59.999Z"),
    });
    expect(enqueueReconciliationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChannelId: 11,
        targetChannelId: 12,
        config: { amountTolerance: 0.005, dateWindowDays: 0 },
      })
    );
  });

  it("should bind the job to the approved batches, by identifier only", async () => {
    await caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" });

    const engineConfig = JSON.parse(
      String(vi.mocked(db.createReconciliationJob).mock.calls[0]?.[0].engineConfig)
    );
    expect(engineConfig.governedDailyControl).toMatchObject({
      settlement: { channelId: 11, manifestId: 701, uploadBatchId: 901 },
      register: { channelId: 12, manifestId: 702, uploadBatchId: 902 },
    });
    // No monetary value travels into job configuration.
    expect(JSON.stringify(engineConfig)).not.toMatch(/Total|amount"?:s*"?d+.d{2}/);
  });

  it("should record the admission in the tenant's trail inside the job's own transaction", async () => {
    await caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" });

    expect(logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create_governed_daily_control_run",
        organizationId: TENANT,
        entityId: 501,
        executor: FAKE_TX,
      })
    );
    // The lenient logger, which swallows its own failure, is not the record.
    expect(logAudit).not.toHaveBeenCalled();
    // Committed before anything is queued.
    expect(vi.mocked(logAuditStrict).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(enqueueReconciliationRun).mock.invocationCallOrder[0]
    );
  });
});

describe("when the admission event cannot be recorded", () => {
  it("should admit no run: the job rolls back with the audit, and nothing is queued", async () => {
    vi.mocked(logAuditStrict).mockRejectedValueOnce(new Error("audit chain unavailable"));

    await expect(
      caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" })
    ).rejects.toThrow();
    expect(enqueueReconciliationRun).not.toHaveBeenCalled();
  });
});

describe("when admission refuses the day", () => {
  it("should create no job and queue nothing", async () => {
    vi.mocked(requireGovernedControlAdmission).mockRejectedValueOnce(new Error("Daily control is not ready for reconciliation."));

    await expect(
      caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" })
    ).rejects.toThrow("Daily control is not ready for reconciliation.");
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
    expect(enqueueReconciliationRun).not.toHaveBeenCalled();
  });
});

describe("when an approved channel is no longer visible to the tenant", () => {
  it("should create no job", async () => {
    vi.mocked(db.getChannelByIdForOrg)
      .mockResolvedValueOnce({
        id: 11,
        code: "C11",
        name: "Channel 11",
        isActive: true,
      } as never)
      .mockResolvedValueOnce(undefined);

    await expect(
      caller().createGovernedDailyControl({ controlPeriod: "2026-10-09" })
    ).rejects.toThrow("Approved register channel not found");
    expect(db.createReconciliationJob).not.toHaveBeenCalled();
    expect(enqueueReconciliationRun).not.toHaveBeenCalled();
  });
});
