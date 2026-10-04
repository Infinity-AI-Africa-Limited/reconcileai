import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  order: vi.fn(),
  privacy: vi.fn(),
}));

vi.mock("./syncQueue", () => ({
  verifyShopifyOrderSyncQueue: () => state.order(),
}));
vi.mock("./privacyQueue", () => ({
  verifyShopifyPrivacyQueue: () => state.privacy(),
}));

import { confirmShopifyRuntimeQueues } from "./runtimeQueueReadiness";

const priorRedisUrl = process.env.REDIS_URL;
const healthy = {
  backend: "bullmq" as const,
  durable: true,
  counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
};

afterEach(() => {
  if (priorRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = priorRedisUrl;
  vi.clearAllMocks();
});

describe("Shopify durable runtime queue readiness", () => {
  it("does not claim durability or construct queues when Redis is absent", async () => {
    delete process.env.REDIS_URL;

    await expect(confirmShopifyRuntimeQueues()).resolves.toEqual({
      status: "unavailable",
      durable: false,
      reason: "redis_not_configured",
    });
    expect(state.order).not.toHaveBeenCalled();
    expect(state.privacy).not.toHaveBeenCalled();
  });

  it("confirms both production queues only after real BullMQ stats are available", async () => {
    process.env.REDIS_URL = "redis://private-runtime";
    state.order.mockResolvedValue(healthy);
    state.privacy.mockResolvedValue(healthy);

    await expect(confirmShopifyRuntimeQueues()).resolves.toEqual({
      status: "confirmed",
      durable: true,
    });
    expect(state.order).toHaveBeenCalledOnce();
    expect(state.privacy).toHaveBeenCalledOnce();
  });

  it("refuses readiness when a constructed queue cannot read Redis counts", async () => {
    process.env.REDIS_URL = "redis://private-runtime";
    state.order.mockResolvedValue(healthy);
    state.privacy.mockResolvedValue({ ...healthy, error: "ECONNRESET" });

    await expect(confirmShopifyRuntimeQueues()).resolves.toEqual({
      status: "unavailable",
      durable: false,
      reason: "queue_unavailable",
    });
  });

  it("refuses readiness when durable queue initialization rejects", async () => {
    process.env.REDIS_URL = "redis://private-runtime";
    state.order.mockRejectedValue(new Error("connection refused"));
    state.privacy.mockResolvedValue(healthy);

    await expect(confirmShopifyRuntimeQueues()).resolves.toEqual({
      status: "unavailable",
      durable: false,
      reason: "queue_unavailable",
    });
  });
});

describe("server startup", () => {
  const startup = fs.readFileSync(
    path.join(__dirname, "..", "..", "_core", "index.ts"),
    "utf8"
  );

  it("waits for the non-merchant readiness probe before listening", () => {
    const probe = startup.lastIndexOf("await confirmShopifyRuntimeQueues()");
    const listen = startup.lastIndexOf("server.listen(");
    expect(probe).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(probe);
  });
});
