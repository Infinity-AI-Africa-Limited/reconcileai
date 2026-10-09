import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import ts from "typescript";
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

import {
  confirmShopifyRuntimeQueues,
  startShopifyQueueEvidence,
  type ShopifyRuntimeQueueReadiness,
} from "./runtimeQueueReadiness";

const priorRedisUrl = process.env.REDIS_URL;
const healthy = {
  backend: "bullmq" as const,
  durable: true,
  counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
};
/** What a count read does while Redis is unreachable: neither resolve nor reject. */
const never = <T,>() => new Promise<T>(() => {});

afterEach(() => {
  if (priorRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = priorRedisUrl;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("when Shopify durable queue readiness is checked", () => {
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

describe("when Redis is configured but does not answer", () => {
  // Greptile #167: BullMQ holds a command until its connection is ready, and its
  // retry strategy never gives up, so an unreachable Redis is a read that never
  // settles. Unbounded, readiness waited with it.

  it("should answer unavailable within its deadline instead of waiting on the read", async () => {
    process.env.REDIS_URL = "redis://unreachable";
    state.order.mockReturnValue(never());
    state.privacy.mockReturnValue(never());
    const started = Date.now();

    await expect(confirmShopifyRuntimeQueues({ timeoutMs: 30 })).resolves.toEqual({
      status: "unavailable",
      durable: false,
      reason: "queue_timeout",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("should leave no rejection unhandled when a read fails after the deadline", async () => {
    process.env.REDIS_URL = "redis://unreachable";
    const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error("too late")), 40));
    state.order.mockImplementation(late);
    state.privacy.mockImplementation(late);
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await expect(confirmShopifyRuntimeQueues({ timeoutMs: 10 })).resolves.toMatchObject({ reason: "queue_timeout" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("when the server boots", () => {
  const pending = () => never<ShopifyRuntimeQueueReadiness>();

  it("should hand startup nothing to wait on, even while the probe never answers", () => {
    process.env.REDIS_URL = "redis://unreachable";
    const probe = vi.fn(pending);

    // void, not a promise: no caller can hold startup on it.
    expect(startShopifyQueueEvidence(probe)).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });

  it("should still serve the liveness check while the probe is pending", async () => {
    process.env.REDIS_URL = "redis://unreachable";
    const app = express();
    app.get("/api/healthz", (_req, res) => {
      res.status(200).send("ok");
    });

    // The boot order in server/_core/index.ts: start the evidence, then listen.
    startShopifyQueueEvidence(pending);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, { signal: AbortSignal.timeout(2_000) });
      expect(response.status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should log the outcome once it arrives, failure included", async () => {
    process.env.REDIS_URL = "redis://unreachable";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    startShopifyQueueEvidence(async () => ({ status: "unavailable", durable: false, reason: "queue_timeout" }));
    startShopifyQueueEvidence(() => Promise.reject(new Error("module failed to load")));

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledWith("[boot] Shopify durable queues unavailable", {
      code: "shopify_durable_queue_unavailable",
      reason: "queue_timeout",
    });
    expect(error).toHaveBeenCalledWith(
      "[boot] Shopify durable queue readiness failed",
      expect.objectContaining({ code: "shopify_durable_queue_readiness_failed", error: "Error" }),
    );
  });

  it("should not probe at all when Redis is not configured", () => {
    delete process.env.REDIS_URL;
    const probe = vi.fn(pending);

    startShopifyQueueEvidence(probe);

    expect(probe).not.toHaveBeenCalled();
  });

  it("should never be awaited by the server entry point", () => {
    // Structural, from the syntax tree rather than text positions: an
    // \`await\` on the readiness module or its probe anywhere in startup would
    // hold \`server.listen\` on Redis again.
    const file = path.join(__dirname, "..", "..", "_core", "index.ts");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const READINESS = /runtimeQueueReadiness|confirmShopifyRuntimeQueues|startShopifyQueueEvidence/;
    const awaited: string[] = [];
    let referenced = false;
    const visit = (node: ts.Node) => {
      if (ts.isAwaitExpression(node) && READINESS.test(node.expression.getText(source))) awaited.push(node.getText(source));
      if (ts.isIdentifier(node) && node.text === "startShopifyQueueEvidence") referenced = true;
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(referenced, "startup must use the non-blocking entry point").toBe(true);
    expect(awaited).toEqual([]);
  });
});
