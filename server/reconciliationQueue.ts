/**
 * Durable reconciliation run execution (multi-source robustness item #1).
 *
 * Runs used to be fired in-process and forgotten — a deploy or crash mid-run
 * lost the job silently and left it stuck "running". Runs now go through the
 * queue abstraction (server/jobQueue.ts): with REDIS_URL set they are durable
 * BullMQ jobs that survive restarts; without it they get the in-process
 * retry queue (same behavior as before, plus bounded retries and structured
 * failure marking).
 *
 * Correctness under retry:
 *   - IDEMPOTENCY GUARD: a job already "completed" is never re-run.
 *   - ARTIFACT RESET: every attempt starts by deleting the job's partial
 *     matches/exceptions and resetting the touched transactions back to
 *     "unmatched" — a crash between writes cannot double-post on retry.
 *   - RETRY SIGNAL: the runner (routers.ts runReconciliation) swallows its own
 *     errors and marks the job "failed"; the handler reloads the status after
 *     the run and THROWS on failure so the queue drives the retry/backoff.
 *   - BOOT SWEEP: recoverStuckReconciliationJobs() marks jobs stuck in
 *     pending/running for >2h as failed (crash orphans under the in-process
 *     backend), so the dashboard never shows immortal spinners.
 *   - ABANDONMENT GUARD: the sweep also stamps `abandonedAt`, and the handler
 *     treats an abandoned job as terminal. Marking the DB row failed does not
 *     delete the durable queue entry, so without this a BullMQ job delivered
 *     after the sweep would reset artifacts and re-run work the user was
 *     already shown as failed — "failed" alone cannot carry that meaning,
 *     because the retry contract above depends on re-running failed jobs.
 *
 * The runner itself stays in routers.ts (it closes over that module's helpers)
 * and is REGISTERED here at module load — no import cycle. The full extraction
 * to server/reconciliationRunner.ts remains split-plan item 12.
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { reconciliationJobs, matches, exceptions as exceptionsTable, transactions } from "../drizzle/schema";
import { createQueue, type JobQueue } from "./jobQueue";
import { ENV } from "./_core/env";

export interface ReconciliationRunPayload {
  jobId: number;
  sourceChannelId: number;
  targetChannelId: number;
  dateFromIso: string;
  dateToIso: string;
  config: { amountTolerance: number; dateWindowDays: number };
  userId: number;
}

export type ReconciliationRunner = (
  jobId: number,
  sourceChannelId: number,
  targetChannelId: number,
  dateFrom: Date,
  dateTo: Date,
  config: { amountTolerance: number; dateWindowDays: number },
  userId: number,
) => Promise<void>;

const MAX_RUN_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 60_000;
const STUCK_JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h

let runner: ReconciliationRunner | null = null;

/** routers.ts registers its runReconciliation here at module load. */
export function registerReconciliationRunner(fn: ReconciliationRunner): void {
  runner = fn;
}

// ─── Artifact reset (retry safety) ───────────────────────────────────────────

/**
 * Delete the job's matches/exceptions and reset the transactions they touched
 * to "unmatched" so a retried run starts from a clean slate. No-op on a fresh
 * job. Chunked to stay inside IN() limits.
 */
export async function resetJobArtifacts(jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const matchRows = await db
    .select({ s: matches.sourceTransactionId, t: matches.targetTransactionId })
    .from(matches)
    .where(eq(matches.jobId, jobId));
  const excRows = await db
    .select({ id: exceptionsTable.transactionId })
    .from(exceptionsTable)
    .where(eq(exceptionsTable.jobId, jobId));

  const txnIds = new Set<number>();
  for (const m of matchRows) { txnIds.add(m.s); txnIds.add(m.t); }
  for (const e of excRows) txnIds.add(e.id);

  const ids = Array.from(txnIds);
  for (let i = 0; i < ids.length; i += 500) {
    await db
      .update(transactions)
      .set({ status: "unmatched", matchId: null })
      .where(inArray(transactions.id, ids.slice(i, i + 500)));
  }

  await db.delete(matches).where(eq(matches.jobId, jobId));
  await db.delete(exceptionsTable).where(eq(exceptionsTable.jobId, jobId));
  await db
    .update(reconciliationJobs)
    .set({ matchedCount: 0, exceptionCount: 0, unmatchedCount: 0, excludedCount: 0, excludedItems: null, matchRate: null })
    .where(eq(reconciliationJobs.id, jobId));
}

