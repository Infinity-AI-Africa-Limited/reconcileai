/**
 * Whether a Shopify store's tenant is a test tenant, decided by Shopify's
 * `shop.plan.partnerDevelopment`, and kept correct when a development store
 * is taken live. The failure this exists to prevent in BOTH directions:
 *
 *   - a development store arriving as a client (2026-10-16: our own did, then
 *     appeared in the owner's SLA alert and blocked platform reviewer links);
 *   - a development store handed to a merchant and taken live, still marked a
 *     test tenant — a paying client whose SLA breaches would never be reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
  createAuditLog: vi.fn(async () => {}),
}));
vi.mock("../../_core/notification", () => ({ notifyOwner: vi.fn(async () => true) }));

import { createAuditLog } from "../../db";
import { notifyOwner } from "../../_core/notification";
import { fetchShopifyShopMetadata } from "./apiClient";
import {
  announceShopifyStoreWentLive,
  applyShopifyStoreClassification,
  fetchShopifyPartnerDevelopment,
  recheckShopifyStoreClassifications,
  shopifyClassificationChange,
} from "./storeClassification";
import { rowOf, scriptedDb, type RecordedOp } from "./scriptedDb.testkit";

const ORGS = "organizations";
const STORES = "shopify_connector_stores";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const STORE = { id: 7, organizationId: 180001, shopDomain: "reconcileai-dev-store.myshopify.com" };
const activeOrg = (isDemo: boolean) => ({ isDemo, deletionState: "active" });
const storeRow = (planPartnerDevelopment: boolean | null) => ({ planPartnerDevelopment, status: "active", privacyRedactionState: "active" });

const okJson = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

function apply(fake: ReturnType<typeof scriptedDb>, observed: boolean | null) {
  return (fake.db as { transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T> }).transaction((tx) =>
    applyShopifyStoreClassification(tx, { store: STORE, observed, now: NOW, trigger: "recheck" }),
  );
}

const writes = (fake: ReturnType<typeof scriptedDb>, table: string) =>
  fake.writes("update", table).map((op) => rowOf(op));

beforeEach(() => {
  vi.mocked(createAuditLog).mockClear();
  vi.mocked(notifyOwner).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("when Shopify is asked whether a store is a development store", () => {
  it("should report what Shopify answers", async () => {
    for (const answer of [true, false]) {
      const fetchImpl = okJson({ data: { shop: { plan: { partnerDevelopment: answer } } } });
      expect(await fetchShopifyPartnerDevelopment({ shopDomain: STORE.shopDomain, accessToken: "t", fetchImpl })).toBe(answer);
    }
  });

  it("should ask for the plan flag and nothing about orders, customers or money", async () => {
    const fetchImpl = okJson({ data: { shop: { plan: { partnerDevelopment: true } } } });
    await fetchShopifyPartnerDevelopment({ shopDomain: STORE.shopDomain, accessToken: "t", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://reconcileai-dev-store.myshopify.com/admin/api/2026-07/graphql.json");
    const query = JSON.parse(String(init.body)).query as string;
    expect(query).toMatch(/plan\s*{\s*partnerDevelopment\s*}/);
    expect(query).not.toMatch(/order|customer|transaction|email|amount/i);
  });

  it.each([
    ["Shopify refuses the field", okJson({ errors: [{ message: "Access denied" }], data: null })],
    ["the answer is missing", okJson({ data: { shop: { plan: null } } })],
    ["the answer is not a boolean", okJson({ data: { shop: { plan: { partnerDevelopment: "yes" } } } })],
    ["Shopify answers with an error status", vi.fn(async () => new Response("", { status: 503 }))],
    ["the body is not JSON", vi.fn(async () => new Response("<html>", { status: 200 }))],
    ["the request fails outright", vi.fn(async () => { throw new TypeError("fetch failed"); })],
  ])("should answer unknown, never throw, when %s", async (_case, fetchImpl) => {
    await expect(
      fetchShopifyPartnerDevelopment({ shopDomain: STORE.shopDomain, accessToken: "t", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });

  it("should not ask a host that is not a Shopify store", async () => {
    const fetchImpl = okJson({});
    expect(await fetchShopifyPartnerDevelopment({ shopDomain: "evil.example.com", accessToken: "t", fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("when the shop metadata for an installation is fetched", () => {
  const metadataBody = {
    data: { shop: { id: "gid://shopify/Shop/1", name: "Dev", contactEmail: "a@b.co", currencyCode: "USD", ianaTimezone: "UTC", primaryDomain: { host: "x" } } },
  };

  it("should carry Shopify's development-store answer", async () => {
    vi.stubGlobal("fetch", okJson(metadataBody));
    const metadata = await fetchShopifyShopMetadata(
      { shopDomain: STORE.shopDomain, accessToken: "t" },
      { fetchPartnerDevelopment: async () => true },
    );
    expect(metadata.partnerDevelopment).toBe(true);
    vi.unstubAllGlobals();
  });

  it("should still succeed when the development-store question cannot be answered", async () => {
    // An installation needs the metadata, not the plan: this must never fail it.
    vi.stubGlobal("fetch", okJson(metadataBody));
    const metadata = await fetchShopifyShopMetadata(
      { shopDomain: STORE.shopDomain, accessToken: "t" },
      { fetchPartnerDevelopment: async () => null },
    );
    expect(metadata).toMatchObject({ name: "Dev", partnerDevelopment: null });
    vi.unstubAllGlobals();
  });
});

describe("when deciding what Shopify's answer changes", () => {
  it.each([
    [null, true, "test_tenant", "a development store seen for the first time"],
    [false, true, "test_tenant", "a store recorded live now reporting development (never demoted by us)"],
    [true, false, "client", "a development store taken live"],
    [true, true, null, "a development store still a development store"],
    [null, false, null, "a live store, never seen as a development store"],
    [false, false, null, "a live store still live"],
    [true, null, null, "no answer for a development store"],
    [null, null, null, "no answer at all"],
  ] as const)("should go from %s to %s as %s (%s)", (previous, observed, expected, _situation) => {
    expect(shopifyClassificationChange(previous, observed)).toBe(expected);
  });
});

describe("when Shopify's answer is applied to a store's tenant", () => {
  it("should make a development store's tenant a test tenant, attributed to Shopify, not a person", async () => {
    const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(false)]], [STORES]: [[storeRow(null)]] } });
    await expect(apply(fake, true)).resolves.toEqual({ changedTo: "test_tenant" });

    expect(writes(fake, STORES)).toEqual([{ planCheckedAt: NOW, planPartnerDevelopment: true }]);
    expect(writes(fake, ORGS)).toEqual([{ isDemo: true }]);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 180001,
        userId: null,
        action: "update_org_is_demo",
        details: expect.objectContaining({ isDemo: true, source: "shopify_partner_development", partnerDevelopment: true, previousPartnerDevelopment: null, trigger: "recheck" }),
      }),
      expect.anything(),
    );
  });

  it("should lock the organisation, then the store — the order every Shopify path uses", async () => {
    const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(false)]], [STORES]: [[storeRow(null)]] } });
    await apply(fake, true);
    const locks = fake.ops.filter((op: RecordedOp) => op.kind === "select" && op.locked).map((op) => op.table);
    expect(locks).toEqual([ORGS, STORES]);
  });

  it("should make a development store that went live a client again", async () => {
    // The dangerous direction: a test tenant that is now a paying client.
    const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(true)]], [STORES]: [[storeRow(true)]] } });
    await expect(apply(fake, false)).resolves.toEqual({ changedTo: "client" });

    expect(writes(fake, ORGS)).toEqual([{ isDemo: false }]);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ isDemo: false, partnerDevelopment: false, previousPartnerDevelopment: true }) }),
      expect.anything(),
    );
  });

  it("should record only that it asked when Shopify could not answer", async () => {
    const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(true)]], [STORES]: [[storeRow(true)]] } });
    await expect(apply(fake, null)).resolves.toEqual({ changedTo: null });

    expect(writes(fake, STORES)).toEqual([{ planCheckedAt: NOW }]);
    expect(writes(fake, ORGS)).toEqual([]);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("should leave an operator's demo mark on a live store alone", async () => {
    // The store was never a development store, so there is no basis of ours to
    // correct: the operator's audited choice stands.
    for (const previous of [null, false] as const) {
      const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(true)]], [STORES]: [[storeRow(previous)]] } });
      await expect(apply(fake, false)).resolves.toEqual({ changedTo: null });
      expect(writes(fake, ORGS)).toEqual([]);
    }
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("should write nothing to the tenant when an operator already marked the development store a demo", async () => {
    const fake = scriptedDb({ select: { [ORGS]: [[activeOrg(true)]], [STORES]: [[storeRow(null)]] } });
    await expect(apply(fake, true)).resolves.toEqual({ changedTo: null });
    expect(writes(fake, ORGS)).toEqual([]);
    expect(writes(fake, STORES)).toEqual([{ planCheckedAt: NOW, planPartnerDevelopment: true }]);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["the tenant is being redacted", { isDemo: false, deletionState: "redacting" }, storeRow(null)],
    ["the store is being redacted", activeOrg(false), { ...storeRow(null), status: "redacting" }],
    ["a customer redaction fences the store", activeOrg(false), { ...storeRow(null), privacyRedactionState: "customer_redacting" }],
  ])("should write nothing when %s", async (_case, org, store) => {
    const fake = scriptedDb({ select: { [ORGS]: [[org]], [STORES]: [[store]] } });
    await expect(apply(fake, true)).resolves.toEqual({ changedTo: null });
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
  });
});

describe("when the stores are re-checked on a schedule", () => {
  const due = { id: 7, organizationId: 180001, shopDomain: STORE.shopDomain };

  function sweepDb(selects: Record<string, unknown[][]>) {
    const fake = scriptedDb({ select: selects });
    state.db = fake.db;
    return fake;
  }

  it("should ask only about stores whose answer could still change, and not too often", async () => {
    const fake = sweepDb({ [STORES]: [[]] });
    await recheckShopifyStoreClassifications({ now: () => NOW });
    const scan = fake.ops.find((op) => op.kind === "select" && op.table === STORES && !op.locked);
    // Unknown or development stores only: a live store cannot become a development store.
    expect(scan?.where?.sql).toMatch(/`planPartnerDevelopment` is null or `shopify_connector_stores`\.`planPartnerDevelopment` = \?/);
    expect(scan?.where?.sql).toMatch(/`planCheckedAt` is null or `shopify_connector_stores`\.`planCheckedAt` <= \?/);
    expect(scan?.where?.params).toContain("2026-10-18 06:00:00.000");
  });

  it("should reclassify a store that went live, and tell the owner once, after the commit", async () => {
    const fake = sweepDb({ [STORES]: [[due], [storeRow(true)]], [ORGS]: [[activeOrg(true)]] });
    const announce = vi.fn(async () => {});
    const report = await recheckShopifyStoreClassifications({
      now: () => NOW,
      getAccessToken: async () => "token",
      fetchPartnerDevelopment: async () => false,
      announce,
    });
    expect(report).toEqual({ scanned: 1, changed: 1, unknown: 0, failed: 0 });
    expect(writes(fake, ORGS)).toEqual([{ isDemo: false }]);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(due);
  });

  it("should tell the owner nothing when nothing changed", async () => {
    // A development store still a development store, every six hours, must not
    // become a stream of "went live" emails.
    sweepDb({ [STORES]: [[due], [storeRow(true)]], [ORGS]: [[activeOrg(true)]] });
    const announce = vi.fn(async () => {});
    const report = await recheckShopifyStoreClassifications({
      now: () => NOW,
      getAccessToken: async () => "token",
      fetchPartnerDevelopment: async () => true,
      announce,
    });
    expect(report).toEqual({ scanned: 1, changed: 0, unknown: 0, failed: 0 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("should not announce a change that rolled back", async () => {
    sweepDb({ [STORES]: [[due], [storeRow(true)]], [ORGS]: [[activeOrg(true)]] });
    vi.mocked(createAuditLog).mockRejectedValueOnce(new Error("audit chain busy"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const announce = vi.fn(async () => {});
    const report = await recheckShopifyStoreClassifications({
      now: () => NOW,
      getAccessToken: async () => "token",
      fetchPartnerDevelopment: async () => false,
      announce,
    });
    expect(report).toMatchObject({ changed: 0, failed: 1 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("should treat a store without a usable credential as unknown, and still record the attempt", async () => {
    const fake = sweepDb({ [STORES]: [[due], [storeRow(null)]], [ORGS]: [[activeOrg(false)]] });
    const fetchPartnerDevelopment = vi.fn(async () => true);
    const report = await recheckShopifyStoreClassifications({
      now: () => NOW,
      getAccessToken: async () => { throw new Error("reauthorization required"); },
      fetchPartnerDevelopment,
    });
    expect(report).toEqual({ scanned: 1, changed: 0, unknown: 1, failed: 0 });
    expect(fetchPartnerDevelopment).not.toHaveBeenCalled();
    expect(writes(fake, STORES)).toEqual([{ planCheckedAt: NOW }]);
    expect(writes(fake, ORGS)).toEqual([]);
  });

  it("should carry on past a store that fails", async () => {
    const second = { id: 8, organizationId: 180002, shopDomain: "second.myshopify.com" };
    const fake = sweepDb({
      [STORES]: [[due, second], new Error("deadlock") as never, [storeRow(null)]],
      [ORGS]: [[activeOrg(false)], [activeOrg(false)]],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await recheckShopifyStoreClassifications({
      now: () => NOW,
      getAccessToken: async () => "token",
      fetchPartnerDevelopment: async () => true,
    });
    expect(report).toEqual({ scanned: 2, changed: 1, unknown: 0, failed: 1 });
    expect(writes(fake, ORGS)).toEqual([{ isDemo: true }]);
  });

  it("should never throw when the database is unavailable", async () => {
    state.db = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recheckShopifyStoreClassifications()).resolves.toEqual({ scanned: 0, changed: 0, unknown: 0, failed: 0 });
  });
});

describe("when a development store goes live", () => {
  it("should tell the owner which store and what changed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await announceShopifyStoreWentLive(STORE);
    expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({
      title: "Shopify store went live: reconcileai-dev-store.myshopify.com",
      content: expect.stringContaining("now covered by SLA alerts"),
    }));
  });

  it("should not fail when the owner cannot be told", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(notifyOwner).mockRejectedValueOnce(new Error("email down"));
    await expect(announceShopifyStoreWentLive(STORE)).resolves.toBeUndefined();
  });
});
