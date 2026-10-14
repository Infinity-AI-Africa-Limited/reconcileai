import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  exceptionWorkflows,
  exceptions,
  organizations,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { logAuditStrict } from "./routers/shared";

export type ExceptionWorkflowActor = {
  id: number;
  role: string;
  organizationId: number | null;
};

type ClientInfo = { ip: string; ua: string };
type Transaction = Parameters<
  Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>["transaction"]>[0]
>[0];

type WorkflowStatus =
  | "active"
  | "escalated"
  | "decision_recorded"
  | "decision_submitted"
  | "approved"
  | "closed";

type StoredWorkflow = {
  id: number;
  organizationId: number;
  exceptionId: number;
  attemptNumber: number;
  ownerUserId: number;
  dueAt: Date;
  approvalRequired: boolean;
  status: WorkflowStatus;
  decisionSubmittedByUserId: number | null;
};

const WORKFLOW_FIELDS = {
  id: exceptionWorkflows.id,
  organizationId: exceptionWorkflows.organizationId,
  exceptionId: exceptionWorkflows.exceptionId,
  attemptNumber: exceptionWorkflows.attemptNumber,
  ownerUserId: exceptionWorkflows.ownerUserId,
  dueAt: exceptionWorkflows.dueAt,
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
  closedByUserId: exceptionWorkflows.closedByUserId,
  closedAt: exceptionWorkflows.closedAt,
  finalOutcome: exceptionWorkflows.finalOutcome,
  startedByUserId: exceptionWorkflows.startedByUserId,
  startedAt: exceptionWorkflows.startedAt,
} as const;

function unavailable(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Database unavailable",
  });
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

function activeWorkflowStatus(status: WorkflowStatus): boolean {
  return status !== "closed";
}

function workflowNotFound(): never {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: "Governed exception workflow not found",
  });
}

/**
 * The approved owner is deliberately a real, active non-guest user in the same
 * tenant. A numeric id alone is not an assignment: without this check a case
 * could be filed to a departed account or to a user from another institution.
 */
async function requireEligibleOwner(
  tx: Transaction,
  organizationId: number,
  ownerUserId: number
) {
  const [owner] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, ownerUserId),
        eq(users.organizationId, organizationId),
        eq(users.isActive, true),
        eq(users.isGuest, false)
      )
    )
    .limit(1)
    .for("update");
  if (!owner) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Eligible workflow owner not found",
    });
  }
}

async function requireException(
  tx: Transaction,
  organizationId: number,
  exceptionId: number
) {
  const [exception] = await tx
    .select({ id: exceptions.id, status: exceptions.status })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.id, exceptionId),
        eq(exceptions.organizationId, organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!exception) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Exception not found" });
  }
  if (exception.status === "resolved" || exception.status === "dismissed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A closed exception cannot enter a governed workflow",
    });
  }
}

async function lockedWorkflow(
  tx: Transaction,
  organizationId: number,
  exceptionId: number
): Promise<StoredWorkflow> {
  const [workflow] = await tx
    .select({
      id: exceptionWorkflows.id,
      organizationId: exceptionWorkflows.organizationId,
      exceptionId: exceptionWorkflows.exceptionId,
      attemptNumber: exceptionWorkflows.attemptNumber,
      ownerUserId: exceptionWorkflows.ownerUserId,
      dueAt: exceptionWorkflows.dueAt,
      approvalRequired: exceptionWorkflows.approvalRequired,
      status: exceptionWorkflows.status,
      decisionSubmittedByUserId: exceptionWorkflows.decisionSubmittedByUserId,
    })
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
  if (!workflow) workflowNotFound();
  return workflow as StoredWorkflow;
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
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.isActive, true),
        eq(users.isGuest, false)
      )
    )
    .orderBy(users.name, users.email, users.id)
    .limit(250);
}

