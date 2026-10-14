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
  isExceptionWorkflowReadyToClose,
  statusAfterDecision,
  statusAfterEscalation,
} from "@shared/exceptionWorkflowRules";
import {
  closureState,
  defaultWorkflowDueAt,
  errorMessageOf,
  exceptionWorkflowEventLabel,
  exceptionWorkflowStatusLabel,
  fromDateTimeLocalValue,
  patchExceptionInList,
  toDateTimeLocalValue,
  workflowFormKey,
} from "./exceptionWorkflowPresentation";

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
