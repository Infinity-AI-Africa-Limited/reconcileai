/**
 * The governed exception workflow against a REAL MySQL — CI's database only,
 * gated like the other *.db.test.ts files because the local .env names
 * production and this suite writes rows. It calls the service directly: no
 * router import, so nothing boots.
 *
 * What only a real engine can show:
 *   - the legacy close BLOCKS behind a Start that holds the exception's lock,
 *     then sees the new workflow and refuses (Greptile #194: it used to check
 *     outside any transaction and close the case regardless);
 *   - a revised decision and a superseded approval survive, as history rows;
 *   - one lock order: a refused Start and a reassignment racing on the same
 *     exception never deadlock.
 */
import { and, eq, inArray } from "drizzle-orm";
import mysql from "mysql2/promise";
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
  closeExceptionOutsideWorkflow,
  getExceptionWorkflow,
  recordExceptionWorkflowDecision,
  resolveExceptionWorkflow,
  startExceptionWorkflow,
  updateExceptionWorkflowOwnership,
} from "./exceptionWorkflow";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe.runIf(localDatabase)("when governed workflows run on a real database", () => {
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const otherOrganizationId = organizationId + 1;
  const client = { ip: "127.0.0.1", ua: "vitest" };
  let db: Db;
  let maker = { id: 0, role: "operations", organizationId };
  let checker = { id: 0, role: "operations", organizationId };
  const due = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  const insertedId = (result: unknown) => Number((result as { insertId?: number }).insertId);

  async function newException(org = organizationId, status: "open" | "resolved" = "open"): Promise<number> {
    const [result] = await db.insert(exceptions).values({
      organizationId: org,
      jobId: 1,
      transactionId: 1,
      category: "amount_mismatch",
      severity: "high",
      status,
    });
    return insertedId(result);
  }

  function failureOf(run: () => Promise<unknown>) {
    return run().then(
      () => ({ code: null as string | null, message: "" }),
      (error: { code?: string; message?: string }) => ({ code: error.code ?? "UNKNOWN", message: error.message ?? "" })
    );
  }

  beforeAll(async () => {
    const found = await getDb();
    if (!found) throw new Error("DATABASE_URL is local, but no database connection was made");
    db = found;
    for (const id of [organizationId, otherOrganizationId]) {
      await db.insert(organizations).values({ id, name: `Workflow proof ${id}`, code: `WFPROOF_${id}`, isDemo: true });
    }
    for (const who of ["maker", "checker"] as const) {
      const [result] = await db.insert(users).values({
        openId: `wf-${who}-${organizationId}`,
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
    const orgs = [organizationId, otherOrganizationId];
    for (const step of [
      () => db.delete(exceptionWorkflowEvents).where(inArray(exceptionWorkflowEvents.organizationId, orgs)),
      () => db.delete(exceptionWorkflows).where(inArray(exceptionWorkflows.organizationId, orgs)),
      () => db.delete(exceptions).where(inArray(exceptions.organizationId, orgs)),
      () => db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs)),
      () => db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, orgs)),
      () => db.delete(users).where(inArray(users.organizationId, orgs)),
      () => db.delete(organizations).where(inArray(organizations.id, orgs)),
    ]) {
      try {
        await step();
      } catch (error) {
        console.error("[exceptionWorkflow.db.test] cleanup step failed:", error);
      }
    }
  });

  it("should make the legacy close wait behind a Start holding the exception, then refuse it", async () => {
    const exceptionId = await newException();
    // Connection A plays a Start mid-flight: it holds the exception's lock and
    // has inserted its workflow, but has not committed.
    const starter = await mysql.createConnection({ uri: url });
    try {
      await starter.query("SET time_zone = '+00:00'");
      await starter.beginTransaction();
      await starter.query("SELECT id FROM exceptions WHERE id = ? FOR UPDATE", [exceptionId]);
      await starter.query(
        "INSERT INTO exception_workflows (organizationId, exceptionId, attemptNumber, ownerUserId, dueAt, approvalRequired, status, startedByUserId) VALUES (?, ?, 1, ?, NOW() + INTERVAL 1 DAY, true, 'active', ?)",
        [organizationId, exceptionId, maker.id, maker.id]
      );

      // B: the legacy close. It must queue behind A, not race past it.
      const legacy = failureOf(() =>
        closeExceptionOutsideWorkflow({ organizationId, exceptionId, status: "resolved", resolutionNotes: "Quick close", actorId: checker.id })
      );
      const early = await Promise.race([legacy.then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("waiting"), 500))]);
      expect(early).toBe("waiting");

      await starter.commit();
      expect(await legacy).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/governed workflow/) });
    } finally {
      await starter.end();
    }
    const [row] = await db.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, exceptionId));
    expect(row.status).toBe("open");
  });

  it("should keep every decision and approval in history when a decision is revised", async () => {
    const exceptionId = await newException();
    await startExceptionWorkflow({ actor: maker, organizationId, exceptionId, ownerUserId: maker.id, dueAt: due(), approvalRequired: true, client });
    await recordExceptionWorkflowDecision({ actor: maker, organizationId, exceptionId, rationale: "First: timing", evidenceReference: "CASE-1", client });
    await approveExceptionWorkflowDecision({ actor: checker, organizationId, exceptionId, approvalNote: "Approved first", client });
    await recordExceptionWorkflowDecision({ actor: maker, organizationId, exceptionId, rationale: "Second: duplicate", evidenceReference: "CASE-2", client });

    const revised = await getExceptionWorkflow(organizationId, exceptionId);
    expect(revised.workflow).toMatchObject({
      status: "decision_submitted",
      decisionRationale: "Second: duplicate",
      approvedByUserId: null,
      approvalNote: null,
    });
    expect(revised.history.map(event => [event.eventType, event.note])).toEqual([
      ["started", null],
      ["decision_recorded", "First: timing"],
      ["decision_approved", "Approved first"],
      ["decision_recorded", "Second: duplicate"],
    ]);
    expect(revised.people.map(person => person.name).sort()).toEqual(["Checker", "Maker"]);

    // The maker cannot approve their own revision; the checker can, and the case then closes.
    expect(await failureOf(() => approveExceptionWorkflowDecision({ actor: maker, organizationId, exceptionId, approvalNote: "Self", client }))).toMatchObject({
      code: "FORBIDDEN",
    });
    await approveExceptionWorkflowDecision({ actor: checker, organizationId, exceptionId, approvalNote: "Approved second", client });
    await resolveExceptionWorkflow({ actor: checker, organizationId, exceptionId, outcome: "resolved", resolutionNotes: "Duplicate reversed", client });

    const closed = await getExceptionWorkflow(organizationId, exceptionId);
    expect(closed.exceptionStatus).toBe("resolved");
    expect(closed.workflow?.status).toBe("closed");
    expect(closed.history.at(-1)).toMatchObject({ eventType: "closed", note: "Duplicate reversed", outcome: "resolved" });
  });

  it("should never deadlock a refused Start against a reassignment of the same exception", async () => {
    const exceptionId = await newException();
    await startExceptionWorkflow({ actor: maker, organizationId, exceptionId, ownerUserId: maker.id, dueAt: due(), approvalRequired: false, client });

    const outcomes = [];
    for (let round = 0; round < 15; round++) {
      outcomes.push(
        ...(await Promise.all([
          failureOf(() => startExceptionWorkflow({ actor: maker, organizationId, exceptionId, ownerUserId: checker.id, dueAt: due(), approvalRequired: false, client })),
          failureOf(() => updateExceptionWorkflowOwnership({ actor: maker, organizationId, exceptionId, ownerUserId: round % 2 ? maker.id : checker.id, dueAt: due(), client })),
        ]))
      );
    }
    const codes = outcomes.map(outcome => outcome.code);
    expect(outcomes.some(outcome => /deadlock/i.test(outcome.message))).toBe(false);
    expect(codes.filter(code => code === "CONFLICT")).toHaveLength(15);
    expect(codes.filter(code => code === null)).toHaveLength(15);
  });

  it("should answer another tenant's exception as not found and leave it untouched", async () => {
    const foreign = await newException(otherOrganizationId);
    expect(
      await failureOf(() => closeExceptionOutsideWorkflow({ organizationId, exceptionId: foreign, status: "resolved", resolutionNotes: null, actorId: maker.id }))
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(await failureOf(() => getExceptionWorkflow(organizationId, foreign))).toMatchObject({ code: "NOT_FOUND" });
    const [row] = await db.select({ status: exceptions.status }).from(exceptions).where(and(eq(exceptions.id, foreign)));
    expect(row.status).toBe("open");
  });
});
