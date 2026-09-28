import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runToNow } = vi.hoisted(() => ({ runToNow: vi.fn(async () => []) }));
vi.mock("./syncOrchestrator", () => ({ runShopifyOrderSyncToNow: runToNow }));

import {
  handleShopifyManualSync,
  recordShopifyManualSyncAnswered,
  requestShopifyManualSync,
  SHOPIFY_SYNC_NOT_COMPLETED,
  SHOPIFY_SYNC_QUEUE_UNAVAILABLE,
  ShopifyManualSyncError,
  toWholeSecond,
} from "./manualSync";
import { scriptedDb } from "./scriptedDb.testkit";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
/** Mid-second, as a real clock almost always is. */
const CLOCK = new Date("2026-09-28T10:00:00.700Z");
const REQUESTED_AT = new Date("2026-09-28T10:00:00.000Z");
const request = { storeId: 7, organizationId: 42 };
const payload = { ...request, requestedAt: REQUESTED_AT.toISOString() };
const dialect = new MySqlDialect();

function activeStore() {
  return scriptedDb({ select: { [STORES]: [[{ id: 7 }]] } });
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ShopifyManualSyncError);
  return (error as ShopifyManualSyncError).code;
}

function rendered(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

beforeEach(() => {
  runToNow.mockReset().mockResolvedValue([]);
});

describe("when a manual sync is requested", () => {
  it("should record the request at whole-second precision and then queue it carrying that time", async () => {
    const fake = activeStore();
    let cursorWritesAtEnqueue = -1;
    const enqueue = vi.fn(async () => {
      cursorWritesAtEnqueue = fake.writes("insert", CURSORS).length;
    });

    const result = await requestShopifyManualSync(request, { db: fake.db as never, now: () => CLOCK, enqueue });

    // The columns hold whole seconds: a millisecond request time could put a
    // sync finishing in the same second "before" it, and pending for ever.
    expect(result).toEqual({ requestedAt: REQUESTED_AT });
    expect(enqueue).toHaveBeenCalledWith(payload);
    // Written BEFORE the enqueue, or a fast worker would answer a request not yet recorded.
    expect(cursorWritesAtEnqueue).toBe(1);
    expect(fake.writes("insert", CURSORS)[0]).toMatchObject({
      data: { storeId: 7, organizationId: 42, resource: "orders", syncRequestedAt: REQUESTED_AT },
      upsert: true,
    });
  });

  it("should look the store up by id, tenant and status together", async () => {
    const fake = activeStore();
    await requestShopifyManualSync(request, { db: fake.db as never, enqueue: vi.fn(async () => {}) });
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual([7, 42, "active"]);
  });

  it("should give one answer for another tenant's store, an unknown id and a disconnected store, writing nothing", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const enqueue = vi.fn(async () => {});

    expect(await codeOf(requestShopifyManualSync(request, { db: fake.db as never, enqueue }))).toBe("STORE_UNAVAILABLE");
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
  });

  it("should record a refused enqueue as answered AND failed, so it shows as failed rather than pending", async () => {
    const fake = activeStore();
    const enqueue = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED redis");
    });

    expect(await codeOf(requestShopifyManualSync(request, { db: fake.db as never, now: () => CLOCK, enqueue })))
      .toBe("QUEUE_UNAVAILABLE");
    expect(fake.writes("update", CURSORS)[0]?.data).toEqual({
      lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE,
      lastErrorAt: CLOCK,
      syncAnsweredAt: REQUESTED_AT,
    });
  });

  it("should refuse as unavailable when there is no database, never reaching for the application's", async () => {
    expect(await codeOf(requestShopifyManualSync(request, { db: null, enqueue: vi.fn() }))).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("when the queue runs a manual sync", () => {
  it("should catch the store up as a manual trigger, then record the request answered", async () => {
    const record = vi.fn(async () => {});
    await handleShopifyManualSync(payload, { record });

    expect(runToNow).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    expect(record).toHaveBeenCalledWith(payload, { failed: false });
  });

  it("should record the request answered as failed, and still fail the job", async () => {
    runToNow.mockRejectedValue(new Error("pagination_error"));
    const record = vi.fn(async () => {});

    await expect(handleShopifyManualSync(payload, { record })).rejects.toThrow("pagination_error");
    expect(record).toHaveBeenCalledWith(payload, { failed: true });
  });

  it("should not report a synced store as failed when only the bookkeeping write fails", async () => {
    const record = vi.fn(async () => {
      throw new Error("deadlock");
    });
    await expect(handleShopifyManualSync(payload, { record })).resolves.toBeUndefined();
  });
});

describe("when a finished manual run is recorded", () => {
  it("should never move the answered request backwards, and encode its time as UTC like the column does", async () => {
    const fake = scriptedDb();
    await recordShopifyManualSyncAnswered(payload, { failed: false }, { db: fake.db as never });

    const write = fake.writes("update", CURSORS)[0];
    expect(Object.keys(write?.data ?? {})).toEqual(["syncAnsweredAt"]);
    const answered = rendered(write?.data?.syncAnsweredAt);
    expect(answered.sql).toBe("GREATEST(COALESCE(`shopify_sync_cursors`.`syncAnsweredAt`, ?), ?)");
    // Through the column's own encoder, not the driver's local-time formatting.
    expect(answered.params).toEqual(["2026-09-28 10:00:00.000", "2026-09-28 10:00:00.000"]);
    expect(write?.where?.params).toEqual([7, 42, "orders"]);
  });

  it("should add a generic failure code only if the run recorded none since the request, in the same statement", async () => {
    const fake = scriptedDb();
    await recordShopifyManualSyncAnswered(payload, { failed: true }, { db: fake.db as never, now: () => CLOCK });

    const data = fake.writes("update", CURSORS)[0]?.data ?? {};
    expect(Object.keys(data).sort()).toEqual(["lastErrorAt", "lastErrorCode", "syncAnsweredAt"]);
    const code = rendered(data.lastErrorCode);
    expect(code.sql).toMatch(/^CASE WHEN \(`shopify_sync_cursors`\.`lastErrorAt` IS NULL OR `shopify_sync_cursors`\.`lastErrorAt` < \?\) THEN \? ELSE `shopify_sync_cursors`\.`lastErrorCode` END$/);
    expect(code.params).toEqual(["2026-09-28 10:00:00.000", SHOPIFY_SYNC_NOT_COMPLETED]);
    expect(rendered(data.lastErrorAt).params).toEqual(["2026-09-28 10:00:00.000", "2026-09-28 10:00:00.700"]);
  });

  it("should write nothing for a payload without a usable request time", async () => {
    const fake = scriptedDb();
    await recordShopifyManualSyncAnswered({ ...request, requestedAt: "not-a-time" }, { failed: true }, { db: fake.db as never });
    expect(fake.ops).toEqual([]);
  });
});

describe("toWholeSecond", () => {
  it("should drop the milliseconds", () => {
    expect(toWholeSecond(CLOCK)).toEqual(REQUESTED_AT);
  });
});
