import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  canStartExceptionWorkflow,
  isExceptionClosed,
  isExceptionWorkflowReadyToClose,
  statusAfterDecision,
  statusAfterEscalation,
  type ExceptionWorkflowStatus,
} from "@shared/exceptionWorkflowRules";
import {
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  users,
} from "../drizzle/schema";
import { getDb, orgFilter } from "./db";
import { logAuditStrict } from "./routers/shared";

/**
 * Governed workflows for material exceptions.
 *
 * LOCK ORDER. Every write takes its locks in this order, and takes no others:
 *   1. the exception row             (FOR UPDATE, scoped to the tenant)
 *   2. its latest workflow attempt   (FOR UPDATE)
 * Owners are read, never locked. With one order, two writes on the same
 * exception queue behind each other instead of deadlocking: Start used to hold
 * exception → owner → workflow while reassignment held workflow → owner →
 * exception. The legacy close takes the same two locks, so it cannot slip
 * between a Start's check and its insert and close a case its new workflow
 * still governs.
 *
 * EVIDENCE. The workflow row holds the CURRENT owner, decision and approval.
 * Every step, with its narrative, is also appended to `exception_workflow_events`,
 * so a revised decision, a second escalation or a superseded approval is never
 * lost. Audit events carry identifiers and flags, never the narratives.
 */

export type ExceptionWorkflowActor = {
  id: number;
  role: string;
  organizationId: number | null;
};

type ClientInfo = { ip: string; ua: string };
type Transaction = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

type StoredWorkflow = {
  id: number;
  organizationId: number;
  exceptionId: number;
  attemptNumber: number;
  ownerUserId: number;
  dueAt: Date;
  overdueAt: Date | null;
  approvalRequired: boolean;
  status: ExceptionWorkflowStatus;
  decisionSubmittedByUserId: number | null;
};

type LockedException = { id: number; status: string };

const WORKFLOW_FIELDS = {
  id: exceptionWorkflows.id,
  organizationId: exceptionWorkflows.organizationId,
  exceptionId: exceptionWorkflows.exceptionId,
  attemptNumber: exceptionWorkflows.attemptNumber,
  ownerUserId: exceptionWorkflows.ownerUserId,
  dueAt: exceptionWorkflows.dueAt,
  overdueAt: exceptionWorkflows.overdueAt,
  approvalRequired: exceptionWorkflows.approvalRequired,
  status: exceptionWorkflows.status,
  decisionRationale: exceptionWorkflows.decisionRationale,
  decisionEvidenceReference: exceptionWorkflows.decisionEvidenceReference,
  decisionSubmittedByUserId: exceptionWorkflows.decisionSubmittedByUserId,
  decisionSubmittedAt: exceptionWorkflows.decisionSubmittedAt,
  escalationNote: exceptionWorkflows.escalationNote,
  escalatedAt: exceptionWorkflows.escalatedAt,
  escalatedByUserId: exceptionWorkflows.escalatedByUserId,
  approvedByUserId: exceptionWorkflows.approvedByUserId,
  approvedAt: exceptionWorkflows.approvedAt,
  approvalNote: exceptionWorkflows.approvalNote,
  lateResolutionReason: exceptionWorkflows.lateResolutionReason,
  closedByUserId: exceptionWorkflows.closedByUserId,
  closedAt: exceptionWorkflows.closedAt,
  finalOutcome: exceptionWorkflows.finalOutcome,
  startedByUserId: exceptionWorkflows.startedByUserId,
  startedAt: exceptionWorkflows.startedAt,
} as const;

const LOCKED_WORKFLOW_FIELDS = {
  id: exceptionWorkflows.id,
  organizationId: exceptionWorkflows.organizationId,
  exceptionId: exceptionWorkflows.exceptionId,
  attemptNumber: exceptionWorkflows.attemptNumber,
  ownerUserId: exceptionWorkflows.ownerUserId,
  dueAt: exceptionWorkflows.dueAt,
  overdueAt: exceptionWorkflows.overdueAt,
  approvalRequired: exceptionWorkflows.approvalRequired,
  status: exceptionWorkflows.status,
  decisionSubmittedByUserId: exceptionWorkflows.decisionSubmittedByUserId,
} as const;

