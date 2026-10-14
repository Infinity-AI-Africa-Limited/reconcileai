import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { exceptionWorkflowEvents, exceptionWorkflows, exceptions } from "../drizzle/schema";
import { getDb } from "./db";
import { loggableError } from "./dbErrors";
import { logAuditStrict } from "./routers/shared";

/**
 * Application-owned overdue control for governed exception workflows.
 *
 * A browser clock and a stored `dueAt` are not an operating control. This
 * monitor repeatedly finds workflow rows whose due date has elapsed and whose
 * expiry has not already been recorded. The durable fact is `overdueAt`, not
 * the timer: a restart, another instance, or a transient query failure simply
 * leaves the row eligible for the next pass. Each candidate is re-read under
 * the same exception → workflow lock order as manual workflow writes, then
 * conditionally marked once. That makes duplicate passes and concurrent
 * instances harmless.
 *
 * The monitor never makes a financial decision, moves funds, posts to a
 * ledger, or closes an exception. It records the elapsed deadline, makes the
 * exception visibly escalated, and withdraws an existing approval only when
 * the customer required a separate approver. A later human decision and
 * separate approval remain required for closure.
 */

const OPEN_STATUSES = [
  "active",
  "escalated",
  "decision_recorded",
  "decision_submitted",
  "approved",
] as const;

const DUE_MONITOR_BATCH_SIZE = 100;
export const EXCEPTION_WORKFLOW_DUE_MONITOR_INTERVAL_MS = 60_000;
export const DUE_DATE_ELAPSED_NOTE = "Due date elapsed; system escalation recorded.";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkflowStatus = (typeof OPEN_STATUSES)[number];

type DueCandidate = {
  id: number;
  organizationId: number;
  exceptionId: number;
};

type LockedWorkflow = DueCandidate & {
  dueAt: Date;
  overdueAt: Date | null;
  approvalRequired: boolean;
  status: WorkflowStatus | "closed";
};

const CANDIDATE_FIELDS = {
  id: exceptionWorkflows.id,
  organizationId: exceptionWorkflows.organizationId,
  exceptionId: exceptionWorkflows.exceptionId,
} as const;

const LOCKED_WORKFLOW_FIELDS = {
  ...CANDIDATE_FIELDS,
  dueAt: exceptionWorkflows.dueAt,
  overdueAt: exceptionWorkflows.overdueAt,
  approvalRequired: exceptionWorkflows.approvalRequired,
  status: exceptionWorkflows.status,
} as const;

/** A timer runs only in the actual production service; the data state is recoverable across a restart. */
export function dueMonitorEnabledHere(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: string } {
  if (env.VITEST) return { enabled: false, reason: "test process" };
  if (env.NODE_ENV !== "production") return { enabled: false, reason: "not a production service" };
  return { enabled: true, reason: "production service" };
}

/** MySQL2 returns a ResultSetHeader inside an array; test adapters use the same observable shape. */
function affectedRowsOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  const value = (header as { affectedRows?: unknown }).affectedRows;
  return typeof value === "number" ? value : Number(value) || 0;
}

function nextStatus(workflow: LockedWorkflow): WorkflowStatus {
  // `expireOne` already excludes this, but keep the helper independently
  // correct if a caller changes its precondition later.
  if (workflow.status === "closed") throw new Error("A closed workflow cannot become overdue");
  // An expiry does not erase the decision. It does invalidate an approval that
  // pre-dated the missed deadline, so a distinct person must approve again.
  if (workflow.approvalRequired && workflow.status === "approved") return "decision_submitted";
  return workflow.status === "active" ? "escalated" : workflow.status;
}

