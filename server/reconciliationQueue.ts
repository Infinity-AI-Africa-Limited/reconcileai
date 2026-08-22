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
 *
 * The runner itself stays in routers.ts (it closes over that module's helpers)
 * and is REGISTERED here at module load — no import cycle. The full extraction
 * to server/reconciliationRunner.ts remains split-plan item 12.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { reconciliationJobs, matches, exceptions as exceptionsTable, transactions } from "../drizzle/schema";
import { createQueue, type JobQueue } from "./jobQueue";

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

export interface RunHandlerDeps {
  loadJobStatus(jobId: number): Promise<string | null>; // null = job gone
  resetArtifacts(jobId: number): Promise<void>;
  getRunner(): ReconciliationRunner | null;
}

const defaultDeps: RunHandlerDeps = {
  async loadJobStatus(jobId) {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [row] = await db
      .select({ status: reconciliationJobs.status })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.id, jobId))
      .limit(1);
    return row?.status ?? null;
  },
  resetArtifacts: resetJobArtifacts,
  getRunner: () => runner,
};

/** Exported factory so tests can inject fakes (the live DB is shared — never test against it). */
export function makeRunHandler(deps: RunHandlerDeps) {
  return async function handle(job: { data: ReconciliationRunPayload; attempt: number }): Promise<void> {
    const p = job.data;

    const status = await deps.loadJobStatus(p.jobId);
    if (status === null) return; // job deleted — nothing to do
    if (status === "completed" || status === "cancelled") return; // idempotency guard

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
    const after = await deps.loadJobStatus(p.jobId);
    if (after === "failed" && job.attempt < MAX_RUN_ATTEMPTS) {
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
      { attempts: MAX_RUN_ATTEMPTS, backoffMs: RETRY_BACKOFF_MS },
    );
  }
  return queuePromise;
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
 */
export async function recoverStuckReconciliationJobs(): Promise<{ recovered: number }> {
  const db = await getDb();
  if (!db) return { recovered: 0 };
  const cutoff = new Date(Date.now() - STUCK_JOB_MAX_AGE_MS);
  const result = await db
    .update(reconciliationJobs)
    .set({ status: "failed", completedAt: new Date() })
    .where(and(
      inArray(reconciliationJobs.status, ["pending", "running"]),
      lt(reconciliationJobs.createdAt, cutoff),
    ));
  const recovered = Number((result as any)?.[0]?.affectedRows ?? 0);
  if (recovered > 0) {
    console.warn(`[reconciliationQueue] boot sweep marked ${recovered} stuck job(s) as failed`);
  }
  return { recovered };
}
