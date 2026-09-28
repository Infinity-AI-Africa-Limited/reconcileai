import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runToNow, recorded } = vi.hoisted(() => ({
  runToNow: vi.fn(async () => []),
  recorded: new WeakSet<object>(),
}));
vi.mock("./syncOrchestrator", () => ({
  runShopifyOrderSyncToNow: runToNow,
  isShopifySyncFailureRecorded: (error: unknown) => typeof error === "object" && error !== null && recorded.has(error),
}));

import {
  handleShopifyManualSync,
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
const dialect = new MySqlDialect();

function rendered(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ShopifyManualSyncError);
  return (error as ShopifyManualSyncError).code;
}

beforeEach(() => {
  runToNow.mockReset().mockResolvedValue([]);
});

describe("when a manual sync is requested", () => {
  function requestDb(countAfter = 5) {
    return scriptedDb({ select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [[{ requestSeq: countAfter }]] } });
  }

  it("should count the request, then queue it, answering with its number", async () => {
    const fake = requestDb(5);
    let countedAtEnqueue = -1;
    const enqueue = vi.fn(async () => {
      countedAtEnqueue = fake.writes("insert", CURSORS).length;
    });

    const result = await requestShopifyManualSync(request, { db: fake.db as never, now: () => CLOCK, enqueue });

    expect(result).toEqual({ requestedAt: REQUESTED_AT, requestSeq: 5 });
    expect(enqueue).toHaveBeenCalledWith(request);
    // Counted BEFORE the enqueue, so the run that answers it cannot start first.
    expect(countedAtEnqueue).toBe(1);
    const count = fake.writes("insert", CURSORS)[0];
    expect(count?.data).toMatchObject({ storeId: 7, organizationId: 42, resource: "orders", syncRequestedAt: REQUESTED_AT, syncRequestSeq: 1 });
    expect(count?.upsert).toBe(true);
  });

  it("should look the store up by id, tenant and status together", async () => {
    const fake = requestDb();
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
    const fake = requestDb(5);
    const enqueue = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED redis");
    });

    expect(await codeOf(requestShopifyManualSync(request, { db: fake.db as never, now: () => CLOCK, enqueue })))
      .toBe("QUEUE_UNAVAILABLE");
    const data = fake.writes("update", CURSORS)[0]?.data ?? {};
    expect(data).toMatchObject({ lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, lastErrorAt: CLOCK });
    expect(rendered(data.syncAnsweredSeq)).toMatchObject({
      sql: "GREATEST(`shopify_sync_cursors`.`syncAnsweredSeq`, ?)",
      params: [5],
    });
  });

  it("should refuse as unavailable when there is no database, never reaching for the application's", async () => {
    expect(await codeOf(requestShopifyManualSync(request, { db: null, enqueue: vi.fn() }))).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("when the queue runs a manual sync", () => {
  it("should answer exactly the requests counted when it STARTED — not one made while it ran", async () => {
    // Counted 3 when the run starts; a 4th request arrives mid-run. That one is
    // left pending for the follow-up run the queue keeps for it.
    const fake = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 3 }]] } });
    runToNow.mockImplementation(async () => {
      fake.ops.push({ kind: "insert", table: CURSORS, where: null, data: { note: "request 4 mid-run" }, upsert: true, txId: null, locked: false });
      return [];
    });

    await handleShopifyManualSync(request, { db: fake.db as never });

    expect(runToNow).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    const snapshot = fake.ops.findIndex((op) => op.kind === "select" && op.table === CURSORS);
    const midRun = fake.ops.findIndex((op) => op.data?.note === "request 4 mid-run");
    expect(snapshot).toBeLessThan(midRun);
    const answered = fake.writes("update", CURSORS)[0]?.data ?? {};
    expect(Object.keys(answered)).toEqual(["syncAnsweredSeq"]);
    expect(rendered(answered.syncAnsweredSeq).params).toEqual([3]);
  });

  it("should keep the precise code a failed sync recorded, and add a generic one only when it recorded none", async () => {
    const precise = new Error("pagination_error");
    recorded.add(precise);
    const withCode = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 2 }]] } });
    runToNow.mockRejectedValueOnce(precise);
    await expect(handleShopifyManualSync(request, { db: withCode.db as never })).rejects.toBe(precise);
    expect(Object.keys(withCode.writes("update", CURSORS)[0]?.data ?? {})).toEqual(["syncAnsweredSeq"]);

    const withoutCode = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 2 }]] } });
    runToNow.mockRejectedValueOnce(new Error("Shopify store not found for tenant or inactive"));
    await expect(handleShopifyManualSync(request, { db: withoutCode.db as never, now: () => CLOCK })).rejects.toThrow();
    // Answered and failed in ONE statement: the page never sees one without the other.
    expect(withoutCode.writes("update", CURSORS)).toHaveLength(1);
    expect(withoutCode.writes("update", CURSORS)[0]?.data).toMatchObject({
      lastErrorCode: SHOPIFY_SYNC_NOT_COMPLETED,
      lastErrorAt: CLOCK,
    });
  });

  it("should not fail a job whose sync succeeded when only the bookkeeping write fails", async () => {
    const fake = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 1 }]] }, update: { [CURSORS]: [new Error("deadlock")] } });
    await expect(handleShopifyManualSync(request, { db: fake.db as never })).resolves.toBeUndefined();
  });
});

describe("toWholeSecond", () => {
  it("should drop the milliseconds", () => {
    expect(toWholeSecond(CLOCK)).toEqual(REQUESTED_AT);
  });
});
