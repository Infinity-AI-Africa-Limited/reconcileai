/**
 * BullMQ enqueue and remove against a Redis that does not answer.
 *
 * BullMQ waits for a connection its retry strategy never abandons, and the
 * connection keeps ioredis's offline queue, so against an unreachable Redis an
 * operation neither resolves nor rejects. Unbounded, a webhook that awaited one
 * never answered and a recovery sweep that awaited one stopped for the length
 * of the outage. The fake below holds chosen operations the same way; the
 * queue must refuse them on time, and stay correct when one lands late.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => {
  const state = {
    /** Operations that do not settle until released: add, getJob, isFailed, updateData, retry, remove. */
    hang: new Set<string>(),
    /** Settle every held operation as Redis coming back would, or as a dropped connection would. */
    release: [] as Array<() => void>,
    fail: [] as Array<() => void>,
    /** Whether getJob finds an exhausted entry, which sends enqueue down the re-arm path. */
    failedEntry: false,
    added: [] as string[],
    hold<T>(operation: string, value: T): Promise<T> {
      if (!state.hang.has(operation)) return Promise.resolve(value);
      return new Promise<T>((resolve, reject) => {
        state.release.push(() => resolve(value));
        state.fail.push(() => reject(new Error("Connection is closed.")));
      });
    },
  };
  return state;
});

vi.mock("bullmq", () => {
  const exhausted = {
    isFailed: () => redis.hold("isFailed", true),
    updateData: () => redis.hold("updateData", undefined),
    retry: () => redis.hold("retry", undefined),
  };
  return {
    Queue: class {
      constructor(public name: string) {}
      add(jobName: string) {
        return redis.hold("add", { id: jobName }).then(job => {
          redis.added.push(jobName);
          return job;
        });
      }
      getJob() {
        return redis.hold("getJob", redis.failedEntry ? exhausted : null);
      }
      remove() {
        return redis.hold("remove", 1);
      }
      async close() {}
    },
    Worker: class {
      on() {}
      async close() {}
    },
  };
});

import {
  createQueue,
  QUEUE_OPERATION_TIMEOUT_MS,
  QueueOperationTimeoutError,
  type JobQueue,
} from "./jobQueue";

const open: Array<JobQueue<unknown>> = [];

async function bullQueue(name: string, opts: Parameters<typeof createQueue>[2] = {}) {
  vi.stubEnv("REDIS_URL", "redis://unreachable:6379");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const q = await createQueue<unknown>(name, async () => {}, { operationTimeoutMs: 50, ...opts });
  open.push(q);
  return q;
}

/** Let settled promise callbacks run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(async () => {
  for (const settle of redis.release.splice(0)) settle();
  redis.fail.length = 0;
  redis.hang.clear();
  redis.failedEntry = false;
  redis.added.length = 0;
  await Promise.all(open.splice(0).map(q => q.close()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("when Redis never answers an enqueue", () => {
  it("should refuse it within the deadline, naming the queue and the operation", async () => {
    redis.hang.add("add");
    const q = await bullQueue("timeout-add");
    const started = Date.now();

    const refusal = await q.enqueue("job-1", {}).catch((error: unknown) => error);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(refusal).toBeInstanceOf(QueueOperationTimeoutError);
    expect(refusal).toMatchObject({
      name: "QueueOperationTimeoutError",
      queueName: "timeout-add",
      operation: "enqueue",
      timeoutMs: 50,
    });
  });

  it.each(["getJob", "isFailed", "updateData", "retry"])(
    "should bound the whole re-arm path when %s does not answer",
    async held => {
      // A redelivery that finds an exhausted entry makes up to four round
      // trips; the deadline is for the enqueue, not for each of them.
      redis.failedEntry = true;
      redis.hang.add(held);
      const q = await bullQueue(`timeout-rearm-${held}`, {
        uniqueJobNames: true,
        replaceFailedOnEnqueue: true,
      });

      await expect(q.enqueue("webhook-1", {})).rejects.toBeInstanceOf(QueueOperationTimeoutError);
    }
  );
});

describe("when Redis never answers a remove", () => {
  it("should refuse it within the deadline", async () => {
    redis.hang.add("remove");
    const q = await bullQueue("timeout-remove", { uniqueJobNames: true });

    await expect(q.remove?.("job-1")).rejects.toMatchObject({
      name: "QueueOperationTimeoutError",
      operation: "remove",
    });
  });
});

describe("when Redis answers after the caller was refused", () => {
  it("should log that the enqueue landed late, so a job that runs anyway is explainable", async () => {
    redis.hang.add("add");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = await bullQueue("timeout-late");
    await expect(q.enqueue("job-7", {})).rejects.toBeInstanceOf(QueueOperationTimeoutError);

    for (const settle of redis.release.splice(0)) settle();
    await flush();

    // The deadline ended the wait, not the command: the job was added.
    expect(redis.added).toEqual(["job-7"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"job-7" completed after its deadline/));
  });

  it("should stay silent, and leave nothing unhandled, when the late operation fails instead", async () => {
    redis.hang.add("add");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = await bullQueue("timeout-late-failure");
    await expect(q.enqueue("job-8", {})).rejects.toBeInstanceOf(QueueOperationTimeoutError);

    for (const drop of redis.fail.splice(0)) drop();
    await flush();

    expect(redis.added).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("when Redis answers in time", () => {
  it("should enqueue without waiting for the deadline, and log nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = await bullQueue("timeout-healthy", { operationTimeoutMs: 5_000 });
    const started = Date.now();

    await q.enqueue("job-2", {});

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(redis.added).toEqual(["job-2"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("when a queue does not set its own deadline", () => {
  it("should use QUEUE_OPERATION_TIMEOUT_MS, which leaves room inside Shopify's 5-second webhook budget", async () => {
    expect(QUEUE_OPERATION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(QUEUE_OPERATION_TIMEOUT_MS).toBeLessThan(5_000);

    redis.hang.add("add");
    vi.stubEnv("REDIS_URL", "redis://unreachable:6379");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const q = await createQueue<unknown>("timeout-default", async () => {});
    open.push(q);
    vi.useFakeTimers();

    const refusal = q.enqueue("job-3", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(QUEUE_OPERATION_TIMEOUT_MS);

    expect(await refusal).toMatchObject({ timeoutMs: QUEUE_OPERATION_TIMEOUT_MS });
  });
});
