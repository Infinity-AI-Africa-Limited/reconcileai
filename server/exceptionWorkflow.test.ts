import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { getDbMock, auditMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: getDbMock }));
vi.mock("./routers/shared", () => ({ logAuditStrict: auditMock }));

import {
  approveExceptionWorkflowDecision,
  assertLegacyExceptionResolutionPermitted,
  escalateExceptionWorkflow,
  recordExceptionWorkflowDecision,
  resolveExceptionWorkflow,
  startExceptionWorkflow,
} from "./exceptionWorkflow";
import { rowOf, scriptedDb } from "./connectors/shopify/scriptedDb.testkit";

const actor = {
  id: 71,
  role: "operations",
  organizationId: 42,
  isGuest: false,
};
const client = { ip: "127.0.0.1", ua: "exception-workflow-test" };
const now = new Date("2026-10-14T12:00:00.000Z");
const dueAt = new Date("2026-10-15T12:00:00.000Z");
const activeWorkflow = {
  id: 91,
  organizationId: 42,
  exceptionId: 5,
  attemptNumber: 1,
  ownerUserId: 8,
  dueAt,
  approvalRequired: true,
  status: "active" as const,
  decisionSubmittedByUserId: null,
};

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error =>
      error instanceof TRPCError
        ? { code: error.code, message: error.message }
        : { code: "UNKNOWN", message: String(error) }
  );
}

beforeEach(() => {
  getDbMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

describe("when a material exception enters a governed workflow", () => {
  it("stores its owner, due date, approval rule and audit record atomically", async () => {
    const fake = scriptedDb({
      standing: {
        organizations: [{ id: 42 }],
        exceptions: [{ id: 5, status: "open" }],
        users: [{ id: 8 }],
      },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      startExceptionWorkflow({
        actor,
        organizationId: 42,
        exceptionId: 5,
        ownerUserId: 8,
        dueAt,
        approvalRequired: true,
        client,
      })
    ).resolves.toEqual({ id: 1000, status: "active" });

    expect(
      rowOf(fake.writes("insert", "exception_workflows")[0])
    ).toMatchObject({
      organizationId: 42,
      exceptionId: 5,
      attemptNumber: 1,
      ownerUserId: 8,
      dueAt,
      approvalRequired: true,
      status: "active",
      startedByUserId: 71,
    });
    expect(rowOf(fake.writes("update", "exceptions")[0])).toMatchObject({
      assignedTo: 8,
      assignedBy: 71,
      status: "in_review",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "exception_workflow_started",
        organizationId: 42,
        details: expect.objectContaining({
          exceptionId: 5,
          ownerUserId: 8,
          approvalRequired: true,
        }),
      })
    );
  });

  it("refuses a due date that has already passed before reading or writing evidence", async () => {
    await expect(
      failureOf(() =>
        startExceptionWorkflow({
          actor,
          organizationId: 42,
          exceptionId: 5,
          ownerUserId: 8,
          dueAt: new Date("2026-10-14T11:59:59.000Z"),
          approvalRequired: true,
          client,
        })
      )
    ).resolves.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/future/),
    });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("preserves a closed attempt and starts the next governed cycle with a new attempt number", async () => {
    const fake = scriptedDb({
      standing: {
        organizations: [{ id: 42 }],
        exceptions: [{ id: 5, status: "open" }],
        users: [{ id: 8 }],
        exception_workflows: [{ ...activeWorkflow, status: "closed", finalOutcome: "resolved" }],
      },
    });
    getDbMock.mockResolvedValue(fake.db);

    await startExceptionWorkflow({ actor, organizationId: 42, exceptionId: 5, ownerUserId: 8, dueAt, approvalRequired: true, client });

    expect(rowOf(fake.writes("insert", "exception_workflows")[0])).toMatchObject({ attemptNumber: 2 });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ attemptNumber: 2 }) }));
  });
});

describe("when an approval-controlled decision is recorded", () => {
  it("records escalation occurrence without duplicating the narrative in the audit event", async () => {
    const fake = scriptedDb({ standing: { exception_workflows: [activeWorkflow] } });
    getDbMock.mockResolvedValue(fake.db);

    await escalateExceptionWorkflow({
      actor,
      organizationId: 42,
      exceptionId: 5,
      note: "The counterparty must provide the missing settlement reference.",
      client,
    });

    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("counterparty");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ escalationNotePresent: true }) }));
  });

  it("requires a different user to approve it before the workflow can close", async () => {
    const submitted = {
      ...activeWorkflow,
      status: "decision_submitted" as const,
      decisionSubmittedByUserId: 71,
    };
    const fake = scriptedDb({ standing: { exception_workflows: [submitted] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      failureOf(() =>
        approveExceptionWorkflowDecision({
          actor,
          organizationId: 42,
          exceptionId: 5,
          approvalNote: "Reviewed against the approved source evidence.",
          client,
        })
      )
    ).resolves.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/different person/),
    });
    expect(fake.writes("update", "exception_workflows")).toHaveLength(0);
  });

  it("records approval occurrence without duplicating the approval narrative in audit metadata", async () => {
    const submitted = {
      ...activeWorkflow,
      status: "decision_submitted" as const,
      decisionSubmittedByUserId: 8,
    };
    const fake = scriptedDb({ standing: { exception_workflows: [submitted] } });
    getDbMock.mockResolvedValue(fake.db);

    await approveExceptionWorkflowDecision({
      actor,
      organizationId: 42,
      exceptionId: 5,
      approvalNote: "Second operator verified the evidence and approved the closure path.",
      client,
    });

    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("Second operator");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ approvalNotePresent: true }) }));
  });

  it("stores only the decision reference in the audit event, not the rationale itself", async () => {
    const fake = scriptedDb({
      standing: { exception_workflows: [activeWorkflow] },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      recordExceptionWorkflowDecision({
        actor,
        organizationId: 42,
        exceptionId: 5,
        rationale:
          "The settlement total reconciles after the documented timing adjustment.",
        evidenceReference: "CASE-42-5-EVIDENCE-01",
        client,
      })
    ).resolves.toEqual({ id: 91, status: "decision_submitted" });

    expect(
      rowOf(fake.writes("update", "exception_workflows")[0])
    ).toMatchObject({
      status: "decision_submitted",
      decisionRationale:
        "The settlement total reconciles after the documented timing adjustment.",
      decisionEvidenceReference: "CASE-42-5-EVIDENCE-01",
      decisionSubmittedByUserId: 71,
    });
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(
      "timing adjustment"
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          decisionEvidenceReference: "CASE-42-5-EVIDENCE-01",
        }),
      })
    );
  });

  it("refuses to close before an approval-required decision is approved", async () => {
    const submitted = {
      ...activeWorkflow,
      status: "decision_submitted" as const,
      decisionSubmittedByUserId: 8,
    };
    const fake = scriptedDb({ standing: { exception_workflows: [submitted] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      failureOf(() =>
        resolveExceptionWorkflow({
          actor,
          organizationId: 42,
          exceptionId: 5,
          outcome: "resolved",
          resolutionNotes: "Closed after a documented review.",
          client,
        })
      )
    ).resolves.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/approval/),
    });
    expect(fake.writes("update", "exceptions")).toHaveLength(0);
  });
});

describe("when an older client tries to close a governed exception directly", () => {
  it("uses a server-side refusal rather than trusting the client workflow UI", async () => {
    const fake = scriptedDb({
      select: {
        exception_workflows: [[{ ...activeWorkflow, status: "active" }]],
      },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      failureOf(() => assertLegacyExceptionResolutionPermitted(42, 5))
    ).resolves.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/governed workflow/),
    });
  });
});
