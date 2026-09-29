import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runToNow } = vi.hoisted(() => ({ runToNow: vi.fn(async () => []) }));
vi.mock("./syncOrchestrator", () => ({
  runShopifyOrderSyncToNow: runToNow,
  shopifySyncFailureCode: (error: unknown) => (error instanceof Error ? `code:${error.message}` : "sync_failed"),
}));

import {
  handleShopifyManualSync,
  requestShopifyManualSync,
  SHOPIFY_SYNC_QUEUE_UNAVAILABLE,
  ShopifyManualSyncError,
  toWholeSecond,
} from "./manualSync";
import { scriptedDb } from "./scriptedDb.testkit";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
const REQUESTS = "shopify_sync_requests";
/** Mid-second, as a real clock almost always is. */
const CLOCK = new Date("2026-09-28T10:00:00.700Z");
const REQUESTED_AT = new Date("2026-09-28T10:00:00.000Z");
const target = { storeId: 7, organizationId: 42 };

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ShopifyManualSyncError);
  return (error as ShopifyManualSyncError).code;
}

beforeEach(() => {
  runToNow.mockReset().mockResolvedValue([]);
});

describe("when a manual sync is requested", () => {
  function requestDb(requestId = 55, requestNumber = 3) {
    return scriptedDb({
      select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [[{ requests: requestNumber }]] },
      insert: { [REQUESTS]: [requestId] },
    });
  }

  it("should record the request as queued, then queue it with its id", async () => {
    const fake = requestDb(55);
    let recordedAtEnqueue = -1;
    const enqueue = vi.fn(async () => {
      recordedAtEnqueue = fake.writes("insert", REQUESTS).length;
    });

    const result = await requestShopifyManualSync(target, { db: fake.db as never, now: () => CLOCK, enqueue });

    expect(result).toEqual({ requestId: 55, requestNumber: 3, requestedAt: REQUESTED_AT });
    expect(enqueue).toHaveBeenCalledWith({ ...target, requestId: 55 });
    // Recorded BEFORE the enqueue, so the run that settles it cannot start first.
    expect(recordedAtEnqueue).toBe(1);
    expect(fake.writes("insert", REQUESTS)[0]?.data).toEqual({
      storeId: 7,
      organizationId: 42,
      status: "queued",
      requestedAt: REQUESTED_AT,
    });
  });

  it("should number the request by the store's own counter, in the transaction that records it", async () => {
    const fake = requestDb(55, 3);
    await requestShopifyManualSync(target, { db: fake.db as never, enqueue: vi.fn(async () => {}) });

    const bump = fake.ops.find((op) => op.kind === "insert" && op.table === CURSORS);
    const readBack = fake.ops.find((op) => op.kind === "select" && op.table === CURSORS);
    const record = fake.ops.find((op) => op.kind === "insert" && op.table === REQUESTS);
    // An upsert, which reads the latest committed count and holds the row's
    // lock to commit: two concurrent requests for one store get two numbers.
    expect(bump?.upsert).toBe(true);
    expect(bump?.data).toMatchObject({ storeId: 7, organizationId: 42, resource: "orders", syncRequestCount: 1 });
    expect(new MySqlDialect().sqlToQuery(bump?.onDuplicate?.syncRequestCount as SQL).sql).toBe(
      "`shopify_sync_cursors`.`syncRequestCount` + 1",
    );
    expect(readBack?.where?.params).toEqual([7, 42, "orders"]);
    // Numbered, then recorded, in one transaction.
    expect(bump?.txId).not.toBeNull();
    expect(new Set([bump?.txId, readBack?.txId, record?.txId]).size).toBe(1);
    expect(fake.ops.indexOf(bump!)).toBeLessThan(fake.ops.indexOf(record!));
  });

  it("should leave no request behind when numbering it fails", async () => {
    const fake = scriptedDb({
      select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [new Error("lock wait timeout")] },
      insert: { [REQUESTS]: [55] },
    });
    const enqueue = vi.fn(async () => {});
    await expect(requestShopifyManualSync(target, { db: fake.db as never, enqueue })).rejects.toThrow("lock wait timeout");
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.writes("insert", REQUESTS)).toEqual([]);
    expect(fake.writes("insert", CURSORS)).toEqual([]);
  });

  it("should look the store up by id, tenant and status together", async () => {
    const fake = requestDb();
    await requestShopifyManualSync(target, { db: fake.db as never, enqueue: vi.fn(async () => {}) });
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual([7, 42, "active"]);
  });

  it("should give one answer for another tenant's store, an unknown id and a disconnected store, writing nothing", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const enqueue = vi.fn(async () => {});

    expect(await codeOf(requestShopifyManualSync(target, { db: fake.db as never, enqueue }))).toBe("STORE_UNAVAILABLE");
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
  });

  it("should refuse as unavailable when there is no database, never reaching for the application's", async () => {
    expect(await codeOf(requestShopifyManualSync(target, { db: null, enqueue: vi.fn() }))).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("when the queue refuses a manual sync", () => {
  it("should settle its own request as failed — that row alone, and only while still queued", async () => {
    const fake = scriptedDb({
      select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [[{ requests: 3 }]] },
      insert: { [REQUESTS]: [55] },
    });
    const enqueue = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED redis");
    });

    const code = await codeOf(requestShopifyManualSync(target, { db: fake.db as never, now: () => CLOCK, enqueue }));

    expect(code).toBe("QUEUE_UNAVAILABLE");
    const settle = fake.writes("update", REQUESTS);
    expect(settle).toHaveLength(1);
    expect(settle[0]?.data).toEqual({ status: "failed", errorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, answeredAt: CLOCK });
    // Its own id, its own store and tenant, and still queued: a request another
    // run is serving is never touched, and one a run already settled keeps its outcome.
    expect(settle[0]?.where?.params).toEqual([7, 42, 55, "queued"]);
  });
});

