/**
 * The open-request count against a REAL MySQL: CI's database only, gated like
 * the Shopify privacy-deadline test (the local .env names production).
 *
 * The overdue count compares in SQL against a cutoff the query sends, so only a
 * real engine can show the cutoff is encoded in the column's UTC terms and that
 * only open requests are counted. Measured as deltas around this test's own
 * rows, so other rows in the table cannot disturb it.
 */
import { inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slConnectorGdprRequests } from "../../../drizzle/connector_schema";
import { createAppPool } from "../../dbSession";
import { classifyDatabaseTarget } from "../../dbTarget";
import { findOpenShoplineGdprRequests } from "./gdprDeadlines";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-04T12:00:00.000Z");

describe.runIf(localDatabase)("when open SHOPLINE GDPR requests are counted in MySQL", () => {
  let pool: Pool;
  let db: MySql2Database;
  const ids: number[] = [];

  beforeAll(async () => {
    // Built as production builds its pools: every session in UTC (CLAUDE.md §12).
    pool = createAppPool(url!).promise();
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    if (ids.length) await db.delete(slConnectorGdprRequests).where(inArray(slConnectorGdprRequests.id, ids));
    await pool.end();
  });

  it("should count open requests, and which of them are past the 30-day deadline", async () => {
    const before = await findOpenShoplineGdprRequests(db as never, NOW);
    const rows = [
      // Open: two overdue (31 and 45 days), one not (29 days). Uneven on
      // purpose: one row each side of the cutoff counts 1 whichever way the
      // comparison points, so a flipped cutoff would pass unseen.
      { status: "received" as const, receivedAt: new Date(NOW.getTime() - 31 * DAY) },
      { status: "received" as const, receivedAt: new Date(NOW.getTime() - 45 * DAY) },
      { status: "received" as const, receivedAt: new Date(NOW.getTime() - 29 * DAY) },
      // Settled one way or another: never counted, however old.
      { status: "completed" as const, receivedAt: new Date(NOW.getTime() - 40 * DAY) },
      { status: "unresolved_store" as const, receivedAt: new Date(NOW.getTime() - 40 * DAY) },
    ];
    for (const row of rows) {
      const [result] = await db.insert(slConnectorGdprRequests).values({
        organizationId: 900_000_000,
        slStoreId: 900_000_000,
        topic: "shop/redact",
        recordsAffected: 0,
        ...row,
      });
      ids.push(Number((result as { insertId: number }).insertId));
    }

    const after = await findOpenShoplineGdprRequests(db as never, NOW);
    expect((after?.requests ?? 0) - (before?.requests ?? 0)).toBe(3);
    expect((after?.overdue ?? 0) - (before?.overdue ?? 0)).toBe(2);
    expect(after?.oldestReceivedAt).toBeInstanceOf(Date);
    expect(after!.oldestReceivedAt.getTime()).toBeLessThanOrEqual(NOW.getTime() - 45 * DAY);
  });
});
