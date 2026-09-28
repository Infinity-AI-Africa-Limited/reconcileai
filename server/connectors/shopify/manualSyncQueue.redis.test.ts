/**
 * The manual-sync queue against a real BullMQ. Skipped unless REDIS_URL is set
 * (CI included), like server/jobQueue.durability.test.ts. Locally:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run server/connectors/shopify/manualSyncQueue.redis.test.ts
 *
 * The sync cycle itself is replaced: this pins the QUEUE's behaviour — stores
 * run in parallel, one store never twice at once, and a failed run is final.
 *
 * ISOLATED BY NAME, like jobQueue.durability.test.ts. The queue is built by the
 * production factory (same options) and fed by the production job builder (same
 * names and coalescing), but under a queue name unique to this run — so no app
 * sharing the Redis, local or otherwise, has a worker on it, and the cleanup
 * can only ever delete this run's queue. Using the real queue name here would
 * let the test's mock worker consume a running app's refresh jobs.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "../../jobQueue";
import type { ShopifyManualSyncPayload } from "./manualSync";

const REDIS_URL = process.env.REDIS_URL?.trim();
const QUEUE_NAME = `test-shopify-manual-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const REQUESTED_AT = "2026-09-28T10:00:00.000Z";

const state = vi.hoisted(() => ({
  started: [] as number[],
  release: new Map<number, Array<(error?: Error) => void>>(),
  markFailed: vi.fn(async () => undefined),
}));

vi.mock("./manualSync", () => ({
  handleShopifyManualSync: (payload: { storeId: number }) =>
    new Promise<void>((resolve, reject) => {
      state.started.push(payload.storeId);
      const waiting = state.release.get(payload.storeId) ?? [];
      waiting.push((error) => (error ? reject(error) : resolve()));
      state.release.set(payload.storeId, waiting);
    }),
  markShopifyManualSyncFailed: state.markFailed,
}));
vi.mock("./syncOrchestrator", () => ({
  handleShopifyWebhookSync: vi.fn(),
  markShopifyWebhookSyncFailed: vi.fn(),
}));

async function until(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function finish(storeId: number, error?: Error): void {
  state.release.get(storeId)?.shift()?.(error);
}

describe.skipIf(!REDIS_URL)("the Shopify manual-sync queue on BullMQ", () => {
  let queue: JobQueue<ShopifyManualSyncPayload> | null = null;

  /** The production queue and enqueue call, under this run's own queue name. */
  async function enqueueShopifyManualSync(request: { storeId: number; organizationId: number }): Promise<void> {
    const { createShopifyManualSyncQueue, shopifyManualSyncJob } = await import("./syncQueue");
    queue ??= await createShopifyManualSyncQueue(QUEUE_NAME);
    expect(queue.backend).toBe("bullmq");
    await queue.enqueue(...shopifyManualSyncJob({ ...request, requestedAt: REQUESTED_AT }));
  }

  afterAll(async () => {
    await queue?.close().catch(() => {});
    const { Queue } = await import("bullmq");
    const q = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } as never });
    await q.obliterate({ force: true }).catch(() => {});
    await q.close().catch(() => {});
  });

  it("should run different stores at once, never one store twice at once, and keep one follow-up", async () => {

    await enqueueShopifyManualSync({ storeId: 1, organizationId: 42 });
    await enqueueShopifyManualSync({ storeId: 2, organizationId: 42 });
    // Both stores start although neither has finished: one store's 60-day
    // backfill does not hold every other store's refresh behind it.
    await until(() => state.started.includes(1) && state.started.includes(2), "two stores to run in parallel");

    // Clicks while store 1 is running: exactly one follow-up, not two runs now.
    await enqueueShopifyManualSync({ storeId: 1, organizationId: 42 });
    await enqueueShopifyManualSync({ storeId: 1, organizationId: 42 });
    await new Promise((r) => setTimeout(r, 400));
    expect(state.started.filter((id) => id === 1)).toHaveLength(1);

    finish(1);
    await until(() => state.started.filter((id) => id === 1).length === 2, "store 1's follow-up");
    finish(1);
    finish(2);
    await new Promise((r) => setTimeout(r, 400));
    expect(state.started.filter((id) => id === 1)).toHaveLength(2);
  });

  it("should not retry a failed run, and should hand it to the failure hook once", async () => {
    const before = state.started.filter((id) => id === 3).length;

    await enqueueShopifyManualSync({ storeId: 3, organizationId: 42 });
    await until(() => state.started.filter((id) => id === 3).length === before + 1, "store 3 to run");
    finish(3, new Error("shopify said no"));

    await until(() => state.markFailed.mock.calls.length === 1, "the failure hook");
    await new Promise((r) => setTimeout(r, 600));
    expect(state.started.filter((id) => id === 3)).toHaveLength(before + 1);
    expect(state.markFailed).toHaveBeenCalledWith({ storeId: 3, organizationId: 42, requestedAt: REQUESTED_AT });
  });
});
