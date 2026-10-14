/**
 * The governed-workflow panel as rendered, in each state its hook can report.
 * The panel takes the hook's state as a prop, so each case is plain data.
 * Lives in client/src/lib because that is the client path vitest collects.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExceptionWorkflowPanel } from "@/components/ExceptionWorkflowPanel";
import type { ExceptionWorkflowState } from "@/hooks/useExceptionWorkflow";

type View = NonNullable<ExceptionWorkflowState["view"]>;
type Workflow = NonNullable<View["workflow"]>;

const workflow = (overrides: Partial<Workflow> = {}): Workflow =>
  ({
    id: 91,
    organizationId: 42,
    exceptionId: 5,
    attemptNumber: 1,
    ownerUserId: 8,
    dueAt: new Date("2026-10-15T12:00:00.000Z"),
    approvalRequired: true,
    status: "active",
    decisionRationale: null,
    decisionEvidenceReference: null,
    decisionSubmittedByUserId: null,
    decisionSubmittedAt: null,
    escalationNote: null,
    escalatedAt: null,
    escalatedByUserId: null,
    approvedByUserId: null,
    approvedAt: null,
    approvalNote: null,
    closedByUserId: null,
    closedAt: null,
    finalOutcome: null,
    startedByUserId: 71,
    startedAt: new Date("2026-10-14T09:00:00.000Z"),
    ...overrides,
  }) as Workflow;

function state(view: Partial<View> | null, overrides: Partial<ExceptionWorkflowState> = {}): ExceptionWorkflowState {
  const noop = vi.fn();
  return {
    view: view === null ? null : ({ exceptionStatus: "in_review", workflow: null, history: [], people: [], ...view } as View),
    isLoading: false,
    owners: [{ id: 8, name: "Ngozi", email: "ngozi@example.com", role: "operations" }],
    ownersLoading: false,
    currentUserId: 71,
    form: {
      ownerId: "8", setOwnerId: noop,
      dueAt: "2026-10-15T13:00", setDueAt: noop,
      approvalRequired: true, setApprovalRequired: noop,
      rationale: "", setRationale: noop,
      evidenceReference: "", setEvidenceReference: noop,
      escalationNote: "", setEscalationNote: noop,
      approvalNote: "", setApprovalNote: noop,
    },
    pending: { start: false, updateOwnership: false, escalate: false, recordDecision: false, approve: false, close: false },
    actions: { start: noop, updateOwnership: noop, escalate: noop, recordDecision: noop, approve: noop, close: noop },
    ...overrides,
  } as ExceptionWorkflowState;
}

const render = (s: ExceptionWorkflowState, canManage = true) =>
  renderToStaticMarkup(createElement(ExceptionWorkflowPanel, { state: s, canManage }));

const CONTROLS = ["Start governed workflow", "Escalate with reason", "Record decision evidence", "Approve decision", "Update owner"];

describe("when the viewer may not change workflows", () => {
  it("should show the evidence and history with no control at all", () => {
    const html = render(
      state({
        workflow: workflow({ decisionEvidenceReference: "CASE-1" }),
        history: [{ id: 1, eventType: "started", actorUserId: 71, note: null, decisionEvidenceReference: null, ownerUserId: 8, dueAt: null, outcome: null, createdAt: new Date() }],
        people: [{ id: 8, name: "Ngozi" }, { id: 71, name: "Ada" }],
      }),
      false
    );
    expect(html).toContain("Governed workflow: active");
    expect(html).toContain("Owner: Ngozi");
    expect(html).toContain("Decision evidence: CASE-1");
    expect(html).toContain("Workflow started");
    for (const control of CONTROLS) expect(html).not.toContain(control);
  });

  it("should render nothing for an exception never governed", () => {
    expect(render(state({ workflow: null }), false)).toBe("");
  });
});

describe("when an exception has never been governed", () => {
  it("should offer to start a workflow, with the due date in local time", () => {
    const html = render(state({ workflow: null, exceptionStatus: "open" }));
    expect(html).toContain("Start governed workflow");
    expect(html).toContain('value="2026-10-15T13:00"');
    expect(html).toContain("Due by (your local time)");
  });
});

describe("when a governed exception has been reopened", () => {
  it("should offer the next review instead of hiding Start", () => {
    const html = render(state({ exceptionStatus: "open", workflow: workflow({ status: "closed", attemptNumber: 2 }) }));
    expect(html).toContain("Start next governed review");
    expect(html).toContain("Attempt 2 closed and the exception was reopened");
  });
});

describe("when a closed workflow's exception is closed too", () => {
  it("should say so and offer no control", () => {
    const html = render(state({ exceptionStatus: "resolved", workflow: workflow({ status: "closed" }) }));
    expect(html).toContain("This governed workflow is closed");
    for (const control of CONTROLS) expect(html).not.toContain(control);
  });
});

describe("when a decision awaits approval", () => {
  const submitted = workflow({ status: "decision_submitted", decisionSubmittedByUserId: 71, decisionSubmittedAt: new Date() });

  it("should not offer approval to the person who submitted it", () => {
    const html = render(state({ workflow: submitted }, { currentUserId: 71 }));
    expect(html).toContain("You submitted this decision");
    expect(html).not.toContain("Approve decision");
  });

  it("should offer approval to someone else, with an empty note rather than an earlier one", () => {
    const html = render(state({ workflow: submitted }, { currentUserId: 72 }));
    expect(html).toContain("Approve decision");
    expect(html).toMatch(/placeholder="Independent review evidence\.\.\."[^>]*><\/textarea>/);
  });

  it("should call the existing decision a revision, warning that it withdraws the approval", () => {
    const html = render(state({ workflow: submitted }));
    expect(html).toContain("Revise decision");
    expect(html).toContain("withdraws any approval");
  });
});

describe("when optional facts are absent", () => {
  it("should render no stray 0, false or null where a fact is missing", () => {
    const html = render(state({ workflow: workflow({ approvedByUserId: null, decisionEvidenceReference: null }) }), false);
    expect(html).not.toMatch(/>(0|false|null)</);
  });
});

describe("when the workflow is still loading", () => {
  it("should say so rather than flash a Start control", () => {
    const html = render(state(null, { isLoading: true }));
    expect(html).toContain("Loading governed workflow");
    expect(html).not.toContain("Start governed workflow");
  });
});
