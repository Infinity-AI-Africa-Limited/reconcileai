/**
 * Real-MySQL proof for the application-owned due-date control. CI supplies an
 * isolated local database; a developer's production DATABASE_URL must never
 * be used for this test. It proves the monitor's durable state, a restart-safe
 * second pass, approval withdrawal, fail-closed late closure, and that no
 * governed write can move a missed deadline out of the monitor's sight.
 *
 * Every sweep here is limited to this test's own organization. A local
 * database is not necessarily an empty one — a developer's holds their own
 * cases, and CI runs other database tests beside this one — and an unscoped
 * sweep would escalate their overdue workflows, fail the exact counts below,
 * and leave changes the cleanup (which removes only this organization's rows)
 * cannot undo.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
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
  updateExceptionWorkflowOwnership,
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
  // Someone else's overdue case, standing in for whatever else the database
  // holds. No sweep here may touch it.
  const bystanderOrganizationId = organizationId + 1;
  let bystanderWorkflowId = 0;
  const client = { ip: "127.0.0.1", ua: "vitest-overdue-control" };
  // A whole second, so the stored value can be compared exactly. A TIMESTAMP
  // column keeps no fraction, and MySQL ROUNDS one rather than truncating it:
  // an instant at .959 is stored as the next second, which made "recorded no
  // later than now" fail about half the time.
  const now = new Date(Math.floor((Date.now() - 10_000) / 1000) * 1000);
  const due = new Date(now.getTime() - 1_000);
  const sweep = () => expireDueExceptionWorkflows({ now, organizationId });
  let db: Db;
  let maker = { id: 0, role: "operations", organizationId };
  let checker = { id: 0, role: "operations", organizationId };

  const insertedId = (result: unknown) => Number((result as { insertId?: number }).insertId);

  async function newException(): Promise<number> {
    const [result] = await db.insert(exceptions).values({
      organizationId,
      // No job or transaction owns these rows, so they name ids none can have:
      // `1` is the first real job in a fresh database, and another test reading
      // that job's exceptions in parallel would find these too.
      jobId: organizationId,
      transactionId: organizationId,
      category: "amount_mismatch",
      severity: "high",
      status: "open",
    });
    return insertedId(result);
  }

  /** Start validly; the deadline is then moved into the past directly, as only time could move it. */
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
    return exceptionId;
  }

  async function missDeadline(exceptionId: number) {
    await db
      .update(exceptionWorkflows)
      .set({ dueAt: due })
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
  }

  async function approvedBeforeDeadline(): Promise<number> {
    const exceptionId = await startedException(true);
    await recordExceptionWorkflowDecision({ actor: maker, organizationId, exceptionId, rationale: "Masked timing difference", evidenceReference: "MASKED-CASE-1", client });
    await approveExceptionWorkflowDecision({ actor: checker, organizationId, exceptionId, approvalNote: "Checked before expiry", client });
    await missDeadline(exceptionId);
    return exceptionId;
  }

  async function workflowOf(exceptionId: number) {
    const [workflow] = await db
      .select({
        status: exceptionWorkflows.status,
        overdueAt: exceptionWorkflows.overdueAt,
        dueAt: exceptionWorkflows.dueAt,
        ownerUserId: exceptionWorkflows.ownerUserId,
        approvedByUserId: exceptionWorkflows.approvedByUserId,
        lateResolutionReason: exceptionWorkflows.lateResolutionReason,
      })
      .from(exceptionWorkflows)
      .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptionWorkflows.exceptionId, exceptionId)));
    return workflow;
  }

  async function eventsOf(exceptionId: number) {
    return db
      .select({
        eventType: exceptionWorkflowEvents.eventType,
        actorUserId: exceptionWorkflowEvents.actorUserId,
        dueAt: exceptionWorkflowEvents.dueAt,
        lateResolutionReason: exceptionWorkflowEvents.lateResolutionReason,
      })
      .from(exceptionWorkflowEvents)
      .where(and(eq(exceptionWorkflowEvents.organizationId, organizationId), eq(exceptionWorkflowEvents.exceptionId, exceptionId)))
      .orderBy(asc(exceptionWorkflowEvents.id));
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

    await db.insert(organizations).values({ id: bystanderOrganizationId, name: `Overdue bystander ${bystanderOrganizationId}`, code: `OVERDUE_${bystanderOrganizationId}`, isDemo: true });
    const [bystanderException] = await db.insert(exceptions).values({
      organizationId: bystanderOrganizationId,
      jobId: bystanderOrganizationId,
      transactionId: bystanderOrganizationId,
      category: "amount_mismatch",
      severity: "high",
      status: "in_review",
    });
    const [bystanderWorkflow] = await db.insert(exceptionWorkflows).values({
      organizationId: bystanderOrganizationId,
      exceptionId: insertedId(bystanderException),
      attemptNumber: 1,
      ownerUserId: maker.id,
      dueAt: due,
      approvalRequired: false,
      status: "active",
      startedByUserId: maker.id,
    });
    bystanderWorkflowId = insertedId(bystanderWorkflow);
  });

  afterAll(async () => {
    if (!db) return;
    for (const step of [
      () => db.delete(exceptionWorkflowEvents).where(inArray(exceptionWorkflowEvents.organizationId, [organizationId, bystanderOrganizationId])),
      () => db.delete(exceptionWorkflows).where(inArray(exceptionWorkflows.organizationId, [organizationId, bystanderOrganizationId])),
      () => db.delete(exceptions).where(inArray(exceptions.organizationId, [organizationId, bystanderOrganizationId])),
      () => db.delete(auditLogs).where(inArray(auditLogs.organizationId, [organizationId, bystanderOrganizationId])),
      () => db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, [organizationId, bystanderOrganizationId])),
      () => db.delete(users).where(eq(users.organizationId, organizationId)),
      () => db.delete(organizations).where(inArray(organizations.id, [organizationId, bystanderOrganizationId])),
    ]) {
      try {
        await step();
      } catch (error) {
        console.error("[exceptionWorkflowDueMonitor.db.test] cleanup step failed:", error);
      }
    }
  });

  it("should record one durable system expiry across a retry and never duplicate the event", async () => {
    const exceptionId = await startedException(false);
    await missDeadline(exceptionId);

    expect(await sweep()).toEqual({ scanned: 1, expired: 1, failed: 0 });
    expect(await sweep()).toEqual({ scanned: 0, expired: 0, failed: 0 });

    const workflow = await workflowOf(exceptionId);
    expect(workflow).toMatchObject({ status: "escalated", ownerUserId: maker.id });
    expect(workflow.overdueAt?.getTime()).toBe(now.getTime());

    const [exception] = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, exceptionId));
    expect(exception.status).toBe("escalated");
    const expiryEvents = (await eventsOf(exceptionId)).filter(event => event.eventType === "due_date_elapsed");
    // The event keeps the deadline that was missed: the row's can change later.
    expect(expiryEvents).toEqual([{ eventType: "due_date_elapsed", actorUserId: null, dueAt: due, lateResolutionReason: null }]);
    const [audit] = await db
      .select({ action: auditLogs.action, userId: auditLogs.userId })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, "exception_workflow_due_date_elapsed")));
    expect(audit).toEqual({ action: "exception_workflow_due_date_elapsed", userId: null });
  });

  it("should withdraw a pre-expiry approval and permit closure only after renewed approval plus late evidence", async () => {
    const exceptionId = await approvedBeforeDeadline();

    expect(await sweep()).toEqual({ scanned: 1, expired: 1, failed: 0 });
    const expired = await workflowOf(exceptionId);
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
    expect(await workflowOf(exceptionId)).toMatchObject({
      status: "closed",
      lateResolutionReason: "Rechecked after the expired deadline against masked source evidence",
    });
    const closure = (await eventsOf(exceptionId)).find(event => event.eventType === "closed");
    expect(closure?.lateResolutionReason).toBe("Rechecked after the expired deadline against masked source evidence");
  });

  it("should record a missed deadline before a reassignment moves it, leaving the monitor nothing to find", async () => {
    // The gap this closes: between monitor passes, moving an elapsed deadline
    // into the future used to hide it from the monitor for good, and the case
    // then closed on its old approval with no late evidence at all.
    const exceptionId = await approvedBeforeDeadline();
    const extended = new Date(Date.now() + 3_600_000);

    await updateExceptionWorkflowOwnership({ actor: maker, organizationId, exceptionId, ownerUserId: checker.id, dueAt: extended, client });

    const moved = await workflowOf(exceptionId);
    expect(moved).toMatchObject({ status: "decision_submitted", approvedByUserId: null, ownerUserId: checker.id });
    expect(moved.overdueAt).not.toBeNull();
    expect(moved.dueAt.getTime()).toBeGreaterThan(Date.now());
    expect((await eventsOf(exceptionId)).map(event => event.eventType).slice(-2)).toEqual(["due_date_elapsed", "reassigned"]);
    expect(await sweep()).toEqual({ scanned: 0, expired: 0, failed: 0 });

    // The later deadline does not make the case on time again.
    expect(await failureOf(() => resolveExceptionWorkflow({
      actor: maker, organizationId, exceptionId, outcome: "resolved", resolutionNotes: "Masked outcome", lateResolutionReason: "r", client,
    }))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/separate human approval/i) });
  });

  it("should keep the deadline's record when the close that found it is refused", async () => {
    // Recorded inside the refused close, the record would roll back with it,
    // and the case would go on showing its withdrawn approval.
    const exceptionId = await approvedBeforeDeadline();

    expect(await failureOf(() => resolveExceptionWorkflow({
      actor: checker, organizationId, exceptionId, outcome: "resolved", resolutionNotes: "Masked outcome", lateResolutionReason: "r", client,
    }))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/missed its due date/i) });

    const refused = await workflowOf(exceptionId);
    expect(refused).toMatchObject({ status: "decision_submitted", approvedByUserId: null });
    expect(refused.overdueAt).not.toBeNull();
    expect((await eventsOf(exceptionId)).map(event => event.eventType).at(-1)).toBe("due_date_elapsed");
  });

  // Last on purpose: every sweep above has run by now.
  it("should have left another organization's overdue case untouched by every sweep", async () => {
    const [bystander] = await db
      .select({ overdueAt: exceptionWorkflows.overdueAt, status: exceptionWorkflows.status })
      .from(exceptionWorkflows)
      .where(eq(exceptionWorkflows.id, bystanderWorkflowId));
    expect(bystander).toEqual({ overdueAt: null, status: "active" });
  });
});