// ─── Handler (dependency-injectable for tests) ───────────────────────────────

/** What the handler needs to decide whether this job may still execute. */
export interface JobExecutionState {
  status: string;
  /** Set by the boot sweep — the job has been declared dead. See below. */
  abandonedAt: Date | null;
}

export interface RunHandlerDeps {
  loadJobState(jobId: number): Promise<JobExecutionState | null>; // null = job gone
  resetArtifacts(jobId: number): Promise<void>;
  getRunner(): ReconciliationRunner | null;
}

const defaultDeps: RunHandlerDeps = {
  async loadJobState(jobId) {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [row] = await db
      .select({ status: reconciliationJobs.status, abandonedAt: reconciliationJobs.abandonedAt })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.id, jobId))
      .limit(1);
    return row ? { status: row.status, abandonedAt: row.abandonedAt ?? null } : null;
  },
  resetArtifacts: resetJobArtifacts,
  getRunner: () => runner,
};

/** Exported factory so tests can inject fakes (the live DB is shared — never test against it). */
export function makeRunHandler(deps: RunHandlerDeps) {
  return async function handle(job: { data: ReconciliationRunPayload; attempt: number }): Promise<void> {
    const p = job.data;

    const state = await deps.loadJobState(p.jobId);
    if (state === null) return; // job deleted — nothing to do
    if (state.status === "completed" || state.status === "cancelled") return; // idempotency guard

    // ABANDONMENT GUARD.
    //
    // "failed" deliberately does NOT stop us here: the retry contract below
    // depends on re-running a job the runner just marked failed. But that makes
    // the boot sweep's output indistinguishable from a retryable failure, and
    // the two must not be treated alike.
    //
    // recoverStuckReconciliationJobs() marks a >2h pending/running job failed
    // WITHOUT being able to delete the durable queue entry that may still exist
    // for it. Under BullMQ that entry outlives the sweep and can be delivered
    // afterwards — at which point this handler would reset the job's artifacts
    // and re-run work the user has already been shown as failed, possibly while
    // the original run is still alive on another worker. The sweep therefore
    // stamps `abandonedAt`, and an abandoned job is terminal here.
    if (state.abandonedAt != null) {
      console.warn(
        `[reconciliationQueue] job ${p.jobId} was abandoned by the recovery sweep at ` +
          `${state.abandonedAt.toISOString()}; refusing to execute a resurrected queue entry`,
      );
      return;
    }

    // Clean slate on EVERY attempt: a crash between writes must not double-post.
    await deps.resetArtifacts(p.jobId);

    const run = deps.getRunner();
    if (!run) throw new Error("Reconciliation runner not registered");

    await run(
      p.jobId,
      p.sourceChannelId,
      p.targetChannelId,
      new Date(p.dateFromIso),
      new Date(p.dateToIso),
      p.config,
      p.userId,
    );

    // The runner swallows its own errors and marks the job failed — reload and
    // throw so the queue applies retry/backoff. On the final attempt the job
    // simply stays failed (already marked by the runner).
    const after = await deps.loadJobState(p.jobId);
    if (after?.status === "failed" && after.abandonedAt == null && job.attempt < MAX_RUN_ATTEMPTS) {
      throw new Error(`Reconciliation job ${p.jobId} failed (attempt ${job.attempt}) — retrying`);
    }
  };
}

// ─── Queue singleton + enqueue ────────────────────────────────────────────────

