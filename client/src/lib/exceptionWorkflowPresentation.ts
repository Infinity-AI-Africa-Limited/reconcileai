export type ExceptionWorkflowPresentation = {
  approvalRequired: boolean;
  status: string;
};

/**
 * The same close predicate used by the workspace's button state and explanatory
 * copy. The server remains authoritative; this keeps the UI from advertising a
 * close action that the governed workflow will fail closed.
 */
export function isExceptionWorkflowReadyToClose(
  workflow: ExceptionWorkflowPresentation | null | undefined
): boolean {
  if (!workflow) return false;
  return workflow.approvalRequired
    ? workflow.status === "approved"
    : workflow.status === "decision_recorded";
}

export function exceptionWorkflowStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