export async function getExceptionWorkflow(
  organizationId: number,
  exceptionId: number
) {
  const db = await requireDb();
  const [workflow] = await db
    .select(WORKFLOW_FIELDS)
    .from(exceptionWorkflows)
    .where(
      and(
        eq(exceptionWorkflows.organizationId, organizationId),
        eq(exceptionWorkflows.exceptionId, exceptionId)
      )
    )
    .orderBy(desc(exceptionWorkflows.attemptNumber))
    .limit(1);
  return workflow ?? null;
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
  const {
    actor,
    organizationId,
    exceptionId,
    ownerUserId,
    dueAt,
    approvalRequired,
    client,
  } = params;
  if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A workflow due date must be in the future",
    });
  }
  const db = await requireDb();
  return db.transaction(async tx => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
      .for("update");
    if (!organization)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Organisation not found",
      });
    await requireException(tx, organizationId, exceptionId);
    await requireEligibleOwner(tx, organizationId, ownerUserId);

    const [existing] = await tx
      .select({
        id: exceptionWorkflows.id,
        attemptNumber: exceptionWorkflows.attemptNumber,
        status: exceptionWorkflows.status,
      })
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
    if (existing && activeWorkflowStatus(existing.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This exception already has a governed workflow. Update its existing workflow instead.",
      });
    }

    const [inserted] = await tx.insert(exceptionWorkflows).values({
      organizationId,
      exceptionId,
      attemptNumber: (existing?.attemptNumber ?? 0) + 1,
      ownerUserId,
      dueAt,
      approvalRequired,
      status: "active",
      startedByUserId: actor.id,
      startedAt: new Date(),
    });
    const id = insertedId(inserted);
    await tx
      .update(exceptions)
      .set({
        assignedTo: ownerUserId,
        assignedAt: new Date(),
        assignedBy: actor.id,
        status: "in_review",
      })
      .where(
        and(
          eq(exceptions.id, exceptionId),
          eq(exceptions.organizationId, organizationId)
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_started",
      id,
      {
        exceptionId,
        attemptNumber: (existing?.attemptNumber ?? 0) + 1,
        ownerUserId,
        dueAt: dueAt.toISOString(),
        approvalRequired,
      }
    );
    return { id, status: "active" as const };
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
  const { actor, organizationId, exceptionId, ownerUserId, dueAt, client } =
    params;
  if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A workflow due date must be in the future",
    });
  }
  const db = await requireDb();
  return db.transaction(async tx => {
    const workflow = await lockedWorkflow(tx, organizationId, exceptionId);
    if (!activeWorkflowStatus(workflow.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "A closed workflow cannot be reassigned",
      });
    }
    await requireEligibleOwner(tx, organizationId, ownerUserId);
    await tx
      .update(exceptionWorkflows)
      .set({ ownerUserId, dueAt })
      .where(
        and(
          eq(exceptionWorkflows.id, workflow.id),
          eq(exceptionWorkflows.organizationId, organizationId)
        )
      );
    await tx
      .update(exceptions)
      .set({
        assignedTo: ownerUserId,
        assignedAt: new Date(),
        assignedBy: actor.id,
      })
      .where(
        and(
          eq(exceptions.id, exceptionId),
          eq(exceptions.organizationId, organizationId)
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_reassigned",
      workflow.id,
      {
        exceptionId,
        ownerUserId,
        dueAt: dueAt.toISOString(),
      }
    );
    return { id: workflow.id, ownerUserId, dueAt };
  });
}

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
    const workflow = await lockedWorkflow(tx, organizationId, exceptionId);
    if (!activeWorkflowStatus(workflow.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "A closed workflow cannot be escalated",
      });
    }
    const now = new Date();
    await tx
      .update(exceptionWorkflows)
      .set({
        status: "escalated",
        escalationNote: note,
        escalatedAt: now,
        escalatedByUserId: actor.id,
      })
      .where(
        and(
          eq(exceptionWorkflows.id, workflow.id),
          eq(exceptionWorkflows.organizationId, organizationId)
        )
      );
    await tx
      .update(exceptions)
      .set({ status: "escalated" })
      .where(
        and(
          eq(exceptions.id, exceptionId),
          eq(exceptions.organizationId, organizationId)
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_escalated",
      workflow.id,
      { exceptionId, escalationNotePresent: true }
    );
    return { id: workflow.id, status: "escalated" as const };
  });
}

