import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createQueue: vi.fn(),
  handle: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  handleManual: vi.fn(async () => {}),
  markManualFailed: vi.fn(async () => {}),
}));

vi.mock("../../jobQueue", () => ({
  createQueue: (...args: unknown[]) => state.createQueue(...args),
}));
vi.mock("./syncOrchestrator", () => ({
  handleShopifyWebhookSync: (...args: unknown[]) => state.handle(...args),
  markShopifyWebhookSyncFailed: (...args: unknown[]) => state.markFailed(...args),
}));
vi.mock("./manualSync", () => ({
  handleShopifyManualSync: (...args: unknown[]) => state.handleManual(...args),
  markShopifyManualSyncFailed: (...args: unknown[]) => state.markManualFailed(...args),
}));

const enqueue = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state.createQueue.mockResolvedValue({
    backend: "bullmq",
    enqueue,
    stats: vi.fn(),
    close: vi.fn(),
  });
});

describe("Shopify order sync durable queue", () => {
  it("records final failure before releasing the unique failed job id", async () => {
    const { enqueueShopifyOrderSync } = await import("./syncQueue");
    const payload = { storeId: 7, organizationId: 42, webhookId: "wh-1" };

    await enqueueShopifyOrderSync(payload);

    expect(state.createQueue).toHaveBeenCalledOnce();
    const [name, handler, options] = state.createQueue.mock.calls[0] as [
      string,
      (job: { data: typeof payload }) => Promise<void>,
      {
        attempts: number;
        requireDurable: boolean;
        uniqueJobNames: boolean;
        replaceFailedOnEnqueue: boolean;
        onFinalFailure(job: { data: typeof payload }): Promise<void>;
      },
    ];
    expect(name).toBe("shopify-order-sync");
    expect(options).toMatchObject({
      attempts: 6,
      requireDurable: true,
      uniqueJobNames: true,
      replaceFailedOnEnqueue: true,
    });

    await handler({ data: payload });
    expect(state.handle).toHaveBeenCalledWith(payload);
    await options.onFinalFailure({ data: payload });
    expect(state.markFailed).toHaveBeenCalledWith(payload);
    expect(enqueue).toHaveBeenCalledWith("webhook-wh-1", payload);
  });

  it("allows a subsequent redelivery to call durable enqueue again with the same receipt id", async () => {
    const { enqueueShopifyOrderSync } = await import("./syncQueue");
    const payload = { storeId: 7, organizationId: 42, webhookId: "wh-redelivered" };

    await enqueueShopifyOrderSync(payload);
    await enqueueShopifyOrderSync(payload);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, "webhook-wh-redelivered", payload);
    expect(enqueue).toHaveBeenNthCalledWith(2, "webhook-wh-redelivered", payload);
  });
});

describe("when a merchant asks for a manual sync", () => {
  it("should queue it on its own queue, which falls back in-process rather than refusing without Redis", async () => {
    const { enqueueShopifyManualSync } = await import("./syncQueue");
    const payload = { storeId: 7, organizationId: 42, requestedAt: "2026-09-28T10:00:00.000Z" };

    await enqueueShopifyManualSync(payload);

    const [name, handler, options] = state.createQueue.mock.calls[0] as [
      string,
      (job: { data: typeof payload }) => Promise<void>,
      Record<string, unknown> & { onFinalFailure(job: { data: typeof payload }): Promise<void> },
    ];
    expect(name).toBe("shopify-manual-sync");
    // Losing a manual sync loses nothing (the watermark has not moved), unlike
    // a webhook sync owed for an acknowledged delivery.
    expect(options.requireDurable).toBeUndefined();
    // One visible failure, not minutes of invisible retries; unique names would
    // be retained with the finished job and absorb every later request.
    expect(options).toMatchObject({ attempts: 1 });
    expect(options.uniqueJobNames).toBeUndefined();
    expect(options.concurrency).toBeGreaterThan(1);

    await handler({ data: payload });
    expect(state.handleManual).toHaveBeenCalledWith(payload);
    await options.onFinalFailure({ data: payload });
    expect(state.markManualFailed).toHaveBeenCalledWith(payload);
  });

  it("should coalesce repeated requests per store, and only per store", async () => {
    const { enqueueShopifyManualSync } = await import("./syncQueue");

    const requestedAt = "2026-09-28T10:00:00.000Z";
    await enqueueShopifyManualSync({ storeId: 7, organizationId: 42, requestedAt });
    await enqueueShopifyManualSync({ storeId: 8, organizationId: 42, requestedAt });

    expect(enqueue).toHaveBeenNthCalledWith(1, "manual-7", { storeId: 7, organizationId: 42, requestedAt }, {
      coalesceKey: "shopify-manual-sync:42:7",
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, "manual-8", { storeId: 8, organizationId: 42, requestedAt }, {
      coalesceKey: "shopify-manual-sync:42:8",
    });
  });
});
