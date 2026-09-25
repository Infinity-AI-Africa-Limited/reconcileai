import { describe, expect, it, vi } from "vitest";
import type { ShopifyEmbeddedContext } from "./embeddedAuth";
import {
  importShopifySettlementEvidence,
  minimizeShopifySettlementEvidenceRows,
  ShopifySettlementEvidenceError,
  shopifySettlementEvidenceChannelCode,
} from "./settlementEvidence";
import { scriptedDb } from "./scriptedDb.testkit";

const STORES = "shopify_connector_stores";
const USERS = "users";
const CHANNELS = "channels";
const BATCHES = "upload_batches";
const TRANSACTIONS = "transactions";

const context: ShopifyEmbeddedContext = {
  storeId: 7,
  organizationId: 42,
  shopDomain: "merchant.myshopify.com",
  displayName: "Merchant Store",
  currency: "USD",
};

const store = { id: 7, organizationId: 42, claimedByUserId: 9 };
const input = {
  fileName: "settlements.csv",
  content: "order_number,settled_amount,customer_email\n#1001,12.34,person@example.com",
  contentEncoding: "utf8" as const,
  sourceLabel: "Courier COD",
  dryRun: false,
};

function parsedFile() {
  return {
    headers: ["order_number", "settled_amount", "customer_email"],
    rows: [{
      order_number: "#1001",
      settled_amount: "12.34",
      customer_email: "person@example.com",
    }],
    parseErrors: [],
  };
}

function expectEvidenceError(code: ShopifySettlementEvidenceError["code"]) {
  return (error: unknown) => {
    expect(error).toBeInstanceOf(ShopifySettlementEvidenceError);
    expect((error as ShopifySettlementEvidenceError).code).toBe(code);
    return true;
  };
}