describe("when the queue runs a manual sync", () => {
  const payload = { ...target, requestId: 55 };

  function runDb(newestQueued: number | Error) {
    return scriptedDb({
      select: { [REQUESTS]: [newestQueued instanceof Error ? newestQueued : [{ id: newestQueued }]] },
    });
  }

  it("should settle exactly the requests queued when it STARTED — not one made while it ran", async () => {
    // 57 is the newest queued request when the run starts; 58 arrives mid-run
    // and is left for the follow-up run the queue keeps for it.
    const fake = runDb(57);
    runToNow.mockImplementation(async () => {
      fake.ops.push({ kind: "insert", table: REQUESTS, where: null, data: { note: "request 58 mid-run" }, upsert: false, txId: null, locked: false });
      return [];
    });

    await handleShopifyManualSync(payload, { db: fake.db as never, now: () => CLOCK });

    expect(runToNow).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    const snapshot = fake.ops.findIndex((op) => op.kind === "select" && op.table === REQUESTS);
    // `data` is a row OR the rows of a bulk insert, so the single-row read narrows first.
    const midRun = fake.ops.findIndex((op) => !Array.isArray(op.data) && op.data?.note === "request 58 mid-run");
    expect(snapshot).toBeLessThan(midRun);
    const lookup = fake.ops[snapshot];
    expect(lookup?.where?.params).toEqual([7, 42, "queued"]);

    const settle = fake.writes("update", REQUESTS);
    expect(settle).toHaveLength(1);
    expect(settle[0]?.data).toEqual({ status: "succeeded", errorCode: null, answeredAt: CLOCK });
    // Rows still queued that it saw — a row an overlapping run has settled keeps
    // its outcome — or its OWN request, and that only from failed to succeeded.
    expect(settle[0]?.where?.params).toEqual([7, 42, "queued", 57, 55, "failed"]);
  });

  it("should settle the requests it saw as failed, with the sync's own code", async () => {
    const fake = runDb(57);
    const failure = new Error("pagination_error");
    runToNow.mockRejectedValueOnce(failure);

    await expect(handleShopifyManualSync(payload, { db: fake.db as never, now: () => CLOCK })).rejects.toBe(failure);

    const settle = fake.writes("update", REQUESTS);
    expect(settle).toHaveLength(1);
    expect(settle[0]?.data).toEqual({ status: "failed", errorCode: "code:pagination_error", answeredAt: CLOCK });
    // A failure never replaces an outcome already recorded: queued rows only.
    expect(settle[0]?.where?.params).toEqual([7, 42, "queued", 57]);
  });

  it("should still settle the request that queued it, failed, when it cannot read the queued requests", async () => {
    const fake = runDb(new Error("read timeout"));

    await expect(handleShopifyManualSync(payload, { db: fake.db as never, now: () => CLOCK })).rejects.toThrow("read timeout");

    expect(runToNow).not.toHaveBeenCalled();
    const settle = fake.writes("update", REQUESTS);
    expect(settle[0]?.data).toMatchObject({ status: "failed", errorCode: "code:read timeout" });
    expect(settle[0]?.where?.params).toEqual([7, 42, "queued", 55]);
  });

  it("should not fail a job whose sync succeeded when only the bookkeeping write fails", async () => {
    const fake = scriptedDb({ select: { [REQUESTS]: [[{ id: 55 }]] }, update: { [REQUESTS]: [new Error("deadlock")] } });
    await expect(handleShopifyManualSync(payload, { db: fake.db as never })).resolves.toBeUndefined();
  });

  it("should refuse to run without a database, never reaching for the application's", async () => {
    await expect(handleShopifyManualSync(payload, { db: null })).rejects.toThrow(/Database unavailable/);
    expect(runToNow).not.toHaveBeenCalled();
  });
});

describe("toWholeSecond", () => {
  it("should drop the milliseconds", () => {
    expect(toWholeSecond(CLOCK)).toEqual(REQUESTED_AT);
  });
});
