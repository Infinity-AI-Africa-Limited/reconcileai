/**
 * The SHOPLINE realtime trigger against a real BullMQ, as two instances.
 * Skipped unless REDIS_URL is set (CI included), like
 * server/jobQueue.durability.test.ts. Locally:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run server/shoplineRealtimeSync.redis.test.ts
 *
 * Two queues are built by the production factory under ONE name, each with its
 * own Queue and Worker, as two Railway instances would be. Requests for one
 * store are fed into both. The window must still open once, run once, and keep
 * exactly one follow-up for requests that arrive mid-run, on whichever
 * instance's worker picks it up.
 *
 * ISOLATED BY NAME: the queue name is unique to this run, so no app sharing
 * the Redis has a worker on it. The window is shortened through the job
 * builder's options; everything else is production.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "./jobQueue";
import type { ShoplineRealtimeSyncPayload } from "./connectors/shopline/realtimeSync";

const REDIS_URL = process.env.REDIS_URL?.trim();
const QUEUE_NAME = `test-shopline-realtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WINDOW_MS = 400;

const state = vi.hoisted(() => ({
  started: 0,
  release: [] as Array<() => void>,
}));

vi.mock("./connectors/shopline/syncOrchestrator", () => ({
  runSyncCycle: () =>
    new Promise(resolve => {
      state.started += 1;
      state.release.push(() =>
        resolve({ error: undefined, ordersIngested: 0, paymentsIngested: 0, matchedCount: 0, exceptionCount: 0 })
      );
    }),
}));

async function until(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!REDIS_URL)("the SHOPLINE realtime trigger on BullMQ, across two instances", () => {
  const instances: Array<JobQueue<ShoplineRealtimeSyncPayload>> = [];

  afterAll(async () => {
    for (const settle of state.release.splice(0)) settle();
    await Promise.all(instances.map(q => q.close()));
    const { Queue } = await import("bullmq");
    const inspector = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } as never });
    await inspector.obliterate({ force: true }).catch(() => {});
    await inspector.close();
  });

  async function request(instance: JobQueue<ShoplineRealtimeSyncPayload>): Promise<void> {
    const { shoplineRealtimeJob } = await import("./connectors/shopline/realtimeSync");
    const [name, payload, options] = shoplineRealtimeJob({
      organizationId: 7,
      slStoreId: 42,
      topic: "orders/paid",
      requestedAt: new Date().toISOString(),
    });
    await instance.enqueue(name, payload, { ...options, delayMs: WINDOW_MS });
  }

  it("should run one sync per window for a store, whichever instance received its webhooks", async () => {
    const { createShoplineRealtimeQueue } = await import("./connectors/shopline/realtimeSync");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const a = await createShoplineRealtimeQueue(QUEUE_NAME);
    const b = await createShoplineRealtimeQueue(QUEUE_NAME);
    instances.push(a, b);

    // A burst split across both instances: one window.
    await Promise.all([request(a), request(b), request(a), request(b)]);
    await until(() => state.started === 1, "the first run");
    await new Promise(r => setTimeout(r, WINDOW_MS * 2));
    expect(state.started).toBe(1);

    // Mid-run requests, again on both instances: still no second run...
    await Promise.all([request(b), request(a)]);
    await new Promise(r => setTimeout(r, WINDOW_MS * 2));
    expect(state.started).toBe(1);

    // ...and exactly one follow-up once it ends.
    state.release.shift()?.();
    await until(() => state.started === 2, "the one follow-up");
    state.release.shift()?.();
    await new Promise(r => setTimeout(r, WINDOW_MS * 3));
    expect(state.started).toBe(2);
  });
});