/** What the workspace shows of every attempt, earlier ones included. */
const ATTEMPT_FIELDS = {
  id: exceptionWorkflows.id,
  attemptNumber: exceptionWorkflows.attemptNumber,
  status: exceptionWorkflows.status,
  approvalRequired: exceptionWorkflows.approvalRequired,
  finalOutcome: exceptionWorkflows.finalOutcome,
  startedAt: exceptionWorkflows.startedAt,
  closedAt: exceptionWorkflows.closedAt,
} as const;

/** Attempts one read returns: a case reopened more often than this is pathological, not a workload. */
const ATTEMPT_LIMIT = 50;

const EVENT_FIELDS = {
  id: exceptionWorkflowEvents.id,
  workflowId: exceptionWorkflowEvents.workflowId,
  eventType: exceptionWorkflowEvents.eventType,
  actorUserId: exceptionWorkflowEvents.actorUserId,
  note: exceptionWorkflowEvents.note,
  decisionEvidenceReference: exceptionWorkflowEvents.decisionEvidenceReference,
  lateResolutionReason: exceptionWorkflowEvents.lateResolutionReason,
  ownerUserId: exceptionWorkflowEvents.ownerUserId,
  dueAt: exceptionWorkflowEvents.dueAt,
  outcome: exceptionWorkflowEvents.outcome,
  createdAt: exceptionWorkflowEvents.createdAt,
} as const;

/** The most history one read returns; an attempt's steps are few, this only bounds a pathological one. */
const HISTORY_LIMIT = 200;

function unavailable(): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
}

async function requireDb() {
  const db = await getDb();
  if (!db) unavailable();
  return db;
}

function insertedId(result: { insertId?: number | string }): number {
  const id = Number(result?.insertId);
  if (!Number.isSafeInteger(id) || id < 1) unavailable();
  return id;
}

function refuse(code: "PRECONDITION_FAILED" | "CONFLICT" | "FORBIDDEN" | "BAD_REQUEST", message: string): never {
  throw new TRPCError({ code, message });
}

function exceptionNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Exception not found" });
}

function assertFutureDueDate(dueAt: Date) {
  if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
    refuse("BAD_REQUEST", "A workflow due date must be in the future");
  }
}

/** Locks 1 and 2 of the lock order. Another tenant's exception is "not found". */
async function lockCase(
  tx: Transaction,
  organizationId: number | null,
  exceptionId: number
): Promise<{ exception: LockedException; workflow: StoredWorkflow | null }> {
  const [exception] = await tx
    .select({ id: exceptions.id, status: exceptions.status })
    .from(exceptions)
    .where(and(eq(exceptions.id, exceptionId), orgFilter(exceptions.organizationId, organizationId)))
    .limit(1)
    .for("update");
  if (!exception) exceptionNotFound();
  // A workflow always belongs to a tenant, so an org-less exception has none.
  if (organizationId === null) return { exception, workflow: null };
  const [workflow] = await tx
    .select(LOCKED_WORKFLOW_FIELDS)
    .from(exceptionWorkflows)
    .where(
      and(
        eq(exceptionWorkflows.organizationId, organizationId),
        eq(exceptionWorkflows.exceptionId, exceptionId)
      )
    )
    .orderBy(desc(exceptionWorkflows.attemptNumber))
    .limit(1)
    .for("update");
  return { exception, workflow: (workflow as StoredWorkflow | undefined) ?? null };
}

/** The case, locked, with an attempt still in progress — or the refusal named. */
async function lockOpenWorkflow(
  tx: Transaction,
  organizationId: number,
  exceptionId: number,
  closedRefusal: string
): Promise<{ exception: LockedException; workflow: StoredWorkflow }> {
  const { exception, workflow } = await lockCase(tx, organizationId, exceptionId);
  if (!workflow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Governed exception workflow not found" });
  }
  if (workflow.status === "closed") refuse("PRECONDITION_FAILED", closedRefusal);
  return { exception, workflow };
}

/**
 * The owner is a real, active, non-guest member of the same tenant. A numeric
 * id alone is not an assignment: without this a case could be filed to a
 * departed account or to another institution's user. A read-only reviewer
 * identity is an outside party and is never accountable for a case. Read, not
 * locked: see the lock order above.
 */
