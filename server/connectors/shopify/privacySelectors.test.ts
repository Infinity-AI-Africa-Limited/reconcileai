import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoState = vi.hoisted(() => ({
  encrypt: vi.fn(async (organizationId: number, value: string) =>
    `tk1:${organizationId}:1:iv:tag:${crypto.createHash("sha256").update(value).digest("hex")}`,
  ),
  blind: vi.fn(async (organizationId: number, context: string, value: string) =>
    `tbi1:1:${crypto.createHash("sha256").update(`${organizationId}:${context}:${value}`).digest("hex")}`,
  ),
  dek: vi.fn(async () => ({ dek: Buffer.alloc(32), version: 1 })),
}));

vi.mock("../../_core/tenantKeys", () => ({
  encryptForTenant: cryptoState.encrypt,
  blindIndexForTenant: cryptoState.blind,
  getTenantDek: cryptoState.dek,
}));

import {
  PROTECT_SELECTOR_CHUNK,
  admitShopifyCustomerPrivacyRequest,
  protectCustomerPrivacySelectors,
  validateCustomerPrivacySelectors,
} from "./privacySelectors";
import { scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const REQUESTS = "shopify_privacy_requests";
const SELECTORS = "shopify_privacy_request_selectors";
const EVENTS = "shopify_webhook_events";
const STORES = "shopify_connector_stores";
const STORE = { id: 7, organizationId: 42, shopId: "gid://shopify/Shop/17", shopDomain: SHOP };
const BODY = {
  shop_id: 17,
  shop_domain: SHOP,
  data_request: { id: 31 },
  customer: { id: 41 },
  orders_requested: [501, 502, 503],
};

beforeEach(() => vi.clearAllMocks());

describe("customer privacy selector protection", () => {
  it("should encrypt and blind-index every selector under the owning tenant", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");

    const protectedSelectors = await protectCustomerPrivacySelectors(
      STORE.organizationId,
      STORE.id,
      validation.selectors,
    );

    expect(protectedSelectors.map(({ resourceType, position }) => ({ resourceType, position }))).toEqual([
      { resourceType: "customer", position: 0 },
      { resourceType: "order", position: 0 },
      { resourceType: "order", position: 1 },
      { resourceType: "order", position: 2 },
    ]);
    expect(cryptoState.encrypt).toHaveBeenCalledTimes(4);
    expect(cryptoState.blind).toHaveBeenCalledWith(42, "shopify:privacy-selector:7:customer", "41");
    expect(cryptoState.blind).toHaveBeenCalledWith(42, "shopify:privacy-selector:7:order", "501");
  });

  it("should isolate otherwise identical selectors by tenant and store context", async () => {
    const selector = [{ resourceType: "customer" as const, position: 0, externalId: "41" }];
    const [tenantA] = await protectCustomerPrivacySelectors(42, 7, selector);
    const [tenantB] = await protectCustomerPrivacySelectors(84, 8, selector);

    expect(tenantA.externalIdEnc).not.toBe(tenantB.externalIdEnc);
    expect(tenantA.externalIdHmac).not.toBe(tenantB.externalIdHmac);
    expect(cryptoState.blind).toHaveBeenNthCalledWith(1, 42, "shopify:privacy-selector:7:customer", "41");
    expect(cryptoState.blind).toHaveBeenNthCalledWith(2, 84, "shopify:privacy-selector:8:customer", "41");
  });
});

describe("customer privacy request admission", () => {
  it("should persist ordered protected selectors without raw identifiers in any row", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");
    const selectors = await protectCustomerPrivacySelectors(STORE.organizationId, STORE.id, validation.selectors);
    const fake = scriptedDb({ select: { [STORES]: [[{ status: "active" }]], [REQUESTS]: [[{ id: 901 }]] } });

    const status = await (fake.db as { transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> }).transaction((tx) =>
      admitShopifyCustomerPrivacyRequest(tx, {
        store: STORE,
        topic: "customers/data_request",
        requestHash: "payload-digest",
        webhookId: "wh-data-request",
        validation,
        selectors,
      }),
    );

    expect(status).toBe("received");
    const request = fake.writes("insert", REQUESTS)[0]?.data;
    expect(request).toMatchObject({ subjectHash: null, status: "received", admissionErrorCode: null });
    const selectorRows = fake.writes("insert", SELECTORS)[0]?.data;
    expect(selectorRows).toEqual([
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "customer", position: 0 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 0 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 1 }),
      expect.objectContaining({ requestId: 901, organizationId: 42, resourceType: "order", position: 2 }),
    ]);
    const persistedStrings = JSON.stringify(fake.committed()).match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
    expect(persistedStrings.map((value) => JSON.parse(value))).not.toEqual(
      expect.arrayContaining(["31", "41", "501", "502", "503"]),
    );
    const execution = fake.writes("insert", "shopify_privacy_data_request_jobs")[0];
    const outbox = fake.writes("insert", "shopify_privacy_queue_outbox")[0];
    expect(execution?.txId).not.toBeNull();
    expect(outbox?.txId).toBe(execution?.txId);
    expect(outbox?.data).toEqual({ kind: "customer_request", jobId: 901, status: "pending" });
  });

  it("should admit malformed selector payloads only into a safe manual-review state", async () => {
    const validation = validateCustomerPrivacySelectors(
      "customers/redact",
      { shop_id: 17, shop_domain: SHOP, orders_to_redact: [501] },
      STORE,
    );
    if (validation.ok) throw new Error("fixture should fail validation");
    const fake = scriptedDb({ select: { [STORES]: [[{ status: "active" }]] } });

    const status = await (fake.db as { transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> }).transaction((tx) =>
      admitShopifyCustomerPrivacyRequest(tx, {
        store: STORE,
        topic: "customers/redact",
        requestHash: "malformed-payload-digest",
        webhookId: "wh-malformed",
        validation,
        selectors: [],
      }),
    );

    expect(status).toBe("manual_review");
    expect(fake.writes("insert", REQUESTS)[0]?.data).toMatchObject({
      status: "manual_review",
      admissionErrorCode: "invalid_customer_id",
      subjectHash: null,
    });
    expect(fake.writes("insert", SELECTORS)).toEqual([]);
    expect(fake.writes("update", EVENTS)[0]?.data).toMatchObject({
      status: "processed",
      errorCode: "invalid_privacy_selectors",
    });
    expect(JSON.stringify(fake.committed())).not.toContain("501");
  });
});

