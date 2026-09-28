import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enqueue: vi.fn(async () => {}),
  createQueue: vi.fn(),
}));

vi.mock("../../jobQueue", () => ({
  createQueue: state.createQueue,
}));

import { enqueueShopifyPrivacyJob, runShopifyPrivacyRecoverySweep, singleFlight } from "./privacyQueue";

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

  it("should assign shop redaction a deterministic name without provider identifiers", async () => {
    await enqueueShopifyPrivacyJob({ kind: "shop_redact", jobId: 903 });

    expect(state.enqueue).toHaveBeenCalledWith(
      "privacy-shop-redact-903-d1",
      { kind: "shop_redact", jobId: 903 },
    );
    const payload = state.enqueue.mock.calls[0][1];
    expect(Object.keys(payload)).toEqual(["kind", "jobId"]);
    expect(JSON.stringify(payload)).not.toMatch(/organization|storeId|domain|webhook|hash|payload/i);
  });
});

describe("when the privacy recovery loop ticks", () => {
  it("should skip a tick while the previous sweep is still running, then run again once it ends", async () => {
    let release: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sweep = singleFlight(task);

    const first = sweep();
    await sweep(); // a slow sweep: this tick must not start a second one
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await first;
    const next = sweep();
    release();
    await next;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("should run cleanup even when dispatch fails, and log the failure without its text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = vi.fn(async () => 0);
    const failure = Object.assign(new Error("Failed query: select ... params: owner@example.com"), { name: "DrizzleQueryError" });

    await runShopifyPrivacyRecoverySweep({ recover: async () => { throw failure; }, cleanup });

    expect(cleanup).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toMatch(/durable_queue_unavailable/);
    expect(logged).toMatch(/"error":"database"/);
    expect(logged).not.toMatch(/owner@example\.com|Failed query/);
    error.mockRestore();
  });
});
