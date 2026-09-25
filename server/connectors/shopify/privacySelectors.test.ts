import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoState = vi.hoisted(() => ({
  encrypt: vi.fn(async (organizationId: number, value: string) =>
    `tk1:${organizationId}:1:iv:tag:${crypto.createHash("sha256").update(value).digest("hex")}`,
  ),
  blind: vi.fn(async (organizationId: number, context: string, value: string) =>
    `tbi1:1:${crypto.createHash("sha256").update(`${organizationId}:${context}:${value}`).digest("hex")}`,
  ),
}));

vi.mock("../../_core/tenantKeys", () => ({
  encryptForTenant: cryptoState.encrypt,
  blindIndexForTenant: cryptoState.blind,
}));

import {
  admitShopifyCustomerPrivacyRequest,
  protectCustomerPrivacySelectors,
  validateCustomerPrivacySelectors,
} from "./privacySelectors";
import { scriptedDb } from "./scriptedDb.testkit";

const SHOP = "merchant.myshopify.com";
const REQUESTS = "shopify_privacy_requests";
const SELECTORS = "shopify_privacy_request_selectors";
const EVENTS = "shopify_webhook_events";
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
    const fake = scriptedDb({ select: { [REQUESTS]: [[{ id: 901 }]] } });

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
    const fake = scriptedDb();

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
