/**
 * Durable-queue failure modes — the evidence the go-live plan asks for.
 *
 * Phase 1 item 2's exit criterion is "Redis/BullMQ health evidence; worker-kill,
 * retry, dedupe, concurrent-worker and dead-letter tests recorded". Everything
 * else covering this path uses injected fakes: those prove the handler's
 * DECISIONS, not that BullMQ behaves the way the decisions assume.
 *
 * That gap is not academic. The reconciliation recovery design rests on a claim
 * about the platform — "a durable entry can be delivered to a worker AFTER the
 * sweep has declared the job dead" — and until now nobody had run it. Seven
 * review rounds reasoned about a queue no test had ever exercised.
 *
 * ─── Running these ───────────────────────────────────────────────────────────
 *
 * Skipped unless REDIS_URL is set, so CI and laptops without Redis stay green,
 * and the suite activates the moment the addon is provisioned. Locally:
 *
 *   docker run -d --rm --name reconcileai-test-redis -p 6380:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6380 npx vitest run server/jobQueue.durability.test.ts
 *
 * Uses its own queue names per test run, so it never collides with a real
 * deployment's queues if pointed at a shared Redis.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createQueue, type JobQueue } from "./jobQueue";

const REDIS_URL = process.env.REDIS_URL?.trim();

/** Unique per run: these tests must never adopt another run's leftovers. */
const RUN = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const created: string[] = [];
function queueName(label: string): string {
  const n = `${RUN}-${label}`;
  created.push(n);
  return n;
}

