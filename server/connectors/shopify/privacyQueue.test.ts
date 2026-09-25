import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enqueue: vi.fn(async () => {}),
  createQueue: vi.fn(),
}));

vi.mock("../../jobQueue", () => ({
  createQueue: state.createQueue,
}));

import { enqueueShopifyPrivacyJob } from "./privacyQueue";

describe("Shopify privacy durable queue boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.createQueue.mockResolvedValue({ enqueue: state.enqueue });
  });

  it("should require durable unique-name dispatch and reveal only kind plus internal job id", async () => {
    await enqueueShopifyPrivacyJob({ kind: "customer_request", jobId: 901 }, 3);
    expect(state.createQueue).toHaveBeenCalledWith(
      "shopify-privacy",
      expect.any(Function),
      expect.objectContaining({ requireDurable: true, uniqueJobNames: true, attempts: 6 }),
    );
    // Unique per DISPATCH: a settled entry from an earlier dispatch of this job
    // must not swallow a later one. The database lease prevents a double run.
    expect(state.enqueue).toHaveBeenCalledWith(
      "privacy-request-901-d3",
      { kind: "customer_request", jobId: 901 },
    );
    const payload = state.enqueue.mock.calls[0][1];
    expect(Object.keys(payload)).toEqual(["kind", "jobId"]);
    expect(JSON.stringify(payload)).not.toMatch(/organization|store|shop|domain|selector|customerId|orderId|hash|url/i);
  });
});
