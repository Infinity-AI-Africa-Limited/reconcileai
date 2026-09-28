import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InsertTransaction } from "../../../drizzle/schema";
import { sanitizeRef } from "../../db";
import { scriptedDb } from "../shopify/scriptedDb.testkit";
import { mapSettlementRows, type ColumnMap } from "./settlementFileImport";
import { rejectAlreadyImportedSettlementRows } from "./syncOrchestrator";

/**
 * The SHOPLINE settlement-file import (CLAUDE.md §2C) re-inserted every row of
 * a re-uploaded file whose order reference held a character storage strips —
 * it compared the file's "#1001" against the stored "1001". These tests drive
 * rows built by the real `mapSettlementRows` through the real guard.
 */

const ORG = 42;
const PAYMENTS = 80;
const TRANSACTIONS = "transactions";
const mapping: ColumnMap = { orderRef: "order", amount: "amount", settledAt: "date" };

function fileRows(lines: Array<[order: string, amount: string, date?: string]>): InsertTransaction[] {
  const { rows } = mapSettlementRows(
    lines.map(([order, amount, date]) => ({ order, amount, date: date ?? "2026-09-01" })),
    mapping,
    { organizationId: ORG, paymentsChannelId: PAYMENTS, batchId: 1, userId: 9, defaultCurrency: "USD", sourceLabel: "DHL COD" },
  );
  return rows;
}

/** A row as the database holds it after `insertTransactions`: sanitised ref, DECIMAL(18,2) amount. */
function asStored(row: InsertTransaction) {
  return {
    transactionRef: sanitizeRef(row.transactionRef),
    amount: Number(row.amount).toFixed(2),
    debitCredit: row.debitCredit,
    currency: row.currency,
    valueDate: row.valueDate,
    rawData: row.rawData,
  };
}

/** A payment the SHOPLINE Payments API synced for an order — no `importedFrom`. */
function apiPayment(orderRef: string) {
  return {
    transactionRef: orderRef,
    amount: "12.34",
    debitCredit: "credit",
    currency: "USD",
    valueDate: new Date("2026-09-01T00:00:00.000Z"),
    rawData: { gatewayEventType: "payment", originalOrderRef: orderRef, gatewayRef: "trade-1" },
  };
}

async function importAgainst(incoming: InsertTransaction[], stored: unknown[]) {
  const fake = scriptedDb({ select: { [TRANSACTIONS]: [stored] } });
  const fresh = await rejectAlreadyImportedSettlementRows(fake.db as never, incoming, {
    organizationId: ORG,
    paymentsChannelId: PAYMENTS,
  });
  return { fresh, fake };
}

describe("when a settlement file is uploaded again", () => {
  it("should add nothing, even when its order references carry a # that storage strips", async () => {
    const file = fileRows([["#1001", "12.34"], ["#1002", "40.00"]]);
    const { fresh } = await importAgainst(file, file.map(asStored));
    expect(fresh).toEqual([]);
  });

  it("should look the stored rows up by the reference as STORED, in this tenant's payments channel", async () => {
    const { fake } = await importAgainst(fileRows([["#1001", "12.34"]]), []);
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === TRANSACTIONS);
    expect(lookup?.where?.params).toEqual([ORG, PAYMENTS, "1001"]);
  });

  it("should import only the events an overlapping export adds", async () => {
    const earlier = fileRows([["#1001", "12.34"]]);
    const { fresh } = await importAgainst(fileRows([["#1001", "12.34"], ["#1003", "7.50"]]), earlier.map(asStored));
    expect(fresh.map((row) => row.transactionRef)).toEqual(["1003"]);
  });
});

describe("when a file holds more than one settlement event for an order", () => {
  it("should keep a payment and its refund in the same file", async () => {
    const { fresh } = await importAgainst(fileRows([["#1001", "12.34"], ["#1001", "-12.34"]]), []);
    expect(fresh.map((row) => row.debitCredit)).toEqual(["credit", "debit"]);
  });

  it("should keep a refund that arrives in a later file than its payment", async () => {
    const payment = fileRows([["#1001", "12.34"]]);
    const { fresh } = await importAgainst(fileRows([["#1001", "-12.34", "2026-09-05"]]), payment.map(asStored));
    expect(fresh.map((row) => row.debitCredit)).toEqual(["debit"]);
  });
});

describe("when the SHOPLINE Payments API already settled the order", () => {
  it("should skip the file's row for it, as before, rather than count the settlement twice", async () => {
    const { fresh } = await importAgainst(
      fileRows([["21076388995485181306699745", "12.34"], ["#1003", "7.50"]]),
      [apiPayment("21076388995485181306699745")],
    );
    expect(fresh.map((row) => row.transactionRef)).toEqual(["1003"]);
  });
});

describe("when the rows come back from the guard", () => {
  it("should carry the references in stored form, with the file's own spelling kept as provenance", async () => {
    const { fresh } = await importAgainst(fileRows([["#1001", "12.34"]]), []);
    expect(fresh[0]).toMatchObject({
      transactionRef: "1001",
      rawData: expect.objectContaining({ originalOrderRef: "#1001", importedFrom: "DHL COD" }),
    });
  });
});

describe("when the import procedure commits a file", () => {
  it("should use the event-aware guard, not the order-keyed one built for API objects", () => {
    const router = readFileSync("server/routers/shoplineConnector.ts", "utf8");
    const importer = router.slice(router.indexOf("importSettlementFile:"));
    const commitBlock = importer.slice(0, importer.indexOf("listAllStores:"));
    expect(commitBlock).toContain("rejectAlreadyImportedSettlementRows(db, rows,");
    expect(commitBlock).not.toContain("rejectAlreadyIngested(");
  });
});
