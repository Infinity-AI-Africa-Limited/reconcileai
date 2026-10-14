/**
 * The governed-workflow rules the workspace shows and the server enforces
 * (shared/exceptionWorkflowRules.ts), and the pure presentation helpers the
 * workspace builds on them. Lives in client/src/lib because that is the client
 * path vitest collects; shared/ is not collected on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canManageExceptionWorkflows,
  canStartExceptionWorkflow,
  isExceptionWorkflowOverdue,
  isExceptionWorkflowReadyToClose,
  statusAfterDeadline,
  statusAfterDecision,
  statusAfterEscalation,
} from "@shared/exceptionWorkflowRules";
import {
  MAX_TIMER_DELAY_MS,
  OPEN_WORKFLOW_REFRESH_MS,
  clearIfStill,
  closureState,
  defaultWorkflowDueAt,
  errorMessageOf,
  exceptionWorkflowEventLabel,
  exceptionWorkflowStatusLabel,
  fromDateTimeLocalValue,
  msUntilDeadlineCheck,
  overdueClosureNotice,
  patchExceptionInList,
  toDateTimeLocalValue,
  workflowFormKey,
  workflowRefreshInterval,
} from "./exceptionWorkflowPresentation";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const PASSED = new Date("2026-10-14T11:59:59.000Z");
const AHEAD = new Date("2026-10-14T12:30:00.000Z");

describe("when deciding who may change a workflow", () => {
  it.each(["super_admin", "admin", "operations"])("should admit the %s role", role => {
    expect(canManageExceptionWorkflows({ role })).toBe(true);
  });

  it.each(["cfo", "compliance", "user", "reviewer"])("should refuse the %s role", role => {
    expect(canManageExceptionWorkflows({ role })).toBe(false);
  });

  it("should refuse a reviewer session even though it carries the operations role", () => {
    expect(canManageExceptionWorkflows({ role: "operations", isReadOnly: true })).toBe(false);
  });

  it("should refuse a guest, and no user at all", () => {
    expect(canManageExceptionWorkflows({ role: "admin", isGuest: true })).toBe(false);
    expect(canManageExceptionWorkflows(null)).toBe(false);
  });
});

describe("when deciding whether a governed attempt may start", () => {
  it("should allow an open exception that was never governed", () => {
    expect(canStartExceptionWorkflow("open", null)).toBe(true);
  });

  it("should allow a reopened exception whose last attempt closed", () => {
    expect(canStartExceptionWorkflow("open", "closed")).toBe(true);
  });

  it.each(["active", "escalated", "decision_submitted", "approved"])("should refuse while an attempt is %s", status => {
    expect(canStartExceptionWorkflow("in_review", status)).toBe(false);
  });

  it.each(["resolved", "dismissed"])("should refuse a %s exception", status => {
    expect(canStartExceptionWorkflow(status, null)).toBe(false);
  });
});

describe("when deciding whether a workflow is ready to close", () => {
  it("should keep an approval-required workflow open until its separate approval exists", () => {
    expect(isExceptionWorkflowReadyToClose({ approvalRequired: true, status: "active" })).toBe(false);
    expect(isExceptionWorkflowReadyToClose({ approvalRequired: true, status: "decision_submitted" })).toBe(false);
    expect(isExceptionWorkflowReadyToClose({ approvalRequired: true, status: "approved" })).toBe(true);
  });

  it("should allow a no-approval workflow only once its decision is recorded", () => {
    expect(isExceptionWorkflowReadyToClose({ approvalRequired: false, status: "escalated" })).toBe(false);
    expect(isExceptionWorkflowReadyToClose({ approvalRequired: false, status: "decision_recorded" })).toBe(true);
  });
});

describe("when a workflow is escalated or its decision recorded", () => {
  it("should escalate only a workflow with no decision, never moving one backwards", () => {
    expect(statusAfterEscalation("active")).toBe("escalated");
    expect(statusAfterEscalation("decision_submitted")).toBe("decision_submitted");
    expect(statusAfterEscalation("approved")).toBe("approved");
  });

  it("should send every decision, first or revised, for approval when one is required", () => {
    expect(statusAfterDecision(true)).toBe("decision_submitted");
    expect(statusAfterDecision(false)).toBe("decision_recorded");
  });
});

describe("when the workspace decides how this exception may close", () => {
  it("should use the ordinary resolve for an exception never governed", () => {
    expect(closureState({ exceptionStatus: "open", workflow: null })).toEqual({ mode: "direct" });
    expect(closureState(null)).toEqual({ mode: "direct" });
  });

  it("should close through the workflow once its evidence is complete", () => {
    expect(closureState({ exceptionStatus: "in_review", workflow: { approvalRequired: true, status: "approved" } })).toEqual({ mode: "governed" });
  });

  it("should block, naming the approval, while evidence is missing", () => {
    const state = closureState({ exceptionStatus: "in_review", workflow: { approvalRequired: true, status: "decision_submitted" } });
    expect(state).toEqual({ mode: "blocked", reason: expect.stringMatching(/separate human approval/) });
  });

  it("should block a reopened governed exception and point to a new review", () => {
    expect(closureState({ exceptionStatus: "open", workflow: { approvalRequired: false, status: "closed" } })).toEqual({
      mode: "blocked",
      reason: expect.stringMatching(/Start a new governed review/),
    });
  });

  it("should block an approval given before a deadline that has now passed, before the server records it", () => {
    // The server withdraws that approval as it records the deadline, which it
    // does before deciding any close: offering the close would only earn a refusal.
    const view = { exceptionStatus: "in_review", workflow: { approvalRequired: true, status: "approved", dueAt: PASSED, overdueAt: null } };
    expect(closureState(view, NOW)).toEqual({ mode: "blocked", reason: expect.stringMatching(/approval given since the deadline/) });
  });

  it("should allow an approval given after the deadline was recorded", () => {
    const view = { exceptionStatus: "escalated", workflow: { approvalRequired: true, status: "approved", dueAt: PASSED, overdueAt: PASSED } };
    expect(closureState(view, NOW)).toEqual({ mode: "governed" });
  });

  it("should allow an approval whose deadline is still ahead", () => {
    const view = { exceptionStatus: "in_review", workflow: { approvalRequired: true, status: "approved", dueAt: AHEAD, overdueAt: null } };
    expect(closureState(view, NOW)).toEqual({ mode: "governed" });
  });
});

describe("when a deadline passes", () => {
  it("should count an open attempt as overdue from the moment its due date passes, recorded or not", () => {
    expect(isExceptionWorkflowOverdue({ status: "approved", dueAt: PASSED, overdueAt: null }, NOW)).toBe(true);
    expect(isExceptionWorkflowOverdue({ status: "approved", dueAt: NOW, overdueAt: null }, NOW)).toBe(true);
    expect(isExceptionWorkflowOverdue({ status: "escalated", dueAt: AHEAD, overdueAt: PASSED }, NOW)).toBe(true);
    expect(isExceptionWorkflowOverdue({ status: "active", dueAt: AHEAD, overdueAt: null }, NOW)).toBe(false);
  });

  it("should not count a closed attempt, or no attempt, as overdue", () => {
    expect(isExceptionWorkflowOverdue({ status: "closed", dueAt: PASSED, overdueAt: PASSED }, NOW)).toBe(false);
    expect(isExceptionWorkflowOverdue(null, NOW)).toBe(false);
  });

  it("should read the wire format the workspace receives", () => {
    expect(isExceptionWorkflowOverdue({ status: "active", dueAt: PASSED.toISOString(), overdueAt: null }, NOW)).toBe(true);
    expect(isExceptionWorkflowOverdue({ status: "active", dueAt: "not a date", overdueAt: null }, NOW)).toBe(false);
  });

  it("should withdraw an approval but keep the decision when the missed deadline is recorded", () => {
    expect(statusAfterDeadline("approved", true)).toBe("decision_submitted");
    expect(statusAfterDeadline("decision_submitted", true)).toBe("decision_submitted");
    expect(statusAfterDeadline("decision_recorded", false)).toBe("decision_recorded");
    expect(statusAfterDeadline("active", true)).toBe("escalated");
  });
});

describe("when the close form explains a missed deadline", () => {
  const workflow = (overrides: Partial<{ approvalRequired: boolean; status: string; dueAt: Date; overdueAt: Date | null }> = {}) => ({
    approvalRequired: true,
    status: "decision_submitted",
    dueAt: PASSED,
    overdueAt: null,
    ...overrides,
  });

  it("should say nothing while the deadline is ahead", () => {
    expect(overdueClosureNotice(workflow({ dueAt: AHEAD }), NOW)).toBeNull();
    expect(overdueClosureNotice(null, NOW)).toBeNull();
  });

  it("should say the record is on its way when the deadline has passed unrecorded", () => {
    expect(overdueClosureNotice(workflow(), NOW)).toMatch(/has passed; the overdue control records it within a minute/);
  });

  it("should name the separate approval only when the workflow requires one", () => {
    expect(overdueClosureNotice(workflow({ overdueAt: PASSED }), NOW)).toMatch(/late-resolution reason and a separate human approval/);
    expect(overdueClosureNotice(workflow({ overdueAt: PASSED, approvalRequired: false }), NOW)).toBe(
      "This workflow missed its due date. Closing it needs a late-resolution reason."
    );
  });
});

describe("when an open workflow is on screen", () => {
  it("should keep re-reading an attempt still in progress, so a recorded deadline appears without a refused close", () => {
    expect(workflowRefreshInterval({ workflow: { status: "approved" } })).toBe(OPEN_WORKFLOW_REFRESH_MS);
  });

  it("should stop re-reading once nothing can change without the viewer", () => {
    expect(workflowRefreshInterval({ workflow: { status: "closed" } })).toBe(false);
    expect(workflowRefreshInterval({ workflow: null })).toBe(false);
    expect(workflowRefreshInterval(undefined)).toBe(false);
  });

  it("should check again just after the deadline passes", () => {
    const due = NOW.getTime() + 60_000;
    expect(msUntilDeadlineCheck({ status: "active", dueAt: new Date(due), overdueAt: null }, NOW.getTime())).toBe(61_000);
  });

  it("should have nothing to wait for once the deadline is past, recorded, or the attempt closed", () => {
    expect(msUntilDeadlineCheck({ status: "active", dueAt: PASSED, overdueAt: null }, NOW.getTime())).toBeNull();
    expect(msUntilDeadlineCheck({ status: "active", dueAt: AHEAD, overdueAt: PASSED }, NOW.getTime())).toBeNull();
    expect(msUntilDeadlineCheck({ status: "closed", dueAt: AHEAD, overdueAt: null }, NOW.getTime())).toBeNull();
    expect(msUntilDeadlineCheck(null, NOW.getTime())).toBeNull();
  });

  it("should wait for a far deadline in steps a browser timer can hold", () => {
    // A longer delay overflows and fires at once — which would re-render in a loop.
    const farOff = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
    expect(msUntilDeadlineCheck({ status: "active", dueAt: farOff, overdueAt: null }, NOW.getTime())).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe("when a due date passes through a datetime-local input", () => {
  // The defect only shows outside UTC, and CI runs in UTC: run this block in
  // Lagos time (+01:00) so it can tell local text from UTC text anywhere.
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Africa/Lagos";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("should run where local time is not UTC, or it proves nothing", () => {
    expect(new Date("2026-10-15T12:00:00.000Z").getHours()).toBe(13);
  });

  it("should show the date in the browser's own time, not UTC clock text", () => {
    // Built with the local constructor, so this holds in any zone the suite runs in.
    expect(toDateTimeLocalValue(new Date(2026, 9, 14, 9, 5))).toBe("2026-10-14T09:05");
  });

  it("should read the input's text back as the same local instant", () => {
    const due = new Date(2026, 9, 14, 9, 5);
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(due))?.getTime()).toBe(due.getTime());
  });

  it("should keep the stored instant when only the owner is changed", () => {
    // The defect: ISO text fed to the input shifted the due date by the zone's offset on every save.
    const stored = new Date("2026-10-15T12:00:00.000Z");
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(stored))?.getTime()).toBe(stored.getTime());
  });

  it.each(["", "2026-10-14", "2026-10-14T9:05", "2026-02-31T09:00", "not a date"])("should refuse %j", value => {
    expect(fromDateTimeLocalValue(value)).toBeNull();
  });

  it("should offer one day from now, to the minute", () => {
    const now = new Date(2026, 9, 14, 9, 5, 42, 123);
    expect(defaultWorkflowDueAt(now)).toEqual(new Date(2026, 9, 15, 9, 5, 0, 0));
  });
});

describe("when a mutation fails", () => {
  it("should show the error's own message when it has one", () => {
    expect(errorMessageOf(new Error("Owner not eligible"), "fallback")).toBe("Owner not eligible");
    expect(errorMessageOf({ message: "From a tRPC shape" }, "fallback")).toBe("From a tRPC shape");
  });

  it.each([null, undefined, "plain string", 42, new Error("   "), { message: 7 }])("should fall back for %j", value => {
    expect(errorMessageOf(value, "Failed to start")).toBe("Failed to start");
  });
});

describe("when the list is updated before the server answers", () => {
  const page = { total: 2, data: [{ id: 1, status: "open" }, { id: 2, status: "open" }] };

  it("should change only the named exception, in a new page", () => {
    const next = patchExceptionInList(page, 2, { status: "escalated" });
    expect(next).toEqual({ total: 2, data: [{ id: 1, status: "open" }, { id: 2, status: "escalated" }] });
    expect(next).not.toBe(page);
    expect(page.data[1].status).toBe("open");
  });

  it("should return the same page when the exception is not on it, and nothing when nothing is cached", () => {
    expect(patchExceptionInList(page, 9, { status: "escalated" })).toBe(page);
    expect(patchExceptionInList<typeof page>(undefined, 1, { status: "escalated" })).toBeUndefined();
  });
});

describe("when statuses and steps are labelled", () => {
  it("should read as words without changing their meaning", () => {
    expect(exceptionWorkflowStatusLabel("decision_submitted")).toBe("decision submitted");
    expect(exceptionWorkflowEventLabel("decision_approved")).toBe("Decision approved");
    expect(exceptionWorkflowEventLabel("something_new")).toBe("something new");
  });
});

describe("when the workflow form decides whether to refill", () => {
  it("should not refill on a stage change, which would wipe a decision being drafted", () => {
    // Greptile #194: an optimistic escalation changed the key and overwrote the draft.
    const active = { id: 91, status: "active" };
    const escalated = { id: 91, status: "escalated" };
    expect(workflowFormKey(5, escalated)).toBe(workflowFormKey(5, active));
  });

  it("should refill for another exception or another attempt", () => {
    expect(workflowFormKey(5, { id: 91 })).not.toBe(workflowFormKey(6, { id: 91 }));
    expect(workflowFormKey(5, { id: 91 })).not.toBe(workflowFormKey(5, { id: 92 }));
    expect(workflowFormKey(5, null)).not.toBe(workflowFormKey(5, { id: 91 }));
  });
});

describe("when a note box clears after its action succeeds", () => {
  it("should clear the note that was submitted", () => {
    expect(clearIfStill("Approval overdue")("Approval overdue")).toBe("");
  });

  it("should keep text typed while the request was in flight", () => {
    // Greptile #194: clearing unconditionally erased the newer text.
    expect(clearIfStill("Approval overdue")("Approval overdue, and the bank called")).toBe("Approval overdue, and the bank called");
  });
});
