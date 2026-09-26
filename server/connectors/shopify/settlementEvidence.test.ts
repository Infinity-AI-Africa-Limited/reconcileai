import { describe, expect, it, vi } from "vitest";

// The default audit writer goes through createAuditLog, which would reach the
// real database. Everything else in ../../db stays real.
const { createAuditLog } = vi.hoisted(() => ({ createAuditLog: vi.fn(async () => undefined) }));
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  createAuditLog,
}));

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
  shopifyUserId: "548380009",
};

const store = { id: 7, organizationId: 42, claimedByUserId: 9 };
/** The in-transaction store lock's answer: the store is still active. */
const storeLock = [{ id: 7 }];
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
        [STORES]: [[store], storeLock],
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
          submittedByShopifyUserId: "548380009",
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
      { orderRefs: ["gid://shopify/Order/1001"] },
    );
    expect(auditCommitted).toHaveBeenCalledWith({
      actorId: 9,
      shopifyUserId: "548380009",
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
        [STORES]: [[store], storeLock],
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

const ORDER_GID = "gid://shopify/Order/1001";
const alignedOrder = [{ transactionRef: ORDER_GID, externalRef: "#1001" }];

function fileWith(rows: Array<Record<string, string>>, headers = ["order_number", "settled_amount"]) {
  return { headers, rows, parseErrors: [] as string[] };
}

/** A settlement row as the import stores it, for the order above. */
function storedEvent(amount: string, debitCredit: "credit" | "debit") {
  return {
    transactionRef: ORDER_GID,
    amount,
    debitCredit,
    currency: "USD",
    valueDate: null,
    rawData: { originalOrderRef: "#1001", gatewayEventType: debitCredit === "credit" ? "payment" : "refund" },
  };
}

async function commitFile(options: {
  rows: Array<Record<string, string>>;
  storedEvidence?: unknown[];
  lock?: unknown[];
  reconcile?: ReturnType<typeof vi.fn>;
}) {
  const fake = scriptedDb({
    select: {
      [STORES]: [[store], options.lock ?? storeLock],
      [USERS]: [[{ id: 9 }]],
      [CHANNELS]: [[{ id: 70 }], [{ id: 80 }]],
      [TRANSACTIONS]: [alignedOrder, options.storedEvidence ?? []],
    },
    insert: { [BATCHES]: [555] },
  });
  const reconcile = options.reconcile ?? vi.fn(async () => ({ matchedCount: 0, exceptionCount: 0 }));
  const auditCommitted = vi.fn(async () => undefined);
  const result = importShopifySettlementEvidence(context, input, fake.db as never, {
    parseFile: vi.fn(async () => fileWith(options.rows)),
    reconcile: reconcile as never,
    auditCommitted,
  });
  return { fake, result, reconcile, auditCommitted };
}

function insertedRows(fake: ReturnType<typeof scriptedDb>): Array<Record<string, unknown>> {
  return fake.writes("insert", TRANSACTIONS).flatMap((op) => op.data as unknown as Array<Record<string, unknown>>);
}

describe("when an export holds more than one settlement event for the same order", () => {
  it("should import a payment and its refund as two events, not drop the refund as a duplicate", async () => {
    const { fake, result } = await commitFile({
      rows: [
        { order_number: "#1001", settled_amount: "12.34" },
        { order_number: "#1001", settled_amount: "-12.34" },
      ],
    });

    await expect(result).resolves.toMatchObject({ imported: 2, duplicates: 0 });
    expect(insertedRows(fake).map((row) => [row.transactionRef, row.debitCredit, row.amount])).toEqual([
      [ORDER_GID, "credit", "12.34"],
      [ORDER_GID, "debit", "12.34"],
    ]);
  });

  it("should import a refund that arrives in a later file than its payment", async () => {
    const { fake, result } = await commitFile({
      rows: [{ order_number: "#1001", settled_amount: "-12.34" }],
      storedEvidence: [storedEvent("12.34", "credit")],
    });

    await expect(result).resolves.toMatchObject({ imported: 1, duplicates: 0 });
    expect(insertedRows(fake).map((row) => row.debitCredit)).toEqual(["debit"]);
  });

  it("should add nothing when the same file is uploaded again", async () => {
    const { fake, result, reconcile } = await commitFile({
      rows: [
        { order_number: "#1001", settled_amount: "12.34" },
        { order_number: "#1001", settled_amount: "-12.34" },
      ],
      storedEvidence: [storedEvent("12.34", "credit"), storedEvent("12.34", "debit")],
    });

    await expect(result).resolves.toMatchObject({ imported: 0, duplicates: 2 });
    expect(insertedRows(fake)).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("should count occurrences, so an overlapping export adds only the events not yet recorded", async () => {
    // One 12.34 settlement is stored; this export holds two of them — two
    // same-amount settlements for one order, with no id to tell them apart.
    const { fake, result } = await commitFile({
      rows: [
        { order_number: "#1001", settled_amount: "12.34" },
        { order_number: "#1001", settled_amount: "12.34" },
      ],
      storedEvidence: [storedEvent("12.340", "credit")],
    });

    await expect(result).resolves.toMatchObject({ imported: 1, duplicates: 1 });
    expect(insertedRows(fake)).toHaveLength(1);
  });

  it("should find evidence stored before the order synced, under the file's own reference", async () => {
    const { fake, result } = await commitFile({ rows: [{ order_number: "#1001", settled_amount: "12.34" }] });
    await result;

    const evidenceLookup = fake.ops.filter((op) => op.kind === "select" && op.table === TRANSACTIONS)[1];
    // The canonical id, and "#1001" as insertTransactions stores it.
    expect(evidenceLookup?.where?.params).toEqual([42, 80, ORDER_GID, "1001"]);
  });
});

describe("when two imports for the same store run at once", () => {
  it("should take the store lock as the transaction's first statement and read existing evidence with a lock", async () => {
    const { fake, result } = await commitFile({ rows: [{ order_number: "#1001", settled_amount: "12.34" }] });
    await result;

    const inTransaction = fake.ops.filter((op) => op.txId !== null);
    expect(inTransaction[0]).toMatchObject({ kind: "select", table: STORES, locked: true });
    expect(inTransaction[0]?.where?.params).toEqual([7, 42, "active"]);
    const evidenceLookup = inTransaction.filter((op) => op.kind === "select" && op.table === TRANSACTIONS)[1];
    expect(evidenceLookup?.locked).toBe(true);
  });

  it("should write nothing when the store stopped being active after authentication", async () => {
    const { fake, result } = await commitFile({
      rows: [{ order_number: "#1001", settled_amount: "12.34" }],
      lock: [],
    });

    await expect(result).rejects.toSatisfy(expectEvidenceError("STORE_UNAVAILABLE"));
    expect(insertedRows(fake)).toEqual([]);
    expect(fake.writes("update", BATCHES)[0]?.data).toMatchObject({ status: "failed" });
  });
});

describe("when a file covers only some of the store's orders", () => {
  it("should reconcile only the orders the imported rows name", async () => {
    const { result, reconcile } = await commitFile({
      rows: [{ order_number: "#1001", settled_amount: "12.34" }],
    });
    await result;

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[7]).toEqual({ orderRefs: [ORDER_GID] });
  });
});

describe("when a Shopify staff member submits the file", () => {
  it("should record that staff member as the submitter, and the administrator only as accountable", async () => {
    const fake = scriptedDb({
      select: {
        [STORES]: [[store], storeLock],
        [USERS]: [[{ id: 9 }]],
        [CHANNELS]: [[{ id: 70 }], [{ id: 80 }]],
        [TRANSACTIONS]: [alignedOrder, []],
      },
      insert: { [BATCHES]: [555] },
    });
    createAuditLog.mockClear();

    await importShopifySettlementEvidence(context, input, fake.db as never, {
      parseFile: vi.fn(async () => parsedFile()),
      reconcile: vi.fn(async () => ({ matchedCount: 0, exceptionCount: 0 })) as never,
    });

    expect(insertedRows(fake)[0]?.rawData).toMatchObject({ submittedByShopifyUserId: "548380009" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9,
      details: expect.objectContaining({
        submittedBy: { kind: "shopify_staff_member", shopifyUserId: "548380009" },
        accountableAdministratorId: 9,
      }),
    }));
  });
});

describe("when the merchant confirms a column mapping", () => {
  const withFee = () => fileWith(
    [{ order_number: "#1001", settled_amount: "12.34", fee: "0.50", ref: "gw-1" }],
    ["order_number", "settled_amount", "fee", "ref"],
  );

  async function dryRun(columnMapping: Record<string, string>) {
    const fake = scriptedDb({ select: { [STORES]: [[store]], [USERS]: [[{ id: 9 }]], [CHANNELS]: [[{ id: 70 }]] } });
    return importShopifySettlementEvidence(
      context,
      { ...input, dryRun: true, columnMapping },
      fake.db as never,
      { parseFile: vi.fn(async () => withFee()) },
    );
  }

  it("should use exactly that mapping, leaving a field it omits unmapped rather than re-detecting it", async () => {
    await expect(dryRun({ orderRef: "order_number", amount: "settled_amount" })).resolves.toMatchObject({
      mapping: { orderRef: "order_number", amount: "settled_amount" },
      missingRequired: [],
    });
  });

  it("should drop a column that is not in this file and report the field as missing", async () => {
    await expect(dryRun({ orderRef: "order_id", amount: "settled_amount" })).resolves.toMatchObject({
      mapping: { amount: "settled_amount" },
      missingRequired: ["orderRef"],
    });
  });
});
