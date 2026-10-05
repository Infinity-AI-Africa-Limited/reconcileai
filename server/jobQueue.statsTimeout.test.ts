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

const counts = vi.hoisted(() => ({ hang: new Set<string>() }));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string) {}
    getJobCounts() {
      if (counts.hang.has(this.name)) return new Promise(() => {});
      return Promise.resolve({ waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 });
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
