/**
 * The governed exception workflow against a scripted database: every write's
 * lock order, conditions, evidence rows and audit events. The same rules on a
 * real MySQL — the legacy close blocking behind a Start's lock, history
 * surviving revisions — are proven in exceptionWorkflow.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { getDbMock, auditMock } = vi.hoisted(() => ({ getDbMock: vi.fn(), auditMock: vi.fn() }));

vi.mock("./db", async importOriginal => ({ ...(await importOriginal<typeof import("./db")>()), getDb: getDbMock }));
vi.mock("./routers/shared", () => ({ logAuditStrict: auditMock }));

import {
  approveExceptionWorkflowDecision,
  closeExceptionOutsideWorkflow,
  escalateExceptionWorkflow,
  getExceptionWorkflow,
  recordExceptionWorkflowDecision,
  resolveExceptionWorkflow,
  startExceptionWorkflow,
  updateExceptionWorkflowOwnership,
} from "./exceptionWorkflow";
import { rowOf, scriptedDb, type RecordedOp } from "./connectors/shopify/scriptedDb.testkit";

const actor = { id: 71, role: "operations", organizationId: 42 };
const approver = { id: 72, role: "operations", organizationId: 42 };
const client = { ip: "127.0.0.1", ua: "exception-workflow-test" };
const NOW = new Date("2026-10-14T12:00:00.000Z");
const dueAt = new Date("2026-10-15T12:00:00.000Z");
/** A deadline that passed an hour before NOW and that nothing has recorded yet. */
const MISSED = new Date("2026-10-14T11:00:00.000Z");
const openException = { id: 5, status: "in_review" };
const workflowRow = {
  id: 91,
  organizationId: 42,
  exceptionId: 5,
  attemptNumber: 1,
  ownerUserId: 8,
  dueAt,
  overdueAt: null as Date | null,
  approvalRequired: true,
  status: "active" as const,
  decisionSubmittedByUserId: null as number | null,
};
const base = { organizationId: 42, exceptionId: 5, client };

function scripted(rows: { exception?: unknown[]; workflow?: unknown[]; users?: unknown[]; events?: unknown[] } = {}) {
  const fake = scriptedDb({
    standing: {
      exceptions: rows.exception ?? [openException],
      exception_workflows: rows.workflow ?? [workflowRow],
      users: rows.users ?? [{ id: 8 }],
      exception_workflow_events: rows.events ?? [],
    },
  });
  getDbMock.mockResolvedValue(fake.db);
  return fake;
}

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error => (error instanceof TRPCError ? { code: error.code, message: error.message } : { code: "UNKNOWN", message: String(error) })
  );
}

/** The tables a call locked, in order. */
const lockOrder = (ops: RecordedOp[]) => ops.filter(op => op.kind === "select" && op.locked).map(op => op.table);
const noWrites = (fake: ReturnType<typeof scripted>) => fake.ops.filter(op => op.kind !== "select" && op.table !== "audit_logs");

