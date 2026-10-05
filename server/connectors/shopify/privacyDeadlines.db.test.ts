/**
 * The privacy-deadline count against a REAL MySQL — CI's database only, gated
 * like syncCursor.db.test.ts (the local .env names production).
 *
 * The overdue count compares in SQL against a cutoff the query sends, so only a
 * real engine can show the cutoff is encoded in the column's UTC terms and the
 * grouping counts what it should. Measured as deltas around this test's own
 * rows, so other rows in the table cannot disturb it.
 */
import { inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shopifyPrivacyRequests } from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { findShopifyPrivacyRequestsNeedingAttention, type ShopifyPrivacyAttentionGroup } from "./privacyDeadlines";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-10-05T12:00:00.000Z");

function tally(groups: ShopifyPrivacyAttentionGroup[]) {
  return new Map(groups.map((group) => [`${group.topic}|${group.status}`, group]));
}

describe.runIf(localDatabase)("when privacy requests are counted in MySQL", () => {
  let pool: mysql.Pool;
  let db: MySql2Database;
  const ids: number[] = [];
  const hash = (n: number) => `${"d".repeat(56)}${String(Math.floor(Math.random() * 1e8) + n).padStart(8, "0")}`;

  beforeAll(async () => {
    pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 1 });
    db = drizzle(pool);
  });

  afterAll(async () => {
    if (!db) return;
    if (ids.length) await db.delete(shopifyPrivacyRequests).where(inArray(shopifyPrivacyRequests.id, ids));
    await pool.end();
  });

  it("should count those needing a person and those stuck, and which are overdue", async () => {
    const before = tally(await findShopifyPrivacyRequestsNeedingAttention(db as never, NOW));
    const rows = [
      // Needs a person: one overdue (31 days), one not (29 days).
      { topic: "shop/redact" as const, status: "manual_review" as const, receivedAt: new Date(NOW.getTime() - 31 * DAY) },
      { topic: "shop/redact" as const, status: "manual_review" as const, receivedAt: new Date(NOW.getTime() - 29 * DAY) },
      // In flight 4 days: stuck. In flight 1 day: not yet.
      { topic: "customers/redact" as const, status: "received" as const, receivedAt: new Date(NOW.getTime() - 4 * DAY) },
      { topic: "customers/redact" as const, status: "received" as const, receivedAt: new Date(NOW.getTime() - 1 * DAY) },
      // An export not downloaded after 4 days: stuck. After 1 day: not yet.
      { topic: "customers/data_request" as const, status: "awaiting_delivery" as const, receivedAt: new Date(NOW.getTime() - 4 * DAY) },
      { topic: "customers/data_request" as const, status: "awaiting_delivery" as const, receivedAt: new Date(NOW.getTime() - 1 * DAY) },
      // Done: never counted.
      { topic: "customers/data_request" as const, status: "completed" as const, receivedAt: new Date(NOW.getTime() - 40 * DAY) },
    ];
    for (const [index, row] of rows.entries()) {
      const [result] = await db.insert(shopifyPrivacyRequests).values({
        storeId: 900_000_000 + index,
        organizationId: 900_000_000,
        requestHash: hash(index),
        ...row,
      });
      ids.push(Number((result as { insertId: number }).insertId));
    }

    const after = tally(await findShopifyPrivacyRequestsNeedingAttention(db as never, NOW));
    const delta = (key: string, field: "requests" | "overdue") =>
      (after.get(key)?.[field] ?? 0) - (before.get(key)?.[field] ?? 0);

    expect(delta("shop/redact|manual_review", "requests")).toBe(2);
    expect(delta("shop/redact|manual_review", "overdue")).toBe(1);
    expect(delta("customers/redact|received", "requests")).toBe(1);
    expect(delta("customers/redact|received", "overdue")).toBe(0);
    expect(delta("customers/data_request|awaiting_delivery", "requests")).toBe(1);
    expect(after.get("customers/data_request|completed")).toBeUndefined();
    expect(after.get("shop/redact|manual_review")?.oldestReceivedAt).toBeInstanceOf(Date);
  });
});
