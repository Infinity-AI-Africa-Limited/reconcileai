import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  assess: vi.fn(),
}));

vi.mock("../controlRunReadiness", () => ({
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
    sourceContractCount: 2,
    batchManifestCount: 2,
  });
});

describe("controlEvidence.assessReadiness", () => {
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

  it("should reject another tenant before it asks the readiness service for evidence", async () => {
    const refusal = await failureOf(() =>
      caller().assessReadiness({
        organizationId: 60001,
        controlPeriod: "2026-10-09",
      })
    );

    expect(refusal?.code).toBe("FORBIDDEN");
    expect(state.assess).not.toHaveBeenCalled();
  });

  it("should reject a non-calendar control period before it queries stored evidence", async () => {
    const refusal = await failureOf(() =>
      caller().assessReadiness({ controlPeriod: "2026-02-30" })
    );

    expect(refusal?.code).toBe("BAD_REQUEST");
    expect(state.assess).not.toHaveBeenCalled();
  });
});