beforeEach(() => {
  getDbMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("when a material exception enters a governed workflow", () => {
  it("should lock the exception, then its latest workflow, and nothing else", async () => {
    const fake = scripted({ workflow: [] });
    await startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true });

    expect(lockOrder(fake.ops)).toEqual(["exceptions", "exception_workflows"]);
    expect(fake.ops.find(op => op.table === "users")?.locked).toBe(false);
    expect(fake.ops.some(op => op.table === "organizations")).toBe(false);
  });

  it("should store owner, due date, approval rule, its first history event and audit in one transaction", async () => {
    const fake = scripted({ workflow: [] });
    await expect(
      startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true })
    ).resolves.toEqual({ id: 1000, status: "active", attemptNumber: 1 });

    expect(rowOf(fake.writes("insert", "exception_workflows")[0])).toMatchObject({
      organizationId: 42, exceptionId: 5, attemptNumber: 1, ownerUserId: 8, dueAt, approvalRequired: true, status: "active", startedByUserId: 71,
    });
    expect(rowOf(fake.writes("update", "exceptions")[0])).toMatchObject({ assignedTo: 8, assignedBy: 71, status: "in_review" });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({
      organizationId: 42, workflowId: 1000, exceptionId: 5, eventType: "started", actorUserId: 71, ownerUserId: 8, dueAt,
    });
    expect(new Set(fake.ops.filter(op => op.kind !== "select").map(op => op.txId)).size).toBe(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "exception_workflow_started", organizationId: 42 }));
  });

  it("should refuse a due date that has passed before reading anything", async () => {
    expect(
      await failureOf(() => startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt: new Date("2026-10-14T11:59:59.000Z"), approvalRequired: true }))
    ).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/future/) });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("should refuse an exception whose workflow is still in progress", async () => {
    const fake = scripted();
    expect(await failureOf(() => startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true }))).toMatchObject({ code: "CONFLICT" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse a closed exception", async () => {
    const fake = scripted({ exception: [{ id: 5, status: "resolved" }], workflow: [] });
    expect(await failureOf(() => startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should answer another tenant's exception as not found", async () => {
    const fake = scripted({ exception: [] });
    expect(await failureOf(() => startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true }))).toEqual({
      code: "NOT_FOUND", message: "Exception not found",
    });
    expect(fake.ops[0].where?.params).toEqual([5, 42]);
  });

  it("should start the next attempt on a reopened exception whose attempt closed", async () => {
    const fake = scripted({ exception: [{ id: 5, status: "open" }], workflow: [{ ...workflowRow, status: "closed" }] });
    await expect(startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: false })).resolves.toMatchObject({ attemptNumber: 2 });
    expect(rowOf(fake.writes("insert", "exception_workflows")[0])).toMatchObject({ attemptNumber: 2 });
  });

  it("should refuse an owner who is not an active, non-guest, non-reviewer member of the tenant", async () => {
    const fake = scripted({ workflow: [], users: [] });
    expect(await failureOf(() => startExceptionWorkflow({ ...base, actor, ownerUserId: 8, dueAt, approvalRequired: true }))).toMatchObject({ code: "NOT_FOUND" });
    const ownerRead = fake.ops.find(op => op.table === "users");
    expect(ownerRead?.where?.sql).toMatch(/`isGuest` = \?.*`isReadOnly` = \?/);
    expect(ownerRead?.where?.params).toEqual([8, 42, true, false, false]);
    expect(noWrites(fake)).toEqual([]);
  });
});

describe("when a workflow's owner or due date changes", () => {
  it("should take the same locks in the same order, then record the change", async () => {
    const fake = scripted();
    await expect(
      updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt })
    ).resolves.toEqual({ id: 91, ownerUserId: 9, dueAt });

    expect(lockOrder(fake.ops)).toEqual(["exceptions", "exception_workflows"]);
    const update = fake.writes("update", "exception_workflows")[0];
    expect(rowOf(update)).toEqual({ ownerUserId: 9, dueAt });
    expect(update.where?.params).toEqual([91, 42, "active"]);
    expect(rowOf(fake.writes("update", "exceptions")[0])).toMatchObject({ assignedTo: 9, assignedBy: 71 });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ eventType: "reassigned", ownerUserId: 9, dueAt });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "exception_workflow_reassigned", details: expect.objectContaining({ previousOwnerUserId: 8, ownerUserId: 9 }) })
    );
  });

  it("should record a deadline that has already passed before moving it, so a later due date cannot erase it", async () => {
    // Between monitor passes, a reassignment used to move an elapsed deadline
    // into the future unrecorded. The monitor then never saw it, and the case
    // closed with no overdue evidence, no renewed approval and no late reason.
    const fake = scripted({ workflow: [{ ...workflowRow, status: "approved", dueAt: MISSED, decisionSubmittedByUserId: 71 }] });

    await updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt });

    expect(lockOrder(fake.ops)).toEqual(["exceptions", "exception_workflows"]);
    const [recorded, reassigned] = fake.writes("update", "exception_workflows");
    expect(rowOf(recorded)).toMatchObject({ status: "decision_submitted", overdueAt: NOW, approvedByUserId: null });
    // The move is guarded on the status the record left, not the one first read:
    // guarded on "approved" it would match no row and change nothing.
    expect(rowOf(reassigned)).toEqual({ ownerUserId: 9, dueAt });
    expect(reassigned.where?.params).toEqual([91, 42, "decision_submitted"]);
    expect(fake.writes("insert", "exception_workflow_events").map(op => rowOf(op))).toEqual([
      expect.objectContaining({ eventType: "due_date_elapsed", actorUserId: null, ownerUserId: 8, dueAt: MISSED }),
      expect.objectContaining({ eventType: "reassigned", actorUserId: 71, ownerUserId: 9, dueAt }),
    ]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "exception_workflow_reassigned",
      details: expect.objectContaining({ previousDueAt: MISSED.toISOString(), dueAt: dueAt.toISOString(), overdue: true }),
    }));
  });

  it("should refuse a closed workflow", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "closed" }] });
    expect(await failureOf(() => updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt }))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/reassigned/),
    });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse an ineligible owner without writing", async () => {
    const fake = scripted({ users: [] });
    expect(await failureOf(() => updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt }))).toMatchObject({ code: "NOT_FOUND" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse a past due date before reading anything", async () => {
    expect(await failureOf(() => updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt: new Date("2026-10-13T00:00:00.000Z") }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("should answer an exception with no workflow as not found", async () => {
    scripted({ workflow: [] });
    expect(await failureOf(() => updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt }))).toEqual({
      code: "NOT_FOUND", message: "Governed exception workflow not found",
    });
  });
});