async function expireOne(
  db: Db,
  candidate: DueCandidate,
  now: Date,
): Promise<boolean> {
  return db.transaction(async tx => {
    // Preserve the workflow service's lock order. Locking workflow first and
    // then the exception would deadlock with a manual close (exception first).
    const [exception] = await tx
      .select({ id: exceptions.id, status: exceptions.status })
      .from(exceptions)
      .where(and(eq(exceptions.id, candidate.exceptionId), eq(exceptions.organizationId, candidate.organizationId)))
      .limit(1)
      .for("update");
    if (!exception) return false;

    const [workflow] = await tx
      .select(LOCKED_WORKFLOW_FIELDS)
      .from(exceptionWorkflows)
      .where(
        and(
          eq(exceptionWorkflows.id, candidate.id),
          eq(exceptionWorkflows.organizationId, candidate.organizationId),
          eq(exceptionWorkflows.exceptionId, candidate.exceptionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!workflow || workflow.overdueAt !== null || workflow.dueAt.getTime() > now.getTime() || workflow.status === "closed") {
      return false;
    }

    const locked = workflow as LockedWorkflow;
    const status = nextStatus(locked);
    const approvalInvalidated = locked.approvalRequired && locked.status === "approved";
    const update = await tx
      .update(exceptionWorkflows)
      .set({
        status,
        overdueAt: now,
        escalatedAt: now,
        escalatedByUserId: null,
        ...(approvalInvalidated
          ? { approvedByUserId: null, approvedAt: null, approvalNote: null }
          : {}),
      })
      .where(
        and(
          eq(exceptionWorkflows.id, locked.id),
          eq(exceptionWorkflows.organizationId, locked.organizationId),
          isNull(exceptionWorkflows.overdueAt),
          eq(exceptionWorkflows.status, locked.status),
          lte(exceptionWorkflows.dueAt, now),
        ),
      );
    // The guard makes a repeated or racing monitor pass a no-op. Never append
    // an event or audit record when this pass did not claim the workflow.
    if (affectedRowsOf(update) !== 1) return false;

    await tx
      .update(exceptions)
      .set({ status: "escalated" })
      .where(and(eq(exceptions.id, locked.exceptionId), eq(exceptions.organizationId, locked.organizationId)));
    await tx.insert(exceptionWorkflowEvents).values({
      organizationId: locked.organizationId,
      workflowId: locked.id,
      exceptionId: locked.exceptionId,
      eventType: "due_date_elapsed",
      actorUserId: null,
      note: DUE_DATE_ELAPSED_NOTE,
    });
    await logAuditStrict({
      userId: null,
      organizationId: locked.organizationId,
      action: "exception_workflow_due_date_elapsed",
      entityType: "exception_workflow",
      entityId: locked.id,
      details: {
        exceptionId: locked.exceptionId,
        previousStatus: locked.status,
        status,
        approvalInvalidated,
      },
      executor: tx,
    });
    return true;
  });
}

/**
 * Record every currently overdue workflow once. The candidate scan is only an
 * optimization; `expireOne` re-checks the durable predicate after obtaining
 * locks, so a restart, retry or second service instance cannot duplicate the
 * escalation evidence.
 */
export async function expireDueExceptionWorkflows(now = new Date()): Promise<{ scanned: number; expired: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable for governed exception due-date control");
  const candidates = await db
    .select(CANDIDATE_FIELDS)
    .from(exceptionWorkflows)
    .where(
      and(
        isNull(exceptionWorkflows.overdueAt),
        lte(exceptionWorkflows.dueAt, now),
        inArray(exceptionWorkflows.status, OPEN_STATUSES),
      ),
    )
    .orderBy(exceptionWorkflows.dueAt, exceptionWorkflows.id)
    .limit(DUE_MONITOR_BATCH_SIZE);

  let expired = 0;
  for (const candidate of candidates as DueCandidate[]) {
    if (await expireOne(db, candidate, now)) expired += 1;
  }
  return { scanned: candidates.length, expired };
}

let dueMonitorTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/**
 * An application-owned recurring sweep. It runs once at production boot and
 * then every minute. A failure is logged and the next interval retries from
 * durable `overdueAt IS NULL` state; no in-memory queue entry is required to
 * recover a missed deadline.
 */
export async function dueMonitorTick(): Promise<{ scanned: number; expired: number } | null> {
  if (tickInFlight) return null;
  tickInFlight = true;
  try {
    const result = await expireDueExceptionWorkflows();
    if (result.expired > 0) {
      console.warn("[exception-workflow-due-monitor] recorded elapsed due dates", result);
    }
    return result;
  } catch (error) {
    console.error("[exception-workflow-due-monitor] pass failed; a later pass will retry", loggableError(error));
    return null;
  } finally {
    tickInFlight = false;
  }
}

export function startExceptionWorkflowDueMonitor(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = EXCEPTION_WORKFLOW_DUE_MONITOR_INTERVAL_MS,
): NodeJS.Timeout | null {
  const enabled = dueMonitorEnabledHere(env);
  if (!enabled.enabled) {
    if (!env.VITEST) console.log(`[exception-workflow-due-monitor] not started: ${enabled.reason}`);
    return null;
  }
  if (dueMonitorTimer) return dueMonitorTimer;
  console.log(`[exception-workflow-due-monitor] starting every ${intervalMs}ms`);
  void dueMonitorTick();
  dueMonitorTimer = setInterval(() => { void dueMonitorTick(); }, intervalMs);
  dueMonitorTimer.unref?.();
  return dueMonitorTimer;
}

export function stopExceptionWorkflowDueMonitor(): void {
  if (!dueMonitorTimer) return;
  clearInterval(dueMonitorTimer);
  dueMonitorTimer = null;
}
