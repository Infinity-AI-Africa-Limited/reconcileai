/**
 * What the realtime trigger asks BullMQ for, which is what makes it
 * cluster-wide.
 *
 * Each request becomes a DELAYED job whose deduplication id is the store's,
 * qualified by tenant, with `keepLastIfActive`. BullMQ (5.79, verified in its
 * Lua scripts) then does the rest in Redis, for every instance at once:
 *
 *   - `SET de:<id> … NX`: while that store's job waits or is delayed, any further
 *     add, from ANY instance, is absorbed into it (deduplicateJobWithoutReplace);
 *   - while it runs, one add is kept as the next job, latest data, and created
 *     with its options, delay included, when the run finishes
 *     (storeDeduplicatedNextJob, requeueDeduplicatedJob).
 *
 * So these pin the request, and the real-Redis test
 * (shoplineRealtimeSync.redis.test.ts) pins the behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => ({
  adds: [] as Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }>,
  workers: [] as Array<{ processor: (job: unknown) => Promise<unknown>; opts: Record<string, unknown> }>,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string) {}
    async add(name: string, data: Record<string, unknown>, opts: Record<string, unknown>) {
      bull.adds.push({ name, data, opts });
      return { id: String(bull.adds.length) };
    }
    async close() {}
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>, opts: Record<string, unknown>) {
      bull.workers.push({ processor, opts });
    }
    on() {}
    async close() {}
  },
}));

const runSyncCycle = vi.fn();
vi.mock("./connectors/shopline/syncOrchestrator", () => ({
  runSyncCycle: (...args: unknown[]) => runSyncCycle(...args),
}));

import {
  __resetRealtimeQueue,
  COALESCE_WINDOW_MS,
  realtimeCoalesceKey,
  scheduleReconciliation,
} from "./connectors/shopline/realtimeSync";

/** Wait for the background enqueue that scheduleReconciliation starts. */
async function settled(count: number): Promise<void> {
  for (let i = 0; i < 50 && bull.adds.length < count; i++) await new Promise(r => setTimeout(r, 5));
}

beforeEach(async () => {
  await __resetRealtimeQueue();
  vi.stubEnv("REDIS_URL", "redis://redis.test:6379");
  vi.spyOn(console, "log").mockImplementation(() => {});
  bull.adds.length = 0;
  bull.workers.length = 0;
  runSyncCycle.mockReset();
});

afterEach(async () => {
  await __resetRealtimeQueue();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("when a store's webhook asks for a sync on BullMQ", () => {
  it("should add one delayed job, deduplicated by tenant and store, keeping one follow-up while it runs", async () => {
    scheduleReconciliation(7, 42, "orders/paid");
    await settled(1);

    expect(bull.adds).toHaveLength(1);
    expect(bull.adds[0].name).toBe("store-42");
    expect(bull.adds[0].opts).toMatchObject({
      delay: COALESCE_WINDOW_MS,
      attempts: 1,
      deduplication: { id: "shopline-realtime:7:42", keepLastIfActive: true },
    });
    // Not a unique job id: a finished job's id would absorb every later request.
    expect(bull.adds[0].opts).not.toHaveProperty("jobId");
  });

  it("should carry only identifiers into Redis, never merchant data", async () => {
    scheduleReconciliation(7, 42, "refunds/create");
    await settled(1);

    expect(Object.keys(bull.adds[0].data).sort()).toEqual(["organizationId", "requestedAt", "slStoreId", "topic"]);
  });

  it("should give every instance the same window for a store, and other stores their own", () => {
    // The deduplication id is computed from the request alone, so every
    // instance receiving a webhook for this store names the same Redis key.
    expect(realtimeCoalesceKey({ organizationId: 7, slStoreId: 42 })).toBe(
      realtimeCoalesceKey({ organizationId: 7, slStoreId: 42 })
    );
    expect(realtimeCoalesceKey({ organizationId: 7, slStoreId: 43 })).not.toBe(
      realtimeCoalesceKey({ organizationId: 7, slStoreId: 42 })
    );
    expect(realtimeCoalesceKey({ organizationId: 8, slStoreId: 42 })).not.toBe(
      realtimeCoalesceKey({ organizationId: 7, slStoreId: 42 })
    );
  });
});

describe("when an instance's worker picks up a store's job", () => {
  it("should run that store's sync, several stores at a time", async () => {
    runSyncCycle.mockResolvedValue({ error: undefined, ordersIngested: 1, paymentsIngested: 1, matchedCount: 1, exceptionCount: 0 });
    vi.spyOn(console, "info").mockImplementation(() => {});
    scheduleReconciliation(7, 42, "orders/paid");
    await settled(1);

    expect(bull.workers[0].opts).toMatchObject({ concurrency: 4 });
    await bull.workers[0].processor({ name: "store-42", data: bull.adds[0].data, attemptsMade: 0 });
    expect(runSyncCycle).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 7, slStoreId: 42 }));
  });
});