async function requireEligibleOwner(tx: Transaction, organizationId: number, ownerUserId: number) {
  const [owner] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, ownerUserId),
        eq(users.organizationId, organizationId),
        eq(users.isActive, true),
        eq(users.isGuest, false),
        eq(users.isReadOnly, false)
      )
    )
    .limit(1);
  if (!owner) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Eligible workflow owner not found" });
  }
}

/** Where the workflow row is still in the state the step was checked against. */
function workflowGuard(workflow: StoredWorkflow) {
  return and(
    eq(exceptionWorkflows.id, workflow.id),
    eq(exceptionWorkflows.organizationId, workflow.organizationId),
    eq(exceptionWorkflows.status, workflow.status)
  );
}

function exceptionRow(organizationId: number | null, exceptionId: number) {
  return and(eq(exceptions.id, exceptionId), orgFilter(exceptions.organizationId, organizationId));
}

async function recordEvent(
  tx: Transaction,
  workflow: { id: number; organizationId: number; exceptionId: number },
  eventType: (typeof exceptionWorkflowEvents.$inferInsert)["eventType"],
  actor: ExceptionWorkflowActor,
  fields: {
    note?: string | null;
    decisionEvidenceReference?: string | null;
    lateResolutionReason?: string | null;
    ownerUserId?: number;
    dueAt?: Date;
    outcome?: "resolved" | "dismissed";
  } = {}
) {
  await tx.insert(exceptionWorkflowEvents).values({
    organizationId: workflow.organizationId,
    workflowId: workflow.id,
    exceptionId: workflow.exceptionId,
    eventType,
    actorUserId: actor.id,
    ...fields,
  });
}

async function audit(
  tx: Transaction,
  actor: ExceptionWorkflowActor,
  organizationId: number,
  client: ClientInfo,
  action: string,
  workflowId: number,
  details: Record<string, unknown>
) {
  await logAuditStrict({
    userId: actor.id,
    organizationId,
    action,
    entityType: "exception_workflow",
    entityId: workflowId,
    details,
    ipAddress: client.ip,
    userAgent: client.ua,
    executor: tx,
  });
}

export async function listExceptionWorkflowOwners(organizationId: number) {
  const db = await requireDb();
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.isActive, true),
        eq(users.isGuest, false),
        eq(users.isReadOnly, false)
      )
    )
    .orderBy(users.name, users.email, users.id)
    .limit(250);
}

/**
 * The exception's current status, its latest attempt and that attempt's step
 * history. Another tenant's exception id is "not found", the same answer as a
 * missing one.
 */
export async function getExceptionWorkflow(organizationId: number, exceptionId: number) {
  const db = await requireDb();
  const [exception] = await db
    .select({ status: exceptions.status })
    .from(exceptions)
    .where(exceptionRow(organizationId, exceptionId))
    .limit(1);
  if (!exception) exceptionNotFound();
  // `.at(0)`, not destructuring: the API's type must say an exception may have
  // no workflow yet, and destructuring an array types its first item as present.
  const workflow = (
    await db
      .select(WORKFLOW_FIELDS)
      .from(exceptionWorkflows)
      .where(
        and(
          eq(exceptionWorkflows.organizationId, organizationId),
          eq(exceptionWorkflows.exceptionId, exceptionId)
        )
      )
      .orderBy(desc(exceptionWorkflows.attemptNumber))
      .limit(1)
  ).at(0);
  // EVERY attempt, not only the latest: starting a reopened case's next review
  // must not hide the decisions and approvals of the reviews before it.
  const attempts = workflow
    ? await db
        .select(ATTEMPT_FIELDS)
        .from(exceptionWorkflows)
        .where(
          and(
            eq(exceptionWorkflows.organizationId, organizationId),
            eq(exceptionWorkflows.exceptionId, exceptionId)
          )
        )
        .orderBy(desc(exceptionWorkflows.attemptNumber))
        .limit(ATTEMPT_LIMIT)
    : [];
  const attemptNumberOf = new Map(attempts.map(attempt => [attempt.id, attempt.attemptNumber]));
  // By workflow id, so the (organizationId, workflowId, id) index serves it.
  const history = attempts.length
    ? (
        await db
          .select(EVENT_FIELDS)
          .from(exceptionWorkflowEvents)
          .where(
            and(
              eq(exceptionWorkflowEvents.organizationId, organizationId),
              inArray(exceptionWorkflowEvents.workflowId, [...attemptNumberOf.keys()])
            )
          )
          .orderBy(desc(exceptionWorkflowEvents.id))
          .limit(HISTORY_LIMIT)
      )
        .reverse()
        .map(({ workflowId, ...event }) => ({ ...event, attemptNumber: attemptNumberOf.get(workflowId) ?? null }))
    : [];
  return {
    exceptionStatus: exception.status,
    workflow: workflow ?? null,
    attempts,
    history,
    people: workflow ? await peopleNamed(db, organizationId, workflow, history) : [],
  };
}

