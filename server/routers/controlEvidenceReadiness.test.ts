import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  assess: vi.fn(),
}));

// Only the database-backed assessment is replaced: the governed-admission
// rules the preflight now reports run for real, business-day window included.
vi.mock("../controlRunReadiness", async importOriginal => ({
  ...(await importOriginal<typeof import("../controlRunReadiness")>()),
  assessPersistedControlRun: state.assess,
}));

import { controlEvidenceRouter } from "./controlEvidence";

const organizationId = 42;

const caller = (role = "operations", isGuest = false) =>
  controlEvidenceRouter.createCaller({
    user: { id: 7, role, organizationId, isGuest, isReadOnly: false },
    viewingAs: null,
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
  } as never);

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof TRPCError
      ? error
      : new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: String(error),
        });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.assess.mockResolvedValue({
    status: "ready_to_reconcile",
    canReconcile: true,
    mayPublishMatchRate: true,
    reasons: [],
    sourceAssessments: [],
    organizationId,
    controlPeriod: "2026-10-09",
    evaluatedAt: new Date("2026-10-09T17:05:00.000Z"),
    persistenceReasons: [],
    sourceContractCount: 1,
    batchManifestCount: 1,
    reconciliationPolicyVersions: ["reconciliation-v1"],
    // Ready to the completeness policy, but only one source: no internal
    // register for a governed run to reconcile it against.
    sourceContractBindings: [
      {
        id: 41,
        sourceKey: "switch-settlement",
        role: "settlement",
        version: 1,
        channelId: 101,
        timeZone: "Africa/Lagos",
        manifestId: 71,
        uploadBatchId: 88,
      },
    ],
  });
});

describe("when a tenant asks whether their control day is ready", () => {
  it("should evaluate only the caller's tenant and remain a query boundary", async () => {
    const result = await caller().assessReadiness({
      controlPeriod: "2026-10-09",
    });

    expect(state.assess).toHaveBeenCalledWith({
      organizationId,
      controlPeriod: "2026-10-09",
    });
    expect(result).toMatchObject({
      status: "ready_to_reconcile",
      canReconcile: true,
      mayPublishMatchRate: true,
    });
    expect(state.assess).toHaveBeenCalledTimes(1);
  });

});

describe("when the evidence is ready but a governed run could not be admitted", () => {
  it("should say so in the preflight, with the same rule admission enforces", async () => {
    // The case Daily Control used to offer Start for, and then fail every click.
    const result = await caller().assessReadiness({ controlPeriod: "2026-10-09" });

    expect(result.canReconcile).toBe(true);
    expect(result.governedAdmission).toEqual({
      admissible: false,
      reasons: ["internal_register_source_count"],
    });
  });
});

describe("when the caller names another organisation", () => {
  it("should reject it before asking the readiness service for evidence", async () => {
    const refusal = await failureOf(() =>
      caller().assessReadiness({
        organizationId: 60001,
        controlPeriod: "2026-10-09",
      })
    );

    expect(refusal?.code).toBe("FORBIDDEN");
    expect(state.assess).not.toHaveBeenCalled();
  });

});

describe("when the control period is not a real calendar day", () => {
  it("should reject it before querying stored evidence", async () => {
    const refusal = await failureOf(() =>
      caller().assessReadiness({ controlPeriod: "2026-02-30" })
    );

    expect(refusal?.code).toBe("BAD_REQUEST");
    expect(state.assess).not.toHaveBeenCalled();
  });
});
