/**
 * The order-sync cursor against a REAL MySQL — CI's database only.
 *
 * GREATEST's NULL behaviour is the database's, so a scripted handle cannot prove
 * it: this runs the actual writes against the actual engine. It is gated on a
 * database that is provably local (the same rule as the `db:push` guard), because
 * the local .env names production and this test writes rows.
 */
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { recordShopifyBackstopAttempt } from "./orderBackstop";
import { recordSuccessfulOrderSync } from "./syncOrchestrator";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

describe.runIf(localDatabase)("when the order-sync cursor is written in MySQL", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  // Ids no real store uses, cleaned up after.
  const base = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const store = (offset: number) => ({ id: base + offset, organizationId: 1 });

  const watermarkOf = async (storeId: number) => {
    const [row] = await db
      .select({ watermark: shopifySyncCursors.watermarkUpdatedAt })
      .from(shopifySyncCursors)
      .where(and(eq(shopifySyncCursors.storeId, storeId), eq(shopifySyncCursors.resource, "orders")));
    return row?.watermark ?? null;
  };

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(shopifySyncCursors).where(sql`${shopifySyncCursors.storeId} between ${base} and ${base + 10}`);
    await pool.end();
  });

  it("should advance a watermark the backstop's turn record left NULL", async () => {
    const target = store(1);
    await recordShopifyBackstopAttempt(db as never, { storeId: target.id, organizationId: target.organizationId });
    expect(await watermarkOf(target.id)).toBeNull();

    const read = new Date("2026-09-28T10:00:00.000Z");
    await recordSuccessfulOrderSync(db as never, target, read);

    expect((await watermarkOf(target.id))?.getTime()).toBe(read.getTime());
  });

  it("should advance a watermark a failed first sync left NULL", async () => {
    const target = store(2);
    // The failure path's write: an error code and nothing else.
    await db.insert(shopifySyncCursors).values({
      storeId: target.id,
      organizationId: target.organizationId,
      resource: "orders",
      lastErrorCode: "sync_failed",
    });

    const read = new Date("2026-09-28T11:00:00.000Z");
    await recordSuccessfulOrderSync(db as never, target, read);

    expect((await watermarkOf(target.id))?.getTime()).toBe(read.getTime());
  });

  it("should never move a watermark backwards, and move it forwards", async () => {
    const target = store(3);
    const later = new Date("2026-09-28T12:00:00.000Z");
    await recordSuccessfulOrderSync(db as never, target, later);

    await recordSuccessfulOrderSync(db as never, target, new Date("2026-09-28T09:00:00.000Z"));
    expect((await watermarkOf(target.id))?.getTime()).toBe(later.getTime());

    const latest = new Date("2026-09-28T13:00:00.000Z");
    await recordSuccessfulOrderSync(db as never, target, latest);
    expect((await watermarkOf(target.id))?.getTime()).toBe(latest.getTime());
  });

  describe("when a replay of the store's orders is owed", () => {
    const replayOf = async (storeId: number) => {
      const [row] = await db
        .select({ replay: shopifySyncCursors.replayWatermarkUpdatedAt })
        .from(shopifySyncCursors)
        .where(and(eq(shopifySyncCursors.storeId, storeId), eq(shopifySyncCursors.resource, "orders")));
      return row?.replay ?? null;
    };
    const owe = async (target: { id: number; organizationId: number }, replay: Date) => {
      await recordSuccessfulOrderSync(db as never, target, new Date("2026-09-28T12:00:00.000Z"));
      await db
        .update(shopifySyncCursors)
        .set({ replayWatermarkUpdatedAt: replay })
        .where(eq(shopifySyncCursors.storeId, target.id));
    };
    const requested = new Date("2026-07-30T12:00:00.000Z");

    it("should keep it owed through a commit from a cycle that never read it", async () => {
      // A sync of the previous release, or one that began before the request.
      const target = store(4);
      await owe(target, requested);

      await recordSuccessfulOrderSync(db as never, target, new Date("2026-09-28T13:00:00.000Z"));

      expect((await replayOf(target.id))?.getTime()).toBe(requested.getTime());
      expect((await watermarkOf(target.id))?.getTime()).toBe(new Date("2026-09-28T13:00:00.000Z").getTime());
    });

    it("should move it from the value the cycle read, and not from any other", async () => {
      const target = store(5);
      await owe(target, requested);
      const step = new Date("2026-08-06T12:00:00.000Z");

      await recordSuccessfulOrderSync(db as never, target, step, { read: requested, caughtUp: false });
      expect((await replayOf(target.id))?.getTime()).toBe(step.getTime());

      // A second cycle that read the same value commits after the first.
      await recordSuccessfulOrderSync(db as never, target, new Date("2026-08-06T13:00:00.000Z"), {
        read: requested,
        caughtUp: true,
      });
      expect((await replayOf(target.id))?.getTime()).toBe(step.getTime());
      // The watermark it does not read from is never moved back.
      expect((await watermarkOf(target.id))?.getTime()).toBe(new Date("2026-09-28T12:00:00.000Z").getTime());
    });

    it("should end it once a cycle that read it has caught up", async () => {
      const target = store(6);
      await owe(target, requested);
      const now = new Date("2026-09-28T14:00:00.000Z");

      await recordSuccessfulOrderSync(db as never, target, now, { read: requested, caughtUp: true });

      expect(await replayOf(target.id)).toBeNull();
      expect((await watermarkOf(target.id))?.getTime()).toBe(now.getTime());
    });
  });

  it("should be proving something: a bare GREATEST over a NULL is NULL in this engine", async () => {
    const [rows] = await pool.query("SELECT GREATEST(NULL, NOW()) AS greatest");
    expect((rows as Array<{ greatest: unknown }>)[0]?.greatest).toBeNull();
  });
});