/** Poll until `check` passes or we run out of patience — no fixed sleeps. */
async function until(check: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Give a would-be duplicate a fair chance to appear before asserting it did not. */
async function settle(ms = 1200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!REDIS_URL)("durable queue — the contract this platform relies on", () => {
  const open: JobQueue<unknown>[] = [];

  afterAll(async () => {
    // BullMQ holds Redis connections open; without this vitest hangs.
    const { Queue } = await import("bullmq");
    for (const name of created) {
      const q = new Queue(name, { connection: { url: REDIS_URL } as never });
      await q.obliterate({ force: true }).catch(() => {});
      await q.close().catch(() => {});
    }
  });

  it("should report itself durable, so an operator can SEE which backend is live", async () => {
    const q = await createQueue<{ n: number }>(queueName("stats"), async () => {}, {});
    open.push(q as JobQueue<unknown>);
    const stats = await q.stats();
    expect(stats.backend).toBe("bullmq");
    expect(stats.durable).toBe(true);
    expect(stats.counts).toBeDefined();
  }, 30000); // the FIRST Redis connection of a run can take >5s

  it("should run a job exactly once for a given name when names are unique", async () => {
    // The de-dupe that stops a double enqueue becoming two concurrent
    // reconciliations over the same job row.
    const seen: number[] = [];
    const q = await createQueue<{ n: number }>(
      queueName("dedupe"),
      async (job) => { seen.push(job.data.n); },
      { uniqueJobNames: true, attempts: 1 },
    );
    open.push(q as JobQueue<unknown>);

    await q.enqueue("job-1", { n: 1 });
    await q.enqueue("job-1", { n: 2 }); // same id — must be ignored
    await until(() => seen.length >= 1, 8000, "first delivery");
    await settle();

    expect(seen).toEqual([1]);
  });

  it("should run BOTH when the names differ — proving the assertion above is real", async () => {
    // Without this pair, "ran once" would pass just as happily if the queue
    // were broken and ran nothing at all.
    const seen: number[] = [];
    const q = await createQueue<{ n: number }>(
      queueName("dedupe-negative"),
      async (job) => { seen.push(job.data.n); },
      { uniqueJobNames: true, attempts: 1 },
    );
    open.push(q as JobQueue<unknown>);

    await q.enqueue("job-A", { n: 1 });
    await q.enqueue("job-B", { n: 2 });
    await until(() => seen.length >= 2, 8000, "both deliveries");

    expect(seen.sort()).toEqual([1, 2]);
  });

  it("should NOT de-duplicate when names repeat by design (webhook delivery)", async () => {
    // webhook-delivery enqueues under the EVENT name, which every delivery of
    // that event shares. If uniqueJobNames leaked to that queue, every webhook
    // after the first would vanish. This pins that it does not.
    const seen: number[] = [];
    const q = await createQueue<{ n: number }>(
      queueName("no-dedupe"),
      async (job) => { seen.push(job.data.n); },
      { attempts: 1 }, // uniqueJobNames deliberately OFF
    );
    open.push(q as JobQueue<unknown>);

    await q.enqueue("same.event", { n: 1 });
    await q.enqueue("same.event", { n: 2 });
    await until(() => seen.length >= 2, 8000, "both deliveries");

    expect(seen.sort()).toEqual([1, 2]);
  });

  it("should retry a failing job up to its attempt limit, then stop", async () => {
    let attempts = 0;
    const q = await createQueue<Record<string, never>>(
      queueName("retry"),
      async () => { attempts += 1; throw new Error("boom"); },
      { attempts: 3, backoffMs: 50 },
    );
    open.push(q as JobQueue<unknown>);

    await q.enqueue("always-fails", {});
    await until(() => attempts >= 3, 10000, "three attempts");
    await settle();

    expect(attempts).toBe(3); // not 2, not 4
  });

  it("should retain an exhausted job as failed — the dead-letter surface", async () => {
    // There is no separate DLQ table for reconciliation. BullMQ's failed set IS
    // the dead-letter store (removeOnFail: 5000), and it must be inspectable,
    // because a run that exhausted its retries has to be visible to an operator
    // rather than silently gone.
    const name = queueName("dlq");
    const q = await createQueue<Record<string, never>>(
      name,
      async () => { throw new Error("permanent failure"); },
      { attempts: 1, backoffMs: 10 },
    );
    open.push(q as JobQueue<unknown>);

    await q.enqueue("doomed", {});

    let failed = 0;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const s = await q.stats();
      failed = s.counts?.failed ?? 0;
      if (failed > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed).toBeGreaterThan(0);

    const { Queue } = await import("bullmq");
    const inspector = new Queue(name, { connection: { url: REDIS_URL } as never });
    const failedJobs = await inspector.getFailed();
    await inspector.close();
    expect(failedJobs.map((j) => j.name)).toContain("doomed");
  });

  it("should remove a queued entry that has not started", async () => {
    // What the recovery sweep uses to reclaim capacity from a job it abandoned.
    //
    // Deliberately NO worker attached: with one, the entry can be picked up
    // before remove() lands and the test races itself. Removal only ever
    // applies to work that has not started, which is exactly this state.
    const { Queue } = await import("bullmq");
    const detachedName = queueName("remove-detached");
    const detached = new Queue(detachedName, { connection: { url: REDIS_URL } as never });
    await detached.add("job-99", {}, { jobId: "job-99" });
    expect(await detached.getJob("job-99")).toBeTruthy();
    await detached.remove("job-99");
    expect(await detached.getJob("job-99")).toBeFalsy();
    await detached.close();
  });

  it("should deliver a job to exactly ONE worker when several are competing", async () => {
    // The multi-instance case Railway will hit the moment it scales past one
    // dyno, and the reason reconciliation needed a claim guard at all.
    const runs: string[] = [];
    const name = queueName("concurrent");

    const a = await createQueue<{ id: number }>(name, async (j) => { runs.push(`a:${j.data.id}`); }, { attempts: 1 });
    const b = await createQueue<{ id: number }>(name, async (j) => { runs.push(`b:${j.data.id}`); }, { attempts: 1 });
    open.push(a as JobQueue<unknown>, b as JobQueue<unknown>);

    await a.enqueue("shared-job", { id: 7 });
    await until(() => runs.length >= 1, 8000, "one delivery");
    await settle();

    expect(runs).toHaveLength(1);
  });
});

describe.skipIf(!REDIS_URL)("BullMQ behaviour the reconciliation recovery design assumes", () => {
  const created2: string[] = [];

  afterAll(async () => {
    const { Queue } = await import("bullmq");
    for (const name of created2) {
      const q = new Queue(name, { connection: { url: REDIS_URL } as never });
      await q.obliterate({ force: true }).catch(() => {});
      await q.close().catch(() => {});
    }
  });

  it("should redeliver a job whose worker died mid-run — the premise of `abandonedAt`", async () => {
    // THE assumption the whole abandonment design rests on: a worker that dies
    // holding a job does not take the job with it. BullMQ notices the stalled
    // lock and hands the entry to another worker — which is exactly how a job
    // the recovery sweep already declared dead can arrive at a live worker and
    // try to re-run work the user was shown as failed.
    //
    // Verified here rather than assumed — and the verification corrected a
    // wrong assumption of mine on the way. Redelivery is gated by
    // `lockDuration` (BullMQ default 30_000ms), NOT by `stalledInterval`:
    // stalledInterval is only how often the check RUNS, while the lock must
    // actually have expired before another worker may take the entry. Both are
    // shortened here so the test takes seconds.
    //
    // Operationally that means a crashed worker's job is not redelivered
    // instantly — it waits out the lock. Worth knowing before anyone tunes the
    // recovery sweep against it.
    const { Queue, Worker } = await import("bullmq");
    const connection = { url: REDIS_URL } as never;
    const name = `${RUN}-stalled`;
    created2.push(name);

    const queue = new Queue(name, { connection });
    await queue.add("long-job", { v: 1 }, { attempts: 2, jobId: "long-job" });

    // Worker 1 picks the job up and then dies without finishing it.
    let firstSaw = false;
    const w1 = new Worker(name, async () => {
      firstSaw = true;
      await new Promise((r) => setTimeout(r, 60_000)); // never completes
    }, { connection, stalledInterval: 500, lockDuration: 2000, maxStalledCount: 3 });

    await until(() => firstSaw, 8000, "worker 1 to take the job");
    await w1.close(true); // hard close: drops the lock without completing

    // Worker 2 should receive the same entry once the lock is seen as stalled.
    let secondSaw = false;
    const w2 = new Worker(name, async () => { secondSaw = true; },
      { connection, stalledInterval: 500, lockDuration: 2000, maxStalledCount: 3 });

    await until(() => secondSaw, 30000, "redelivery to worker 2");
    await w2.close();
    await queue.close();

    expect(firstSaw).toBe(true);
    expect(secondSaw).toBe(true);
  }, 60000);
});
