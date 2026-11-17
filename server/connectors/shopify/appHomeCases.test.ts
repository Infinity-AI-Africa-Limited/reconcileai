import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { exceptions } from "../../../drizzle/schema";
import { detailShopifyCase, listShopifyCases } from "./appHomeCases";
import { casesDb } from "./casesDb.testkit";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import { SHOPIFY_CASE_CATEGORIES, SHOPIFY_CASE_SEVERITIES, SHOPIFY_CASE_STATUSES, shopifyCaseDetailInput, shopifyCaseListInput } from "../../../shared/shopifyAppHomeCases";
const context: ShopifyEmbeddedContext = { storeId: 7, organizationId: 42, shopDomain: "store7.myshopify.com", displayName: "Synthetic", currency: "USD", shopifyUserId: "1" };

/** Every log line the reader wrote, as [message, fields]. */
let logged: MockInstance<typeof console.error>;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe("when a verified store inspects its cases", () => {
  it("should isolate rows, total and detail from a same-org second store and a foreign tenant, retaining jobId zero refunds", async () => {
    const fake = casesDb();
    const result = await listShopifyCases(fake.db, context);
    expect(result.total).toBe(3);
    expect(result.cases.map(row => row.caseId)).toEqual([3, 2, 1]);
    expect(result.cases.map(row => row.sourceKind)).toEqual(["merchant_settlement", "shopify_refund", "shopify_order"]);
    expect((await detailShopifyCase(fake.db, context, 2)).sourceKind).toBe("shopify_refund");
    for (const id of [4, 5, 6, 7, 8, 9, 10, 11, 999]) await expect(detailShopifyCase(fake.db, context, id)).rejects.toMatchObject({ code: "not_found", message: "not_found" });
    const second = await listShopifyCases(fake.db, { ...context, storeId: 8, shopDomain: "store8.myshopify.com" });
    expect(second.total).toBe(2); expect(second.cases.map(row => row.caseId)).toEqual([5, 4]);
    const foreign = await listShopifyCases(fake.db, { ...context, storeId: 9, organizationId: 99, shopDomain: "store9.myshopify.com" });
    expect(foreign.total).toBe(1); expect(foreign.cases[0].caseId).toBe(6);
    expect(fake.queries.every(query => query.transaction === 1 && query.sql.startsWith("select "))).toBe(true);
    expect(fake.queries.some(query => query.sql.includes("reconciliation_jobs"))).toBe(false);
    const listReads = fake.queries.filter(query => query.sql.includes("from `exceptions`")).slice(0, 2);
    expect(listReads[0].sql.split(" where ")[1]).toBe(listReads[1].sql.split(" where ")[1].split(" order by ")[0]);
  });
  it("should fail closed for each absent or foreign-organization channel without a tenant-wide fallback", async () => {
    for (const remove of [[70], [71], [70, 71]]) {
      const fake = casesDb(); fake.data.channels = fake.data.channels.filter(channel => !remove.includes(Number(channel.id)));
      // A same-code foreign tenant row is NOT a valid server resolution.
      fake.data.channels.push({ id: 70, code: "shopify_orders_7", organizationId: 99 });
      const result = await listShopifyCases(fake.db, context);
      expect(result.total).toBe(remove.length === 2 ? 0 : remove[0] === 70 ? 1 : 2);
      if (remove.includes(70)) await expect(detailShopifyCase(fake.db, context, 1)).rejects.toMatchObject({ code: "not_found" });
      if (remove.includes(71)) await expect(detailShopifyCase(fake.db, context, 3)).rejects.toMatchObject({ code: "not_found" });
    }
  });
  it("should default to unresolved across all dates and use bounded deterministic pagination with the identical count predicate", async () => {
    const fake = casesDb();
    fake.data.exceptions[0].status = "resolved"; fake.data.exceptions[1].status = "dismissed";
    expect((await listShopifyCases(fake.db, context)).total).toBe(1);
    expect((await listShopifyCases(fake.db, context, { status: "all" })).total).toBe(3);
    expect((await listShopifyCases(fake.db, context, { status: "resolved" })).cases[0].caseId).toBe(1);
    const original = fake.data.exceptions[2];
    fake.data.exceptions.push(...Array.from({ length: 22 }, (_, i) => ({ ...original, id: 100 + i })));
    const page = await listShopifyCases(fake.db, context, { page: 2 });
    expect(page).toMatchObject({ total: 23, page: 2, pageSize: 20 });
    expect(page.cases.map(row => row.caseId)).toEqual([101, 100, 3]);
  });
  it("should return only approved keys and exact primary decimal strings, never raw text, contacts, GIDs or internal identities", async () => {
    const fake = casesDb();
    const row = await detailShopifyCase(fake.db, context, 1);
    expect(row.amount).toBe("9999999999999999.99");
    expect(Object.keys(row).sort()).toEqual(["caseId", "category", "severity", "status", "createdAt", "amount", "currency", "evidenceDate", "sourceKind"].sort());
    expect(JSON.stringify(row)).not.toMatch(/private@|RAW SECRET|gid:|organizationId|storeId|channelId|jobId|userId|rawData|aiAnalysis/);
  });
  it.each(["inactive", "uninstalled", "redacting", "customer_redacting", "org_deleted", "org_disabled", "wrong_shop", "org_rebound"])("should recheck %s within the read transaction before evidence", async fence => {
    const fake = casesDb(); const store = fake.data.stores[0]; const org = fake.data.organizations[0];
    if (["inactive", "uninstalled", "redacting"].includes(fence)) store.status = fence;
    if (fence === "customer_redacting") store.privacyRedactionState = "customer_redacting";
    if (fence === "org_deleted") org.deletionState = "redacting";
    if (fence === "org_disabled") org.isActive = 0;
    if (fence === "wrong_shop") store.shopDomain = "other.myshopify.com";
    if (fence === "org_rebound") store.organizationId = 99;
    await expect(listShopifyCases(fake.db, context)).rejects.toMatchObject({ code: "unavailable" });
    await expect(detailShopifyCase(fake.db, context, 1)).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.queries.every(query => query.sql.includes("from `shopify_connector_stores`"))).toBe(true);
    expect(logged.mock.calls).toEqual(["list", "detail"].map(operation => ["[shopify-app-home] case read unavailable",
      { operation, storeId: 7, organizationId: 42, reason: "store_unavailable" }]));
  });
  it("should return a static outage, not success-empty or operational error detail", async () => {
    const fake = casesDb(); fake.setOutage();
    await expect(listShopifyCases(fake.db, context)).rejects.toMatchObject({ message: "unavailable" });
    await expect(detailShopifyCase(fake.db, context, 1)).rejects.toMatchObject({ message: "unavailable" });
  });
});

