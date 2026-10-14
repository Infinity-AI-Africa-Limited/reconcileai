/**
 * Real-MySQL proof for the application-owned due-date control. CI supplies an
 * isolated local database; a developer's production DATABASE_URL must never
 * be used for this test. It proves the monitor's durable state, a restart-safe
 * second pass, approval withdrawal, and fail-closed late closure.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditChainLocks,
  auditLogs,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  organizations,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { classifyDatabaseTarget } from "./dbTarget";
import {
  approveExceptionWorkflowDecision,
  recordExceptionWorkflowDecision,
  resolveExceptionWorkflow,
  startExceptionWorkflow,
} from "./exceptionWorkflow";
import { expireDueExceptionWorkflows } from "./exceptionWorkflowDueMonitor";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null as string | null, message: "" }),
    (error: { code?: string; message?: string }) => ({ code: error.code ?? "UNKNOWN", message: error.message ?? "" }),
  );
}

describe.runIf(localDatabase)("when the governed due-date monitor uses a real database", () => {
  const organizationId = 910_000_000 + Math.floor(Math.random() * 1_000_000);
  const client = { ip: "127.0.0.1", ua: "vitest-overdue-control" };
  const now = new Date(Date.now() - 10_000);
  const due = new Date(now.getTime() - 1_000);
  let db: Db;
  let maker = { id: 0, role: "operations", organizationId };
  let checker = { id: 0, role: "operations", organizationId };

  const insertedId = (result: unknown) => Number((result as { insertId?: number }).insertId);

  async function newException(): Promise<number> {
    const [result] = await db.insert(exceptions).values({
      organizationId,
      jobId: 1,
      transactionId: 1,
      category: "amount_mismatch",
      severity: "high",
      status: "open",
    });
    return insertedId(result);
  }

  /** Start validly, then use a masked test clock state: production's monitor, not the test, observes expiry. */
  async function startedException(approvalRequired: boolean): Promise<number> {
    const exceptionId = await newException();
    await startExceptionWorkflow({
      actor: maker,
      organizationId,
      exceptionId,
      ownerUserId: maker.id,
      dueAt: new Date(Date.now() + 60_000),
      approvalRequired,
      client,
    });
    await db
      .update(exceptionWorkflows)
      .set({ dueAt: due })
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
    return exceptionId;
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    await db.insert(organizations).values({ id: organizationId, name: `Overdue control proof ${organizationId}`, code: `OVERDUE_${organizationId}`, isDemo: true });
    for (const who of ["maker", "checker"] as const) {
      const [result] = await db.insert(users).values({
        openId: `overdue-${who}-${organizationId}`,
        name: who === "maker" ? "Maker" : "Checker",
        role: "operations",
        organizationId,
        loginMethod: "email",
      });
      const person = { id: insertedId(result), role: "operations", organizationId };
      if (who === "maker") maker = person;
      else checker = person;
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const step of [
      () => db.delete(exceptionWorkflowEvents).where(eq(exceptionWorkflowEvents.organizationId, organizationId)),
      () => db.delete(exceptionWorkflows).where(eq(exceptionWorkflows.organizationId, organizationId)),
      () => db.delete(exceptions).where(eq(exceptions.organizationId, organizationId)),
      () => db.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId)),
      () => db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, [organizationId])),
      () => db.delete(users).where(eq(users.organizationId, organizationId)),
      () => db.delete(organizations).where(eq(organizations.id, organizationId)),
    ]) {
      try {
        await step();
      } catch (error) {
        console.error("[exceptionWorkflowDueMonitor.db.test] cleanup step failed:", error);
      }
    }
  });

  it("records one durable system expiry across a retry and never duplicates the event", async () => {
    const exceptionId = await startedException(false);

    expect(await expireDueExceptionWorkflows(now)).toEqual({ scanned: 1, expired: 1 });
    expect(await expireDueExceptionWorkflows(now)).toEqual({ scanned: 0, expired: 0 });

    const [workflow] = await db
      .select({ status: exceptionWorkflows.status, overdueAt: exceptionWorkflows.overdueAt, ownerUserId: exceptionWorkflows.ownerUserId })
      .from(exceptionWorkflows)
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
    expect(workflow).toMatchObject({ status: "escalated", ownerUserId: maker.id });
    // MySQL TIMESTAMP precision is deployment-configured; prove the monitor
    // wrote the durable marker without assuming millisecond preservation.
    expect(workflow.overdueAt).not.toBeNull();
    expect(workflow.overdueAt!.getTime()).toBeLessThanOrEqual(now.getTime());

    const [exception] = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, exceptionId));
    expect(exception.status).toBe("escalated");
    const expiryEvents = await db
      .select({ eventType: exceptionWorkflowEvents.eventType, actorUserId: exceptionWorkflowEvents.actorUserId })
      .from(exceptionWorkflowEvents)
      .where(and(eq(exceptionWorkflowEvents.organizationId, organizationId), eq(exceptionWorkflowEvents.exceptionId, exceptionId), eq(exceptionWorkflowEvents.eventType, "due_date_elapsed")));
    expect(expiryEvents).toEqual([{ eventType: "due_date_elapsed", actorUserId: null }]);
    const [audit] = await db
      .select({ action: auditLogs.action, userId: auditLogs.userId })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, "exception_workflow_due_date_elapsed")));
    expect(audit).toEqual({ action: "exception_workflow_due_date_elapsed", userId: null });
  });

  it("withdraws a pre-expiry approval and permits closure only after renewed approval plus late evidence", async () => {
    const exceptionId = await newException();
    await startExceptionWorkflow({
      actor: maker,
      organizationId,
      exceptionId,
      ownerUserId: maker.id,
      dueAt: new Date(Date.now() + 60_000),
      approvalRequired: true,
      client,
    });
    await recordExceptionWorkflowDecision({ actor: maker, organizationId, exceptionId, rationale: "Masked timing difference", evidenceReference: "MASKED-CASE-1", client });
    await approveExceptionWorkflowDecision({ actor: checker, organizationId, exceptionId, approvalNote: "Checked before expiry", client });
    await db
      .update(exceptionWorkflows)
      .set({ dueAt: due })
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));

    expect(await expireDueExceptionWorkflows(now)).toEqual({ scanned: 1, expired: 1 });
    const [expired] = await db
      .select({ status: exceptionWorkflows.status, approvedByUserId: exceptionWorkflows.approvedByUserId, overdueAt: exceptionWorkflows.overdueAt })
      .from(exceptionWorkflows)
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
    expect(expired.status).toBe("decision_submitted");
    expect(expired.approvedByUserId).toBeNull();
    expect(expired.overdueAt).not.toBeNull();

    expect(await failureOf(() => resolveExceptionWorkflow({
      actor: checker, organizationId, exceptionId, outcome: "resolved", resolutionNotes: "Masked outcome", client,
    }))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/separate human approval/i) });

    await approveExceptionWorkflowDecision({ actor: checker, organizationId, exceptionId, approvalNote: "Rechecked after overdue evidence", client });
    expect(await failureOf(() => resolveExceptionWorkflow({
      actor: checker, organizationId, exceptionId, outcome: "resolved", resolutionNotes: "Masked outcome", client,
    }))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/late-resolution reason/i) });

    await resolveExceptionWorkflow({
      actor: checker,
      organizationId,
      exceptionId,
      outcome: "resolved",
      resolutionNotes: "Masked outcome",
      lateResolutionReason: "Rechecked after the expired deadline against masked source evidence",
      client,
    });
    const [closed] = await db
      .select({ status: exceptionWorkflows.status, lateResolutionReason: exceptionWorkflows.lateResolutionReason })
      .from(exceptionWorkflows)
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
    expect(closed).toMatchObject({ status: "closed", lateResolutionReason: "Rechecked after the expired deadline against masked source evidence" });
    const [closureEvent] = await db
      .select({ lateResolutionReason: exceptionWorkflowEvents.lateResolutionReason })
      .from(exceptionWorkflowEvents)
      .where(and(eq(exceptionWorkflowEvents.organizationId, organizationId), eq(exceptionWorkflowEvents.exceptionId, exceptionId), eq(exceptionWorkflowEvents.eventType, "closed")));
    expect(closureEvent.lateResolutionReason).toBe("Rechecked after the expired deadline against masked source evidence");
  });
});
