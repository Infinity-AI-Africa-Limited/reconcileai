/**
 * Synthetic durable-queue smoke drill (go-live plan Phase 1 item 2).
 *
 * Exercises the three behaviours the evidence record claims, against a REAL
 * Redis: a retryable failure that succeeds on its second attempt, a duplicate
 * enqueue that runs once, and a poison record that exhausts its attempts and
 * lands in the dead-letter set.
 *
 * ─── What the handler's own counters can and cannot prove ────────────────────
 *
 * The handler records `job.attempt` and THEN throws, so the in-memory counter
 * reaches its final value while the last attempt is still running. Treating
 * that as the finish line — as the first version of this drill did — lets the
 * process exit before BullMQ has written anything, so the drill could report a
 * pass for "durable exhausted-failure handling" without the failure ever having
 * been persisted. The counters say what the WORKER saw; only the queue's own
 * state says what SURVIVED.
 *
 * So every claim here is confirmed against BullMQ after the fact:
 *   retry   -> the job completed
 *   dedupe  -> exactly one delivery, after a settle window
 *   poison  -> in the FAILED set, with its attempts exhausted
 *
 * Usage:
 *   docker run -d --rm --name drill-redis -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npx tsx scripts/run-durable-queue-smoke.ts
 */
import { setTimeout as delay } from "node:timers/promises";

type SyntheticJob = { scenario: "retry" | "dedupe" | "poison" };

const ATTEMPTS = 2;
const OBSERVE_TIMEOUT_MS = 15_000;
/** Long enough for a duplicate to show up if de-duplication were broken. */
const SETTLE_MS = 1_500;

const redisUrl = process.env.REDIS_URL?.trim();
if (!redisUrl) {
  throw new Error("Set REDIS_URL before running the synthetic durable-queue smoke drill.");
}

const { createQueue } = await import("../server/jobQueue");
const { Queue } = await import("bullmq");

const queueName = `prebank-durable-smoke-${Date.now()}`;
const attempts = new Map<string, number[]>();

const queue = await createQueue<SyntheticJob>(
  queueName,
  async (job) => {
    const recorded = attempts.get(job.name) ?? [];
    recorded.push(job.attempt);
    attempts.set(job.name, recorded);

    if (job.data.scenario === "retry" && job.attempt === 1) {
      throw new Error("Synthetic retryable failure");
    }
    if (job.data.scenario === "poison") {
      throw new Error("Synthetic poison record");
    }
  },
  { requireDurable: true, uniqueJobNames: true, attempts: ATTEMPTS, backoffMs: 25 },
);

/** Inspector connection, separate from the worker's, for reading queue state. */
const inspector = new Queue(queueName, { connection: { url: redisUrl } as never });

/** Always release Redis and remove this run's keys, whatever the outcome. */
async function cleanup(): Promise<void> {
  await inspector.obliterate({ force: true }).catch(() => {});
  await inspector.close().catch(() => {});
  await queue.close().catch(() => {});
}

function fail(reason: string, detail: Record<string, unknown>): never {
  console.error(JSON.stringify({ result: "fail", reason, ...detail }, null, 2));
  process.exitCode = 1;
  // Cleanup is awaited by the caller; throwing here would skip it.
  throw new DrillFailure(reason);
}

class DrillFailure extends Error {}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  fail(`timed out waiting for ${label}`, { attempts: Object.fromEntries(attempts) });
}

try {
  if (queue.backend !== "bullmq") {
    fail("expected the BullMQ backend", { backend: queue.backend });
  }

  await queue.enqueue("retry", { scenario: "retry" });
  await queue.enqueue("dedupe", { scenario: "dedupe" });
  await queue.enqueue("dedupe", { scenario: "dedupe" }); // same id — must be ignored
  await queue.enqueue("poison", { scenario: "poison" });

  // Phase 1 — what the worker saw.
  await waitFor(
    () =>
      (attempts.get("retry")?.length ?? 0) >= ATTEMPTS &&
      (attempts.get("dedupe")?.length ?? 0) >= 1 &&
      (attempts.get("poison")?.length ?? 0) >= ATTEMPTS,
    "all three scenarios to be attempted",
  );

  // Phase 2 — let the queue finish writing, and give a duplicate its chance to
  // appear. Without this the dedupe claim is only "no duplicate YET".
  await delay(SETTLE_MS);

  // Phase 3 — what actually survived, read back from BullMQ.
  const retryAttempts = attempts.get("retry") ?? [];
  const dedupeAttempts = attempts.get("dedupe") ?? [];
  const poisonAttempts = attempts.get("poison") ?? [];

  const retryJob = await inspector.getJob("retry");
  const poisonJob = await inspector.getJob("poison");
  const failedJobs = await inspector.getFailed();
  const counts = await inspector.getJobCounts("waiting", "active", "completed", "failed", "delayed");

  const retryState = retryJob ? await retryJob.getState() : "missing";
  const poisonState = poisonJob ? await poisonJob.getState() : "missing";
  const poisonAttemptsMade = poisonJob?.attemptsMade ?? 0;
  const poisonInFailedSet = failedJobs.some((job) => job.name === "poison");

  const verified = {
    backend: queue.backend,
    retry: { attempts: retryAttempts, state: retryState },
    dedupe: { attempts: dedupeAttempts },
    poison: {
      attempts: poisonAttempts,
      state: poisonState,
      attemptsMade: poisonAttemptsMade,
      inFailedSet: poisonInFailedSet,
    },
    counts,
  };

  if (JSON.stringify(retryAttempts) !== JSON.stringify([1, 2]) || retryState !== "completed") {
    fail("the retryable job did not fail once and then complete", verified);
  }
  if (JSON.stringify(dedupeAttempts) !== JSON.stringify([1])) {
    fail("the duplicate enqueue was not de-duplicated to a single delivery", verified);
  }
  // The claim this drill exists to support: the failure is DURABLE, not merely
  // observed by the worker before the process exited.
  if (!poisonInFailedSet || poisonState !== "failed" || poisonAttemptsMade !== ATTEMPTS) {
    fail("the poison record's terminal failure was not persisted by BullMQ", verified);
  }

  console.log(JSON.stringify({ ...verified, result: "pass" }, null, 2));
} catch (error) {
  if (!(error instanceof DrillFailure)) {
    console.error(
      JSON.stringify(
        { result: "error", message: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
