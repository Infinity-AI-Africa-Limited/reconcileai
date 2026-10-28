/**
 * Two reconciliations of one SHOPLINE store at the same moment, against a REAL
 * MySQL — gated like the other *.db.test.ts files because the local .env names
 * production and this test writes rows.
 *
 * A pass reads "already raised?" and then raises. The API sync used to do that
 * with no lock, after its ingest lock was released. So a realtime sync beside
 * the poll, or a sync beside a settlement file, could both read before either
 * wrote, and file the same exception twice (Greptile, #209).
 * reconcileStoreUnderLock serialises every pass for a store on the store's row
 * lock, and reads under it with locking reads.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { exceptions, transactions } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { classifyDatabaseTarget } from "../../dbTarget";
import { reconcileStoreUnderLock } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const ROUNDS = 8;

describe.runIf(localDatabase)("when two passes reconcile one store at the same moment", () => {
  // An organisation no real tenant uses, cleaned up after.
  const organizationId = 950_000_000 + Math.floor(Math.random() * 1_000_000);
  const ORDERS_CHANNEL = 950_000_001;
  const PAYMENTS_CHANNEL = 950_000_002;
  const from = new Date("2026-10-26T00:00:00Z");
  const to = new Date("2026-10-27T00:00:00Z");
  let storeId = 0;

  async function db() {
    const found = await getDb();
    if (!found) throw new Error("no database");
    return found;
  }

  const pass = async () =>
    reconcileStoreUnderLock(await db(), {
      organizationId,
      storeId,
      ordersChannelId: ORDERS_CHANNEL,
      paymentsChannelId: PAYMENTS_CHANNEL,
      from,
      to,
      currency: "USD",
    });

  beforeAll(async () => {
    const [row] = await (await db()).insert(slConnectorStores).values({
      organizationId,
      storeHandle: `race-${organizationId}`,
      storeId: String(organizationId),
      status: "active",
    });
    storeId = (row as unknown as { insertId: number }).insertId;
  });

  afterAll(async () => {
    const found = await getDb();
    if (!found) return;
    await found.delete(exceptions).where(eq(exceptions.organizationId, organizationId));
    await found.delete(transactions).where(eq(transactions.organizationId, organizationId));
    await found.delete(slConnectorStores).where(eq(slConnectorStores.organizationId, organizationId));
  });

  it("should file each exception once, whichever pass gets there first", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // An order whose payment never arrives: both passes find it unmatched.
      const [inserted] = await (await db()).insert(transactions).values({
        batchId: 1,
        channelId: ORDERS_CHANNEL,
        userId: 1,
        organizationId,
        transactionRef: `race-${round}`,
        amount: "42.00",
        currency: "USD",
        transactionDate: new Date("2026-10-26T12:00:00Z"),
        debitCredit: "credit",
        status: "unmatched",
      });
      const transactionId = (inserted as unknown as { insertId: number }).insertId;

      await Promise.all([pass(), pass()]);

      const filed = await (await db())
        .select({ id: exceptions.id, subCategory: exceptions.subCategory })
        .from(exceptions)
        .where(and(eq(exceptions.organizationId, organizationId), eq(exceptions.transactionId, transactionId)));
      // One per category the engine raised; never the same category twice.
      expect(filed.length, `round ${round}`).toBeGreaterThan(0);
      expect(new Set(filed.map((e) => e.subCategory)).size, `round ${round}`).toBe(filed.length);
    }

    // Every later round also re-read the earlier rounds' unmatched orders.
    // Across all of them, no transaction holds the same category twice.
    const all = await (await db())
      .select({ transactionId: exceptions.transactionId, subCategory: exceptions.subCategory })
      .from(exceptions)
      .where(eq(exceptions.organizationId, organizationId));
    const keys = all.map((e) => `${e.transactionId}::${e.subCategory}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("should reconcile nothing for a store that is no longer active", async () => {
    await (await db())
      .update(slConnectorStores)
      .set({ status: "uninstalled" })
      .where(eq(slConnectorStores.id, storeId));

    expect(await pass()).toBeNull();
  });
});