describe("when a workflow is escalated", () => {
  it("should move an active workflow to escalated and keep the reason in its history", async () => {
    const fake = scripted();
    await expect(escalateExceptionWorkflow({ ...base, actor, note: "Counterparty silent for 5 days" })).resolves.toEqual({ id: 91, status: "escalated" });
    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({ status: "escalated", escalationNote: "Counterparty silent for 5 days" });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ eventType: "escalated", note: "Counterparty silent for 5 days" });
    // The narrative stays out of audit metadata.
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("Counterparty silent");
  });

  it("should keep a submitted decision in force rather than send it back", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "decision_submitted", decisionSubmittedByUserId: 71 }] });
    await expect(escalateExceptionWorkflow({ ...base, actor, note: "Approval overdue" })).resolves.toEqual({ id: 91, status: "decision_submitted" });
    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({ status: "decision_submitted" });
  });

  it("should refuse a closed workflow", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "closed" }] });
    expect(await failureOf(() => escalateExceptionWorkflow({ ...base, actor, note: "x" }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(noWrites(fake)).toEqual([]);
  });
});

describe("when a decision is recorded or revised", () => {
  it("should submit a first decision for approval and keep its narrative in history", async () => {
    const fake = scripted();
    await expect(
      recordExceptionWorkflowDecision({ ...base, actor, rationale: "Timing difference", evidenceReference: "CASE-1" })
    ).resolves.toEqual({ id: 91, status: "decision_submitted", revision: false });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({
      eventType: "decision_recorded", note: "Timing difference", decisionEvidenceReference: "CASE-1", actorUserId: 71,
    });
  });

  it("should record a decision that needs no approval as ready", async () => {
    scripted({ workflow: [{ ...workflowRow, approvalRequired: false }] });
    await expect(
      recordExceptionWorkflowDecision({ ...base, actor, rationale: "r", evidenceReference: "e" })
    ).resolves.toMatchObject({ status: "decision_recorded" });
  });

  it("should withdraw an approval when the decision it approved is revised, keeping both in history", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "approved", decisionSubmittedByUserId: 71 }] });
    await expect(
      recordExceptionWorkflowDecision({ ...base, actor, rationale: "Revised: duplicate posting", evidenceReference: "CASE-2" })
    ).resolves.toEqual({ id: 91, status: "decision_submitted", revision: true });

    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({
      status: "decision_submitted",
      decisionRationale: "Revised: duplicate posting",
      approvedByUserId: null,
      approvedAt: null,
      approvalNote: null,
    });
    // History only ever grows: the earlier decision and approval are not touched.
    expect(fake.writes("update", "exception_workflow_events")).toEqual([]);
    expect(fake.writes("delete", "exception_workflow_events")).toEqual([]);
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ note: "Revised: duplicate posting" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ revision: true, supersededApproval: true }) })
    );
  });

  it("should refuse a closed workflow", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "closed" }] });
    expect(await failureOf(() => recordExceptionWorkflowDecision({ ...base, actor, rationale: "r", evidenceReference: "e" }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(noWrites(fake)).toEqual([]);
  });
});

