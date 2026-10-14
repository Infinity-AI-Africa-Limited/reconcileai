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

const CLOSED_EXCEPTION_STATUSES = new Set(["resolved", "dismissed"]);

export function isExceptionClosed(exceptionStatus: string | null | undefined): boolean {
  return typeof exceptionStatus === "string" && CLOSED_EXCEPTION_STATUSES.has(exceptionStatus);
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
