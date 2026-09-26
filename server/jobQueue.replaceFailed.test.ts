/**
 * `replaceFailedOnEnqueue` against a scripted BullMQ.
 *
 * The real-Redis suite (jobQueue.durability.test.ts) is skipped wherever
 * REDIS_URL is unset — CI included — so the concurrency rules of re-arming a
 * failed unique entry are pinned here, where a test can decide who wins a race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type State = "waiting" | "active" | "failed" | "completed";

class FakeJob {
  constructor(public id: string, public data: unknown, public state: State) {}
  retryCalls: unknown[] = [];
  /** Runs before retry() checks state — lets a test land a concurrent re-arm first. */
  beforeRetry?: () => void;
  async isFailed() { return this.state === "failed"; }
  async updateData(data: unknown) { this.data = data; }
  async retry(state: string, opts: unknown) {
    this.retryCalls.push(opts);
    this.beforeRetry?.();
    // BullMQ's reprocessJob script: moves the job only while it is in `state`.
    if (state !== "failed" || this.state !== "failed") throw new Error(`Job ${this.id} is not in the ${state} state`);
    this.state = "waiting";
  }
  async remove() { removed.push(this.id); jobs.delete(this.id); }
}

const jobs = new Map<string, FakeJob>();
const added: Array<{ name: string; data: unknown }> = [];
const removed: string[] = [];

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob(id: string) { return jobs.get(id) ?? null; }
    async add(name: string, data: unknown, opts: { jobId?: string }) {
      added.push({ name, data });
      const id = opts.jobId ?? name;
      if (!jobs.has(id)) jobs.set(id, new FakeJob(id, data, "waiting"));
    }
    async close() {}
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));

import { createQueue, type JobQueue } from "./jobQueue";

let queue: JobQueue<{ delivery: number }>;

beforeEach(async () => {
  jobs.clear();
  added.length = 0;
  removed.length = 0;
  vi.stubEnv("REDIS_URL", "redis://scripted");
  queue = await createQueue<{ delivery: number }>("replace-failed-scripted", async () => {}, {
    uniqueJobNames: true,
    replaceFailedOnEnqueue: true,
    requireDurable: true,
  });
});

afterEach(async () => {
  await queue.close();
  vi.unstubAllEnvs();
});

describe("re-arming a failed unique entry on redelivery", () => {
  describe("when the same work is redelivered after its attempts are exhausted", () => {
    it("should re-arm the entry in place with the new data and a fresh attempt cycle", async () => {
      jobs.set("receipt-1", new FakeJob("receipt-1", { delivery: 1 }, "failed"));

      await queue.enqueue("receipt-1", { delivery: 2 });

      const job = jobs.get("receipt-1");
      expect(job?.state).toBe("waiting");
      expect(job?.data).toEqual({ delivery: 2 });
      expect(job?.retryCalls).toEqual([{ resetAttemptsMade: true, resetAttemptsStarted: true }]);
      expect(removed).toEqual([]);
      expect(added).toEqual([]);
    });
  });

  describe("when a concurrent redelivery re-arms the entry first", () => {
    it("should treat the lost race as success, not fail the delivery or delete the fresh entry", async () => {
      const job = new FakeJob("receipt-1", { delivery: 1 }, "failed");
      job.beforeRetry = () => { job.state = "waiting"; }; // the other redelivery won
      jobs.set("receipt-1", job);

      await expect(queue.enqueue("receipt-1", { delivery: 2 })).resolves.toBeUndefined();

      expect(jobs.get("receipt-1")?.state).toBe("waiting");
      expect(removed).toEqual([]);
      expect(added).toEqual([]);
    });
  });

  describe("when retention trimmed the failed entry before it could be re-armed", () => {
    it("should queue the work afresh", async () => {
      const job = new FakeJob("receipt-1", { delivery: 1 }, "failed");
      job.beforeRetry = () => { jobs.delete("receipt-1"); job.state = "completed"; };
      jobs.set("receipt-1", job);

      await queue.enqueue("receipt-1", { delivery: 2 });

      expect(added).toEqual([{ name: "receipt-1", data: { delivery: 2 } }]);
      expect(jobs.get("receipt-1")?.state).toBe("waiting");
    });
  });

  describe("when the entry is still failed after the re-arm was refused", () => {
    it("should surface the error so the delivery is retried", async () => {
      const job = new FakeJob("receipt-1", { delivery: 1 }, "failed");
      job.retry = async () => { throw new Error("redis unavailable"); };
      jobs.set("receipt-1", job);

      await expect(queue.enqueue("receipt-1", { delivery: 2 })).rejects.toThrow("redis unavailable");
      expect(added).toEqual([]);
    });
  });

  describe("when the entry is not failed", () => {
    it("should leave it alone and let the unique id de-duplicate", async () => {
      jobs.set("receipt-1", new FakeJob("receipt-1", { delivery: 1 }, "waiting"));

      await queue.enqueue("receipt-1", { delivery: 2 });

      expect(jobs.get("receipt-1")?.data).toEqual({ delivery: 1 });
      expect(jobs.get("receipt-1")?.retryCalls).toEqual([]);
    });
  });
});
