import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({
  db: null as unknown,
  secret: "whsec",
  digestKey: "ab".repeat(32),
  enqueue: vi.fn(async () => {}),
}));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
  createAuditLog: vi.fn(async () => {}),
}));
vi.mock("../../_core/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../_core/env")>();
  return {
    ...mod,
    ENV: new Proxy(mod.ENV, {
      get: (target, key) => {
        if (key === "shopifyClientSecret") return state.secret;
        if (key === "shopifyWebhookDigestKey") return state.digestKey;
        return Reflect.get(target, key);
      },
    }),
  };
});
vi.mock("./syncOrchestrator", () => ({
  enqueueShopifyWebhookSync: (...args: unknown[]) => state.enqueue(...args),
}));
vi.mock("../../_core/tenantKeys", () => ({
  encryptForTenant: vi.fn(async (organizationId: number, plaintext: string) =>
    `tk1:${organizationId}:1:iv:tag:${Buffer.from(plaintext).toString("hex")}`,
  ),
  blindIndexForTenant: vi.fn(async (organizationId: number, context: string, plaintext: string) =>
    `tbi1:1:${organizationId}:${context}:${plaintext}`,
  ),
}));

import type express from "express";
import { validateCustomerPrivacySelectors } from "./privacySelectors";
import { declaredShopDomain, handleShopifyWebhook, isStaleUninstall } from "./webhooks";
import { scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const STORES = "shopify_connector_stores";
const TOKENS = "shopify_connector_tokens";
const EVENTS = "shopify_webhook_events";
const PRIVACY_REQUESTS = "shopify_privacy_requests";
const PRIVACY_SELECTORS = "shopify_privacy_request_selectors";
const REDACTION_JOBS = "shopify_shop_redaction_jobs";
const OUTBOX = "shopify_privacy_queue_outbox";
const ORGANIZATIONS = "organizations";
const USERS = "users";

const store = {
  id: 7,
  organizationId: 42,
  shopId: "gid://shopify/Shop/17",
  shopDomain: SHOP,
  claimedByUserId: 9,
  claimedAt: new Date("2026-09-20T12:00:00Z"),
};

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
  state.digestKey = "ab".repeat(32);
  state.enqueue.mockResolvedValue(undefined);
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

describe("when a verified order event arrives", () => {
  it("should durably enqueue only an allowlisted topic and leave the receipt unsettled for the worker", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [EVENTS]: [[{ status: "received" }]] } });
    state.db = fake.db;

    const res = await delivery("orders/paid", { id: 1001 }).run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "queued_for_order_sync" });
    expect(state.enqueue).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, webhookId: "wh-orders/paid" });
    expect(fake.writes("update", EVENTS)).toEqual([]);
  });

  it("should answer 503 and mark failed when durable enqueue is unavailable", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [EVENTS]: [[{ status: "received" }]] } });
    state.db = fake.db;
    state.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"));

    const res = await delivery("orders/edited", { id: 1001 }).run();

    expect(res.statusCode).toBe(503);
    expect(fake.writes("update", EVENTS)[0]?.data).toMatchObject({ status: "failed", errorCode: "processing_error" });
  });

  it("should settle a verified non-allowlisted topic as ignored without enqueueing it", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [EVENTS]: [[{ status: "received" }]] } });
    state.db = fake.db;

    const res = await delivery("orders/fulfilled", { id: 1001 }).run();

    expect(res.body).toMatchObject({ status: "ignored_topic" });
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(fake.writes("update", EVENTS)[0]?.data).toMatchObject({ status: "ignored", errorCode: "topic_not_allowlisted" });
  });
});

