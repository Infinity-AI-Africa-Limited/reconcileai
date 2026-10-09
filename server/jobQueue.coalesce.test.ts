/**
 * `coalesceKey`: the same rule on both backends.
 *
 * The in-process cases always run. The BullMQ cases run wherever REDIS_URL is
 * set (skipped in CI, like jobQueue.durability.test.ts), because the point is
 * to show BullMQ's `deduplication` behaves the way the in-process mirror
 * assumes — not to test a fake of it. Locally:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run server/jobQueue.coalesce.test.ts
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createQueue, type JobQueue } from "./jobQueue";

const REDIS_URL = process.env.REDIS_URL?.trim();
const RUN = `coalesce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdOnRedis: string[] = [];

async function until(check: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

type Payload = { key: string; label: string };

/** A queue whose handler holds each run open until the test releases it. */
async function gatedQueue(backend: "in-process" | "bullmq", label: string) {
  vi.stubEnv("REDIS_URL", backend === "bullmq" ? REDIS_URL! : "");
  const name = `${RUN}-${label}`;
  if (backend === "bullmq") createdOnRedis.push(name);
  const runs: Payload[] = [];
  const gates: Array<() => void> = [];
  const queue = await createQueue<Payload>(
    name,
    async (job) => {
      runs.push(job.data);
      await new Promise<void>((release) => gates.push(release));
    },
    { attempts: 1, backoffMs: 10 },
  );
  expect(queue.backend).toBe(backend);
  const releaseNext = async () => {
    await until(() => gates.length > 0, 8000, "a run to be holding the gate");
    gates.shift()!();
  };
  return { queue, runs, gates, releaseNext };
}

const open: JobQueue<Payload>[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  for (const q of open) await q.close().catch(() => {});
  if (!REDIS_URL || createdOnRedis.length === 0) return;
  const { Queue } = await import("bullmq");
  for (const name of createdOnRedis) {
    const q = new Queue(name, { connection: { url: REDIS_URL } as never });
    await q.obliterate({ force: true }).catch(() => {});
    await q.close().catch(() => {});
  }
});

const backends = [
  ["in-process", true],
  ["bullmq", Boolean(REDIS_URL)],
] as const;

for (const [backend, enabled] of backends) {
  describe.skipIf(!enabled)(`coalesceKey on the ${backend} backend`, () => {
    it("should keep exactly one follow-up, with the latest data, for requests made while a run is in progress", async () => {
      const { queue, runs, releaseNext } = await gatedQueue(backend, `${backend}-follow-up`);
      open.push(queue);

      await queue.enqueue("sync", { key: "store-1", label: "first" }, { coalesceKey: "store-1" });
      await until(() => runs.length === 1, 8000, "the first run to start");
      await queue.enqueue("sync", { key: "store-1", label: "second" }, { coalesceKey: "store-1" });
      await queue.enqueue("sync", { key: "store-1", label: "third" }, { coalesceKey: "store-1" });

      await settle(300);
      expect(runs).toHaveLength(1); // never two at once for one key
      await releaseNext();
      await until(() => runs.length === 2, 8000, "the follow-up run");
      await releaseNext();
      await settle(800);

      expect(runs.map((r) => r.label)).toEqual(["first", "third"]);
    });

    it("should release the key when the work finishes, so the same work can be requested again", async () => {
      const { queue, runs, releaseNext } = await gatedQueue(backend, `${backend}-release`);
      open.push(queue);

      await queue.enqueue("sync", { key: "store-1", label: "first" }, { coalesceKey: "store-1" });
      await releaseNext();
      await until(() => runs.length === 1, 8000, "the first run");
      await settle(300);

      await queue.enqueue("sync", { key: "store-1", label: "later" }, { coalesceKey: "store-1" });
      await releaseNext();
      await until(() => runs.length === 2, 8000, "the later request to run");

      expect(runs.map((r) => r.label)).toEqual(["first", "later"]);
    });

    it("should not coalesce different keys", async () => {
      const { queue, runs, gates } = await gatedQueue(backend, `${backend}-keys`);
      open.push(queue);

      await queue.enqueue("sync", { key: "store-1", label: "a" }, { coalesceKey: "store-1" });
      await until(() => runs.length === 1, 8000, "store-1 to start");
      // One worker slot is busy (BullMQ default concurrency 1), so store-2 waits
      // rather than runs — but it is queued, not absorbed.
      await queue.enqueue("sync", { key: "store-2", label: "b" }, { coalesceKey: "store-2" });
      gates.shift()!();
      await until(() => runs.length === 2, 8000, "store-2 to run");
      gates.shift()?.();

      expect(runs.map((r) => r.key)).toEqual(["store-1", "store-2"]);
    });
  });
}

