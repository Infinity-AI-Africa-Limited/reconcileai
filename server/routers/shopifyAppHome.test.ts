/**
 * shopifyAppHome — the embedded Shopify Admin workspace's tRPC boundary.
 *
 * The authority here is the App Bridge ID token in `Authorization`, never the
 * ReconcileAI session, and every answer is an allow-list. Calls go through the
 * real procedures; only the token verifier, the sync, the import and the
 * database are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
const state = vi.hoisted(() => ({
  db: null as unknown,
  authenticate: vi.fn(),
  runSync: vi.fn(),
  importEvidence: vi.fn(),
}));

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("../connectors/shopify/embeddedAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/shopify/embeddedAuth")>()),
  authenticateShopifyEmbeddedRequest: state.authenticate,
}));
vi.mock("../connectors/shopify/syncOrchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/shopify/syncOrchestrator")>()),
  runShopifyOrderSync: state.runSync,
}));
vi.mock("../connectors/shopify/settlementEvidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/shopify/settlementEvidence")>()),
  importShopifySettlementEvidence: state.importEvidence,
}));

import { ENV } from "../_core/env";
import { ShopifyEmbeddedAuthError, type ShopifyEmbeddedContext } from "../connectors/shopify/embeddedAuth";
import { scriptedDb } from "../connectors/shopify/scriptedDb.testkit";
import { ShopifySettlementEvidenceError } from "../connectors/shopify/settlementEvidence";
import { ShopifyTokenUnavailableError } from "../connectors/shopify/tokenStore";
import { shopifyAppHomeRouter } from "./shopifyAppHome";

const CURSORS = "shopify_sync_cursors";
const TOKEN = "Bearer signed-id-token";
const context: ShopifyEmbeddedContext = {
  storeId: 7,
  organizationId: 42,
  shopDomain: "merchant.myshopify.com",
  displayName: "Merchant Store",
  currency: "USD",
  shopifyUserId: "548380009",
};

/** An embedded caller; `sessionUser` is a ReconcileAI cookie the browser may also hold. */
function caller(authorization: string | undefined = TOKEN, sessionUser: unknown = null) {
  return shopifyAppHomeRouter.createCaller({
    user: sessionUser,
    viewingAs: null,
    req: { headers: authorization === undefined ? {} : { authorization } },
    res: {},
  } as never);
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return { code: error.code, message: error.message };
  }
}

const evidenceInput = {
  fileName: "evidence.csv",
  content: "Order ID,Amount\n#1001,12.34",
  contentEncoding: "utf8" as const,
  sourceLabel: "Courier COD",
  dryRun: true,
};

let clientId: string;
beforeEach(() => {
  clientId = ENV.shopifyClientId;
  state.authenticate.mockReset().mockResolvedValue(context);
  state.runSync.mockReset();
  state.importEvidence.mockReset();
  state.db = scriptedDb().db;
});
afterEach(() => {
  (ENV as { shopifyClientId: string }).shopifyClientId = clientId;
});

describe("when App Bridge asks for its configuration", () => {
  it("should serve only the public API key", async () => {
    (ENV as { shopifyClientId: string }).shopifyClientId = "public-api-key";
    await expect(caller(undefined).config()).resolves.toEqual({ apiKey: "public-api-key" });
  });

  it("should answer a stable code, not a detail, when the key is not configured", async () => {
    (ENV as { shopifyClientId: string }).shopifyClientId = "";
    expect(await refusal(() => caller(undefined).config())).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "configuration_unavailable",
    });
  });
});

describe("when the ID token does not verify", () => {
  it("should refuse as unauthenticated before anything runs", async () => {
    state.authenticate.mockRejectedValue(new ShopifyEmbeddedAuthError("TOKEN_INVALID"));
    expect(await refusal(() => caller().syncNow())).toEqual({ code: "UNAUTHORIZED", message: "authentication_required" });
    expect(state.runSync).not.toHaveBeenCalled();
  });

  it("should answer an outage, not an authentication failure, when verification itself is unavailable", async () => {
    state.authenticate.mockRejectedValue(new ShopifyEmbeddedAuthError("CONFIG_UNAVAILABLE"));
    expect(await refusal(() => caller().context())).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    state.authenticate.mockRejectedValue(new Error("pool exhausted"));
    expect(await refusal(() => caller().context())).toEqual({ code: "SERVICE_UNAVAILABLE", message: "service_unavailable" });
  });
});

describe("when the workspace loads its context", () => {
  it("should return a PII-free store view, scoped cursor evidence and fixed Scope A capabilities", async () => {
    const db = scriptedDb({
      select: { [CURSORS]: [[{ lastSuccessfulAt: new Date("2026-09-25T07:30:00.000Z"), lastErrorCode: null }]] },
    });
    state.db = db.db;
    state.authenticate.mockResolvedValue({ ...context, contactEmail: "owner@example.com", accessToken: "must-not-leak" });

    const view = await caller().context();

    expect(state.authenticate).toHaveBeenCalledWith(TOKEN);
    expect(view).toEqual({
      store: { shopDomain: context.shopDomain, displayName: context.displayName, currency: context.currency },
      sync: { lastSuccessfulAt: "2026-09-25T07:30:00.000Z", lastErrorCode: null },
      capabilities: { scope: "read_orders", readOrders: true, manualSync: true, shopifyPayments: false, mutations: false },
    });
    expect(JSON.stringify(view)).not.toMatch(/owner@example\.com|must-not-leak|storeId|organizationId|shopifyUserId/);
    expect(db.ops[0]?.where?.params).toEqual([7, 42, "orders"]);
  });
});

