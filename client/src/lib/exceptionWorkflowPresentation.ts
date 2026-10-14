import { isExceptionClosed, isExceptionWorkflowReadyToClose } from "@shared/exceptionWorkflowRules";

/**
 * Pure presentation rules for the governed exception workflow: what the
 * workspace shows and offers. The predicates themselves live in
 * shared/exceptionWorkflowRules.ts, which the server enforces.
 */

export function exceptionWorkflowStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

const EVENT_LABELS: Record<string, string> = {
  started: "Workflow started",
  reassigned: "Owner or due date changed",
  escalated: "Escalated",
  due_date_elapsed: "Due date elapsed — system escalation recorded",
  decision_recorded: "Decision recorded",
  decision_approved: "Decision approved",
  closed: "Closed",
};

export function exceptionWorkflowEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? exceptionWorkflowStatusLabel(eventType);
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The value a `datetime-local` input shows for `date`, in the BROWSER's zone.
 * The input reads its text as local time, so feeding it UTC clock text (from
 * toISOString) shifted every due date by the viewer's offset — and saving
 * after changing only the owner moved the due date.
 */
export function toDateTimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value names, read as local time; null when it is not one. */
export function fromDateTimeLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  // Reject a value the calendar rolled over (31 February) rather than shift it.
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** The due date a new workflow is offered: one day from `now`, to the minute. */
export function defaultWorkflowDueAt(now: Date): Date {
  const due = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  due.setSeconds(0, 0);
  return due;
}

/**
 * When the workflow form refills from the server: a different exception or a
 * different attempt. NOT a change of stage — an escalation (even an optimistic
 * one that then rolls back) must not overwrite the decision being drafted.
 */
export function workflowFormKey(exceptionId: number | null, workflow: { id: number } | null | undefined): string {
  return `${exceptionId ?? "none"}:${workflow?.id ?? "none"}`;
}

/**
 * A state updater that clears a text box only if it still holds what was
 * submitted. The box stays editable while the request is in flight, so
 * clearing unconditionally on success erased whatever was typed meanwhile.
 */
export function clearIfStill(submitted: string): (current: string) => string {
  return current => (current === submitted ? "" : current);
}

/** A thrown value's message for a toast, or the fallback when it carries none. */
export function errorMessageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}

export type WorkflowView = {
  exceptionStatus: string;
  workflow: { approvalRequired: boolean; status: string } | null;
};

/**
 * How the workspace may close this exception:
 *   - "direct"   — never governed: the ordinary resolve applies;
 *   - "governed" — its attempt has the evidence a close needs;
 *   - "blocked"  — with the reason to show.
 * Mirrors the server: a governed case — including one reopened after its
 * attempt closed — closes only through a governed attempt.
 */
export function closureState(
  view: WorkflowView | null | undefined
): { mode: "direct" } | { mode: "governed" } | { mode: "blocked"; reason: string } {
  if (!view || !view.workflow) return { mode: "direct" };
  const { workflow, exceptionStatus } = view;
  if (workflow.status === "closed") {
    return isExceptionClosed(exceptionStatus)
      ? { mode: "blocked", reason: "This exception is closed." }
      : { mode: "blocked", reason: "This exception was reopened after its governed review closed. Start a new governed review to close it." };
  }
  if (isExceptionWorkflowReadyToClose(workflow)) return { mode: "governed" };
  return {
    mode: "blocked",
    reason: `Closure is blocked until this governed workflow has the required decision evidence${workflow.approvalRequired ? " and separate human approval" : ""}.`,
  };
}

/** A list page with one exception changed, for an optimistic update; the same page when it is not there. */
export function patchExceptionInList<Page extends { data: Array<{ id: number }> }>(
  page: Page | undefined,
  exceptionId: number,
  patch: Partial<Page["data"][number]>
): Page | undefined {
  if (!page || !page.data.some(row => row.id === exceptionId)) return page;
  return { ...page, data: page.data.map(row => (row.id === exceptionId ? { ...row, ...patch } : row)) };
}