describe("when a signed shop/redact delivery arrives", () => {
  function shopRedact(existingRunId?: string) {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [EVENTS]: [[{ status: "received" }]],
        [REDACTION_JOBS]: [existingRunId ? [{ jobId: 903, runId: existingRunId }] : []],
        [PRIVACY_REQUESTS]: [[{ id: 904 }]],
      },
      insert: { [REDACTION_JOBS]: [903] },
    });
    state.db = fake.db;
    return { fake, run: delivery("shop/redact", { shop_domain: SHOP, shop_id: 17 }).run };
  }

  it("should durably admit, fence, revoke, and acknowledge a known merchant", async () => {
    const { fake, run } = shopRedact();
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "shop_redact_admitted" });
    const job = fake.writes("insert", REDACTION_JOBS)[0];
    const outbox = fake.writes("insert", OUTBOX)[0];
    expect(job?.data).toMatchObject({ organizationId: 42, storeId: 7, status: "admitted" });
    expect(outbox?.data).toEqual({ kind: "shop_redact", jobId: 903, status: "pending" });
    expect(outbox?.txId).toBe(job?.txId);
    expect(outbox?.txId).not.toBeNull();
    expect(JSON.stringify(outbox?.data)).not.toMatch(/organization|storeId|domain|webhook|hash|payload/i);
    expect(fake.writes("update", ORGANIZATIONS)[0]?.data).toMatchObject({ isActive: false, deletionState: "redacting" });
    expect(fake.writes("update", USERS)[0]?.data).toMatchObject({ isActive: false });
    expect(fake.writes("delete", TOKENS)).toHaveLength(1);
    expect(fake.writes("update", STORES).at(-1)?.data).toMatchObject({ status: "redacting", statusReason: "shop_redact_requested" });
  });

  it("should treat a second request for the same store as an idempotent admission", async () => {
    const { fake, run } = shopRedact("existing-redaction-run");
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "shop_redact_duplicate" });
    expect(fake.writes("insert", REDACTION_JOBS)).toEqual([]);
    expect(fake.writes("insert", OUTBOX)).toEqual([]);
    expect(fake.writes("delete", TOKENS)).toEqual([]);
  });

  it("should roll back the shop job, outbox intent, and fence when admission cannot finish", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [EVENTS]: [[{ status: "received" }]],
        [REDACTION_JOBS]: [[]],
        [PRIVACY_REQUESTS]: [[{ id: 904 }]],
      },
      insert: { [REDACTION_JOBS]: [903], [OUTBOX]: [new Error("outbox unavailable")] },
    });
    state.db = fake.db;

    const res = await delivery("shop/redact", { shop_domain: SHOP, shop_id: 17 }).run();

    expect(res.statusCode).toBe(503);
    for (const table of [REDACTION_JOBS, OUTBOX, ORGANIZATIONS, USERS, TOKENS]) {
      expect(fake.committed().filter((op) => op.table === table && op.kind !== "select")).toEqual([]);
    }
  });
});

