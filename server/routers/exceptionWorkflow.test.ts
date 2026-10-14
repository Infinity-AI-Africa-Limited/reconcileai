import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const service = vi.hoisted(() => ({
  getExceptionWorkflow: vi.fn(),
  listExceptionWorkflowOwners: vi.fn(),
  startExceptionWorkflow: vi.fn(),
  updateExceptionWorkflowOwnership: vi.fn(),
  escalateExceptionWorkflow: vi.fn(),
  recordExceptionWorkflowDecision: vi.fn(),
  approveExceptionWorkflowDecision: vi.fn(),
  resolveExceptionWorkflow: vi.fn(),
}));

vi.mock("../exceptionWorkflow", () => service);

import { exceptionWorkflowRouter } from "./exceptionWorkflow";

type User = {
  id: number;
  role: string;
  organizationId: number | null;
  isGuest: boolean;
  isReadOnly: boolean;
  email: string;
};

const operations: User = {
  id: 7,
  role: "operations",
  organizationId: 42,
  isGuest: false,
  isReadOnly: false,
  email: "ops@example.com",
};

function callerAs(user: User, viewingAs: number | null = null) {
  return exceptionWorkflowRouter.createCaller({
    user,
    viewingAs,
    req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" },
    res: {},
  } as never);
}

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error =>
      error instanceof TRPCError
        ? { code: error.code, message: error.message }
        : { code: "UNKNOWN", message: String(error) }
  );
}

beforeEach(() => {
  for (const fn of Object.values(service))
    fn.mockReset().mockResolvedValue({ ok: true });
});

describe("when an operations owner starts a governed exception workflow", () => {
  it("passes parsed tenant-scoped inputs and request context to the workflow service", async () => {
    await expect(
      callerAs(operations).start({
        exceptionId: 5,
        ownerUserId: 8,
        dueAt: "2026-10-15T12:00:00.000Z",
        approvalRequired: true,
      })
    ).resolves.toEqual({ ok: true });

    expect(service.startExceptionWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 42,
        exceptionId: 5,
        ownerUserId: 8,
        dueAt: new Date("2026-10-15T12:00:00.000Z"),
        approvalRequired: true,
        actor: expect.objectContaining({ id: 7 }),
        client: expect.objectContaining({ ua: "vitest" }),
      })
    );
  });
});

describe("when an unauthorised account attempts workflow mutations", () => {
  const denied: ReadonlyArray<readonly [string, User]> = [
    ["guest", { ...operations, isGuest: true }],
    ["CFO", { ...operations, role: "cfo" }],
    ["compliance", { ...operations, role: "compliance" }],
    ["ordinary user", { ...operations, role: "user" }],
  ];

  for (const [label, user] of denied) {
    it(`refuses ${label} before the service is reached`, async () => {
      await expect(
        failureOf(() =>
          callerAs(user).start({
            exceptionId: 5,
            ownerUserId: 8,
            dueAt: "2026-10-15T12:00:00.000Z",
            approvalRequired: true,
          })
        )
      ).resolves.toMatchObject({ code: "FORBIDDEN" });
      expect(service.startExceptionWorkflow).not.toHaveBeenCalled();
    });
  }
});

describe("when a workflow decision is approved", () => {
  it("uses the caller tenant rather than a client-selected one", async () => {
    await callerAs(operations).approveDecision({
      exceptionId: 5,
      approvalNote: "Independent review completed.",
    });
    expect(service.approveExceptionWorkflowDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 42,
        exceptionId: 5,
        approvalNote: "Independent review completed.",
      })
    );
  });

  it("refuses an ordinary user attempting to choose another tenant", async () => {
    await expect(
      failureOf(() =>
        callerAs({ ...operations, role: "user" }).get({
          organizationId: 99,
          exceptionId: 5,
        })
      )
    ).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(service.getExceptionWorkflow).not.toHaveBeenCalled();
  });

  it("uses the portal tenant for a super-admin query and keeps that tenant in the cache input", async () => {
    await callerAs({ ...operations, role: "super_admin", organizationId: null }).get({
      viewAsOrgId: 99,
      exceptionId: 5,
    });

    expect(service.getExceptionWorkflow).toHaveBeenCalledWith(99, 5);
  });
});
