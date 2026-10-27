/**
 * Inline SHOPLINE reconciliation re-reads windows it has read before, against a
 * REAL MySQL — gated like the other *.db.test.ts files because the local .env
 * names production and this test writes rows.
 *
 * Every successive window overlaps the last: the 15-minute poll by its seam
 * overlap, a stepped catch-up by the same overlap at every step, and the
 * realtime sync, daily batch and "Sync Now" by re-reading the whole last 24
 * hours. A row still unmatched is therefore reconciled many times, and each
 * pass must not file another copy of an exception a person has not yet dealt
 * with.
 */
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exceptions, transactions } from "../../../drizzle/schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { runReconciliationOnPersistedData } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

describe.runIf(localDatabase)("when an unscoped sync reconciles a window it has reconciled before", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  // Ids no real tenant uses, cleaned up after.
  const organizationId = 910_000_000 + Math.floor(Math.random() * 1_000_000);
  const ORDERS_CHANNEL = 910_000_001;
  const PAYMENTS_CHANNEL = 910_000_002;
  const from = new Date("2026-10-26T00:00:00Z");
  const to = new Date("2026-10-27T00:00:00Z");

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
    // An order whose payment never arrives — it stays unmatched on every pass.
    await db.insert(transactions).values({
      batchId: 1,
      channelId: ORDERS_CHANNEL,
      userId: 1,
      organizationId,
      transactionRef: "50011001",
      amount: "42.00",
      currency: "USD",
      transactionDate: new Date("2026-10-26T12:00:00Z"),
      debitCredit: "credit",
      status: "unmatched",
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(exceptions).where(eq(exceptions.organizationId, organizationId));
    await db.delete(transactions).where(eq(transactions.organizationId, organizationId));
    await pool.end();
  });

  const openExceptions = () =>
    db
      .select({ id: exceptions.id, subCategory: exceptions.subCategory, status: exceptions.status })
      .from(exceptions)
      .where(eq(exceptions.organizationId, organizationId));

  it("should file the exception once, however many passes read the row", async () => {
    const first = await runReconciliationOnPersistedData(
      db as never, organizationId, ORDERS_CHANNEL, PAYMENTS_CHANNEL, from, to, "USD",
    );
    expect(first.exceptionCount).toBeGreaterThan(0);
    const afterFirst = await openExceptions();

    const second = await runReconciliationOnPersistedData(
      db as never, organizationId, ORDERS_CHANNEL, PAYMENTS_CHANNEL, from, to, "USD",
    );

    expect(second.exceptionCount).toBe(0);
    expect(await openExceptions()).toHaveLength(afterFirst.length);
  });

  it("should not undo a person's decision when a sync re-reads the row", async () => {
    // Closing an exception leaves its transaction `unmatched`. A sync re-reading
    // the same window brings no new evidence, so raising the case again would
    // reopen what the person resolved or dismissed on every later pass.
    await db.update(exceptions).set({ status: "dismissed" }).where(eq(exceptions.organizationId, organizationId));

    const reread = await runReconciliationOnPersistedData(
      db as never, organizationId, ORDERS_CHANNEL, PAYMENTS_CHANNEL, from, to, "USD",
    );

    expect(reread.exceptionCount).toBe(0);
  });

  it("should raise it again for a settlement file that names the order, once a person has closed it", async () => {
    // A file is new evidence about the orders it names, so a case a person
    // closed may be raised again. That was the file import's behaviour before,
    // and it is unchanged.
    await db.update(exceptions).set({ status: "resolved" }).where(eq(exceptions.organizationId, organizationId));

    const fromFile = await runReconciliationOnPersistedData(
      db as never, organizationId, ORDERS_CHANNEL, PAYMENTS_CHANNEL, from, to, "USD", { orderRefs: ["50011001"] },
    );

    expect(fromFile.exceptionCount).toBeGreaterThan(0);
  });
});
