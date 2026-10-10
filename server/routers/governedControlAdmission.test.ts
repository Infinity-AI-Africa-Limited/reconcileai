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
  })),
}));
vi.mock("./shared", async importOriginal => ({
  ...(await importOriginal<typeof import("./shared")>()),
  assertModuleAvailable: vi.fn(async () => {}),
  logAudit: vi.fn(async () => {}),
}));

import * as db from "../db";
import { requireGovernedControlAdmission } from "../controlRunAdmission";
import { enqueueReconciliationRun } from "../reconciliationQueue";
import { reconciliationRouter } from "./reconciliation";

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
  vi.mocked(db.createReconciliationJob).mockResolvedValue(501);
});

describe("governed daily-control reconciliation admission", () => {
  it("derives channels and the business-day window from readiness evidence", async () => {
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

  it("will not create a job when the derived channel is no longer tenant-visible", async () => {
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
