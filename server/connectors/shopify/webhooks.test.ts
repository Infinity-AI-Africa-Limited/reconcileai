import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({ db: null as unknown, secret: "whsec" }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
  createAuditLog: vi.fn(async () => {}),
}));
vi.mock("../../_core/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../_core/env")>();
  return {
    ...mod,
    ENV: new Proxy(mod.ENV, { get: (target, key) => (key === "shopifyClientSecret" ? state.secret : Reflect.get(target, key)) }),
  };
});

import type express from "express";
import { declaredShopDomain, handleShopifyWebhook, isStaleUninstall } from "./webhooks";
import { scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const STORES = "shopify_connector_stores";
const TOKENS = "shopify_connector_tokens";
const EVENTS = "shopify_webhook_events";

const store = { id: 7, organizationId: 42, shopDomain: SHOP, claimedByUserId: 9, claimedAt: new Date("2026-09-20T12:00:00Z") };

function delivery(topic: string, body: object, headers: Record<string, string> = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const all: Record<string, string> = {
    "x-shopify-hmac-sha256": crypto.createHmac("sha256", "whsec").update(raw).digest("base64"),
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": SHOP,
    "x-shopify-webhook-id": `wh-${topic}`,
    ...headers,
  };
  const req = { rawBody: raw, header: (name: string) => all[name.toLowerCase()] } as unknown as express.Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req, res, run: () => handleShopifyWebhook(req, res as unknown as express.Response).then(() => res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.secret = "whsec";
});

describe("when the database fails mid-delivery", () => {
  it("should answer 503 rather than let the rejection escape the handler", async () => {
    // Express 4 does not catch a rejected handler and the server has no
    // unhandledRejection hook: an escaped error here exits the process.
    state.db = scriptedDb({ select: { [STORES]: [new Error("ECONNRESET")] } }).db;
    const res = await delivery("orders/paid", { id: 1 }).run();
    expect(res.statusCode).toBe(503);
  });
});

describe("when the signed body names a different shop than the unsigned header", () => {
  it("should refuse without acting on the header's store", async () => {
    const fake = scriptedDb();
    state.db = fake.db;
    const res = await delivery("shop/redact", { shop_id: 1, shop_domain: "attacker.myshopify.com" }).run();
    expect(res.statusCode).toBe(400);
    expect(fake.ops).toEqual([]);
  });
});

describe("when an app/uninstalled delivery arrives", () => {
  function uninstall(triggeredAt: string, eventStatus = "received") {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [EVENTS]: [[{ status: eventStatus }]] } });
    state.db = fake.db;
    return { fake, run: delivery("app/uninstalled", { id: 1, myshopify_domain: SHOP }, { "x-shopify-triggered-at": triggeredAt }).run };
  }

  it("should revoke the store's credentials when it was triggered after the latest authorization", async () => {
    const { fake, run } = uninstall("2026-09-21T08:00:00Z");
    expect((await run()).statusCode).toBe(200);
    expect(fake.writes("delete", TOKENS)).toHaveLength(1);
    expect(fake.writes("update", STORES)[0]?.data).toMatchObject({ status: "uninstalled", statusReason: "uninstalled" });
  });

  it("should ignore a retry triggered before the merchant reinstalled, keeping the new credentials", async () => {
    const { fake, run } = uninstall("2026-09-19T08:00:00Z");
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ignored_stale" });
    expect(fake.writes("delete", TOKENS)).toEqual([]);
    expect(fake.writes("update", EVENTS)[0]?.data).toMatchObject({ status: "ignored", errorCode: "stale_uninstall" });
  });

  it("should acknowledge a redelivery of an already-processed event without re-applying it", async () => {
    const { fake, run } = uninstall("2026-09-21T08:00:00Z", "processed");
    const res = await run();
    expect(res.body).toMatchObject({ status: "duplicate" });
    expect(fake.writes("delete", TOKENS)).toEqual([]);
  });
});

describe("when the HMAC does not verify", () => {
  it("should answer 401 for a wrong signature", async () => {
    state.db = scriptedDb().db;
    const { run } = delivery("customers/redact", { shop_domain: SHOP }, { "x-shopify-hmac-sha256": "bm90LWEtc2lnbmF0dXJl" });
    expect((await run()).statusCode).toBe(401);
  });

  it("should answer 401 and say why when the client secret is not configured", async () => {
    state.secret = "";
    state.db = scriptedDb().db;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await delivery("customers/redact", { shop_domain: SHOP }).run()).statusCode).toBe(401);
    expect(log.mock.calls.flat().join(" ")).toMatch(/SHOPIFY_CLIENT_SECRET is not configured/);
    log.mockRestore();
  });
});

describe("isStaleUninstall", () => {
  const claimed = new Date("2026-09-20T12:00:00Z");
  it("should be stale only when triggered strictly before the latest claim", () => {
    expect(isStaleUninstall("2026-09-20T11:59:59Z", claimed)).toBe(true);
    expect(isStaleUninstall("2026-09-20T12:00:01Z", claimed)).toBe(false);
  });
  it("should apply the uninstall when it cannot tell", () => {
    expect(isStaleUninstall(undefined, claimed)).toBe(false);
    expect(isStaleUninstall("not a date", claimed)).toBe(false);
    expect(isStaleUninstall("2026-09-19T00:00:00Z", null)).toBe(false);
  });
});

describe("declaredShopDomain", () => {
  it("should read the shop from compliance and uninstall bodies, normalised", () => {
    expect(declaredShopDomain({ shop_domain: "Merchant.MyShopify.com" })).toBe(SHOP);
    expect(declaredShopDomain({ myshopify_domain: SHOP })).toBe(SHOP);
  });
  it("should say nothing when the body names no shop", () => {
    expect(declaredShopDomain({ myshopify_domain: null })).toBeNull();
    expect(declaredShopDomain(null)).toBeNull();
  });
});
