/**
 * Committing a SHOPLINE settlement file — the four defects the order-level,
 * non-transactional import had, each pinned by what the database is asked.
 */
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../shopify/scriptedDb.testkit";
import { commitShoplineSettlementFile } from "./settlementFileCommit";
import { mapSettlementRows } from "./settlementFileImport";

const STORES = "sl_connector_stores";
const TXNS = "transactions";
const BATCHES = "upload_batches";
const ORG = 42;

const MAPPING = { orderRef: "Order", amount: "Amount", settledAt: "Date", gatewayRef: "Txn" };
const CONTEXT = {
  organizationId: ORG,
  paymentsChannelId: 20,
  batchId: 300,
  userId: 9,
  defaultCurrency: "USD",
  sourceLabel: "Stripe",
};

/** Rows exactly as the import maps them from a file. */
function fileRows(...lines: Array<Record<string, string>>) {
  return mapSettlementRows(lines, MAPPING, CONTEXT).rows;
}

/** A settlement row already stored by an earlier file import. */
function storedFileRow(order: string, amount: string, direction: "credit" | "debit", date: string, txn: string) {
  return {
    transactionRef: order.replace(/[^\w\-:/.\s]/g, ""),
    amount,
    debitCredit: direction,
    currency: "USD",
    valueDate: new Date(date),
    rawData: {
      gatewayEventType: direction === "credit" ? "payment" : "refund",
      originalOrderRef: order,
      gatewayRef: txn,
      importedFrom: "Stripe",
    },
  };
}

function commit(fake: ReturnType<typeof scriptedDb>, rows: ReturnType<typeof fileRows>, reconcile = vi.fn(async () => ({ matchedCount: 0, exceptionCount: 0 }))) {
  return {
    reconcile,
    run: commitShoplineSettlementFile(
      fake.db as never,
      {
        organizationId: ORG,
        storeId: 5,
        ordersChannelId: 10,
        paymentsChannelId: 20,
        batchId: 300,
        rows,
        mappingFailures: [],
        currency: "USD",
      },
      { reconcile: reconcile as never },
    ),
  };
}

/** A fresh answer each time: scripted answer queues are consumed as they are read. */
const activeStore = () => ({ [STORES]: [[{ id: 5 }]] });

describe("when a refund arrives in a later file than its payment", () => {
  it("should import the refund, not drop it as a duplicate of the payment", async () => {
    // Same order, same gateway transaction, a different event.
    const fake = scriptedDb({
      select: { ...activeStore(), [TXNS]: [[storedFileRow("1001", "100.00", "credit", "2026-09-01", "ch_1")]] },
    });
    const { run } = commit(fake, fileRows({ Order: "1001", Amount: "-100.00", Date: "2026-09-03", Txn: "ch_1" }));

    await expect(run).resolves.toMatchObject({ imported: 1, duplicates: 0 });
    const [insert] = fake.writes("insert", TXNS);
    expect(insert?.data).toEqual([expect.objectContaining({ transactionRef: "1001", debitCredit: "debit", amount: "100" })]);
  });

  it("should keep a second partial settlement for the same order", async () => {
    const fake = scriptedDb({
      select: { ...activeStore(), [TXNS]: [[storedFileRow("1001", "60.00", "credit", "2026-09-01", "po_1")]] },
    });
    const { run } = commit(fake, fileRows({ Order: "1001", Amount: "40.00", Date: "2026-09-02", Txn: "po_2" }));

    await expect(run).resolves.toMatchObject({ imported: 1, duplicates: 0 });
  });
});

describe("when the same file is uploaded again", () => {
  it("should add nothing, comparing references in the form they were stored", async () => {
    // `#1001` is stored as `1001`: the old dedupe compared the file's text and
    // so inserted every such row a second time.
    const fake = scriptedDb({
      select: {
        ...activeStore(),
        [TXNS]: [[
          storedFileRow("#1001", "100.00", "credit", "2026-09-01", "ch_1"),
          storedFileRow("#1002", "25.50", "credit", "2026-09-01", "ch_2"),
        ]],
      },
    });
    const { run, reconcile } = commit(
      fake,
      fileRows(
        { Order: "#1001", Amount: "100.00", Date: "2026-09-01", Txn: "ch_1" },
        { Order: "#1002", Amount: "25.50", Date: "2026-09-01", Txn: "ch_2" },
      ),
    );

    await expect(run).resolves.toMatchObject({ imported: 0, duplicates: 2 });
    expect(fake.writes("insert", TXNS)).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === TXNS);
    expect(lookup?.where?.params).toEqual(expect.arrayContaining(["1001", "1002"]));
    expect(lookup?.where?.params).not.toContain("#1001");
  });

  it("should keep two identical events that one export genuinely contains", async () => {
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[]] } });
    const same = { Order: "1003", Amount: "10.00", Date: "2026-09-01", Txn: "" };
    const { run } = commit(fake, fileRows(same, same));

    await expect(run).resolves.toMatchObject({ imported: 2, duplicates: 0 });
  });
});

