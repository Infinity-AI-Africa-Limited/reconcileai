import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { createMock, listMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock("../controlPolicyStore", () => ({
  createControlPolicy: createMock,
  approveControlPolicy: vi.fn(),
  activateControlPolicy: vi.fn(),
  retireControlPolicy: vi.fn(),
  listControlPolicies: listMock,
}));

import { controlPoliciesRouter } from "./controlPolicies";

const baseCtx = {
  user: {
    id: 7,
    role: "operations",
    organizationId: 42,
    isGuest: false,
    isReadOnly: false,
    email: "ops@example.com",
  },
  req: { headers: {}, ip: "127.0.0.1" },
  res: {},
};

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null }),
    error => ({ code: error instanceof TRPCError ? error.code : "UNKNOWN" })
  );
}

describe("controlPolicies router", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ id: 1, status: "draft" });
    listMock
      .mockReset()
      .mockResolvedValue({ organizationId: 42, rows: [], hasMore: false });
  });

  it("passes an org-scoped draft creation request to the immutable registry", async () => {
    const caller = controlPoliciesRouter.createCaller(baseCtx as never);
    await expect(
      caller.createDraft({
        policyType: "mapping",
        policyKey: "settlement-csv-v1",
        version: 1,
        displayName: "Settlement CSV mapping",
        description: "Maps approved settlement columns.",
        definition: { transactionReference: "reference" },
        effectiveAt: "2026-10-13T00:00:00.000Z",
      })
    ).resolves.toEqual({ id: 1, status: "draft" });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 42 })
    );
  });

  it("refuses a guest policy write before invoking storage", async () => {
    const caller = controlPoliciesRouter.createCaller({
      ...baseCtx,
      user: { ...baseCtx.user, isGuest: true },
    } as never);
    const result = await failureOf(() =>
      caller.createDraft({
        policyType: "mapping",
        policyKey: "settlement-csv-v1",
        version: 1,
        displayName: "Settlement CSV mapping",
        description: "Maps approved settlement columns.",
        definition: {},
        effectiveAt: "2026-10-13T00:00:00.000Z",
      })
    );
    expect(result).toEqual({ code: "FORBIDDEN" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("keeps read-only listing tenant-scoped", async () => {
    const caller = controlPoliciesRouter.createCaller(baseCtx as never);
    await caller.list({ policyType: "reconciliation" });
    expect(listMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ policyType: "reconciliation" })
    );
  });
});
