/**
 * The daily batch re-reports open SHOPLINE GDPR requests every day, whatever
 * the stores' state. A shop/redact arrives after its store is uninstalled, so
 * a batch that finds no active store is exactly when one is open. The report
 * stays out of the batch's response, which the scheduler prints to a public
 * workflow log. (Greptile on #221: nothing pinned the call's position.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../shopify/scriptedDb.testkit";

const state = vi.hoisted(() => ({ db: null as unknown, report: vi.fn(), runSyncCycle: vi.fn() }));
vi.mock("../../db", () => ({ getDb: async () => state.db }));
vi.mock("./gdprDeadlines", () => ({ reportOpenShoplineGdprRequests: state.report }));
vi.mock("./syncOrchestrator", () => ({ runSyncCycle: state.runSyncCycle }));
vi.mock("./apiClient", () => ({ listWebhooks: vi.fn(), registerWebhook: vi.fn() }));
vi.mock("./tokenStore", () => ({ getValidToken: vi.fn() }));
vi.mock("./webhookHandler", () => ({ replayStalledWebhookEvents: vi.fn() }));

import { handleShoplineDailyBatch } from "./scheduledSync";

const STORES = "sl_connector_stores";

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

async function runBatch() {
  const res = response();
  await handleShoplineDailyBatch({ url: "/api/scheduled/shoplineDailyBatch" } as never, res as never);
  return res;
}

beforeEach(() => {
  state.report.mockReset();
  state.runSyncCycle.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("when the daily batch finds no active store", () => {
  it("should still report open GDPR requests, and keep them out of its response", async () => {
    state.db = scriptedDb({ select: { [STORES]: [[]] } }).db;

    const res = await runBatch();

    expect(state.report).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ ok: true, skipped: "no_active_stores", durationMs: expect.any(Number) });
    expect(state.runSyncCycle).not.toHaveBeenCalled();
  });
});

describe("when the daily batch syncs a store", () => {
  it("should report open GDPR requests once, and say nothing of them in its response", async () => {
    state.db = scriptedDb({
      select: { [STORES]: [[{ id: 7, organizationId: 42, storeHandle: "synthetic", storeId: "1", currency: "USD", apiVersion: "v1", lastSyncAt: null }]] },
    }).db;
    state.runSyncCycle.mockResolvedValue({
      success: true, organizationId: 42, storeHandle: "synthetic", window: { from: new Date(), to: new Date() },
      ordersIngested: 0, paymentsIngested: 0, payoutsIngested: 0, totalPersisted: 0, matchedCount: 0, exceptionCount: 0, durationMs: 1,
    });

    const res = await runBatch();

    expect(state.report).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/gdpr|erasure|redact/i);
  });
});

describe("when the daily batch cannot read its stores", () => {
  it("should already have reported open GDPR requests", async () => {
    state.db = scriptedDb({ select: { [STORES]: [new Error("connection lost")] } }).db;

    const res = await runBatch();

    expect(res.statusCode).toBe(500);
    expect(state.report).toHaveBeenCalledTimes(1);
  });
});
