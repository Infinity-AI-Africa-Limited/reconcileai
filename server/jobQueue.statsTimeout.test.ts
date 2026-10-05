/**
 * `allQueueStats` against a Redis that does not answer.
 *
 * BullMQ registers a queue at construction, before anything has connected, and
 * its client waits for a connection its retry strategy never gives up on. So
 * against an unreachable Redis a count read neither resolves nor rejects. The
 * fake below behaves that way for one queue, and the snapshot (what
 * /api/health and the pilot gate read) must still answer, on time, with that
 * queue reported as failing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({
  hang: new Set<string>(),
  /** Count reads issued to Redis, per queue. */
  calls: new Map<string, number>(),
  /** Settle a hung read, as Redis coming back would. */
  release: new Map<string, () => void>(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string) {}
    getJobCounts() {
      counts.calls.set(this.name, (counts.calls.get(this.name) ?? 0) + 1);
      const answer = { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 };
      if (counts.hang.has(this.name)) {
        return new Promise((resolve) => counts.release.set(this.name, () => resolve(answer)));
      }
      return Promise.resolve(answer);
    }
    async close() {}
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));

import { allQueueStats, createQueue } from "./jobQueue";
import { classifyQueueDurability } from "./queueDurability";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("when one queue's Redis never answers a count read", () => {
  it("should answer on time, report that queue as failing, and never call it confirmed", async () => {
    vi.stubEnv("REDIS_URL", "redis://unreachable:6379");
    vi.spyOn(console, "log").mockImplementation(() => {});
    counts.hang.add("stats-timeout-hung");
    await createQueue("stats-timeout-hung", async () => {});
    await createQueue("stats-timeout-healthy", async () => {});
    const started = Date.now();

    const queues = await allQueueStats(50);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(queues["stats-timeout-hung"]).toEqual({ backend: "bullmq", durable: true, error: "count read timed out" });
    // The reads run side by side: the healthy queue is still counted.
    expect(queues["stats-timeout-healthy"]).toMatchObject({ backend: "bullmq", durable: true, counts: { waiting: 1 } });
    expect(queues["stats-timeout-healthy"].error).toBeUndefined();
    expect(classifyQueueDurability(queues, process.env.REDIS_URL)).toEqual({
      durable: false,
      durability: "unreachable",
      status: "error",
    });
  });
});

describe("when many callers ask while a read is hung", () => {
  // Greptile #167: a caller's deadline ends its wait, not the read. Each health
  // check and each OAuth request used to start fresh reads, which stayed
  // pending for the whole outage, so they piled up without limit.
  it("should send Redis one read per queue, shared by every caller, and a fresh one once it settles", async () => {
    vi.stubEnv("REDIS_URL", "redis://unreachable:6379");
    vi.spyOn(console, "log").mockImplementation(() => {});
    counts.hang.add("stats-shared");
    await createQueue("stats-shared", async () => {});

    await Promise.all(Array.from({ length: 25 }, () => allQueueStats(10)));
    for (let i = 0; i < 5; i += 1) await allQueueStats(10);

    expect(counts.calls.get("stats-shared")).toBe(1);

    // Redis answers: the shared read settles, and the next caller reads afresh.
    counts.hang.delete("stats-shared");
    counts.release.get("stats-shared")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await allQueueStats(50);

    expect(counts.calls.get("stats-shared")).toBe(2);
    expect(after["stats-shared"]).toMatchObject({ durable: true, counts: { waiting: 1 } });
    expect(after["stats-shared"].error).toBeUndefined();
  });
});