describe("when a signed customer privacy delivery arrives", () => {
  const body = {
    shop_id: 17,
    shop_domain: SHOP,
    data_request: { id: 31 },
    customer: { id: 41 },
    orders_requested: [501, 502, 503],
  };

  it("should durably admit the request and all ordered selectors before acknowledging", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [EVENTS]: [[{ status: "received" }]],
        [PRIVACY_REQUESTS]: [[{ id: 901 }]],
      },
    });
    state.db = fake.db;

    const res = await delivery("customers/data_request", body).run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true, status: "privacy_work_admitted" });
    expect(fake.writes("insert", PRIVACY_SELECTORS)[0]?.data).toEqual([
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "customer", position: 0 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 0 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 1 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 2 }),
    ]);
    const eventWrite = fake.writes("update", EVENTS).at(-1);
    expect(eventWrite?.data).toMatchObject({ status: "processed", errorCode: null });
    expect(eventWrite?.txId).not.toBeNull();
    expect(fake.writes("insert", "shopify_privacy_data_request_jobs")[0]?.data).toMatchObject({
      requestId: 901,
      organizationId: 42,
      storeId: 7,
      status: "received",
    });
    expect(fake.writes("insert", "shopify_privacy_queue_outbox")[0]?.data).toEqual({
      kind: "customer_request",
      jobId: 901,
      status: "pending",
    });
  });

  it("should acknowledge a processed duplicate without encrypting or inserting selectors again", async () => {
    const fake = scriptedDb({
      select: { [STORES]: [[store]], [EVENTS]: [[{ status: "processed" }]] },
    });
    state.db = fake.db;

    const res = await delivery("customers/data_request", body).run();

    expect(res.body).toEqual({ received: true, status: "duplicate" });
    expect(fake.writes("insert", PRIVACY_REQUESTS)).toEqual([]);
    expect(fake.writes("insert", PRIVACY_SELECTORS)).toEqual([]);
  });

  it("should retain malformed payloads as manual review without selector material", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [EVENTS]: [[{ status: "received" }]] } });
    state.db = fake.db;

    const res = await delivery("customers/redact", {
      shop_id: 17,
      shop_domain: SHOP,
      orders_to_redact: [501],
    }).run();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true, status: "privacy_manual_review" });
    expect(fake.writes("insert", PRIVACY_REQUESTS)[0]?.data).toMatchObject({
      status: "manual_review",
      admissionErrorCode: "invalid_customer_id",
      subjectHash: null,
    });
    expect(fake.writes("insert", PRIVACY_SELECTORS)).toEqual([]);
    expect(JSON.stringify(fake.committed())).not.toContain("501");
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

  it("should refuse to persist a webhook when the replay-digest secret is absent", async () => {
    state.digestKey = "";
    state.db = scriptedDb().db;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await delivery("customers/redact", { shop_domain: SHOP }).run();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "webhook_replay_protection_unavailable" });
    expect(log.mock.calls.flat().join(" ")).toMatch(/SHOPIFY_WEBHOOK_DIGEST_KEY is unavailable/);
    log.mockRestore();
  });
});

describe("when customer privacy selectors are validated", () => {
  const identity = { shopId: "gid://shopify/Shop/17", shopDomain: SHOP };

  it("should preserve the ordered order-selector set for a data request", () => {
    expect(
      validateCustomerPrivacySelectors(
        "customers/data_request",
        {
          shop_id: 17,
          shop_domain: SHOP,
          data_request: { id: 31 },
          customer: { id: 41 },
          orders_requested: [501, "502", 503],
        },
        identity,
      ),
    ).toEqual({
      ok: true,
      selectors: [
        { resourceType: "customer", position: 0, externalId: "41" },
        { resourceType: "order", position: 0, externalId: "501" },
        { resourceType: "order", position: 1, externalId: "502" },
        { resourceType: "order", position: 2, externalId: "503" },
      ],
    });
  });

  it.each([
    ["missing customer", { shop_id: 17, shop_domain: SHOP, data_request: { id: 31 } }],
    ["wrong shop", { shop_id: 18, shop_domain: SHOP, data_request: { id: 31 }, customer: { id: 41 } }],
    ["unsafe numeric id", { shop_id: 17, shop_domain: SHOP, data_request: { id: 31 }, customer: { id: 2 ** 54 } }],
    ["duplicate order", { shop_id: 17, shop_domain: SHOP, data_request: { id: 31 }, customer: { id: 41 }, orders_requested: [501, 501] }],
  ])("should reject %s without returning any raw selector", (_case, body) => {
    const result = validateCustomerPrivacySelectors("customers/data_request", body, identity);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/31|41|501/);
  });
});

describe("when an uninstall's trigger time is weighed against the latest authorization", () => {
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

describe("when the shop is read from a webhook body", () => {
  it("should read the shop from compliance and uninstall bodies, normalised", () => {
    expect(declaredShopDomain({ shop_domain: "Merchant.MyShopify.com" })).toBe(SHOP);
    expect(declaredShopDomain({ myshopify_domain: SHOP })).toBe(SHOP);
  });
  it("should say nothing when the body names no shop", () => {
    expect(declaredShopDomain({ myshopify_domain: null })).toBeNull();
    expect(declaredShopDomain(null)).toBeNull();
  });
});