describe("when a decision is approved", () => {
  const submitted = { ...workflowRow, status: "decision_submitted" as const, decisionSubmittedByUserId: 71 };

  it("should accept a different person's approval and keep the note in history", async () => {
    const fake = scripted({ workflow: [submitted] });
    await expect(approveExceptionWorkflowDecision({ ...base, actor: approver, approvalNote: "Checked CASE-1" })).resolves.toEqual({ id: 91, status: "approved" });
    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({ status: "approved", approvedByUserId: 72, approvalNote: "Checked CASE-1" });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ eventType: "decision_approved", note: "Checked CASE-1", actorUserId: 72 });
  });

  it("should record a missed deadline first, so an approval given after it stands", async () => {
    // Recorded later by the monitor instead, the deadline would withdraw this
    // approval as though it had been given before it.
    const fake = scripted({ workflow: [{ ...submitted, dueAt: MISSED }] });
    await expect(approveExceptionWorkflowDecision({ ...base, actor: approver, approvalNote: "Checked after the deadline" })).resolves.toEqual({ id: 91, status: "approved" });

    const [recorded, approved] = fake.writes("update", "exception_workflows");
    expect(rowOf(recorded)).toMatchObject({ status: "decision_submitted", overdueAt: NOW });
    expect(rowOf(approved)).toMatchObject({ status: "approved", approvedByUserId: 72 });
    expect(fake.writes("insert", "exception_workflow_events").map(op => rowOf(op)?.eventType)).toEqual(["due_date_elapsed", "decision_approved"]);
  });

  it("should refuse the person who submitted the decision", async () => {
    const fake = scripted({ workflow: [submitted] });
    expect(await failureOf(() => approveExceptionWorkflowDecision({ ...base, actor, approvalNote: "Self" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse when no decision awaits approval", async () => {
    scripted();
    expect(await failureOf(() => approveExceptionWorkflowDecision({ ...base, actor: approver, approvalNote: "n" }))).toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("should refuse a workflow that needs no approval", async () => {
    scripted({ workflow: [{ ...submitted, approvalRequired: false, status: "decision_recorded" }] });
    expect(await failureOf(() => approveExceptionWorkflowDecision({ ...base, actor: approver, approvalNote: "n" }))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/does not require/),
    });
  });
});

describe("when a governed workflow closes", () => {
  it("should close the exception and the workflow together, keeping the closure notes in history", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "approved", decisionSubmittedByUserId: 71 }] });
    await expect(
      resolveExceptionWorkflow({ ...base, actor: approver, outcome: "resolved", resolutionNotes: "Reversed at bank" })
    ).resolves.toEqual({ id: 91, status: "closed", outcome: "resolved" });

    expect(rowOf(fake.writes("update", "exceptions")[0])).toMatchObject({ status: "resolved", resolvedBy: 72, resolutionNotes: "Reversed at bank" });
    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({ status: "closed", finalOutcome: "resolved", closedByUserId: 72 });
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ eventType: "closed", note: "Reversed at bank", outcome: "resolved" });
  });

  it.each([
    ["an approval-required workflow without its approval", { status: "decision_submitted" as const, approvalRequired: true }],
    ["a workflow with no decision", { status: "escalated" as const, approvalRequired: false }],
  ])("should refuse %s, writing nothing", async (_label, state) => {
    const fake = scripted({ workflow: [{ ...workflowRow, ...state }] });
    expect(await failureOf(() => resolveExceptionWorkflow({ ...base, actor, outcome: "resolved", resolutionNotes: "n" }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse an exception that is already closed", async () => {
    scripted({ exception: [{ id: 5, status: "resolved" }], workflow: [{ ...workflowRow, status: "approved" }] });
    expect(await failureOf(() => resolveExceptionWorkflow({ ...base, actor, outcome: "resolved", resolutionNotes: "n" }))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/already closed/),
    });
  });

  it("should record a missed deadline in its own commit, then refuse a close whose approval predates it", async () => {
    // The approval was given before the deadline; recording the deadline
    // withdraws it. The record must survive the refusal, so the workspace's
    // refetch shows why the close was refused rather than the old approval.
    const unrecorded = { ...workflowRow, status: "approved" as const, dueAt: MISSED, decisionSubmittedByUserId: 71 };
    const recorded = { ...unrecorded, status: "decision_submitted" as const, overdueAt: NOW };
    const fake = scriptedDb({
      select: { exception_workflows: [[unrecorded], [recorded]] },
      standing: { exceptions: [openException] },
    });
    getDbMock.mockResolvedValue(fake.db);

    expect(await failureOf(() => resolveExceptionWorkflow({
      ...base, actor: approver, outcome: "resolved", resolutionNotes: "n", lateResolutionReason: "Counterparty answered late",
    }))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/missed its due date.*separate human approval given since/i),
    });

    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({
      status: "decision_submitted", overdueAt: NOW, approvedByUserId: null, approvedAt: null, approvalNote: null,
    });
    expect(fake.writes("insert", "exception_workflow_events").map(op => rowOf(op)?.eventType)).toEqual(["due_date_elapsed"]);
    // Nothing of the close itself.
    expect(fake.writes("update", "exceptions").map(op => rowOf(op))).toEqual([{ status: "escalated" }]);
    expect(fake.writes("update", "exception_workflows")).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "exception_workflow_due_date_elapsed", userId: null,
      details: expect.objectContaining({ trigger: "workflow_write", approvalInvalidated: true }),
    }));
  });

  it("should record and close a late case in one request when its reason is given and no approval is needed", async () => {
    const unrecorded = { ...workflowRow, approvalRequired: false, status: "decision_recorded" as const, dueAt: MISSED, decisionSubmittedByUserId: 71 };
    const fake = scriptedDb({
      select: { exception_workflows: [[unrecorded], [{ ...unrecorded, status: "decision_recorded" as const, overdueAt: NOW }]] },
      standing: { exceptions: [openException] },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(resolveExceptionWorkflow({
      ...base, actor: approver, outcome: "resolved", resolutionNotes: "n", lateResolutionReason: "  Bank statement arrived late  ",
    })).resolves.toEqual({ id: 91, status: "closed", outcome: "resolved" });

    expect(fake.writes("insert", "exception_workflow_events").map(op => rowOf(op)?.eventType)).toEqual(["due_date_elapsed", "closed"]);
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[1])).toMatchObject({ lateResolutionReason: "Bank statement arrived late" });
    expect(rowOf(fake.writes("update", "exception_workflows")[1])).toMatchObject({ status: "closed", lateResolutionReason: "Bank statement arrived late" });
  });

  it("should not keep a late-resolution reason sent for a close that was on time", async () => {
    // It would read as evidence of a lateness the server never recorded.
    const fake = scripted({ workflow: [{ ...workflowRow, status: "approved", decisionSubmittedByUserId: 71 }] });
    await resolveExceptionWorkflow({ ...base, actor: approver, outcome: "resolved", resolutionNotes: "n", lateResolutionReason: "Browser clock ran fast" });

    expect(rowOf(fake.writes("update", "exception_workflows")[0])).not.toHaveProperty("lateResolutionReason");
    expect(rowOf(fake.writes("insert", "exception_workflow_events")[0])).toMatchObject({ eventType: "closed", lateResolutionReason: null });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ overdue: false }) }));
  });

  it("should fail closed when an elapsed deadline could not be recorded", async () => {
    // Under the locks the record cannot lose a race, but if it ever made no
    // row change the close must not go ahead as though the case were on time.
    const fake = scriptedDb({
      standing: { exceptions: [openException], exception_workflows: [{ ...workflowRow, status: "approved", dueAt: MISSED }] },
      update: { exception_workflows: [0, 0] },
    });
    getDbMock.mockResolvedValue(fake.db);

    expect(await failureOf(() => resolveExceptionWorkflow({
      ...base, actor: approver, outcome: "resolved", resolutionNotes: "n", lateResolutionReason: "r",
    }))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/could not be recorded/) });
    expect(fake.writes("update", "exceptions")).toEqual([]);
    expect(fake.writes("insert", "exception_workflow_events")).toEqual([]);
  });

  it("should require and persist a separate late-resolution reason once overdue evidence exists", async () => {
    const overdue = { ...workflowRow, status: "approved" as const, overdueAt: new Date("2026-10-14T12:00:00.000Z") };
    const refused = scripted({ workflow: [overdue] });
    expect(await failureOf(() => resolveExceptionWorkflow({ ...base, actor: approver, outcome: "resolved", resolutionNotes: "n" }))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/late-resolution reason/i),
    });
    expect(noWrites(refused)).toEqual([]);

    const accepted = scripted({ workflow: [overdue] });
    await expect(resolveExceptionWorkflow({
      ...base,
      actor: approver,
      outcome: "resolved",
      resolutionNotes: "n",
      lateResolutionReason: "Approved after customer evidence review",
    })).resolves.toEqual({ id: 91, status: "closed", outcome: "resolved" });
    expect(rowOf(accepted.writes("update", "exception_workflows")[0])).toMatchObject({
      status: "closed", lateResolutionReason: "Approved after customer evidence review",
    });
    expect(rowOf(accepted.writes("insert", "exception_workflow_events")[0])).toMatchObject({
      eventType: "closed", lateResolutionReason: "Approved after customer evidence review",
    });
    // Narrative stays in the protected workflow row, not audit metadata.
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("Approved after customer evidence");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ overdue: true, lateResolutionReasonPresent: true }),
    }));
  });
});

