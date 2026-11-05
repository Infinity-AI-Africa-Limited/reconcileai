/**
 * SHOPLINE shop/redact is acknowledged, but nothing erases a SHOPLINE shop's
 * data yet. Until 2026-11-04 the request was recorded as "completed", with a
 * note that a purge was scheduled when none existed. It must be recorded as an
 * OPEN obligation (`received`), which the owner's reminder counts
 * (gdprDeadlines.ts), until erasure is built
 * (docs/security/SHOPLINE_SHOP_ERASURE.md). No page lists these rows yet.
 * Synthetic rows only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowOf, scriptedDb } from "../shopify/scriptedDb.testkit";

const state = vi.hoisted(() => ({ db: null as unknown, uninstall: vi.fn(), report: vi.fn() }));
vi.mock("../../db", () => ({ getDb: async () => state.db }));
vi.mock("./onboarding", () => ({ handleShoplineUninstall: state.uninstall }));
vi.mock("./gdprDeadlines", () => ({ reportOpenShoplineGdprRequests: state.report }));
vi.mock("../../_core/env", () => ({ ENV: { shoplineAppSecret: "synthetic-secret" } }));

import { processGdprRequest } from "./gdpr";

const STORES = "sl_connector_stores";
const REQUESTS = "sl_connector_gdpr_requests";

function shopRedact(shopDomain = "synthetic-store.myshopline.com") {
  return processGdprRequest({
    rawBody: Buffer.from("{}"),
    hmacHeader: "synthetic",
    topic: "shop/redact",
    payload: { shop_domain: shopDomain },
    endpointKind: "shop_redact",
  });
}

beforeEach(() => {
  state.uninstall.mockReset();
  state.report.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("when SHOPLINE asks for an installed shop's data to be erased", () => {
  it("should record the request as open, not completed, because nothing has been erased", async () => {
    const db = scriptedDb({ select: { [STORES]: [[{ id: 7, organizationId: 42 }]] } });
    state.db = db.db;

    await expect(shopRedact()).resolves.toEqual({ status: "received", kind: "shop_redact" });

    const [recorded] = db.writes("insert", REQUESTS);
    expect(rowOf(recorded)).toMatchObject({
      organizationId: 42,
      slStoreId: 7,
      status: "received",
      recordsAffected: 0,
      completedAt: null,
    });
    const note = String(rowOf(recorded)?.note);
    expect(note).toContain("NOT been erased");
    expect(note).not.toMatch(/scheduled for purge/i);
  });

  it("should still uninstall the store, which stops its syncs", async () => {
    state.db = scriptedDb({ select: { [STORES]: [[{ id: 7, organizationId: 42 }]] } }).db;
    await shopRedact();
    expect(state.uninstall).toHaveBeenCalledWith("synthetic-store");
  });

  it("should raise a fixed alert code with ids only, never the shop's domain", async () => {
    state.db = scriptedDb({ select: { [STORES]: [[{ id: 7, organizationId: 42 }]] } }).db;
    await shopRedact();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("NOT erased"),
      { code: "shopline_shop_redact_erasure_pending", organizationId: 42, slStoreId: 7 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("synthetic-store");
  });

  it("should tell the owner once the open request is recorded", async () => {
    const db = scriptedDb({ select: { [STORES]: [[{ id: 7, organizationId: 42 }]] } });
    state.db = db.db;
    state.report.mockImplementation(() => {
      // Reported after the record, so the new request is in the count.
      expect(db.writes("insert", REQUESTS)).toHaveLength(1);
    });

    await shopRedact();
    expect(state.report).toHaveBeenCalledTimes(1);
  });
});

describe("when the shop is not one we hold", () => {
  it("should record it as unresolved and raise no erasure alert", async () => {
    const db = scriptedDb({ select: { [STORES]: [[]] } });
    state.db = db.db;

    await expect(shopRedact("unknown.myshopline.com")).resolves.toEqual({ status: "unresolved_store", kind: "shop_redact" });

    expect(rowOf(db.writes("insert", REQUESTS)[0])).toMatchObject({ status: "unresolved_store", organizationId: null });
    expect(console.error).not.toHaveBeenCalled();
    expect(state.report).not.toHaveBeenCalled();
  });
});
