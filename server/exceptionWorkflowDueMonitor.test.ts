import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, auditMock } = vi.hoisted(() => ({ getDbMock: vi.fn(), auditMock: vi.fn() }));

vi.mock("./db", async importOriginal => ({ ...(await importOriginal<typeof import("./db")>()), getDb: getDbMock }));
vi.mock("./routers/shared", () => ({ logAuditStrict: auditMock }));

import {
  DUE_DATE_ELAPSED_NOTE,
  dueMonitorEnabledHere,
  expireDueExceptionWorkflows,
  startExceptionWorkflowDueMonitor,
  stopExceptionWorkflowDueMonitor,
} from "./exceptionWorkflowDueMonitor";
import { rowOf, scriptedDb, type RecordedOp } from "./connectors/shopify/scriptedDb.testkit";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const candidate = { id: 91, organizationId: 42, exceptionId: 5 };
const openException = { id: 5, status: "in_review" };
const overdueActive = {
  ...candidate,
  dueAt: new Date("2026-10-14T11:59:59.000Z"),
  overdueAt: null,
  approvalRequired: true,
  status: "active" as const,
};

function scripted(workflow: Record<string, unknown> = overdueActive, updateRows = 1) {
  const fake = scriptedDb({
    select: {
      // First, the bounded candidate scan. Then, `expireOne` re-reads and
      // locks this workflow; the same fixture supplies both rows by default.
      exception_workflows: [[candidate], [workflow]],
      exceptions: [[openException]],
    },
    update: { exception_workflows: [updateRows] },
  });
  getDbMock.mockResolvedValue(fake.db);
  return fake;
}

function writes(fake: ReturnType<typeof scripted>, kind: RecordedOp["kind"], table: string) {
  return fake.committed().filter(op => op.kind === kind && op.table === table);
}

beforeEach(() => {
  getDbMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  stopExceptionWorkflowDueMonitor();
});

afterEach(() => stopExceptionWorkflowDueMonitor());

describe("when a governed workflow due date has elapsed", () => {
  it("records one system escalation, keeps the owner, and makes the exception visibly escalated", async () => {
    const fake = scripted();

    await expect(expireDueExceptionWorkflows(NOW)).resolves.toEqual({ scanned: 1, expired: 1 });

    const workflowUpdate = rowOf(writes(fake, "update", "exception_workflows")[0]);
    expect(workflowUpdate).toMatchObject({
      status: "escalated",
      overdueAt: NOW,
      escalatedAt: NOW,
      escalatedByUserId: null,
    });
    // Claim only when neither a prior pass nor a manual workflow write got there first.
    expect(writes(fake, "update", "exception_workflows")[0].where?.params).toEqual([91, 42, "active", "2026-10-14 12:00:00.000"]);
    expect(rowOf(writes(fake, "update", "exceptions")[0])).toEqual({ status: "escalated" });
    expect(rowOf(writes(fake, "insert", "exception_workflow_events")[0])).toMatchObject({
      organizationId: 42,
      workflowId: 91,
      exceptionId: 5,
      eventType: "due_date_elapsed",
      actorUserId: null,
      note: DUE_DATE_ELAPSED_NOTE,
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: null,
      organizationId: 42,
      action: "exception_workflow_due_date_elapsed",
      entityId: 91,
      details: expect.objectContaining({ exceptionId: 5, previousStatus: "active", status: "escalated", approvalInvalidated: false }),
    }));
  });

  it("withdraws an approval made before expiry and requires a later distinct approval", async () => {
    const fake = scripted({
      ...overdueActive,
      status: "approved",
      decisionSubmittedByUserId: 71,
      approvedByUserId: 72,
      approvedAt: new Date("2026-10-14T11:55:00.000Z"),
      approvalNote: "Approved before due time",
    });

    await expect(expireDueExceptionWorkflows(NOW)).resolves.toEqual({ scanned: 1, expired: 1 });

    expect(rowOf(writes(fake, "update", "exception_workflows")[0])).toMatchObject({
      status: "decision_submitted",
      overdueAt: NOW,
      approvedByUserId: null,
      approvedAt: null,
      approvalNote: null,
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ previousStatus: "approved", status: "decision_submitted", approvalInvalidated: true }),
    }));
  });

  it("does not write a duplicate event when a concurrent pass already claimed the workflow", async () => {
    const fake = scripted(overdueActive, 0);

    await expect(expireDueExceptionWorkflows(NOW)).resolves.toEqual({ scanned: 1, expired: 0 });

    expect(writes(fake, "insert", "exception_workflow_events")).toEqual([]);
    expect(writes(fake, "update", "exceptions")).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("does nothing when the re-read workflow is not due yet", async () => {
    const fake = scripted({ ...overdueActive, dueAt: new Date("2026-10-14T12:00:00.001Z") });

    await expect(expireDueExceptionWorkflows(NOW)).resolves.toEqual({ scanned: 1, expired: 0 });

    expect(writes(fake, "update", "exception_workflows")).toEqual([]);
    expect(writes(fake, "insert", "exception_workflow_events")).toEqual([]);
  });
});

describe("when the due monitor is started", () => {
  it("runs only in the deployed production service", () => {
    expect(dueMonitorEnabledHere({ VITEST: "true", NODE_ENV: "production" })).toEqual({ enabled: false, reason: "test process" });
    expect(dueMonitorEnabledHere({ NODE_ENV: "development" })).toEqual({ enabled: false, reason: "not a production service" });
    expect(dueMonitorEnabledHere({ NODE_ENV: "production" })).toEqual({ enabled: true, reason: "production service" });
  });

  it("does not create a timer in a test or development process", () => {
    vi.useFakeTimers();
    expect(startExceptionWorkflowDueMonitor({ VITEST: "true", NODE_ENV: "production" })).toBeNull();
    expect(startExceptionWorkflowDueMonitor({ NODE_ENV: "development" })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