describe("when the legacy close runs", () => {
  const legacy = { organizationId: 42, exceptionId: 5, status: "resolved" as const, resolutionNotes: "Done", actorId: 71 };

  it("should check and write in one transaction, under the same locks as a Start", async () => {
    const fake = scripted({ workflow: [] });
    await closeExceptionOutsideWorkflow(legacy);

    expect(lockOrder(fake.ops)).toEqual(["exceptions", "exception_workflows"]);
    const update = fake.writes("update", "exceptions")[0];
    expect(rowOf(update)).toMatchObject({ status: "resolved", resolvedBy: 71, resolutionNotes: "Done" });
    expect(update.txId).not.toBeNull();
    expect(new Set(fake.ops.map(op => op.txId))).toEqual(new Set([update.txId]));
  });

  it("should refuse an exception whose governed workflow is in progress", async () => {
    const fake = scripted();
    expect(await failureOf(() => closeExceptionOutsideWorkflow(legacy))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/decision evidence and required approval/),
    });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should refuse a reopened exception that was governed, pointing to a new review", async () => {
    const fake = scripted({ workflow: [{ ...workflowRow, status: "closed" }] });
    expect(await failureOf(() => closeExceptionOutsideWorkflow(legacy))).toMatchObject({
      code: "PRECONDITION_FAILED", message: expect.stringMatching(/Start a new governed review/),
    });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should answer another tenant's exception as not found and write nothing", async () => {
    const fake = scripted({ exception: [] });
    expect(await failureOf(() => closeExceptionOutsideWorkflow(legacy))).toEqual({ code: "NOT_FOUND", message: "Exception not found" });
    expect(noWrites(fake)).toEqual([]);
  });

  it("should close an org-less exception without looking for a workflow, which it cannot have", async () => {
    const fake = scripted({ workflow: [] });
    await closeExceptionOutsideWorkflow({ ...legacy, organizationId: null });
    expect(fake.ops.some(op => op.table === "exception_workflows")).toBe(false);
    expect(fake.writes("update", "exceptions")[0].where?.sql).toMatch(/`organizationId` is null/);
  });
});

