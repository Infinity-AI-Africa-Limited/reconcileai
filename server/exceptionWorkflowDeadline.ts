import { and, eq, isNull, lte } from "drizzle-orm";
import {
  isExceptionClosed,
  statusAfterDeadline,
  type ExceptionWorkflowStatus,
} from "@shared/exceptionWorkflowRules";
import { exceptionWorkflowEvents, exceptionWorkflows, exceptions } from "../drizzle/schema";
import type { getDb } from "./db";
import { logAuditStrict } from "./routers/shared";

/**
 * Recording a governed workflow's missed deadline — the one place it happens.
 *
 * Two callers, one rule. The due-date monitor sweeps for deadlines nobody has
 * recorded, and EVERY governed write records one before it acts, under the
 * same locks. The second caller is what makes the control hold between monitor
 * passes: without it, reassigning a case could move an elapsed deadline into
 * the future before the monitor saw it, and the case would then close with no
 * overdue evidence, no renewed approval and no late-resolution reason.
 *
 * Recording is a system act, not the act of whoever happened to touch the case,
 * so the event and audit record name no user (`actorUserId` null). The audit
 * details say which caller recorded it.
 */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const DUE_DATE_ELAPSED_NOTE = "Due date elapsed; system escalation recorded.";

/** Who noticed: the scheduled sweep, or a governed write that found the deadline first. */
export type DeadlineTrigger = "due_monitor" | "workflow_write";

export type DeadlineWorkflow = {
  id: number;
  organizationId: number;
  exceptionId: number;
  ownerUserId: number;
  dueAt: Date;
  overdueAt: Date | null;
  approvalRequired: boolean;
  status: ExceptionWorkflowStatus;
};

/** An open attempt whose deadline has passed and is not yet on record. */
export function deadlineAwaitingRecord(workflow: DeadlineWorkflow, now: Date): boolean {
  return workflow.status !== "closed" && workflow.overdueAt === null && workflow.dueAt.getTime() <= now.getTime();
}

/** mysql2 answers an UPDATE with a ResultSetHeader inside an array. */
function affectedRowsOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  const value = (header as { affectedRows?: unknown }).affectedRows;
  return typeof value === "number" ? value : Number(value) || 0;
}

/**
 * Record the attempt's elapsed deadline, once, and return the attempt as it now
 * stands — or null when there was nothing to record.
 *
 * PRECONDITION: the caller holds the exception row, then this workflow row,
 * `FOR UPDATE` (the lock order in exceptionWorkflow.ts), and passes the rows it
 * read under those locks. The update is still conditional on the deadline being
 * unrecorded, so a second caller that somehow got here first makes this a no-op
 * rather than a duplicate event.
 *
 * A caller that goes on to write the workflow MUST continue from the returned
 * attempt: its status may have changed, and every workflow write is guarded on
 * the status it read.
 */
export async function recordElapsedDeadline<W extends DeadlineWorkflow>(
  tx: Transaction,
  exception: { id: number; status: string },
  workflow: W,
  now: Date,
  trigger: DeadlineTrigger
): Promise<W | null> {
  if (!deadlineAwaitingRecord(workflow, now)) return null;
  const status = statusAfterDeadline(workflow.status, workflow.approvalRequired);
  const approvalWithdrawn = workflow.approvalRequired && workflow.status === "approved";
  const claimed = await tx
    .update(exceptionWorkflows)
    .set({
      status,
      overdueAt: now,
      // The current escalation is now the system's, so all three fields say so:
      // a person's earlier note under a null escalator would misattribute it.
      // That note is not lost — it stays in the step history.
      escalatedAt: now,
      escalatedByUserId: null,
      escalationNote: DUE_DATE_ELAPSED_NOTE,
      ...(approvalWithdrawn ? { approvedByUserId: null, approvedAt: null, approvalNote: null } : {}),
    })
    .where(
      and(
        eq(exceptionWorkflows.id, workflow.id),
        eq(exceptionWorkflows.organizationId, workflow.organizationId),
        isNull(exceptionWorkflows.overdueAt),
        eq(exceptionWorkflows.status, workflow.status),
        lte(exceptionWorkflows.dueAt, now)
      )
    );
  // Never append evidence for a record this call did not make.
  if (affectedRowsOf(claimed) !== 1) return null;

  // An exception closed some other way stays closed: the control escalates open
  // work, and must never reopen a case.
  if (!isExceptionClosed(exception.status)) {
    await tx
      .update(exceptions)
      .set({ status: "escalated" })
      .where(and(eq(exceptions.id, workflow.exceptionId), eq(exceptions.organizationId, workflow.organizationId)));
  }
  // The deadline that was missed, and who owned the case when it was. The
  // workflow row cannot keep these: its owner and due date can change later.
  await tx.insert(exceptionWorkflowEvents).values({
    organizationId: workflow.organizationId,
    workflowId: workflow.id,
    exceptionId: workflow.exceptionId,
    eventType: "due_date_elapsed",
    actorUserId: null,
    note: DUE_DATE_ELAPSED_NOTE,
    ownerUserId: workflow.ownerUserId,
    dueAt: workflow.dueAt,
  });
  await logAuditStrict({
    userId: null,
    organizationId: workflow.organizationId,
    action: "exception_workflow_due_date_elapsed",
    entityType: "exception_workflow",
    entityId: workflow.id,
    details: {
      exceptionId: workflow.exceptionId,
      dueAt: workflow.dueAt.toISOString(),
      ownerUserId: workflow.ownerUserId,
      previousStatus: workflow.status,
      status,
      approvalInvalidated: approvalWithdrawn,
      trigger,
    },
    executor: tx,
  });
  return { ...workflow, status, overdueAt: now };
}