/**
 * Display names for everyone the workflow names, read within the tenant.
 * Names only: an email is not needed to read a case, and read-only sessions
 * see this too. Someone outside the tenant (staff acting in a portal) is
 * simply absent, and shows as "User N".
 */
async function peopleNamed(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  organizationId: number,
  workflow: {
    ownerUserId: number;
    startedByUserId: number;
    decisionSubmittedByUserId: number | null;
    approvedByUserId: number | null;
    escalatedByUserId: number | null;
    closedByUserId: number | null;
  },
  history: Array<{ actorUserId: number | null; ownerUserId: number | null }>
): Promise<Array<{ id: number; name: string | null }>> {
  const ids = new Set<number>();
  for (const id of [
    workflow.ownerUserId,
    workflow.startedByUserId,
    workflow.decisionSubmittedByUserId,
    workflow.approvedByUserId,
    workflow.escalatedByUserId,
    workflow.closedByUserId,
    ...history.flatMap(event => [event.actorUserId, event.ownerUserId]),
  ]) {
    if (typeof id === "number") ids.add(id);
  }
  if (ids.size === 0) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.organizationId, organizationId)));
}

export async function startExceptionWorkflow(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  ownerUserId: number;
  dueAt: Date;
  approvalRequired: boolean;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, ownerUserId, dueAt, approvalRequired, client } = params;
  assertFutureDueDate(dueAt);
  const db = await requireDb();
  return db.transaction(async tx => {
    const { exception, workflow: latest } = await lockCase(tx, organizationId, exceptionId);
    if (!canStartExceptionWorkflow(exception.status, latest?.status)) {
      if (isExceptionClosed(exception.status)) {
        refuse("PRECONDITION_FAILED", "A closed exception cannot enter a governed workflow");
      }
      refuse("CONFLICT", "This exception already has a governed workflow in progress. Update it instead.");
    }
    await requireEligibleOwner(tx, organizationId, ownerUserId);

    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const now = new Date();
    const [inserted] = await tx.insert(exceptionWorkflows).values({
      organizationId,
      exceptionId,
      attemptNumber,
      ownerUserId,
      dueAt,
      approvalRequired,
      status: "active",
      startedByUserId: actor.id,
      startedAt: now,
    });
    const workflow = { id: insertedId(inserted), organizationId, exceptionId };
    await tx
      .update(exceptions)
      .set({ assignedTo: ownerUserId, assignedAt: now, assignedBy: actor.id, status: "in_review" })
      .where(exceptionRow(organizationId, exceptionId));
    await recordEvent(tx, workflow, "started", actor, { ownerUserId, dueAt });
    await audit(tx, actor, organizationId, client, "exception_workflow_started", workflow.id, {
      exceptionId,
      attemptNumber,
      ownerUserId,
      dueAt: dueAt.toISOString(),
      approvalRequired,
    });
    return { id: workflow.id, status: "active" as const, attemptNumber };
  });
}

export async function updateExceptionWorkflowOwnership(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  ownerUserId: number;
  dueAt: Date;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, ownerUserId, dueAt, client } = params;
  assertFutureDueDate(dueAt);
  const db = await requireDb();
  return db.transaction(async tx => {
    const { workflow } = await lockOpenWorkflow(tx, organizationId, exceptionId, "A closed workflow cannot be reassigned");
    await requireEligibleOwner(tx, organizationId, ownerUserId);
    const now = new Date();
    await tx.update(exceptionWorkflows).set({ ownerUserId, dueAt }).where(workflowGuard(workflow));
    await tx
      .update(exceptions)
      .set({ assignedTo: ownerUserId, assignedAt: now, assignedBy: actor.id })
      .where(exceptionRow(organizationId, exceptionId));
    await recordEvent(tx, workflow, "reassigned", actor, { ownerUserId, dueAt });
    await audit(tx, actor, organizationId, client, "exception_workflow_reassigned", workflow.id, {
      exceptionId,
      previousOwnerUserId: workflow.ownerUserId,
      ownerUserId,
      dueAt: dueAt.toISOString(),
    });
    return { id: workflow.id, ownerUserId, dueAt };
  });
}