describe("when a workflow is read", () => {
  it("should return the exception's status, its latest attempt, the history in order, and names within the tenant", async () => {
    const events = [
      { id: 3, workflowId: 91, eventType: "decision_recorded", actorUserId: 71, note: "n2" },
      { id: 2, workflowId: 91, eventType: "started", actorUserId: 71, ownerUserId: 8 },
    ];
    const workflow = { ...workflowRow, startedByUserId: 71, approvedByUserId: null, escalatedByUserId: null, closedByUserId: null };
    const fake = scripted({ workflow: [workflow], events, users: [{ id: 71, name: "Ada" }] });

    const view = await getExceptionWorkflow(42, 5);

    expect(view.exceptionStatus).toBe("in_review");
    expect(view.workflow).toMatchObject({ id: 91 });
    expect(view.history.map(event => [event.id, event.attemptNumber])).toEqual([[2, 1], [3, 1]]);
    expect(view.history[0]).not.toHaveProperty("workflowId");
    expect(view.people).toEqual([{ id: 71, name: "Ada" }]);
    const peopleRead = fake.ops.filter(op => op.table === "users").at(-1);
    expect(peopleRead?.where?.params).toEqual(expect.arrayContaining([42]));
    expect(peopleRead?.fields).toEqual(["id", "name"]);
  });

  it("should keep earlier attempts' evidence readable once the next attempt starts", async () => {
    // Greptile #194: history was read for the latest attempt only.
    const attempt2 = { ...workflowRow, id: 92, attemptNumber: 2, startedByUserId: 71, approvedByUserId: null, escalatedByUserId: null, closedByUserId: null };
    const attempt1 = { ...attempt2, id: 91, attemptNumber: 1, status: "closed" };
    const events = [
      { id: 7, workflowId: 92, eventType: "started", actorUserId: 71 },
      { id: 5, workflowId: 91, eventType: "decision_approved", actorUserId: 72, note: "First approval" },
    ];
    const fake = scripted({ workflow: [attempt2, attempt1], events });

    const view = await getExceptionWorkflow(42, 5);

    expect(view.attempts.map(attempt => attempt.attemptNumber)).toEqual([2, 1]);
    expect(view.history.map(event => [event.note ?? event.eventType, event.attemptNumber])).toEqual([
      ["First approval", 1],
      ["started", 2],
    ]);
    const historyRead = fake.ops.find(op => op.table === "exception_workflow_events");
    expect(historyRead?.where?.sql).toMatch(/`workflowId` in \(\?, \?\)/);
    expect(historyRead?.where?.params).toEqual([42, 92, 91]);
  });

  it("should return no workflow, attempts, history or names for an exception never governed", async () => {
    scripted({ workflow: [] });
    await expect(getExceptionWorkflow(42, 5)).resolves.toEqual({
      exceptionStatus: "in_review", workflow: null, attempts: [], history: [], people: [],
    });
  });

  it("should answer another tenant's exception as not found", async () => {
    scripted({ exception: [] });
    expect(await failureOf(() => getExceptionWorkflow(42, 5))).toEqual({ code: "NOT_FOUND", message: "Exception not found" });
  });
});