let queuePromise: Promise<JobQueue<ReconciliationRunPayload>> | null = null;
function getQueue(): Promise<JobQueue<ReconciliationRunPayload>> {
  if (!queuePromise) {
    queuePromise = createQueue<ReconciliationRunPayload>(
      "reconciliation-runs",
      makeRunHandler(defaultDeps),
      {
        attempts: MAX_RUN_ATTEMPTS,
        backoffMs: RETRY_BACKOFF_MS,
        // On-premise mode always represents an institution-controlled data
        // boundary. A reconciliation job must therefore survive process loss;
        // private-cloud bank deployments opt in with the explicit flag.
        requireDurable: ENV.deploymentMode === "on_premise" || ENV.reconciliationRequireDurableQueue,
        // `job-<reconciliationJobId>` is unique per unit of work and enqueued
        // exactly once at job creation, so the name is safe to use as the
        // durable job id. That is what makes an abandoned entry removable, and
        // it stops a double enqueue from producing two concurrent runs over the
        // same job row.
        uniqueJobNames: true,
      },
    ).catch((err) => {
      // NEVER cache a rejection. `queuePromise` is memoised for the process
      // lifetime, so a single failed initialisation — Redis simply not up yet
      // when the boot sweep touches the queue, say — would otherwise make every
      // later enqueue fail with that same stale error even after Redis
      // recovered. Clearing it lets the next caller try again.
      queuePromise = null;
      throw err;
    });
  }
  return queuePromise;
}

/** Initialise the queue before a job row is created so unavailable durability never leaves a pending run behind. */
export async function assertReconciliationQueueAvailable(): Promise<void> {
  await getQueue();
}

export async function enqueueReconciliationRun(payload: ReconciliationRunPayload): Promise<void> {
  const queue = await getQueue();
  await queue.enqueue(`job-${payload.jobId}`, payload);
}

// ─── Boot sweep for crash orphans ────────────────────────────────────────────

/**
 * Mark jobs stuck in pending/running for >2h as failed. Under the in-process
 * backend a crash orphans them permanently; under BullMQ retries finish well
 * inside the window, so anything older is genuinely dead either way.
 *
 * Declaring a job dead has to make it dead in BOTH places it lives, because the
 * database row and the durable queue entry are separate facts:
 *
 *   1. `abandonedAt` is stamped alongside the failure. The handler treats an
 *      abandoned job as terminal, so a queue entry delivered after the sweep
 *      cannot reset the job's artifacts and re-run it. This is the load-bearing
 *      guard — it holds even if step 2 fails or the entry is mid-flight on
 *      another worker.
 *   2. The BullMQ entry itself is removed where the backend supports it, so the
 *      dead job stops consuming worker capacity and retry slots. Best-effort:
 *      an entry that is currently active cannot be removed, which is exactly
 *      the case step 1 already covers.
 */
export async function recoverStuckReconciliationJobs(): Promise<{ recovered: number }> {
  const db = await getDb();
  if (!db) return { recovered: 0 };
  const cutoff = new Date(Date.now() - STUCK_JOB_MAX_AGE_MS);

  // Read the ids first: the UPDATE cannot report which rows it touched, and
  // without them the queue entries cannot be identified for removal.
  const stuck = await db
    .select({ id: reconciliationJobs.id })
    .from(reconciliationJobs)
    .where(and(
      inArray(reconciliationJobs.status, ["pending", "running"]),
      lt(reconciliationJobs.createdAt, cutoff),
      isNull(reconciliationJobs.abandonedAt),
    ));
  if (stuck.length === 0) return { recovered: 0 };

  const now = new Date();
  const result = await db
    .update(reconciliationJobs)
    .set({ status: "failed", completedAt: now, abandonedAt: now })
    .where(inArray(reconciliationJobs.id, stuck.map((j) => j.id)));
  const recovered = Number((result as any)?.[0]?.affectedRows ?? stuck.length);

  // Defence in depth (see 2 above) — never let a queue problem block the sweep.
  // The rows are already marked abandoned, which is the guard that matters.
  try {
    const queue = await getQueue();
    if (queue.remove) {
      for (const j of stuck) {
        // Per entry, not per batch: removal throws for an entry that is
        // currently active, and one of those must not stop the rest from being
        // cleaned up.
        try {
          await queue.remove(`job-${j.id}`);
        } catch (err) {
          console.warn(
            `[reconciliationQueue] could not remove queue entry job-${j.id} (row is marked abandoned):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } catch (err) {
    console.error(
      "[reconciliationQueue] queue unavailable for abandoned-entry cleanup (rows are still marked abandoned):",
      err instanceof Error ? err.message : err,
    );
  }

  if (recovered > 0) {
    console.warn(`[reconciliationQueue] boot sweep abandoned ${recovered} stuck job(s) as failed`);
  }
  return { recovered };
}
