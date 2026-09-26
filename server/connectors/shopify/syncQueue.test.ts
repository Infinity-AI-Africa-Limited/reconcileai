import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createQueue: vi.fn(),
  handle: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
}));

vi.mock("../../jobQueue", () => ({
  createQueue: (...args: unknown[]) => state.createQueue(...args),
}));
vi.mock("./syncOrchestrator", () => ({
  handleShopifyWebhookSync: (...args: unknown[]) => state.handle(...args),
  markShopifyWebhookSyncFailed: (...args: unknown[]) => state.markFailed(...args),
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