describe("when any write on an open attempt finds its deadline passed and unrecorded", () => {
  // The class, not one instance: every write on an open attempt goes through
  // the same lock-and-record step, so none can act on a missed deadline that
  // is not yet on record. A new write that skipped it would fail here.
  const late = { ...workflowRow, dueAt: MISSED };
  it.each([
    ["a reassignment", { ...late }, () => updateExceptionWorkflowOwnership({ ...base, actor, ownerUserId: 9, dueAt })],
    ["an escalation", { ...late }, () => escalateExceptionWorkflow({ ...base, actor, note: "Chasing the bank" })],
    ["a decision", { ...late }, () => recordExceptionWorkflowDecision({ ...base, actor, rationale: "r", evidenceReference: "e" })],
    [
      "an approval",
      { ...late, status: "decision_submitted" as const, decisionSubmittedByUserId: 71 },
      () => approveExceptionWorkflowDecision({ ...base, actor: approver, approvalNote: "n" }),
    ],
    [
      "a close",
      { ...late, approvalRequired: false, status: "decision_recorded" as const, decisionSubmittedByUserId: 71 },
      () => resolveExceptionWorkflow({ ...base, actor: approver, outcome: "resolved", resolutionNotes: "n", lateResolutionReason: "r" }),
    ],
  ])("should record the missed deadline before %s acts", async (_label, workflow, write) => {
    const fake = scripted({ workflow: [workflow] });

    await write();

    const events = fake.writes("insert", "exception_workflow_events").map(op => rowOf(op)?.eventType);
    expect(events[0]).toBe("due_date_elapsed");
    expect(events.length).toBeGreaterThan(1);
    expect(rowOf(fake.writes("update", "exception_workflows")[0])).toMatchObject({ overdueAt: NOW });
  });
});
