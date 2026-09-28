/**
 * The manual-sync queue against a real BullMQ. Skipped unless REDIS_URL is set
 * (CI included), like server/jobQueue.durability.test.ts. Locally:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run server/connectors/shopify/manualSyncQueue.redis.test.ts
 *
 * The sync cycle itself is replaced: this pins the QUEUE's behaviour — stores
 * run in parallel, one store never twice at once, and a failed run is final.
 *
 * LOOPBACK ONLY. Unlike jobQueue.durability.test.ts, which names its queues per
 * run, this must use the real queue name to test the real queue — so pointed at
 * a shared Redis it would enqueue jobs a live worker could run, and its cleanup
 * would obliterate the live queue. REDIS_URL is routinely exported during
 * production maintenance, so the test refuses any host that is not provably
 * local (the rule scripts/guardLocalDb.ts follows: allow the provably safe,
 * refuse the rest).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

function loopbackRedisUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1" ? value : undefined;
  } catch {
    return undefined;
  }
}

const REDIS_URL = loopbackRedisUrl(process.env.REDIS_URL);

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
  afterAll(async () => {
    const { Queue } = await import("bullmq");
    const q = new Queue("shopify-manual-sync", { connection: { url: REDIS_URL } as never });
    await q.obliterate({ force: true }).catch(() => {});
    await q.close().catch(() => {});
  });

  it("should run different stores at once, never one store twice at once, and keep one follow-up", async () => {
    const { enqueueShopifyManualSync } = await import("./syncQueue");

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
    const { enqueueShopifyManualSync } = await import("./syncQueue");
    const before = state.started.filter((id) => id === 3).length;

    await enqueueShopifyManualSync({ storeId: 3, organizationId: 42 });
    await until(() => state.started.filter((id) => id === 3).length === before + 1, "store 3 to run");
    finish(3, new Error("shopify said no"));

    await until(() => state.markFailed.mock.calls.length === 1, "the failure hook");
    await new Promise((r) => setTimeout(r, 600));
    expect(state.started.filter((id) => id === 3)).toHaveLength(before + 1);
    expect(state.markFailed).toHaveBeenCalledWith({ storeId: 3, organizationId: 42 });
  });
});