describe("Shopify merchant settlement evidence", () => {
  it("drops optional free-text settlement descriptions before evidence is persisted", () => {
    const rows = minimizeShopifySettlementEvidenceRows([
      {
        description: "Jane Doe, jane@example.com, 1 Private Street",
        rawData: {
          gatewayEventType: "payment",
          originalOrderRef: "#1001",
          gatewayRef: "gw-123",
          feeAmount: 1.25,
          importedFrom: "ignored source",
          unsupportedField: "do not retain",
        },
      } as never,
    ], "Courier COD");

    expect(rows[0]?.description).toBe("Settlement import (Courier COD)");
    expect(rows[0]?.rawData).toEqual({
      gatewayEventType: "payment",
      originalOrderRef: "#1001",
      gatewayRef: "gw-123",
      feeAmount: 1.25,
      importedFrom: "Courier COD",
    });
    expect(JSON.stringify(rows)).not.toMatch(/Jane Doe|jane@example\.com|Private Street|unsupportedField/);
  });

  it("does not write on dry-run and returns no row values", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }]],
      },
    });
    const parseFile = vi.fn(async () => parsedFile());

    const result = await importShopifySettlementEvidence(
      context,
      { ...input, dryRun: true },
      fake.db as never,
      { parseFile },
    );

    expect(result).toEqual({
      committed: false,
      headers: ["order_number", "settled_amount", "customer_email"],
      mapping: { orderRef: "order_number", amount: "settled_amount" },
      missingRequired: [],
      totalRows: 1,
      parseErrors: [],
    });
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(fake.committed().filter((op) => op.kind !== "select")).toEqual([]);
  });

  it("commits with authenticated tenant/store channel codes and the same-tenant active admin", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }], [], [{ id: 80 }]],
        [TRANSACTIONS]: [
          [{ transactionRef: "gid://shopify/Order/1001", externalRef: "#1001" }],
          [],
        ],
      },
      insert: { [BATCHES]: [555] },
    });
    const reconcile = vi.fn(async () => ({ matchedCount: 1, exceptionCount: 0 }));
    const auditCommitted = vi.fn(async () => undefined);

    const result = await importShopifySettlementEvidence(context, input, fake.db as never, {
      parseFile: vi.fn(async () => parsedFile()),
      reconcile: reconcile as never,
      auditCommitted,
    });

    expect(result).toEqual({
      committed: true,
      mapping: { orderRef: "order_number", amount: "settled_amount" },
      totalRows: 1,
      imported: 1,
      duplicates: 0,
      failed: 0,
      matchedCount: 1,
      exceptionCount: 0,
    });
    const storeLookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(storeLookup?.where?.params).toEqual(expect.arrayContaining([7, 42, "active"]));
    const actorLookup = fake.ops.find((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookup?.where?.params).toEqual(expect.arrayContaining([9, 42, "admin", true]));
    const channelLookups = fake.ops.filter((op) => op.kind === "select" && op.table === CHANNELS);
    expect(channelLookups[0]?.where?.params).toEqual(expect.arrayContaining([42, "shopify_orders_7", true]));
    expect(channelLookups[1]?.where?.params).toEqual([42, shopifySettlementEvidenceChannelCode(7)]);
    expect(fake.writes("insert", CHANNELS)[0]?.data).toMatchObject({
      organizationId: 42,
      code: "shopify_settlement_evidence_7",
    });
    expect(fake.writes("insert", BATCHES)[0]?.data).toMatchObject({
      userId: 9,
      organizationId: 42,
      channelId: 80,
      status: "processing",
    });
    expect(fake.writes("insert", TRANSACTIONS)[0]?.data).toEqual([
      expect.objectContaining({
        userId: 9,
        organizationId: 42,
        channelId: 80,
        batchId: 555,
        transactionRef: "gid://shopify/Order/1001",
        counterparty: "Courier COD",
        rawData: expect.objectContaining({
          importedFrom: "Courier COD",
          originalOrderRef: "#1001",
        }),
      }),
    ]);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      42,
      70,
      80,
      expect.any(Date),
      expect.any(Date),
      "USD",
    );
    expect(auditCommitted).toHaveBeenCalledWith({
      actorId: 9,
      organizationId: 42,
      storeId: 7,
      imported: 1,
      duplicates: 0,
      failed: 0,
      matchedCount: 1,
      exceptionCount: 0,
    });
  });

  it("requires the existing Shopify orders channel before parsing merchant data", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[]],
      },
    });
    const parseFile = vi.fn(async () => parsedFile());

    await expect(
      importShopifySettlementEvidence(context, input, fake.db as never, { parseFile }),
    ).rejects.toSatisfy(expectEvidenceError("ORDER_SYNC_REQUIRED"));
    expect(parseFile).not.toHaveBeenCalled();
    expect(fake.committed().filter((op) => op.kind !== "select")).toEqual([]);
  });

  it("denies when no same-tenant active admin exists before parsing or channel processing", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [USERS]: [[], []],
      },
    });
    const parseFile = vi.fn(async () => parsedFile());

    await expect(
      importShopifySettlementEvidence(context, input, fake.db as never, { parseFile }),
    ).rejects.toSatisfy(expectEvidenceError("ACTOR_UNAVAILABLE"));
    expect(parseFile).not.toHaveBeenCalled();
    expect(fake.ops.filter((op) => op.table === CHANNELS)).toEqual([]);
    const actorLookups = fake.ops.filter((op) => op.kind === "select" && op.table === USERS);
    expect(actorLookups).toHaveLength(2);
    expect(actorLookups[0]?.where?.params).toEqual(expect.arrayContaining([9, 42, "admin", true]));
    expect(actorLookups[1]?.where?.params).toEqual(expect.arrayContaining([42, "admin", true]));
  });

  it("marks an opened batch failed and commits no transaction rows when reconciliation fails", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store]],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }], [{ id: 80 }]],
        [TRANSACTIONS]: [[]],
      },
      insert: { [BATCHES]: [555] },
    });

    await expect(
      importShopifySettlementEvidence(context, input, fake.db as never, {
        parseFile: vi.fn(async () => parsedFile()),
        reconcile: vi.fn(async () => { throw new Error("provider value PII-SECRET"); }) as never,
        auditCommitted: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("provider value PII-SECRET");

    expect(fake.writes("insert", TRANSACTIONS)).toEqual([]);
    expect(fake.writes("update", BATCHES)).toHaveLength(1);
    expect(fake.writes("update", BATCHES)[0]?.data).toMatchObject({
      status: "failed",
      errorMessage: "Settlement evidence import failed",
    });
  });
});
