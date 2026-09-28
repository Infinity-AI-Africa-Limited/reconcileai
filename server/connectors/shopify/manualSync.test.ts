import { beforeEach, describe, expect, it, vi } from "vitest";

const { runSync } = vi.hoisted(() => ({ runSync: vi.fn(async () => undefined) }));
vi.mock("./syncOrchestrator", () => ({ runShopifyOrderSync: runSync }));

import {
  handleShopifyManualSync,
  markShopifyManualSyncFailed,
  requestShopifyManualSync,
  SHOPIFY_SYNC_NOT_COMPLETED,
  SHOPIFY_SYNC_QUEUE_UNAVAILABLE,
  ShopifyManualSyncError,
} from "./manualSync";
import { scriptedDb } from "./scriptedDb.testkit";

const STORES = "shopify_connector_stores";
const CURSORS = "shopify_sync_cursors";
const REQUESTED_AT = new Date("2026-09-28T10:00:00.000Z");
const payload = { storeId: 7, organizationId: 42 };

function activeStore() {
  return scriptedDb({ select: { [STORES]: [[{ id: 7 }]] } });
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ShopifyManualSyncError);
  return (error as ShopifyManualSyncError).code;
}

beforeEach(() => {
  runSync.mockClear();
});

describe("when a manual sync is requested", () => {
  it("should record the request and then queue it, answering with when it was asked for", async () => {
    const fake = activeStore();
    let cursorWritesAtEnqueue = -1;
    const enqueue = vi.fn(async () => {
      cursorWritesAtEnqueue = fake.writes("insert", CURSORS).length;
    });

    const result = await requestShopifyManualSync(payload, { db: fake.db as never, now: () => REQUESTED_AT, enqueue });

    expect(result).toEqual({ requestedAt: REQUESTED_AT });
    expect(enqueue).toHaveBeenCalledWith(payload);
    // Written BEFORE the enqueue: a worker finishing first would otherwise
    // record its outcome earlier than the request, which then looks pending.
    expect(cursorWritesAtEnqueue).toBe(1);
    expect(fake.writes("insert", CURSORS)[0]).toMatchObject({
      data: { storeId: 7, organizationId: 42, resource: "orders", syncRequestedAt: REQUESTED_AT },
      upsert: true,
    });
  });

  it("should look the store up by id, tenant and status together", async () => {
    const fake = activeStore();
    await requestShopifyManualSync(payload, { db: fake.db as never, enqueue: vi.fn(async () => {}) });
    const lookup = fake.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual([7, 42, "active"]);
  });

  it("should give one answer for another tenant's store, an unknown id and a disconnected store, writing nothing", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });
    const enqueue = vi.fn(async () => {});

    expect(await codeOf(requestShopifyManualSync(payload, { db: fake.db as never, enqueue }))).toBe("STORE_UNAVAILABLE");
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
  });

  it("should record the refusal when the queue will not take the work, so it does not look pending", async () => {
    const fake = activeStore();
    const enqueue = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED redis");
    });

    expect(await codeOf(requestShopifyManualSync(payload, { db: fake.db as never, now: () => REQUESTED_AT, enqueue })))
      .toBe("QUEUE_UNAVAILABLE");
    expect(fake.writes("update", CURSORS)[0]?.data).toEqual({
      lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE,
      lastErrorAt: REQUESTED_AT,
    });
  });

  it("should refuse as unavailable when there is no database", async () => {
    expect(await codeOf(requestShopifyManualSync(payload, { db: null as never, enqueue: vi.fn() })))
      .toBe("SERVICE_UNAVAILABLE");
  });
});

describe("when the queue runs a manual sync", () => {
  it("should run the ordinary sync cycle as a manual trigger", async () => {
    await handleShopifyManualSync(payload);
    expect(runSync).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
  });
});

describe("when a queued manual sync fails for the last time", () => {
  it("should record a failure only if the run recorded no outcome after the request", async () => {
    const fake = scriptedDb();
    await markShopifyManualSyncFailed(payload, { db: fake.db as never, now: () => REQUESTED_AT });

    const write = fake.writes("update", CURSORS)[0];
    expect(write?.data).toEqual({ lastErrorCode: SHOPIFY_SYNC_NOT_COMPLETED, lastErrorAt: REQUESTED_AT });
    // Never overwrite the precise code a failed run already recorded, nor a success.
    expect(write?.where?.sql).toMatch(/`lastErrorAt` is null or `shopify_sync_cursors`\.`lastErrorAt` < `shopify_sync_cursors`\.`syncRequestedAt`/);
    expect(write?.where?.sql).toMatch(/`lastSuccessfulAt` is null or `shopify_sync_cursors`\.`lastSuccessfulAt` < `shopify_sync_cursors`\.`syncRequestedAt`/);
    expect(write?.where?.sql).toMatch(/`syncRequestedAt` is not null/);
    expect(write?.where?.params).toEqual([7, 42, "orders"]);
  });
});