/**
 * Escalation is recorded at any point before closure, but never moves the
 * workflow backwards: escalating a case whose decision is submitted or
 * approved keeps that decision in force rather than discarding it.
 */
export async function escalateExceptionWorkflow(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  note: string;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, note, client } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const { workflow } = await lockOpenWorkflow(tx, organizationId, exceptionId, "A closed workflow cannot be escalated");
    const status = statusAfterEscalation(workflow.status);
    await tx
      .update(exceptionWorkflows)
      .set({ status, escalationNote: note, escalatedAt: new Date(), escalatedByUserId: actor.id })
      .where(workflowGuard(workflow));
    await tx.update(exceptions).set({ status: "escalated" }).where(exceptionRow(organizationId, exceptionId));
    await recordEvent(tx, workflow, "escalated", actor, { note });
    await audit(tx, actor, organizationId, client, "exception_workflow_escalated", workflow.id, {
      exceptionId,
      escalationNotePresent: true,
      previousStatus: workflow.status,
      status,
    });
    return { id: workflow.id, status };
  });
}

/**
 * Record the decision, or revise it. A revision replaces the CURRENT decision
 * and clears the current approval — an approval vouches for the decision it
 * saw, not for its replacement — while the earlier decision and approval stay
 * in the step history.
 */
export async function recordExceptionWorkflowDecision(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  rationale: string;
  evidenceReference: string;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, rationale, evidenceReference, client } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const { workflow } = await lockOpenWorkflow(tx, organizationId, exceptionId, "A closed workflow cannot receive a decision");
    const revision = workflow.decisionSubmittedByUserId !== null;
    const status = statusAfterDecision(workflow.approvalRequired);
    await tx
      .update(exceptionWorkflows)
      .set({
        status,
        decisionRationale: rationale,
        decisionEvidenceReference: evidenceReference,
        decisionSubmittedByUserId: actor.id,
        decisionSubmittedAt: new Date(),
        approvedByUserId: null,
        approvedAt: null,
        approvalNote: null,
      })
      .where(workflowGuard(workflow));
    await recordEvent(tx, workflow, "decision_recorded", actor, {
      note: rationale,
      decisionEvidenceReference: evidenceReference,
    });
    await audit(tx, actor, organizationId, client, "exception_workflow_decision_recorded", workflow.id, {
      exceptionId,
      approvalRequired: workflow.approvalRequired,
      decisionEvidenceReference: evidenceReference,
      revision,
      supersededApproval: workflow.status === "approved",
    });
    return { id: workflow.id, status, revision };
  });
}

export async function approveExceptionWorkflowDecision(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  approvalNote: string;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, approvalNote, client } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const { workflow } = await lockOpenWorkflow(tx, organizationId, exceptionId, "A closed workflow cannot be approved");
    if (!workflow.approvalRequired) {
      refuse("PRECONDITION_FAILED", "This workflow does not require a separate approval");
    }
    if (workflow.status !== "decision_submitted") {
      refuse("PRECONDITION_FAILED", "Record a decision before it can be approved");
    }
    if (workflow.decisionSubmittedByUserId === actor.id) {
      refuse("FORBIDDEN", "A decision must be approved by a different person");
    }
    await tx
      .update(exceptionWorkflows)
      .set({ status: "approved", approvedByUserId: actor.id, approvedAt: new Date(), approvalNote })
      .where(workflowGuard(workflow));
    await recordEvent(tx, workflow, "decision_approved", actor, { note: approvalNote });
    await audit(tx, actor, organizationId, client, "exception_workflow_decision_approved", workflow.id, {
      exceptionId,
      approvalNotePresent: true,
    });
    return { id: workflow.id, status: "approved" as const };
  });
}