export async function recordExceptionWorkflowDecision(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  rationale: string;
  evidenceReference: string;
  client: ClientInfo;
}) {
  const {
    actor,
    organizationId,
    exceptionId,
    rationale,
    evidenceReference,
    client,
  } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const workflow = await lockedWorkflow(tx, organizationId, exceptionId);
    if (!activeWorkflowStatus(workflow.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "A closed workflow cannot receive a decision",
      });
    }
    const now = new Date();
    const status: WorkflowStatus = workflow.approvalRequired
      ? "decision_submitted"
      : "decision_recorded";
    await tx
      .update(exceptionWorkflows)
      .set({
        status,
        decisionRationale: rationale,
        decisionEvidenceReference: evidenceReference,
        decisionSubmittedByUserId: actor.id,
        decisionSubmittedAt: now,
      })
      .where(
        and(
          eq(exceptionWorkflows.id, workflow.id),
          eq(exceptionWorkflows.organizationId, organizationId)
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_decision_recorded",
      workflow.id,
      {
        exceptionId,
        approvalRequired: workflow.approvalRequired,
        decisionEvidenceReference: evidenceReference,
      }
    );
    return { id: workflow.id, status };
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
    const workflow = await lockedWorkflow(tx, organizationId, exceptionId);
    if (!workflow.approvalRequired) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This workflow does not require a separate approval",
      });
    }
    if (workflow.status !== "decision_submitted") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Record a decision before it can be approved",
      });
    }
    if (workflow.decisionSubmittedByUserId === actor.id) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "A decision must be approved by a different person",
      });
    }
    const now = new Date();
    await tx
      .update(exceptionWorkflows)
      .set({
        status: "approved",
        approvedByUserId: actor.id,
        approvedAt: now,
        approvalNote,
      })
      .where(
        and(
          eq(exceptionWorkflows.id, workflow.id),
          eq(exceptionWorkflows.organizationId, organizationId),
          eq(exceptionWorkflows.status, "decision_submitted")
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_decision_approved",
      workflow.id,
      {
        exceptionId,
        approvalNotePresent: true,
      }
    );
    return { id: workflow.id, status: "approved" as const };
  });
}

export async function resolveExceptionWorkflow(params: {
  actor: ExceptionWorkflowActor;
  organizationId: number;
  exceptionId: number;
  outcome: "resolved" | "dismissed";
  resolutionNotes: string;
  client: ClientInfo;
}) {
  const {
    actor,
    organizationId,
    exceptionId,
    outcome,
    resolutionNotes,
    client,
  } = params;
  const db = await requireDb();
  return db.transaction(async tx => {
    const workflow = await lockedWorkflow(tx, organizationId, exceptionId);
    const isDecisionReady = workflow.approvalRequired
      ? workflow.status === "approved"
      : workflow.status === "decision_recorded";
    if (!isDecisionReady) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: workflow.approvalRequired
          ? "This workflow needs a recorded decision and a separate human approval before resolution."
          : "This workflow needs recorded decision evidence before resolution.",
      });
    }
    const now = new Date();
    await tx
      .update(exceptions)
      .set({
        status: outcome,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNotes,
      })
      .where(
        and(
          eq(exceptions.id, exceptionId),
          eq(exceptions.organizationId, organizationId)
        )
      );
    await tx
      .update(exceptionWorkflows)
      .set({
        status: "closed",
        closedByUserId: actor.id,
        closedAt: now,
        finalOutcome: outcome,
      })
      .where(
        and(
          eq(exceptionWorkflows.id, workflow.id),
          eq(exceptionWorkflows.organizationId, organizationId),
          eq(exceptionWorkflows.status, workflow.status)
        )
      );
    await audit(
      tx,
      actor,
      organizationId,
      client,
      "exception_workflow_closed",
      workflow.id,
      {
        exceptionId,
        outcome,
        decisionApproved: workflow.approvalRequired,
      }
    );
    return { id: workflow.id, status: "closed" as const, outcome };
  });
}

/**
 * Existing `exceptions.resolve` remains for ordinary exceptions, but it must not
 * close a case already enrolled in governed workflow. This is a server-side
 * backstop for clients that do not yet render the new workflow controls.
 */
export async function assertLegacyExceptionResolutionPermitted(
  organizationId: number | null,
  exceptionId: number
) {
  if (!organizationId) return;
  const workflow = await getExceptionWorkflow(organizationId, exceptionId);
  if (workflow && workflow.status !== "closed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This exception has a governed workflow. Record its decision evidence and required approval before closing it.",
    });
  }
}
