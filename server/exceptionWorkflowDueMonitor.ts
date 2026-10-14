import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { exceptionWorkflows, exceptions } from "../drizzle/schema";
import { getDb } from "./db";
import { loggableError } from "./dbErrors";
import { recordElapsedDeadline } from "./exceptionWorkflowDeadline";

export { DUE_DATE_ELAPSED_NOTE } from "./exceptionWorkflowDeadline";

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
 * The monitor is not the only recorder. Every governed write records an elapsed
 * deadline before it acts (exceptionWorkflowDeadline.ts), so the window between
 * passes cannot be used to move a missed deadline out of sight.
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

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type DueCandidate = {
  id: number;
  organizationId: number;
  exceptionId: number;
};

const CANDIDATE_FIELDS = {
  id: exceptionWorkflows.id,
  organizationId: exceptionWorkflows.organizationId,
  exceptionId: exceptionWorkflows.exceptionId,
} as const;

const LOCKED_WORKFLOW_FIELDS = {
  ...CANDIDATE_FIELDS,
  ownerUserId: exceptionWorkflows.ownerUserId,
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
    if (!workflow) return false;
    // Re-checked under the locks: a write may have recorded it, closed the
    // attempt, or moved the deadline since the scan. `now` is the sweep's
    // as-of time, read before any lock wait. That is safe HERE and nowhere
    // else: the monitor only records, so an early clock can make it record
    // less, never let anything through. Every workflow write reads its clock
    // after taking these locks (lockOpenWorkflow), and catches what this skips.
    return (await recordElapsedDeadline(tx, exception, workflow, now, "due_monitor")) !== null;
  });
}

/**
 * Record every currently overdue workflow once. The candidate scan is only an
 * optimization; `expireOne` re-checks the durable predicate after obtaining
 * locks, so a restart, retry or second service instance cannot duplicate the
 * escalation evidence.
 *
 * One candidate's failure does not stop the pass. The scan is ordered by due
 * date, so a row that fails every time would otherwise be first in every batch
 * and block every deadline behind it, in every tenant, indefinitely.
 *
 * `organizationId` limits a sweep to one tenant, for a caller that must not
 * touch any other — an operator's targeted run, or a test on a shared database.
 * The scheduled monitor sweeps every tenant.
 */
export async function expireDueExceptionWorkflows(
  options: { now?: Date; organizationId?: number } = {},
): Promise<{ scanned: number; expired: number; failed: number }> {
  const now = options.now ?? new Date();
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
        options.organizationId === undefined ? undefined : eq(exceptionWorkflows.organizationId, options.organizationId),
      ),
    )
    .orderBy(exceptionWorkflows.dueAt, exceptionWorkflows.id)
    .limit(DUE_MONITOR_BATCH_SIZE);

  let expired = 0;
  let failed = 0;
  for (const candidate of candidates as DueCandidate[]) {
    try {
      if (await expireOne(db, candidate, now)) expired += 1;
    } catch (error) {
      failed += 1;
      console.error("[exception-workflow-due-monitor] could not record an elapsed due date; a later pass will retry", {
        workflowId: candidate.id,
        organizationId: candidate.organizationId,
        ...loggableError(error),
      });
    }
  }
  return { scanned: candidates.length, expired, failed };
}

let dueMonitorTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/**
 * An application-owned recurring sweep. It runs once at production boot and
 * then every minute. A failure is logged and the next interval retries from
 * durable `overdueAt IS NULL` state; no in-memory queue entry is required to
 * recover a missed deadline.
 */
export async function dueMonitorTick(): Promise<{ scanned: number; expired: number; failed: number } | null> {
  if (tickInFlight) return null;
  tickInFlight = true;
  try {
    const result = await expireDueExceptionWorkflows();
    if (result.expired > 0 || result.failed > 0) {
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
