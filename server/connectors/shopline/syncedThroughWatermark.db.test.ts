/**
 * The SHOPLINE catch-up watermark against a REAL MySQL — gated like the other
 * *.db.test.ts files because the local .env names production and this test
 * writes rows.
 *
 * The rule lives in an UPDATE's WHERE (so concurrent cycles cannot interleave a
 * read and a write), which only a real database can prove.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { recordSyncOutcome, rewindCatchUp, type SyncReport } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-29T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function report(from: Date, to: Date, error?: string): SyncReport {
  return {
    success: !error,
    organizationId: 0,
    storeHandle: "watermark",
    window: { from, to },
    ordersIngested: 0,
    paymentsIngested: 0,
    payoutsIngested: 0,
    totalPersisted: 0,
    matchedCount: 0,
    exceptionCount: 0,
    durationMs: 1,
    ...(error ? { error } : {}),
  };
}

describe.runIf(localDatabase)("when a sync or an operator writes the SHOPLINE catch-up watermark", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  // An organisation no real tenant uses, cleaned up after.
  const organizationId = 920_000_000 + Math.floor(Math.random() * 1_000_000);
  let nextHandle = 0;

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(slConnectorStores).where(eq(slConnectorStores.organizationId, organizationId));
    await pool.end();
  });

  async function storeWith(
    syncedThroughAt: Date | null,
    status: "active" | "uninstalled" = "active",
  ): Promise<number> {
    const [row] = await db.insert(slConnectorStores).values({
      organizationId,
      storeHandle: `watermark-${organizationId}-${nextHandle++}`,
      storeId: String(nextHandle),
      status,
      lastSyncAt: syncedThroughAt,
      syncedThroughAt,
    });
    return (row as { insertId: number }).insertId;
  }

  async function read(id: number) {
    const [row] = await db
      .select({
        syncedThroughAt: slConnectorStores.syncedThroughAt,
        lastSyncAt: slConnectorStores.lastSyncAt,
        lastSyncAttemptAt: slConnectorStores.lastSyncAttemptAt,
        lastSyncError: slConnectorStores.lastSyncError,
      })
      .from(slConnectorStores)
      .where(eq(slConnectorStores.id, id));
    return row;
  }

  describe("when a 24-hour sync succeeds after a three-day outage", () => {
    it("should record the success but leave the watermark at the start of the gap", async () => {
      // The realtime sync, the daily batch and "Sync Now" all read the last day.
      const id = await storeWith(ago(72));

      await recordSyncOutcome(db as never, id, report(ago(24), NOW), NOW);

      const row = await read(id);
      expect(row.syncedThroughAt).toEqual(ago(72));
      expect(row.lastSyncAt).toEqual(NOW);
      expect(row.lastSyncError).toBeNull();
    });
  });

  describe("when a window starts at or before the watermark", () => {
    it("should advance the watermark to the window's end, not to the clock", async () => {
      const id = await storeWith(ago(72));

      await recordSyncOutcome(db as never, id, report(ago(72.1), ago(48.1)), NOW);

      expect((await read(id)).syncedThroughAt).toEqual(ago(48.1));
    });
  });

  describe("when a window ends before the watermark", () => {
    it("should never move the watermark backwards", async () => {
      // A slow cycle finishing after a newer one has already moved it on.
      const id = await storeWith(ago(1));

      await recordSyncOutcome(db as never, id, report(ago(30), ago(6)), NOW);

      expect((await read(id)).syncedThroughAt).toEqual(ago(1));
    });
  });

  describe("when the store has never synced", () => {
    it("should take the first successful window's end as its starting point", async () => {
      const id = await storeWith(null);

      await recordSyncOutcome(db as never, id, report(ago(24), NOW), NOW);

      expect((await read(id)).syncedThroughAt).toEqual(NOW);
    });
  });

  describe("when an operator rewinds the catch-up", () => {
    it("should move active stores back, never forward, and leave never-synced and uninstalled stores alone", async () => {
      const outageStart = ago(80);
      const ahead = await storeWith(ago(1));
      const behind = await storeWith(ago(200));
      const neverSynced = await storeWith(null);
      const uninstalled = await storeWith(ago(1), "uninstalled");
      // rewindCatchUp moves every active store in the database, by design.
      // Count what qualifies first, rather than assume this test is alone.
      const [{ qualifying }] = await db
        .select({ qualifying: sql<number>`count(*)` })
        .from(slConnectorStores)
        .where(and(eq(slConnectorStores.status, "active"), gt(slConnectorStores.syncedThroughAt, outageStart)));

      const moved = await rewindCatchUp(db as never, outageStart);

      expect(moved).toBe(Number(qualifying));
      expect((await read(ahead)).syncedThroughAt).toEqual(outageStart);
      expect((await read(behind)).syncedThroughAt).toEqual(ago(200));
      expect((await read(neverSynced)).syncedThroughAt).toBeNull();
      expect((await read(uninstalled)).syncedThroughAt).toEqual(ago(1));
    });
  });

  describe("when the sync fails", () => {
    it("should record the failure and leave the watermark and last success alone", async () => {
      const id = await storeWith(ago(72));

      await recordSyncOutcome(db as never, id, report(ago(72.1), ago(48.1), "SHOPLINE answered 503"), NOW);

      const row = await read(id);
      expect(row.syncedThroughAt).toEqual(ago(72));
      expect(row.lastSyncAt).toEqual(ago(72));
      expect(row.lastSyncAttemptAt).toEqual(NOW);
      expect(row.lastSyncError).toBe("SHOPLINE answered 503");
    });
  });
});