/**
 * Close the exception through its governed workflow. The caller runs the
 * closure's after-effects (webhook, learning) once this has COMMITTED — see
 * `afterExceptionClosed` — so they never describe a closure that rolled back.
 */
export async function resolveExceptionWorkflow(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  outcome: "resolved" | "dismissed";
  resolutionNotes: string;
  lateResolutionReason?: string;
  client: ClientInfo;
}) {
  const { actor, organizationId, exceptionId, outcome, resolutionNotes, lateResolutionReason, client } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const { exception, workflow } = await lockOpenWorkflow(tx, organizationId, exceptionId, "This governed workflow is already closed");
    if (!isExceptionWorkflowReadyToClose(workflow)) {
      refuse(
        "PRECONDITION_FAILED",
        workflow.approvalRequired
          ? "This workflow needs a recorded decision and a separate human approval before resolution."
          : "This workflow needs recorded decision evidence before resolution."
      );
    }
    const now = new Date();
    // A deadline can elapse in the window before the monitor's next pass. Do
    // not let that timing race bypass the durable overdue event and reapproval.
    if (workflow.dueAt.getTime() <= now.getTime() && workflow.overdueAt === null) {
      refuse("PRECONDITION_FAILED", "This workflow due date has elapsed. Wait for the overdue control to record it, then provide late-resolution evidence and obtain the required approval.");
    }
    if (workflow.overdueAt !== null && !lateResolutionReason?.trim()) {
      refuse("PRECONDITION_FAILED", "This workflow is overdue. Record a late-resolution reason before closing it.");
    }
    if (isExceptionClosed(exception.status)) {
      refuse("PRECONDITION_FAILED", "This exception is already closed");
    }
    await tx
      .update(exceptions)
      .set({ status: outcome, resolvedBy: actor.id, resolvedAt: now, resolutionNotes })
      .where(exceptionRow(organizationId, exceptionId));
    await tx
      .update(exceptionWorkflows)
      .set({
        status: "closed",
        closedByUserId: actor.id,
        closedAt: now,
        finalOutcome: outcome,
        ...(workflow.overdueAt !== null ? { lateResolutionReason: lateResolutionReason!.trim() } : {}),
      })
      .where(workflowGuard(workflow));
    // The closure notes live on the exception row, which a reopen overwrites.
    await recordEvent(tx, workflow, "closed", actor, {
      note: resolutionNotes,
      lateResolutionReason: workflow.overdueAt !== null ? lateResolutionReason!.trim() : null,
      outcome,
    });
    await audit(tx, actor, organizationId, client, "exception_workflow_closed", workflow.id, {
      exceptionId,
      outcome,
      decisionApproved: workflow.approvalRequired,
      overdue: workflow.overdueAt !== null,
      lateResolutionReasonPresent: workflow.overdueAt !== null,
    });
    return { id: workflow.id, status: "closed" as const, outcome };
  });
}

/**
 * The legacy close (`exceptions.resolve`), for exceptions that were never
 * governed. It takes the SAME two locks as Start, in the same order, and
 * checks and writes inside them: checked outside a transaction, a Start could
 * enrol the case between the check and this update, which would then close it
 * without its decision or approval.
 *
 * Fails closed for any exception that has ever been governed, including one
 * reopened after its attempt closed: its next close goes through a new
 * governed attempt. A missing exception, or another tenant's, is "not found"
 * — the legacy route used to report success for it.
 */
export async function closeExceptionOutsideWorkflow(params: {
  organizationId: number | null;
  exceptionId: number;
  status: "resolved" | "dismissed";
  resolutionNotes: string | null;
  actorId: number;
}) {
  const { organizationId, exceptionId, status, resolutionNotes, actorId } = params;
  const db = await requireDb();
  await db.transaction(async tx => {
    const { workflow } = await lockCase(tx, organizationId, exceptionId);
    if (workflow) {
      refuse(
        "PRECONDITION_FAILED",
        workflow.status === "closed"
          ? "This exception was governed and has been reopened. Start a new governed review to close it."
          : "This exception has a governed workflow. Record its decision evidence and required approval before closing it."
      );
    }
    await tx
      .update(exceptions)
      .set({ status, resolvedBy: actorId, resolvedAt: new Date(), resolutionNotes })
      .where(exceptionRow(organizationId, exceptionId));
  });
}
