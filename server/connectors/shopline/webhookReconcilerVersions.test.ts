/**
 * The webhook reconciler reports the API version of every subscription
 * SHOPLINE lists, not only how many there are.
 *
 * The connector registers each topic at SHOPLINE_API_VERSION. A subscription
 * at any other version was created somewhere else (an older connector, or the
 * Partner Portal's legacy configuration page), and two subscriptions to one
 * topic deliver every event twice. A count of 12 cannot tell twelve pinned
 * subscriptions from six pinned and six legacy; the versions can. The
 * development-store rehearsal (CLAUDE.md §2B.14) needs exactly that.
 */
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("./tokenStore", () => ({ getValidToken: vi.fn(async () => "token") }));
// Imported by the scheduled handlers beside this one; nothing here runs them.
vi.mock("./syncOrchestrator", () => ({ runSyncCycle: vi.fn() }));
vi.mock("./webhookHandler", () => ({ replayStalledWebhookEvents: vi.fn() }));
// The network edge: listing and registering subscriptions.
vi.mock("./apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apiClient")>()),
  listWebhooks: vi.fn(),
  registerWebhook: vi.fn(async () => ({})),
}));
// Belt and braces: any request that still escapes fails the suite loudly.
vi.stubGlobal("fetch", vi.fn(async () => {
  throw new Error("webhookReconcilerVersions.test.ts must not reach the network");
}));

import { SHOPLINE_API_VERSION, SHOPLINE_BILLING_WEBHOOK_TOPICS, SHOPLINE_WEBHOOK_TOPICS } from "../../../shared/shoplineConstants";
import { scriptedDb } from "../shopify/scriptedDb.testkit";
import { listWebhooks, registerWebhook, type ShoplineWebhookRegistration } from "./apiClient";
import { handleShoplineWebhookReconciler } from "./scheduledSync";

const REQUIRED = [...SHOPLINE_WEBHOOK_TOPICS, ...SHOPLINE_BILLING_WEBHOOK_TOPICS];
const LEGACY = "v20240101";

const subscription = (topic: string, apiVersion: string | undefined): ShoplineWebhookRegistration =>
  ({ id: `${topic}@${apiVersion}`, topic, address: "https://example.test/api/webhooks/shopline", api_version: apiVersion, created_at: "2026-10-01T00:00:00Z" }) as ShoplineWebhookRegistration;

interface StoreReport {
  storeHandle: string;
  existingCount: number;
  subscriptions: Array<{ topic: string; apiVersion: string | null }>;
  apiVersions: Record<string, number>;
  missingTopics: string[];
}

async function runReconciler(): Promise<StoreReport[]> {
  let body: { results?: StoreReport[] } = {};
  const res = {
    status: vi.fn(() => res),
    json: vi.fn((payload: { results?: StoreReport[] }) => {
      body = payload;
      return res;
    }),
  };
  await handleShoplineWebhookReconciler({ headers: {}, url: "/api/scheduled/shoplineWebhookReconciler" } as unknown as Request, res as unknown as Response);
  expect(res.status).not.toHaveBeenCalled();
  return body.results ?? [];
}

beforeEach(() => {
  vi.mocked(listWebhooks).mockReset();
  vi.mocked(registerWebhook).mockClear();
  state.db = scriptedDb({
    standing: {
      sl_connector_stores: [{ id: 5, organizationId: 42, storeHandle: "shop", storeId: "1", currency: "USD", apiVersion: SHOPLINE_API_VERSION, lastSyncAt: null }],
    },
  }).db;
});

describe("when a store's subscriptions are listed", () => {
  it("should report each subscription's API version beside the count", async () => {
    vi.mocked(listWebhooks).mockResolvedValue([
      ...REQUIRED.map((topic) => subscription(topic, SHOPLINE_API_VERSION)),
      subscription("orders/paid", LEGACY),
      subscription("appsubscription/paid", LEGACY),
    ]);

    const [report] = await runReconciler();

    expect(report.existingCount).toBe(REQUIRED.length + 2);
    expect(report.subscriptions).toHaveLength(REQUIRED.length + 2);
    expect(report.apiVersions).toEqual({ [SHOPLINE_API_VERSION]: REQUIRED.length, [LEGACY]: 2 });
    expect(report.subscriptions.filter((listed) => listed.topic === "appsubscription/paid")).toEqual([
      { topic: "appsubscription/paid", apiVersion: LEGACY },
      { topic: "appsubscription/paid", apiVersion: SHOPLINE_API_VERSION },
    ]);
    expect(report.missingTopics).toEqual([]);
  });

  it("should report a subscription SHOPLINE gives no version for, rather than drop it", async () => {
    vi.mocked(listWebhooks).mockResolvedValue([
      ...REQUIRED.map((topic) => subscription(topic, SHOPLINE_API_VERSION)),
      subscription("orders/create", undefined),
    ]);

    const [report] = await runReconciler();

    expect(report.subscriptions).toContainEqual({ topic: "orders/create", apiVersion: null });
    expect(report.apiVersions).toEqual({ [SHOPLINE_API_VERSION]: REQUIRED.length, none: 1 });
  });

  it("should still register only the topics that are missing", async () => {
    const [absent, ...present] = REQUIRED;
    vi.mocked(listWebhooks).mockResolvedValue(present.map((topic) => subscription(topic, LEGACY)));

    const [report] = await runReconciler();

    expect(report.missingTopics).toEqual([absent]);
    expect(vi.mocked(registerWebhook)).toHaveBeenCalledTimes(1);
    expect(report.apiVersions).toEqual({ [LEGACY]: present.length });
  });
});