describe("when a case read cannot be answered", () => {
  it("should log one line per failure with the failure's type and never its query, parameters or text", async () => {
    const fake = casesDb(); fake.setOutage();
    await expect(listShopifyCases(fake.db, context)).rejects.toMatchObject({ code: "unavailable" });
    await expect(detailShopifyCase(fake.db, context, 1)).rejects.toMatchObject({ code: "unavailable" });
    expect(logged.mock.calls).toEqual(["list", "detail"].map(operation => ["[shopify-app-home] case read unavailable",
      { operation, storeId: 7, organizationId: 42, reason: "read_failed", error: "Error" }]));
    // The outage's text names a customer; drizzle's wrapper adds the SQL and its parameters.
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/RAW SQL|private@|Failed query|params|select|store7/i);
  });
  it("should refuse a stored row it cannot vouch for, naming the field and never its value", async () => {
    const fake = casesDb();
    fake.data.exceptions[0].category = "some_future_category";
    await expect(listShopifyCases(fake.db, context)).rejects.toMatchObject({ code: "unavailable" });
    expect(logged.mock.calls).toEqual([["[shopify-app-home] case read unavailable",
      { operation: "list", storeId: 7, organizationId: 42, reason: "invalid_row", field: "category" }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("some_future_category");
  });
  it("should not log a case that is simply not this store's", async () => {
    const fake = casesDb();
    await expect(detailShopifyCase(fake.db, context, 999)).rejects.toMatchObject({ code: "not_found" });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("when the exceptions table's enums change", () => {
  // A stored value outside these lists makes the merchant's WHOLE case list
  // unavailable (one row cannot be vouched for). So a new category, severity or
  // status must fail here, before it reaches a merchant: add it to
  // shared/shopifyAppHomeCases.ts, and the client's typed copy then requires a
  // label for it.
  it("should accept exactly the categories the table can hold", () => {
    expect([...SHOPIFY_CASE_CATEGORIES].sort()).toEqual([...exceptions.category.enumValues].sort());
  });
  it("should accept exactly the severities the table can hold", () => {
    expect([...SHOPIFY_CASE_SEVERITIES].sort()).toEqual([...exceptions.severity.enumValues].sort());
  });
  it("should accept exactly the statuses the table can hold, plus the two aggregate filters", () => {
    const stored = SHOPIFY_CASE_STATUSES.filter(status => status !== "unresolved" && status !== "all");
    expect([...stored].sort()).toEqual([...exceptions.status.enumValues].sort());
  });
});

describe("when a store's input is checked", () => {
  it("should reject extra identities and unsafe selector/pagination values", () => {
    for (const key of ["organizationId", "storeId", "shop", "channelId", "jobId", "userId", "role", "portalOrg"]) {
      expect(shopifyCaseListInput.safeParse({ [key]: 7 }).success).toBe(false);
      expect(shopifyCaseDetailInput.safeParse({ caseId: 1, [key]: 7 }).success).toBe(false);
    }
    for (const caseId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(shopifyCaseDetailInput.safeParse({ caseId }).success).toBe(false);
    for (const page of [0, 501, 1.5, "1"]) expect(shopifyCaseListInput.safeParse({ page }).success).toBe(false);
    expect(shopifyCaseListInput.safeParse({ status: "unknown" }).success).toBe(false);
    expect(shopifyCaseListInput.safeParse({ limit: 9999 }).success).toBe(false);
  });
});
