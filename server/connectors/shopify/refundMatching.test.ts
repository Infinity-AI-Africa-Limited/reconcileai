/**
 * Shopify orders against a gateway's settlement file, end to end through the
 * real projections and the real reconciliation boundary: the order and refund
 * rows are what ingest.ts writes, the settlement rows are what the file import
 * maps, and `runReconciliationOnPersistedData` runs the retail engine exactly
 * as the import does. Only the database is scripted.
 *
 * The file names the order by its Shopify GID here; in the import that is the
 * alignment step's job (settlementEvidence.ts), tested on its own.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import type { InsertTransaction, Transaction } from "../../../drizzle/schema";
import { mapSettlementRows } from "../shopline/settlementFileImport";
import { runReconciliationOnPersistedData } from "../shopline/syncOrchestrator";
import { toShopifyOrderTransaction, toShopifyRefundTransaction } from "./ingest";
import type { NormalizedShopifyOrder, NormalizedShopifyRefund } from "./orders";
import { scriptedDb } from "./scriptedDb.testkit";

const TRANSACTIONS = "transactions";
const EXCEPTIONS = "exceptions";
const ORDERS_CHANNEL = 70;
const SETTLEMENT_CHANNEL = 71;
const GID = "gid://shopify/Order/1001";

const order = (total: string, refunds: NormalizedShopifyRefund[] = []): NormalizedShopifyOrder => ({
  gid: GID,
  name: "#1001",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-21T09:00:05.000Z",
  processedAt: "2026-09-20T10:01:00.000Z",
  currencyCode: "USD",
  totalPrice: { amount: total, currencyCode: "USD" },
  totalRefunded: {
    amount: refunds.reduce((sum, refund) => sum + Number(refund.amount), 0).toFixed(2),
    currencyCode: "USD",
  },
  refunds,
  displayFinancialStatus: refunds.length > 0 ? "PARTIALLY_REFUNDED" : "PAID",
  cancelledAt: null,
});
const refund = (id: number, amount: string): NormalizedShopifyRefund => ({
  gid: `gid://shopify/Refund/${id}`,
  createdAt: "2026-09-21T09:00:00.000Z",
  amount,
  currencyCode: "USD",
});

/** A row as the database returns it, with every column's default. */
function stored(id: number, row: InsertTransaction): Transaction {
  return {
    id,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    organizationId: null,
    shopifyStoreId: null,
    shopifyRefundId: "",
    transactionRef: null,
    externalRef: null,
    description: null,
    valueDate: null,
    shopifyOrderCurrency: null,
    shopifyUpdatedAt: null,
    shopifyFinancialStatus: null,
    shopifyCancelledAt: null,
    counterparty: null,
    isReversal: false,
    originalTransactionRef: null,
    status: "unmatched",
    matchId: null,
    rawData: null,
    ...row,
  } as Transaction;
}

const ingest = { organizationId: 42, storeId: 7, channelId: ORDERS_CHANNEL, batchId: 80, userId: 9 };

/** What Shopify sync stores for the order: its own row, then one per refund. */
function shopifyLedger(source: NormalizedShopifyOrder): Transaction[] {
  return [
    stored(1, toShopifyOrderTransaction(source, ingest)),
    ...source.refunds.map((r, index) => stored(10 + index, toShopifyRefundTransaction(source, r, ingest))),
  ];
}

/** What the settlement import stores for a gateway file of `[amount, settled on]` lines. */
function settlementFile(lines: Array<[string, string]>): Transaction[] {
  const { rows, failures } = mapSettlementRows(
    lines.map(([amount, date], index) => ({
      Order: GID,
      Amount: amount,
      Date: date,
      Currency: "USD",
      "Transaction ID": `txn_${index + 1}`,
    })),
    { orderRef: "Order", amount: "Amount", settledAt: "Date", currency: "Currency", gatewayRef: "Transaction ID" },
    {
      organizationId: 42,
      paymentsChannelId: SETTLEMENT_CHANNEL,
      batchId: 81,
      userId: 9,
      defaultCurrency: "USD",
      sourceLabel: "Gateway",
    },
  );
  expect(failures).toEqual([]);
  return rows.map((row, index) => stored(100 + index, row));
}

async function reconcile(ledger: Transaction[], settlement: Transaction[]) {
  const fake = scriptedDb({ select: { [TRANSACTIONS]: [ledger, settlement], [EXCEPTIONS]: [[]] } });
  const result = await runReconciliationOnPersistedData(
    fake.db as never,
    42,
    ORDERS_CHANNEL,
    SETTLEMENT_CHANNEL,
    new Date("2026-09-17T00:00:00Z"),
    new Date("2026-09-25T00:00:00Z"),
    "USD",
    { orderRefs: [GID] },
  );
  // Each match marks its source row matched to its target; read those pairs back.
  const pairs = fake
    .writes("update", TRANSACTIONS)
    .map((write) => [write.where?.params[0], (write.data as { matchId: number }).matchId])
    .filter(([id]) => (id as number) < 100);
  const exceptions = (fake.writes("insert", EXCEPTIONS)[0]?.data ?? []) as Array<{ transactionId: number; subCategory: string }>;
  return { result, pairs, exceptions };
}

describe("when a partially refunded order is reconciled against its gateway settlement", () => {
  it("should match the order to its gross payment and the refund to the gateway's refund line", async () => {
    const { result, pairs, exceptions } = await reconcile(
      shopifyLedger(order("100.00", [refund(9, "30.00")])),
      settlementFile([
        ["100.00", "2026-09-20"],
        ["-30.00", "2026-09-22"],
      ]),
    );

    expect(result).toEqual({ matchedCount: 2, exceptionCount: 0 });
    expect(pairs).toEqual(expect.arrayContaining([[1, 100], [10, 101]]));
    expect(exceptions).toEqual([]);
  });

  it("would match nothing with the order stored net of its refund, as before", async () => {
    // The previous projection: the order at its total after refunds, no refund row.
    const net = stored(1, { ...toShopifyOrderTransaction(order("100.00"), ingest), amount: "70.00" });

    const { result } = await reconcile(
      [net],
      settlementFile([
        ["100.00", "2026-09-20"],
        ["-30.00", "2026-09-22"],
      ]),
    );

    expect(result.matchedCount).toBe(0);
  });
});

describe("when Shopify recorded a refund the gateway file does not show", () => {
  it("should flag the refund as not reflected in settlement, and still match the payment", async () => {
    const { result, pairs, exceptions } = await reconcile(
      shopifyLedger(order("100.00", [refund(9, "30.00")])),
      settlementFile([["100.00", "2026-09-20"]]),
    );

    expect(result.matchedCount).toBe(1);
    expect(pairs).toEqual([[1, 100]]);
    expect(exceptions).toEqual([expect.objectContaining({ transactionId: 10, subCategory: "retail_refund_not_settled" })]);
  });
});

describe("when an order is refunded in full", () => {
  it("should pair each row with the line of the same direction, never the payment with the refund", async () => {
    const { result, pairs } = await reconcile(
      shopifyLedger(order("50.00", [refund(9, "50.00")])),
      settlementFile([
        ["-50.00", "2026-09-22"],
        ["50.00", "2026-09-20"],
      ]),
    );

    expect(result).toEqual({ matchedCount: 2, exceptionCount: 0 });
    // Line 1 of the file (id 100) is the refund, line 2 (id 101) the payment.
    expect(pairs).toEqual(expect.arrayContaining([[1, 101], [10, 100]]));
  });
});
