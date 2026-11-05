/**
 * Durable queues whose workers were built only on first use: webhook delivery
 * and Shopify manual sync. Work retained in Redis through a restart waited for
 * the next dispatch or request. The reconciliation worker had the same gap
 * (Greptile, #215; fixed in #219). Synthetic queues only; nothing connects.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createQueue: vi.fn(),
  env: { shopifyClientId: "synthetic-client", shopifyClientSecret: "synthetic-secret" },
}));

vi.mock("./jobQueue", () => ({
  createQueue: state.createQueue,
  QueueOperationTimeoutError: class extends Error {},
}));
vi.mock("./_core/env", () => ({ ENV: state.env }));
vi.mock("./db", () => ({ getDb: async () => null }));
vi.mock("./connectors/shopify/syncOrchestrator", () => ({
  handleShopifyWebhookSync: vi.fn(),
  markShopifyWebhookSyncFailed: vi.fn(),
}));
vi.mock("./connectors/shopify/manualSync", () => ({ handleShopifyManualSync: vi.fn() }));

const queue = () => ({ backend: "bullmq", enqueue: vi.fn(), stats: vi.fn(), close: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  state.createQueue.mockReset();
  state.createQueue.mockImplementation(async () => queue());
  state.env.shopifyClientId = "synthetic-client";
  state.env.shopifyClientSecret = "synthetic-secret";
  vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("when an instance restarts with webhook deliveries retained in Redis", () => {
  it("should build the delivery worker at boot", async () => {
    const { startWebhookDeliveryWorker } = await import("./webhookDelivery");
    await startWebhookDeliveryWorker();
    expect(state.createQueue).toHaveBeenCalledTimes(1);
    expect(state.createQueue).toHaveBeenCalledWith("webhook-delivery", expect.any(Function), expect.any(Object));
  });

  it("should not build an in-process queue at boot, which holds nothing across a restart", async () => {
    vi.stubEnv("REDIS_URL", undefined);
    const { startWebhookDeliveryWorker } = await import("./webhookDelivery");
    await startWebhookDeliveryWorker();
    expect(state.createQueue).not.toHaveBeenCalled();
  });

  it("should not cache a failed build, so a later dispatch can still reach Redis", async () => {
    state.createQueue.mockRejectedValueOnce(new Error("synthetic redis not ready"));
    const { startWebhookDeliveryWorker } = await import("./webhookDelivery");
    await expect(startWebhookDeliveryWorker()).rejects.toThrow("synthetic redis not ready");
    await expect(startWebhookDeliveryWorker()).resolves.toBeUndefined();
    expect(state.createQueue).toHaveBeenCalledTimes(2);
  });
});

describe("when an instance restarts with Shopify manual syncs retained in Redis", () => {
  it("should build the manual-sync worker at boot", async () => {
    const { startShopifyManualSyncWorker } = await import("./connectors/shopify/syncQueue");
    await startShopifyManualSyncWorker();
    expect(state.createQueue).toHaveBeenCalledTimes(1);
    expect(state.createQueue).toHaveBeenCalledWith("shopify-manual-sync", expect.any(Function), expect.objectContaining({ requireDurable: true }));
  });

  it("should not build it without Redis, which the queue requires", async () => {
    vi.stubEnv("REDIS_URL", undefined);
    const { startShopifyManualSyncWorker } = await import("./connectors/shopify/syncQueue");
    await startShopifyManualSyncWorker();
    expect(state.createQueue).not.toHaveBeenCalled();
  });

  it("should not build it without the Shopify app's credentials, which the sync requires", async () => {
    state.env.shopifyClientSecret = "";
    const { startShopifyManualSyncWorker } = await import("./connectors/shopify/syncQueue");
    await startShopifyManualSyncWorker();
    expect(state.createQueue).not.toHaveBeenCalled();
  });
});

describe("when the server boots", () => {
  const boot = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");

  it.each([
    ['import("../webhookDelivery")', ".then((m) => m.startWebhookDeliveryWorker())"],
    ['import("../connectors/shopify/syncQueue")', ".then((m) => m.startShopifyManualSyncWorker())"],
  ])("should start the worker behind %s", (module, call) => {
    const at = boot.indexOf(call);
    expect(at).toBeGreaterThan(-1);
    expect(boot.slice(Math.max(0, at - 120), at)).toContain(module);
  });
});
