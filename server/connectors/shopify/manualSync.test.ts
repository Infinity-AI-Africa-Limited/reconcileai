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
/** Mid-second, as a real clock almost always is. */
const CLOCK = new Date("2026-09-28T10:00:00.700Z");
const REQUESTED_AT = new Date("2026-09-28T10:00:00.000Z");
const target = { storeId: 7, organizationId: 42 };
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
  function requestDb(ownSeq = 5) {
    return scriptedDb({ select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [[{ requestSeq: ownSeq }]] } });
  }

  it("should count the request, then queue it with its own number", async () => {
    const fake = requestDb(5);
    let countedAtEnqueue = -1;
    const enqueue = vi.fn(async () => {
      countedAtEnqueue = fake.writes("insert", CURSORS).length;
    });

    const result = await requestShopifyManualSync(target, { db: fake.db as never, now: () => CLOCK, enqueue });

    expect(result).toEqual({ requestedAt: REQUESTED_AT, requestSeq: 5 });
    expect(enqueue).toHaveBeenCalledWith({ ...target, requestSeq: 5 });
    // Counted BEFORE the enqueue, so the run that answers it cannot start first.
    expect(countedAtEnqueue).toBe(1);
    const count = fake.writes("insert", CURSORS)[0];
    expect(count?.data).toMatchObject({ storeId: 7, organizationId: 42, resource: "orders", syncRequestedAt: REQUESTED_AT, syncRequestSeq: 1 });
    expect(count?.upsert).toBe(true);
  });

  it("should read its number back in the transaction that counted it, so it is its own and not a concurrent one's", async () => {
    const fake = requestDb();
    await requestShopifyManualSync(target, { db: fake.db as never, enqueue: vi.fn(async () => {}) });
    const count = fake.ops.find((op) => op.kind === "insert" && op.table === CURSORS);
    const readBack = fake.ops.find((op) => op.kind === "select" && op.table === CURSORS);
    expect(count?.txId).not.toBeNull();
    expect(readBack?.txId).toBe(count?.txId);
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
  async function refused(ownSeq: number) {
    const fake = scriptedDb({ select: { [STORES]: [[{ id: 7 }]], [CURSORS]: [[{ requestSeq: ownSeq }]] } });
    const enqueue = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED redis");
    });
    const code = await codeOf(requestShopifyManualSync(target, { db: fake.db as never, now: () => CLOCK, enqueue }));
    return { code, answer: fake.writes("update", CURSORS)[0] };
  }

  it("should answer its own request as failed, so the page shows a failure rather than waiting", async () => {
    const { code, answer } = await refused(5);
    expect(code).toBe("QUEUE_UNAVAILABLE");
    expect(answer?.data).toEqual({ lastErrorCode: SHOPIFY_SYNC_QUEUE_UNAVAILABLE, lastErrorAt: CLOCK, syncAnsweredSeq: 5 });
  });

  it("should answer only while its request is the sole one outstanding — never one another request queued", async () => {
    // Answering 5 answers everything below it too. So the write applies only
    // when 5 is the latest request counted AND every earlier one is answered.
    const { answer } = await refused(5);
    expect(answer?.where?.sql).toContain("`syncRequestSeq` = ?");
    expect(answer?.where?.sql).toContain("`syncAnsweredSeq` = ?");
    expect(answer?.where?.params).toEqual([7, 42, "orders", 5, 4]);
  });
});

describe("when the queue runs a manual sync", () => {
  const payload = { ...target, requestSeq: 3 };

  it("should answer exactly the requests counted when it STARTED — not one made while it ran", async () => {
    // Counted 4 when the run starts; a 5th request arrives mid-run. That one is
    // left pending for the follow-up run the queue keeps for it.
    const fake = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 4 }]] } });
    runToNow.mockImplementation(async () => {
      fake.ops.push({ kind: "insert", table: CURSORS, where: null, data: { note: "request 5 mid-run" }, upsert: true, txId: null, locked: false });
      return [];
    });

    await handleShopifyManualSync(payload, { db: fake.db as never });

    expect(runToNow).toHaveBeenCalledWith({ storeId: 7, organizationId: 42, trigger: "manual" });
    const snapshot = fake.ops.findIndex((op) => op.kind === "select" && op.table === CURSORS);
    const midRun = fake.ops.findIndex((op) => op.data?.note === "request 5 mid-run");
    expect(snapshot).toBeLessThan(midRun);
    const answered = fake.writes("update", CURSORS)[0]?.data ?? {};
    // A success leaves the error code alone: it errs towards "failed", never
    // towards a success that did not happen.
    expect(Object.keys(answered)).toEqual(["syncAnsweredSeq"]);
    expect(rendered(answered.syncAnsweredSeq)).toMatchObject({
      sql: "GREATEST(`shopify_sync_cursors`.`syncAnsweredSeq`, ?)",
      params: [4],
    });
  });

  it("should write a failed run's code again as it answers, so a webhook success in between cannot hide the failure", async () => {
    const fake = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 3 }]] } });
    const failure = new Error("pagination_error");
    runToNow.mockRejectedValueOnce(failure);

    await expect(handleShopifyManualSync(payload, { db: fake.db as never, now: () => CLOCK })).rejects.toBe(failure);

    // Answered and failed in ONE statement: the page never sees one without the other.
    const writes = fake.writes("update", CURSORS);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.data).toMatchObject({ lastErrorCode: "code:pagination_error", lastErrorAt: CLOCK });
    expect(rendered(writes[0]?.data?.syncAnsweredSeq).params).toEqual([3]);
  });

  it("should still answer the request that queued it, failed, when it cannot read the count", async () => {
    const fake = scriptedDb({ select: { [CURSORS]: [new Error("read timeout")] } });

    await expect(handleShopifyManualSync(payload, { db: fake.db as never, now: () => CLOCK })).rejects.toThrow("read timeout");

    expect(runToNow).not.toHaveBeenCalled();
    const answer = fake.writes("update", CURSORS)[0]?.data ?? {};
    expect(answer).toMatchObject({ lastErrorCode: "code:read timeout", lastErrorAt: CLOCK });
    expect(rendered(answer.syncAnsweredSeq).params).toEqual([3]);
  });

  it("should not fail a job whose sync succeeded when only the bookkeeping write fails", async () => {
    const fake = scriptedDb({ select: { [CURSORS]: [[{ requestSeq: 3 }]] }, update: { [CURSORS]: [new Error("deadlock")] } });
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
