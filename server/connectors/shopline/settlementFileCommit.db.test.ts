/**
 * A SHOPLINE settlement file committed against a REAL MySQL — CI's database
 * only, gated like the other *.db.test.ts files because the local .env names
 * production and this test writes rows.
 *
 * The date window is applied in SQL (`selectUnmatchedLeg`), so only a real
 * database proves which order rows the import's reconciliation actually reads.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { exceptions, transactions } from "../../../drizzle/schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { commitShoplineSettlementFile } from "./settlementFileCommit";
import { mapSettlementRows } from "./settlementFileImport";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

describe.runIf(localDatabase)("when a COD remittance arrives weeks after its order", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  // Ids no real tenant uses, cleaned up after.
  const organizationId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const ORDERS_CHANNEL = 900_000_001;
  const PAYMENTS_CHANNEL = 900_000_002;
  let storeId = 0;

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
    const [store] = await db.insert(slConnectorStores).values({
      organizationId,
      storeHandle: `cod-window-${organizationId}`,
      storeId: String(organizationId),
      status: "active",
    });
    storeId = (store as { insertId: number }).insertId;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(exceptions).where(eq(exceptions.organizationId, organizationId));
    await db.delete(transactions).where(eq(transactions.organizationId, organizationId));
    await db.delete(slConnectorStores).where(eq(slConnectorStores.organizationId, organizationId));
    await pool.end();
  });

  it("should match the remittance line to the order it settles", async () => {
    // The order, as the SHOPLINE sync stores it: dated when it was placed.
    await db.insert(transactions).values({
      batchId: 1,
      channelId: ORDERS_CHANNEL,
      userId: 1,
      organizationId,
      transactionRef: "40017001",
      amount: "80.00",
      currency: "USD",
      transactionDate: new Date("2026-09-01T09:00:00Z"),
      debitCredit: "credit",
      status: "unmatched",
    });
    // The courier remits the cash three weeks later.
    const { rows, failures } = mapSettlementRows(
      [{ Order: "#40017001", Amount: "80.00", Date: "2026-09-22", Txn: "cod-1" }],
      { orderRef: "Order", amount: "Amount", settledAt: "Date", gatewayRef: "Txn" },
      {
        organizationId,
        paymentsChannelId: PAYMENTS_CHANNEL,
        batchId: 1,
        userId: 1,
        defaultCurrency: "USD",
        sourceLabel: "Courier COD",
      },
    );
    expect(failures).toEqual([]);

    const result = await commitShoplineSettlementFile(db as never, {
      organizationId,
      storeId,
      ordersChannelId: ORDERS_CHANNEL,
      paymentsChannelId: PAYMENTS_CHANNEL,
      batchId: 1,
      rows,
      mappingFailures: [],
      currency: "USD",
    });

    expect(result).toMatchObject({ imported: 1, matchedCount: 1, exceptionCount: 0 });
    const statuses = await db
      .select({ channelId: transactions.channelId, status: transactions.status })
      .from(transactions)
      .where(and(eq(transactions.organizationId, organizationId), eq(transactions.transactionRef, "40017001")));
    expect(statuses.map((row) => row.status)).toEqual(["matched", "matched"]);
  });
});