describe("coalesceKey on the in-process backend, before a run has started", () => {
  it("should absorb a request made while the first is still waiting", async () => {
    const { queue, runs, releaseNext } = await gatedQueue("in-process", "in-process-waiting");
    open.push(queue);

    // Both enqueues complete before setImmediate starts the first run.
    await queue.enqueue("sync", { key: "store-1", label: "first" }, { coalesceKey: "store-1" });
    await queue.enqueue("sync", { key: "store-1", label: "second" }, { coalesceKey: "store-1" });
    await releaseNext();
    await settle(200);

    expect(runs.map((r) => r.label)).toEqual(["first"]);
  });
});

describe.skipIf(!REDIS_URL)("coalesceKey on the bullmq backend, before a run has started", () => {
  it("should absorb a request made while the first is still waiting", async () => {
    const { queue, runs, gates } = await gatedQueue("bullmq", "bullmq-waiting");
    open.push(queue);

    // Occupy the single worker slot so store-1's entry stays WAITING.
    await queue.enqueue("sync", { key: "blocker", label: "blocker" }, { coalesceKey: "blocker" });
    await until(() => runs.length === 1, 8000, "the blocker to start");
    await queue.enqueue("sync", { key: "store-1", label: "first" }, { coalesceKey: "store-1" });
    await queue.enqueue("sync", { key: "store-1", label: "second" }, { coalesceKey: "store-1" });

    gates.shift()!();
    await until(() => runs.length === 2, 8000, "store-1 to run");
    gates.shift()!();
    await settle(1000);

    expect(runs.map((r) => r.label)).toEqual(["blocker", "first"]);
  });
});

describe("when a request is delayed on the in-process backend", () => {
  // Fake timers, not real ones: the property is about WHEN work runs, and a
  // margin on a loaded runner is how a timing test becomes a flake.
  afterEach(() => {
    vi.useRealTimers();
  });

  async function timedQueue(label: string) {
    vi.stubEnv("REDIS_URL", "");
    const ranAt: Array<{ label: string; at: number }> = [];
    const queue = await createQueue<Payload>(
      `${RUN}-${label}`,
      async (job) => {
        ranAt.push({ label: job.data.label, at: Date.now() });
      },
      { attempts: 1, backoffMs: 10 },
    );
    open.push(queue);
    vi.useFakeTimers();
    return { queue, ranAt, start: Date.now() };
  }

  it("should open a coalesced window at the first request and not move it for later ones", async () => {
    const { queue, ranAt, start } = await timedQueue("delay-window");

    await queue.enqueue("sync", { key: "store-1", label: "first" }, { coalesceKey: "store-1", delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(600);
    await queue.enqueue("sync", { key: "store-1", label: "second" }, { coalesceKey: "store-1", delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(399);
    expect(ranAt).toEqual([]);

    // Closes 1s after the FIRST request, not 1s after the second.
    await vi.advanceTimersByTimeAsync(10);
    expect(ranAt).toHaveLength(1);
    expect(ranAt[0].label).toBe("first");
    expect(ranAt[0].at - start).toBeLessThan(1_100);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ranAt).toHaveLength(1);
  });

  it("should delay work that is not coalesced as well", async () => {
    const { queue, ranAt } = await timedQueue("delay-plain");

    await queue.enqueue("sync", { key: "a", label: "plain" }, { delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(ranAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(ranAt.map((r) => r.label)).toEqual(["plain"]);
  });

  it("should start at once when no delay is asked for", async () => {
    const { queue, ranAt } = await timedQueue("delay-none");

    await queue.enqueue("sync", { key: "b", label: "now" });
    await vi.advanceTimersByTimeAsync(1);
    expect(ranAt.map((r) => r.label)).toEqual(["now"]);
  });
});