const admit = (fake: ReturnType<typeof scriptedDb>, params: Parameters<typeof admitShopifyCustomerPrivacyRequest>[1]) =>
  (fake.db as { transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> }).transaction((tx) =>
    admitShopifyCustomerPrivacyRequest(tx, params),
  );

describe("when a large delivery is protected", () => {
  it("should resolve the tenant key once, before any selector is protected", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");
    await protectCustomerPrivacySelectors(STORE.organizationId, STORE.id, validation.selectors);

    expect(cryptoState.dek).toHaveBeenCalledTimes(1);
    expect(cryptoState.dek).toHaveBeenCalledWith(42);
    const keyResolved = cryptoState.dek.mock.invocationCallOrder[0];
    expect(Math.min(...cryptoState.encrypt.mock.invocationCallOrder)).toBeGreaterThan(keyResolved);
    expect(Math.min(...cryptoState.blind.mock.invocationCallOrder)).toBeGreaterThan(keyResolved);
  });

  it("should bound how many selectors are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    cryptoState.encrypt.mockImplementation(async (organizationId: number, value: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return `tk1:${organizationId}:1:iv:tag:${value}`;
    });
    const many = Array.from({ length: PROTECT_SELECTOR_CHUNK * 2 + 17 }, (_, position) => ({
      resourceType: "order" as const,
      position,
      externalId: String(position + 1),
    }));

    const prepared = await protectCustomerPrivacySelectors(42, 7, many);

    expect(prepared).toHaveLength(many.length);
    expect(prepared.map((selector) => selector.position)).toEqual(many.map((selector) => selector.position));
    expect(peak).toBeLessThanOrEqual(PROTECT_SELECTOR_CHUNK);
    expect(cryptoState.dek).toHaveBeenCalledTimes(1);
  });
});

describe("when the tenant has been fenced for shop redaction", () => {
  it("should write nothing at all, checked under the store-row lock", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");
    const fake = scriptedDb({ select: { [STORES]: [[{ status: "redacting" }]] } });

    const status = await admit(fake, {
      store: STORE,
      topic: "customers/data_request",
      requestHash: "late-delivery",
      webhookId: "wh-late",
      validation,
      selectors: [],
    });

    expect(status).toBe("fenced");
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
    const lock = fake.ops.find((op) => op.table === STORES);
    expect(lock).toMatchObject({ kind: "select", locked: true });
    expect(lock?.where?.params).toEqual(expect.arrayContaining([7, 42]));
  });
});

describe("when a request parked for manual review is replayed and now validates", () => {
  it("should promote it to received — and never regress a request further along", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");
    const fake = scriptedDb({ select: { [STORES]: [[{ status: "active" }]], [REQUESTS]: [[{ id: 901 }]] } });

    await admit(fake, {
      store: STORE,
      topic: "customers/data_request",
      requestHash: "replayed-payload",
      webhookId: "wh-replay",
      validation,
      selectors: [],
    });

    const promote = fake.writes("update", REQUESTS).find((op) => op.data?.status === "received");
    expect(promote?.data).toEqual({ status: "received", admissionErrorCode: null });
    // Only a manual-review row moves.
    expect(promote?.where?.params).toEqual(expect.arrayContaining([901, 42, "manual_review"]));
  });
});

describe("when a received customer request has no selectors", () => {
  it("should be quarantined for manual review by every admission for its store, after that admission's own selectors", async () => {
    const validation = validateCustomerPrivacySelectors("customers/data_request", BODY, STORE);
    if (!validation.ok) throw new Error("fixture should validate");
    const selectors = await protectCustomerPrivacySelectors(STORE.organizationId, STORE.id, validation.selectors);
    const fake = scriptedDb({ select: { [STORES]: [[{ status: "active" }]], [REQUESTS]: [[{ id: 901 }]] } });

    await admit(fake, {
      store: STORE,
      topic: "customers/data_request",
      requestHash: "fresh",
      webhookId: "wh-fresh",
      validation,
      selectors,
    });

    const repair = fake.writes("update", REQUESTS).find((op) => op.data?.admissionErrorCode === "selectors_unavailable");
    expect(repair?.data).toEqual({ status: "manual_review", admissionErrorCode: "selectors_unavailable" });
    expect(repair?.where?.sql).toMatch(/not exists \(select 1 from `shopify_privacy_request_selectors`/i);
    expect(repair?.where?.params).toEqual(
      expect.arrayContaining([42, 7, "customers/data_request", "customers/redact", "received"]),
    );
    // This request's own selectors were inserted first, so it cannot quarantine itself.
    const selectorInsertAt = fake.ops.findIndex((op) => op.kind === "insert" && op.table === SELECTORS);
    const repairAt = fake.ops.findIndex((op) => op === repair);
    expect(selectorInsertAt).toBeGreaterThanOrEqual(0);
    expect(repairAt).toBeGreaterThan(selectorInsertAt);
  });
});
