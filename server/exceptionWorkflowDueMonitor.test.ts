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
const MISSED = new Date("2026-10-14T11:59:59.000Z");
const candidate = { id: 91, organizationId: 42, exceptionId: 5 };
const openException = { id: 5, status: "in_review" };
const overdueActive = {
  ...candidate,
  ownerUserId: 8,
  dueAt: MISSED,
  overdueAt: null,
  approvalRequired: true,
  status: "active" as const,
};

function scripted(workflow: Record<string, unknown> = overdueActive, updateRows = 1, exception: Record<string, unknown> = openException) {
  const fake = scriptedDb({
    select: {
      // First, the bounded candidate scan. Then, `expireOne` re-reads and
      // locks this workflow; the same fixture supplies both rows by default.
      exception_workflows: [[candidate], [workflow]],
      exceptions: [[exception]],
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

afterEach(() => {
  stopExceptionWorkflowDueMonitor();
  vi.restoreAllMocks();
});

describe("when a governed workflow due date has elapsed", () => {
  it("should record one system escalation, keep the owner, and make the exception visibly escalated", async () => {
    const fake = scripted();

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 1, failed: 0 });

    const workflowUpdate = rowOf(writes(fake, "update", "exception_workflows")[0]);
    expect(workflowUpdate).toEqual({
      status: "escalated",
      overdueAt: NOW,
      escalatedAt: NOW,
      escalatedByUserId: null,
      escalationNote: DUE_DATE_ELAPSED_NOTE,
    });
    // Claim only when neither a prior pass nor a manual workflow write got there first.
    expect(writes(fake, "update", "exception_workflows")[0].where?.params).toEqual([91, 42, "active", "2026-10-14 12:00:00.000"]);
    expect(rowOf(writes(fake, "update", "exceptions")[0])).toEqual({ status: "escalated" });
    expect(rowOf(writes(fake, "insert", "exception_workflow_events")[0])).toEqual({
      organizationId: 42,
      workflowId: 91,
      exceptionId: 5,
      eventType: "due_date_elapsed",
      actorUserId: null,
      note: DUE_DATE_ELAPSED_NOTE,
      // The deadline that was missed and who owned it then — the row's own
      // owner and due date can change afterwards.
      ownerUserId: 8,
      dueAt: MISSED,
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: null,
      organizationId: 42,
      action: "exception_workflow_due_date_elapsed",
      entityId: 91,
      details: {
        exceptionId: 5,
        dueAt: MISSED.toISOString(),
        ownerUserId: 8,
        previousStatus: "active",
        status: "escalated",
        approvalInvalidated: false,
        trigger: "due_monitor",
      },
    }));
  });

  it("should withdraw an approval made before expiry and require a later distinct approval", async () => {
    const fake = scripted({
      ...overdueActive,
      status: "approved",
      decisionSubmittedByUserId: 71,
      approvedByUserId: 72,
      approvedAt: new Date("2026-10-14T11:55:00.000Z"),
      approvalNote: "Approved before due time",
    });

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 1, failed: 0 });

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

  it("should not write a duplicate event when a concurrent pass already claimed the workflow", async () => {
    const fake = scripted(overdueActive, 0);

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 0, failed: 0 });

    expect(writes(fake, "insert", "exception_workflow_events")).toEqual([]);
    expect(writes(fake, "update", "exceptions")).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("should do nothing when the re-read workflow is not due yet", async () => {
    const fake = scripted({ ...overdueActive, dueAt: new Date("2026-10-14T12:00:00.001Z") });

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 0, failed: 0 });

    expect(writes(fake, "update", "exception_workflows")).toEqual([]);
    expect(writes(fake, "insert", "exception_workflow_events")).toEqual([]);
  });

  it("should do nothing when a workflow write recorded the deadline between the scan and the lock", async () => {
    const fake = scripted({ ...overdueActive, status: "escalated", overdueAt: new Date("2026-10-14T11:59:59.500Z") });

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 0, failed: 0 });

    expect(writes(fake, "update", "exception_workflows")).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("should record the deadline but leave an exception closed some other way closed", async () => {
    // The control escalates open work. Flipping a resolved exception back to
    // "escalated" would reopen a case nobody asked to reopen.
    const fake = scripted(overdueActive, 1, { id: 5, status: "resolved" });

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 1, expired: 1, failed: 0 });

    expect(writes(fake, "update", "exceptions")).toEqual([]);
    expect(writes(fake, "insert", "exception_workflow_events")).toHaveLength(1);
  });
});

describe("when one overdue workflow cannot be recorded", () => {
  it("should still record the others and report the failure, so one bad row cannot block every deadline behind it", async () => {
    // The scan is ordered by due date: a row that fails every time is first in
    // every batch, and used to end each pass before any row behind it.
    const second = { id: 92, organizationId: 43, exceptionId: 6 };
    const fake = scriptedDb({
      select: {
        exception_workflows: [[candidate, second], [{ ...overdueActive, ...second }]],
        exceptions: [new Error("Deadlock found when trying to get lock"), [{ id: 6, status: "open" }]],
      },
    });
    getDbMock.mockResolvedValue(fake.db);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(expireDueExceptionWorkflows({ now: NOW })).resolves.toEqual({ scanned: 2, expired: 1, failed: 1 });

    expect(writes(fake, "insert", "exception_workflow_events").map(op => rowOf(op)?.workflowId)).toEqual([92]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("could not record an elapsed due date"),
      expect.objectContaining({ workflowId: 91, organizationId: 42 })
    );
  });
});

describe("when a sweep is limited to one tenant", () => {
  it("should scan only that tenant's workflows", async () => {
    const fake = scripted();

    await expireDueExceptionWorkflows({ now: NOW, organizationId: 42 });

    const scan = fake.ops.find(op => op.kind === "select" && op.table === "exception_workflows" && !op.locked);
    expect(scan?.where?.sql).toMatch(/`exception_workflows`\.`organizationId` = \?/);
    expect(scan?.where?.params.at(-1)).toBe(42);
  });

  it("should scan every tenant when no tenant is named", async () => {
    const fake = scripted();

    await expireDueExceptionWorkflows({ now: NOW });

    const scan = fake.ops.find(op => op.kind === "select" && op.table === "exception_workflows" && !op.locked);
    expect(scan?.where?.sql).not.toMatch(/organizationId/);
  });
});

describe("when the due monitor is started", () => {
  it("should run only in the deployed production service", () => {
    expect(dueMonitorEnabledHere({ VITEST: "true", NODE_ENV: "production" })).toEqual({ enabled: false, reason: "test process" });
    expect(dueMonitorEnabledHere({ NODE_ENV: "development" })).toEqual({ enabled: false, reason: "not a production service" });
    expect(dueMonitorEnabledHere({ NODE_ENV: "production" })).toEqual({ enabled: true, reason: "production service" });
  });

  it("should not create a timer in a test or development process", () => {
    vi.useFakeTimers();
    try {
      expect(startExceptionWorkflowDueMonitor({ VITEST: "true", NODE_ENV: "production" })).toBeNull();
      expect(startExceptionWorkflowDueMonitor({ NODE_ENV: "development" })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
