/**
 * The rules of a governed exception workflow that both sides must agree on.
 *
 * Shared on purpose: the workspace decides which controls to offer and the
 * server decides what to accept. If those two read different rules, a button
 * that is always refused (or a refusal no button explains) is the result, so
 * both import these.
 */

export const EXCEPTION_WORKFLOW_STATUSES = [
  "active",
  "escalated",
  "decision_recorded",
  "decision_submitted",
  "approved",
  "closed",
] as const;
export type ExceptionWorkflowStatus = (typeof EXCEPTION_WORKFLOW_STATUSES)[number];

/** Who may change a workflow: an allow-list, so a role added later is refused until decided. */
export const EXCEPTION_WORKFLOW_WRITER_ROLES: readonly string[] = ["super_admin", "admin", "operations"];

/**
 * Whether this user may change governed workflows. A read-only reviewer
 * session carries a writer's role, so the role alone is not enough: the server
 * refuses every mutation for `isReadOnly`, and the workspace must not offer one.
 */
export function canManageExceptionWorkflows(
  user: { role?: string | null; isGuest?: boolean | null; isReadOnly?: boolean | null } | null | undefined
): boolean {
  if (!user || user.isGuest === true || user.isReadOnly === true) return false;
  return typeof user.role === "string" && EXCEPTION_WORKFLOW_WRITER_ROLES.includes(user.role);
}

/** Exception statuses that end an investigation. Every other status, including one added later, is still open. */
export const CLOSED_EXCEPTION_STATUSES = ["resolved", "dismissed"] as const;
const closedExceptionStatuses: ReadonlySet<string> = new Set(CLOSED_EXCEPTION_STATUSES);

/** The workflow status that ends a governed attempt; every other one is still live. */
export const CLOSED_EXCEPTION_WORKFLOW_STATUS = "closed" satisfies ExceptionWorkflowStatus;

export function isExceptionClosed(exceptionStatus: string | null | undefined): boolean {
  return typeof exceptionStatus === "string" && closedExceptionStatuses.has(exceptionStatus);
}

/**
 * A new governed attempt may start when the exception is still open and no
 * attempt is in progress. A REOPENED exception whose last attempt closed
 * qualifies: that is how its next review cycle begins.
 */
export function canStartExceptionWorkflow(
  exceptionStatus: string | null | undefined,
  latestWorkflowStatus: string | null | undefined
): boolean {
  if (exceptionStatus == null || isExceptionClosed(exceptionStatus)) return false;
  return latestWorkflowStatus == null || latestWorkflowStatus === "closed";
}

/** The decision evidence a closure needs: a recorded decision, and its separate approval where required. */
export function isExceptionWorkflowReadyToClose(
  workflow: { approvalRequired: boolean; status: string } | null | undefined
): boolean {
  if (!workflow) return false;
  return workflow.approvalRequired ? workflow.status === "approved" : workflow.status === "decision_recorded";
}

/** Escalation never moves a workflow backwards: only one with no decision yet changes status. */
export function statusAfterEscalation(status: ExceptionWorkflowStatus): ExceptionWorkflowStatus {
  return status === "active" ? "escalated" : status;
}

/** A decision, first or revised, waits for approval when one is required. */
export function statusAfterDecision(approvalRequired: boolean): ExceptionWorkflowStatus {
  return approvalRequired ? "decision_submitted" : "decision_recorded";
}

/**
 * What an attempt becomes when its missed deadline is recorded. The decision
 * stays; an approval does not. Every governed write records an elapsed deadline
 * before it acts, so an attempt still `approved` when its deadline is recorded
 * was approved BEFORE the deadline, and that approval no longer vouches for a
 * case closing late: a different person must approve again.
 */
export function statusAfterDeadline(status: ExceptionWorkflowStatus, approvalRequired: boolean): ExceptionWorkflowStatus {
  if (approvalRequired && status === "approved") return "decision_submitted";
  return statusAfterEscalation(status);
}

/**
 * Whether an open attempt has missed its deadline — from the moment its due
 * date passes, not only once the server's due-date control has recorded it.
 *
 * The server's record (`overdueAt`) is the authority, and it is what a close is
 * checked against. The workspace reads this so it can ask for the late-closure
 * evidence as the deadline passes, instead of after a refused close.
 */
export function isExceptionWorkflowOverdue(
  workflow: { status: string; dueAt: Date | string; overdueAt: Date | string | null } | null | undefined,
  now: Date
): boolean {
  if (!workflow || workflow.status === "closed") return false;
  if (workflow.overdueAt != null) return true;
  const due = new Date(workflow.dueAt).getTime();
  return Number.isFinite(due) && due <= now.getTime();
}