describe("when the merchant starts a sync", () => {
  const report = {
    success: true,
    organizationId: 42,
    storeId: 7,
    window: { from: new Date("2026-09-25T07:00:00.000Z"), to: new Date("2026-09-25T08:00:00.000Z") },
    fetched: 3,
    inserted: 2,
    updated: 1,
    unchanged: 0,
    batchId: 998,
  };

  it("should sync only the store the token names, even if the browser also holds a ReconcileAI session", async () => {
    state.runSync.mockResolvedValue(report);
    const result = await caller(TOKEN, { id: 1, role: "super_admin", organizationId: 999, isReadOnly: false }).syncNow();

    expect(state.runSync).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    expect(result).toEqual({
      success: true,
      window: { from: "2026-09-25T07:00:00.000Z", to: "2026-09-25T08:00:00.000Z" },
      fetched: 3,
      inserted: 2,
      updated: 1,
      unchanged: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/998|storeId|organizationId/);
  });

  it.each([
    [new ShopifyTokenUnavailableError("another worker holds lease secret-123", "refresh_in_progress"), "CONFLICT", "sync_in_progress"],
    [new ShopifyTokenUnavailableError("provider rejected private credential", "reauthorize"), "PRECONDITION_FAILED", "store_action_required"],
    [new Error("database host and password details"), "SERVICE_UNAVAILABLE", "service_unavailable"],
  ] as const)("should map %s to a stable code without its detail", async (error, code, message) => {
    state.runSync.mockRejectedValue(error);
    expect(await refusal(() => caller().syncNow())).toEqual({ code, message });
  });
});

describe("when the merchant imports settlement evidence", () => {
  it("should strip browser tenant, store and channel fields and return only the safe dry-run summary", async () => {
    const db = {};
    state.db = db;
    state.importEvidence.mockResolvedValue({
      committed: false,
      headers: ["Order ID", "Amount"],
      mapping: { orderRef: "Order ID", amount: "Amount" },
      missingRequired: [],
      totalRows: 1,
      parseErrors: [],
      sampleRows: [{ "Order ID": "customer@example.com", Amount: "12.34" }],
      channelId: 987,
    });

    const result = await caller().importSettlementEvidence({
      ...evidenceInput,
      storeId: 999,
      organizationId: 888,
      channelId: 987,
    } as never);

    expect(state.importEvidence).toHaveBeenCalledWith(context, evidenceInput, db);
    expect(result).toEqual({
      committed: false,
      headers: ["Order ID", "Amount"],
      mapping: { orderRef: "Order ID", amount: "Amount" },
      missingRequired: [],
      totalRows: 1,
      parseErrors: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/customer@example\.com|12\.34|channelId|987/);
  });

  it("should return only committed counters, whatever else the import reports", async () => {
    state.importEvidence.mockResolvedValue({
      committed: true,
      mapping: { orderRef: "order_number", amount: "paid_amount" },
      totalRows: 4,
      imported: 3,
      duplicates: 1,
      failed: 0,
      matchedCount: 2,
      exceptionCount: 1,
      sampleRows: [{ order_number: "PII-SECRET" }],
      batchId: 112233,
    });
    const result = await caller().importSettlementEvidence({ ...evidenceInput, dryRun: false });
    expect(JSON.stringify(result)).not.toMatch(/PII-SECRET|112233|batchId|sampleRows/);
    expect(result).toMatchObject({ committed: true, imported: 3, duplicates: 1, matchedCount: 2, exceptionCount: 1 });
  });

  it("should accept a confirmed mapping that names only some fields, and forward it", async () => {
    state.importEvidence.mockResolvedValue({ committed: false, headers: [], mapping: {}, missingRequired: [], totalRows: 0, parseErrors: [] });
    const columnMapping = { orderRef: "Merchant Ref", amount: "Net" };

    await caller().importSettlementEvidence({ ...evidenceInput, columnMapping });

    expect(state.importEvidence).toHaveBeenCalledWith(context, { ...evidenceInput, columnMapping }, expect.anything());
  });

  it("should refuse a mapping naming a field that does not exist", async () => {
    expect(
      await refusal(() => caller().importSettlementEvidence({ ...evidenceInput, columnMapping: { customerEmail: "Email" } } as never)),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(state.importEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["INVALID_REQUEST", "BAD_REQUEST", "invalid_request"],
    ["ORDER_SYNC_REQUIRED", "PRECONDITION_FAILED", "order_sync_required"],
    ["ACTOR_UNAVAILABLE", "FORBIDDEN", "active_admin_required"],
    ["STORE_UNAVAILABLE", "PRECONDITION_FAILED", "store_action_required"],
    ["SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE", "service_unavailable"],
  ] as const)("should map %s to %s with a stable code", async (serviceCode, code, message) => {
    state.importEvidence.mockRejectedValue(new ShopifySettlementEvidenceError(serviceCode));
    expect(await refusal(() => caller().importSettlementEvidence(evidenceInput))).toEqual({ code, message });
  });
});
