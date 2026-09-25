import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import { createShopifyAppHomeRouter, SHOPIFY_APP_FRAME_ANCESTORS } from "./appHomeRoutes";
import { scriptedDb } from "./scriptedDb.testkit";
import { ShopifySettlementEvidenceError } from "./settlementEvidence";
import { ShopifyTokenUnavailableError } from "./tokenStore";

const CURSORS = "shopify_sync_cursors";
const context: ShopifyEmbeddedContext = {
  storeId: 7,
  organizationId: 42,
  shopDomain: "merchant.myshopify.com",
  displayName: "Merchant Store",
  currency: "USD",
};

const servers: Array<ReturnType<express.Express["listen"]>> = [];

async function start(router = createShopifyAppHomeRouter()) {
  const app = express();
  // Match production ordering: JSON parsing runs before the Shopify router.
  app.use(express.json());
  app.use(router);
  app.get("*", (_req, res) => res.type("html").send("app shell"));
  const server = await new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Shopify embedded App Home routes", () => {
  it("serves only the public API key, or a generic 503 when it is absent", async () => {
    const configured = await start(createShopifyAppHomeRouter({ clientId: () => "public-api-key" }));
    const success = await fetch(`${configured}/api/shopify/app-home/config`);
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ apiKey: "public-api-key" });

    const missing = await start(createShopifyAppHomeRouter({ clientId: () => "" }));
    const unavailable = await fetch(`${missing}/api/shopify/app-home/config`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: { code: "configuration_unavailable" } });
  });

  it("returns a PII-free active-store view, scoped cursor evidence, and fixed Scope A capabilities", async () => {
    const db = scriptedDb({
      select: {
        [CURSORS]: [[{ lastSuccessfulAt: new Date("2026-09-25T07:30:00.000Z"), lastErrorCode: null }]],
      },
    });
    const authenticate = vi.fn(async () => ({
      ...context,
      contactEmail: "owner@example.com",
      accessToken: "must-not-leak",
    }) as ShopifyEmbeddedContext);
    const base = await start(createShopifyAppHomeRouter({
      authenticate,
      getDatabase: async () => db.db as never,
    }));

    const response = await fetch(`${base}/api/shopify/app-home/context`, {
      headers: { authorization: "Bearer signed-id-token" },
    });
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith("Bearer signed-id-token");
    expect(body).toEqual({
      store: {
        shopDomain: context.shopDomain,
        displayName: context.displayName,
        currency: context.currency,
      },
      sync: { lastSuccessfulAt: "2026-09-25T07:30:00.000Z", lastErrorCode: null },
      capabilities: {
        scope: "read_orders",
        readOrders: true,
        manualSync: true,
        shopifyPayments: false,
        mutations: false,
      },
    });
    expect(text).not.toMatch(/owner@example\.com|must-not-leak|storeId|organizationId|contactEmail|accessToken/);
    expect(db.ops[0]?.where?.params).toEqual([7, 42, "orders"]);
  });

  it("scopes Shopify frame headers to /shopify/app and does not emit X-Frame-Options deny", async () => {
    const base = await start(createShopifyAppHomeRouter());
    const embedded = await fetch(`${base}/shopify/app`);
    const ordinary = await fetch(`${base}/shopify/welcome`);

    expect(embedded.headers.get("content-security-policy")).toBe(SHOPIFY_APP_FRAME_ANCESTORS);
    expect(embedded.headers.get("x-frame-options")).toBeNull();
    expect(ordinary.headers.get("content-security-policy")).toBeNull();
  });

  it("ignores browser tenant/store fields and syncs only the authenticated context", async () => {
    const runSync = vi.fn(async () => ({
      success: true,
      organizationId: context.organizationId,
      storeId: context.storeId,
      window: {
        from: new Date("2026-09-25T07:00:00.000Z"),
        to: new Date("2026-09-25T08:00:00.000Z"),
      },
      fetched: 3,
      inserted: 2,
      updated: 1,
      unchanged: 0,
      batchId: 998,
    }));
    const authenticate = vi.fn(async (_authorization: Request["headers"]["authorization"]) => context);
    const base = await start(createShopifyAppHomeRouter({ authenticate, runSync }));

    const response = await fetch(`${base}/api/shopify/app-home/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-id-token" },
      body: JSON.stringify({ storeId: 999, organizationId: 888, trigger: "webhook" }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(runSync).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    expect(JSON.parse(text)).toEqual({
      success: true,
      window: { from: "2026-09-25T07:00:00.000Z", to: "2026-09-25T08:00:00.000Z" },
      fetched: 3,
      inserted: 2,
      updated: 1,
      unchanged: 0,
    });
    expect(text).not.toMatch(/998|storeId|organizationId/);
  });

  it("maps sync conflicts, merchant action, and outages without leaking operational messages", async () => {
    const cases = [
      {
        error: new ShopifyTokenUnavailableError("another worker holds lease secret-123", "refresh_in_progress"),
        status: 409,
        code: "sync_in_progress",
      },
      {
        error: new ShopifyTokenUnavailableError("provider rejected private credential", "reauthorize"),
        status: 422,
        code: "store_action_required",
      },
      { error: new Error("database host and password details"), status: 503, code: "service_unavailable" },
    ] as const;

    for (const testCase of cases) {
      const base = await start(createShopifyAppHomeRouter({
        authenticate: async () => context,
        runSync: vi.fn(async () => { throw testCase.error; }),
      }));
      const response = await fetch(`${base}/api/shopify/app-home/sync`, {
        method: "POST",
        headers: { authorization: "Bearer signed-id-token" },
      });
      const body = await response.text();
      expect(response.status).toBe(testCase.status);
      expect(JSON.parse(body)).toEqual({ error: { code: testCase.code } });
      expect(body).not.toMatch(/lease|credential|database|password|secret-123/);
    }
  });

  it("ignores browser tenant/store/channel fields and returns only the safe dry-run summary", async () => {
    const importSettlementEvidence = vi.fn(async () => ({
      committed: false as const,
      headers: ["Order ID", "Amount"],
      mapping: { orderRef: "Order ID", amount: "Amount" },
      missingRequired: [],
      totalRows: 1,
      parseErrors: [],
      sampleRows: [{ "Order ID": "customer@example.com", Amount: "12.34" }],
      channelId: 987,
      organizationId: 888,
    }));
    const db = {} as never;
    const base = await start(createShopifyAppHomeRouter({
      authenticate: async () => context,
      getDatabase: async () => db,
      importSettlementEvidence: importSettlementEvidence as never,
    }));

    const response = await fetch(`${base}/api/shopify/app-home/settlement-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-id-token" },
      body: JSON.stringify({
        fileName: "evidence.csv",
        content: "Order ID,Amount\n#1001,12.34",
        contentEncoding: "utf8",
        sourceLabel: "Courier COD",
        dryRun: true,
        storeId: 999,
        organizationId: 888,
        channelId: 987,
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(importSettlementEvidence).toHaveBeenCalledWith(
      context,
      {
        fileName: "evidence.csv",
        content: "Order ID,Amount\n#1001,12.34",
        contentEncoding: "utf8",
        sourceLabel: "Courier COD",
        dryRun: true,
      },
      db,
    );
    expect(JSON.parse(text)).toEqual({
      committed: false,
      headers: ["Order ID", "Amount"],
      mapping: { orderRef: "Order ID", amount: "Amount" },
      missingRequired: [],
      totalRows: 1,
      parseErrors: [],
    });
    expect(text).not.toMatch(/customer@example\.com|12\.34|channelId|organizationId|storeId|987|888/);
  });

  it("returns only committed counters even if an import seam includes internal or row data", async () => {
    const importSettlementEvidence = vi.fn(async () => ({
      committed: true as const,
      mapping: { orderRef: "order_number", amount: "paid_amount" },
      totalRows: 4,
      imported: 3,
      duplicates: 1,
      failed: 0,
      matchedCount: 2,
      exceptionCount: 1,
      sampleRows: [{ order_number: "PII-SECRET" }],
      batchId: 112233,
    }));
    const base = await start(createShopifyAppHomeRouter({
      authenticate: async () => context,
      getDatabase: async () => ({} as never),
      importSettlementEvidence: importSettlementEvidence as never,
    }));
    const response = await fetch(`${base}/api/shopify/app-home/settlement-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-id-token" },
      body: JSON.stringify({
        fileName: "evidence.csv",
        content: "order_number,paid_amount\n#1001,12.34",
        contentEncoding: "utf8",
        sourceLabel: "Bank export",
        dryRun: false,
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      committed: true,
      mapping: { orderRef: "order_number", amount: "paid_amount" },
      totalRows: 4,
      imported: 3,
      duplicates: 1,
      failed: 0,
      matchedCount: 2,
      exceptionCount: 1,
    });
    expect(text).not.toMatch(/PII-SECRET|112233|batchId|sampleRows/);
  });

  it("rejects malformed or extra column-override keys with one generic response", async () => {
    const importSettlementEvidence = vi.fn();
    const base = await start(createShopifyAppHomeRouter({
      authenticate: async () => context,
      getDatabase: async () => ({} as never),
      importSettlementEvidence,
    }));
    const response = await fetch(`${base}/api/shopify/app-home/settlement-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-id-token" },
      body: JSON.stringify({
        fileName: "evidence.csv",
        content: "order,amount\nA,1",
        contentEncoding: "utf8",
        sourceLabel: "Bank",
        dryRun: true,
        columnOverrides: { customerEmail: "Email" },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(importSettlementEvidence).not.toHaveBeenCalled();
  });

  it("maps a missing order channel and unavailable tenant admin to safe action errors", async () => {
    const cases = [
      { serviceCode: "ORDER_SYNC_REQUIRED", status: 422, responseCode: "order_sync_required" },
      { serviceCode: "ACTOR_UNAVAILABLE", status: 403, responseCode: "active_admin_required" },
    ] as const;

    for (const testCase of cases) {
      const base = await start(createShopifyAppHomeRouter({
        authenticate: async () => context,
        getDatabase: async () => ({} as never),
        importSettlementEvidence: vi.fn(async () => {
          throw new ShopifySettlementEvidenceError(testCase.serviceCode);
        }),
      }));
      const response = await fetch(`${base}/api/shopify/app-home/settlement-evidence`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer signed-id-token" },
        body: JSON.stringify({
          fileName: "evidence.csv",
          content: "order,amount\nA,1",
          contentEncoding: "utf8",
          sourceLabel: "Bank",
          dryRun: true,
        }),
      });
      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toEqual({ error: { code: testCase.responseCode } });
    }
  });
});