describe("when the SHOPLINE API sync has already settled an order", () => {
  it("should skip the file's rows for that order and import the rest", async () => {
    // An API row shares the payments channel and keys the same order, but has
    // no importedFrom: the API is the record for that order.
    const apiRow = {
      transactionRef: "2001",
      amount: "80.00",
      debitCredit: "credit",
      currency: "USD",
      valueDate: new Date("2026-09-01"),
      rawData: { gatewayEventType: "payment", originalOrderRef: "2001", gatewayRef: "deal_9", shoplineTransactionId: "t_9" },
    };
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[apiRow]] } });
    const { run } = commit(
      fake,
      fileRows(
        { Order: "2001", Amount: "80.00", Date: "2026-09-01", Txn: "ch_9" },
        { Order: "2002", Amount: "15.00", Date: "2026-09-01", Txn: "ch_10" },
      ),
    );

    await expect(run).resolves.toMatchObject({ imported: 1, duplicates: 1 });
    expect(fake.writes("insert", TXNS)[0]?.data).toEqual([expect.objectContaining({ transactionRef: "2002" })]);
  });
});

describe("when two imports for one store overlap", () => {
  it("should lock the store first, read existing rows under that lock, and write in the same transaction", async () => {
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[]] } });
    const { run } = commit(fake, fileRows({ Order: "3001", Amount: "5.00", Date: "2026-09-01", Txn: "x" }));
    await run;

    const inTransaction = fake.ops.filter((op) => op.txId !== null);
    expect(inTransaction[0]).toMatchObject({ kind: "select", table: STORES, locked: true });
    expect(inTransaction[0]?.where?.params).toEqual(expect.arrayContaining([5, ORG, "active"]));
    expect(fake.ops.find((op) => op.kind === "select" && op.table === TXNS)?.locked).toBe(true);
    const txIds = new Set(
      fake.ops.filter((op) => op.kind !== "select" || op.locked).map((op) => op.txId),
    );
    expect(txIds.size).toBe(1);
    expect([...txIds][0]).not.toBeNull();
  });

  it("should refuse, writing nothing, when the store stopped being active", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const { run } = commit(fake, fileRows({ Order: "3002", Amount: "5.00", Date: "2026-09-01", Txn: "x" }));

    await expect(run).rejects.toBeInstanceOf(TRPCError);
    expect(fake.writes("insert", TXNS)).toEqual([]);
    expect(fake.writes("update", BATCHES)).toEqual([]);
  });
});

describe("when the file covers only some of the store's orders", () => {
  it("should reconcile only the orders this file speaks to, inside the transaction", async () => {
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[]] } });
    const { run, reconcile } = commit(
      fake,
      fileRows(
        { Order: "#4001", Amount: "12.00", Date: "2026-09-05", Txn: "a" },
        { Order: "4002", Amount: "8.00", Date: "2026-09-06", Txn: "b" },
      ),
    );
    await run;

    expect(reconcile).toHaveBeenCalledTimes(1);
    const args = reconcile.mock.calls[0] as unknown[];
    // The scope is the stored form of this file's references, and nothing else.
    expect(args[7]).toEqual({ orderRefs: ["4001", "4002"] });
    // Run on the transaction's own handle, not a fresh connection.
    expect(args[0]).not.toBe(fake.db);
  });

  it("should close the batch with its counts in the same transaction", async () => {
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[]] } });
    const { run } = commit(fake, fileRows({ Order: "5001", Amount: "3.00", Date: "2026-09-01", Txn: "c" }));
    await run;

    const [close] = fake.writes("update", BATCHES);
    expect(close?.data).toMatchObject({ status: "completed", validRows: 1, invalidRows: 0 });
    expect(close?.txId).toBe(fake.writes("insert", TXNS)[0]?.txId);
    expect(close?.where?.params).toEqual(expect.arrayContaining([300, ORG]));
  });
});

describe("when a later file repeats a settlement that carries no transaction ID", () => {
  // Greptile #164: with no gateway ID, a genuinely separate same-amount, same-day
  // settlement for an order is indistinguishable from an overlapping export's
  // repeat of one already imported. It is skipped — importing it would
  // double-count every overlap — but never silently.
  it("should skip it, count it as unverifiable, and say so on the batch", async () => {
    const stored = storedFileRow("6001", "50.00", "credit", "2026-09-01", "");
    stored.rawData.gatewayRef = undefined as unknown as string;
    const fake = scriptedDb({ select: { ...activeStore(), [TXNS]: [[stored]] } });
    const { run } = commit(fake, fileRows({ Order: "6001", Amount: "50.00", Date: "2026-09-01", Txn: "" }));

    await expect(run).resolves.toMatchObject({ imported: 0, duplicates: 1, unverifiableDuplicates: 1 });
    expect(String(fake.writes("update", BATCHES)[0]?.data?.errorMessage)).toMatch(/no transaction ID to tell them apart/);
  });

  it("should treat a repeat that does carry a transaction ID as a proven duplicate, with nothing to report", async () => {
    const fake = scriptedDb({
      select: { ...activeStore(), [TXNS]: [[storedFileRow("6002", "50.00", "credit", "2026-09-01", "ch_7")]] },
    });
    const { run } = commit(fake, fileRows({ Order: "6002", Amount: "50.00", Date: "2026-09-01", Txn: "ch_7" }));

    await expect(run).resolves.toMatchObject({ imported: 0, duplicates: 1, unverifiableDuplicates: 0 });
    expect(fake.writes("update", BATCHES)[0]?.data?.errorMessage).toBeNull();
  });
});
