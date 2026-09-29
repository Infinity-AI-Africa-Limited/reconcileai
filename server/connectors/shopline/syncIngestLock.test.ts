/**
 * The SHOPLINE API sync writes a store's ledger as ONE step per store,
 * serialised with every other writer of it — the settlement-file import and
 * other sync cycles — by the store's row lock in the shared database.
 *
 * Before, the sync checked "already recorded?" and inserted as two separate
 * statements, so two writers running at once (a webhook-triggered cycle beside
 * a scheduled one, a cycle per instance, or a cycle beside a file import) could
 * both pass the check and record one payment twice. This drives the real
 * runSyncCycle over a scripted database; only the network edges are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: vi.fn(async () => state.db),
  createUploadBatch: vi.fn(async () => 700),
  updateUploadBatch: vi.fn(async () => undefined),
}));
vi.mock("./tokenStore", () => ({ getValidToken: vi.fn(async () => "token") }));
vi.mock("./billingWebhook", () => ({ isSyncBlockedBySubscription: vi.fn(async () => ({ blocked: false })) }));
// The network edge. Every page the cycle reads is stubbed, so this suite can
// never reach SHOPLINE — a stub on the wrong name once let it call the live API.
vi.mock("./apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apiClient")>()),
  fetchOrders: vi.fn(async () => ({ data: [{ id: "order-1" }], nextPageInfo: null })),
  fetchPaymentTransactions: vi.fn(async () => ({ data: [{ id: "payment-1" }], nextPageInfo: null })),
  fetchPayouts: vi.fn(async () => ({ data: [], nextPageInfo: null })),
}));
// Belt and braces: any request that still escapes fails the suite loudly.
vi.stubGlobal("fetch", vi.fn(async () => {
  throw new Error("syncIngestLock.test.ts must not reach the network");
}));
vi.mock("./ingest", async (importOriginal) => {
  const row = (channelId: number, transactionRef: string) => ({
    channelId,
    transactionRef,
    organizationId: 42,
    amount: "10.00",
    currency: "USD",
    debitCredit: "credit",
    transactionDate: new Date("2026-09-01T00:00:00.000Z"),
    status: "unmatched",
  });
  return {
    ...(await importOriginal<typeof import("./ingest")>()),
    normaliseOrder: vi.fn((_order: unknown, ctx: { ordersChannelId: number }) => row(ctx.ordersChannelId, "order-1")),
    normalisePaymentTransaction: vi.fn((_p: unknown, ctx: { paymentsChannelId: number }) => row(ctx.paymentsChannelId, "order-1")),
    normalisePayout: vi.fn(),
  };
});

import { scriptedDb } from "../shopify/scriptedDb.testkit";
import { shoplineOrdersChannelCode, shoplinePaymentsChannelCode } from "./onboarding";
import { runSyncCycle } from "./syncOrchestrator";

const STORES = "sl_connector_stores";
const TXNS = "transactions";

function syncDb(lockAnswer: unknown[] = [{ id: 5 }]) {
  return scriptedDb({
    select: {
      // The cycle's own lookup, then the lock taken under the transaction.
      [STORES]: [[{ id: 5, organizationId: 42, storeHandle: "shop", currency: "USD", status: "active" }], lockAnswer],
      channels: [[
        { id: 10, code: shoplineOrdersChannelCode("shop") },
        { id: 20, code: shoplinePaymentsChannelCode("shop") },
      ]],
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("when a SHOPLINE sync cycle writes a store's ledger", () => {
  it("should take the store's lock first, check under a locking read, and insert in the same transaction", async () => {
    const fake = syncDb();
    state.db = fake.db;

    const report = await runSyncCycle({ slStoreId: 5, organizationId: 42 });

    expect(report.error ?? "").toBe("");
    expect(report.success).toBe(true);
    const inTransaction = fake.ops.filter((op) => op.txId !== null);
    expect(inTransaction[0]).toMatchObject({ kind: "select", table: STORES, locked: true });
    expect(inTransaction[0]?.where?.params).toEqual(expect.arrayContaining([5, 42, "active"]));
    const dedupe = inTransaction.find((op) => op.kind === "select" && op.table === TXNS);
    expect(dedupe?.locked).toBe(true);
    const inserts = fake.writes("insert", TXNS);
    expect(inserts.length).toBeGreaterThan(0);
    expect(new Set([inTransaction[0]?.txId, dedupe?.txId, ...inserts.map((op) => op.txId)]).size).toBe(1);
  });

  it("should write nothing when the store stopped being active before the lock was taken", async () => {
    const fake = syncDb([]);
    state.db = fake.db;

    const report = await runSyncCycle({ slStoreId: 5, organizationId: 42 });

    expect(report.success).toBe(false);
    expect(fake.writes("insert", TXNS)).toEqual([]);
  });
});
