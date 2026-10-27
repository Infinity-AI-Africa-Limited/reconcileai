/**
 * The 15-minute SHOPLINE poll catching a store up after an outage.
 *
 * One sync cycle reads at most a day (it bounds the paginated SHOPLINE calls
 * one cycle makes), but how far back the catch-up reaches must not be bounded
 * by that: a store dark for three days is walked forward from its watermark one
 * day at a time. Until 2026-10-27 the poll clamped its window to the last 24
 * hours, so everything older than a day at recovery was never fetched.
 */
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncOptions, SyncReport } from "./syncOrchestrator";

type StoreFixture = {
  id: number;
  organizationId: number;
  storeHandle: string;
  storeId: string;
  currency: string | null;
  apiVersion: string;
  lastSyncAt: Date | null;
  syncedThroughAt: Date | null;
};

const state = vi.hoisted(() => ({
  stores: [] as StoreFixture[],
  windows: [] as Array<{ store: number; from: Date; to: Date }>,
  /** Called per runSyncCycle; return a failure message to make that step fail. */
  onStep: (() => undefined) as (opts: { slStoreId: number; from: Date; to: Date }, n: number) => string | undefined,
}));

vi.mock("../../db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({ from: () => ({ where: async () => state.stores }) }),
  })),
}));

vi.mock("./webhookHandler", () => ({
  replayStalledWebhookEvents: vi.fn(async () => ({ examined: 0, processed: 0, failed: 0, movedToDlq: 0 })),
}));

vi.mock("./syncOrchestrator", () => ({
  SHOPLINE_BACKFILL_DAYS: 90,
  // The real rule (backwards only, NULL untouched) is pinned on a real MySQL in
  // syncedThroughWatermark.db.test.ts; this stand-in applies the same rule to
  // the fixtures so the handler's ordering can be checked here.
  rewindCatchUp: vi.fn(async (_db: unknown, to: Date) => {
    let moved = 0;
    for (const s of state.stores) {
      if (s.syncedThroughAt && s.syncedThroughAt > to) {
        s.syncedThroughAt = to;
        moved++;
      }
    }
    return moved;
  }),
  runSyncCycle: vi.fn(async (opts: SyncOptions): Promise<SyncReport> => {
    const window = { from: opts.from as Date, to: opts.to as Date };
    state.windows.push({ store: opts.slStoreId, ...window });
    const error = state.onStep({ slStoreId: opts.slStoreId, ...window }, state.windows.length);
    return {
      success: !error,
      organizationId: opts.organizationId,
      storeHandle: `store-${opts.slStoreId}`,
      window,
      ordersIngested: error ? 0 : 1,
      paymentsIngested: 0,
      payoutsIngested: 0,
      totalPersisted: error ? 0 : 1,
      matchedCount: 0,
      exceptionCount: 0,
      durationMs: 1,
      ...(error ? { error } : {}),
    };
  }),
}));

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = new Date("2026-10-29T12:00:00Z");

function store(id: number, syncedThroughAt: Date | null): StoreFixture {
  return {
    id,
    organizationId: 7,
    storeHandle: `store-${id}`,
    storeId: String(id),
    currency: "USD",
    apiVersion: "v20260601",
    lastSyncAt: syncedThroughAt,
    syncedThroughAt,
  };
}

async function poll(query: Record<string, string> = {}) {
  const { handleShoplineSyncCycle } = await import("./scheduledSync");
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  await handleShoplineSyncCycle({ url: "/api/scheduled/shoplineSyncCycle", query } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.stores = [];
  state.windows = [];
  state.onStep = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when a store has been dark for three days", () => {
  const watermark = new Date(NOW.getTime() - 72 * HOUR);

  it("should walk from its watermark to now in contiguous steps of at most a day", async () => {
    state.stores = [store(1, watermark)];

    const { body } = await poll();

    const windows = state.windows;
    expect(windows[0].from.getTime()).toBe(watermark.getTime() - 5 * MINUTE);
    expect(windows.at(-1)?.to.getTime()).toBe(NOW.getTime());
    for (const w of windows) expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(24 * HOUR);
    // Each step starts at the previous step's end, less the seam overlap — so
    // no instant between the watermark and now goes unread.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].from.getTime()).toBe(windows[i - 1].to.getTime() - 5 * MINUTE);
    }
    expect(windows).toHaveLength(4);
    expect(body).toMatchObject({ ok: true, successCount: 1, failCount: 0 });
    expect((body.reports as Array<Record<string, unknown>>)[0]).toMatchObject({
      steps: 4,
      caughtUp: true,
      orders: 4,
      window: { from: windows[0].from.toISOString(), to: NOW.toISOString() },
    });
  });

  it("should stop at a failed step, so the next poll resumes from the last one that succeeded", async () => {
    state.stores = [store(1, watermark)];
    state.onStep = (_w, n) => (n === 2 ? "SHOPLINE answered 503" : undefined);

    const { body } = await poll();

    expect(state.windows).toHaveLength(2);
    expect(body).toMatchObject({ successCount: 0, failCount: 1 });
    expect((body.reports as Array<Record<string, unknown>>)[0]).toMatchObject({
      success: false,
      steps: 2,
      caughtUp: false,
      error: "SHOPLINE answered 503",
    });
  });

  it("should take further steps only within the poll's time budget, but always every store's first", async () => {
    state.stores = [store(1, watermark), store(2, watermark)];
    // Each step takes 40 seconds; the budget is a minute.
    state.onStep = () => {
      vi.setSystemTime(Date.now() + 40_000);
      return undefined;
    };

    const { body } = await poll();

    const perStore = (id: number) => state.windows.filter((w) => w.store === id).length;
    expect(perStore(1)).toBe(2); // 40s, then 80s: over budget, stop
    expect(perStore(2)).toBe(1); // over budget already, but its first step still runs
    const reports = body.reports as Array<Record<string, unknown>>;
    expect(reports.map((r) => r.caughtUp)).toEqual([false, false]);
    expect(body).toMatchObject({ successCount: 2, caughtUpCount: 0 });
  });
});

describe("when a store is current", () => {
  it("should read once, from its watermark less the overlap, to now", async () => {
    const watermark = new Date(NOW.getTime() - 10 * MINUTE);
    state.stores = [store(1, watermark)];

    await poll();

    expect(state.windows).toEqual([
      { store: 1, from: new Date(watermark.getTime() - 5 * MINUTE), to: NOW },
    ]);
  });
});

describe("when an operator points the poll back at an earlier instant", () => {
  it("should rewind before reading the stores, and walk from there in the same poll", async () => {
    // Recovery on older code wrote the clock as the watermark, skipping the
    // outage. The operator names the outage's start.
    state.stores = [store(1, new Date(NOW.getTime() - 10 * MINUTE)), store(2, null)];
    const outageStart = "2026-10-27T12:00:00Z";

    const { status, body } = await poll({ catchUpFrom: outageStart });

    expect(status).toBe(200);
    expect(body.catchUpRewind).toEqual({ to: "2026-10-27T12:00:00.000Z", storesRewound: 1 });
    const store1 = state.windows.filter((w) => w.store === 1);
    expect(store1[0].from.toISOString()).toBe("2026-10-27T11:55:00.000Z");
    expect(store1.at(-1)?.to).toEqual(NOW);
    // A store that never synced keeps its own first window.
    expect(state.windows.filter((w) => w.store === 2)).toEqual([
      { store: 2, from: new Date(NOW.getTime() - 24 * HOUR), to: NOW },
    ]);
  });

  it.each([
    ["a date without a time", "2026-10-27"],
    ["an offset rather than UTC", "2026-10-27T12:00:00+01:00"],
    ["words", "yesterday"],
    ["the future", "2026-10-29T12:00:01Z"],
    ["further back than the install backfill reaches", "2026-07-30T00:00:00Z"],
  ])("should refuse %s before doing anything", async (_label, catchUpFrom) => {
    state.stores = [store(1, new Date(NOW.getTime() - 10 * MINUTE))];

    const { status, body } = await poll({ catchUpFrom });

    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(state.windows).toEqual([]);
    expect(state.stores[0].syncedThroughAt).toEqual(new Date(NOW.getTime() - 10 * MINUTE));
  });

  it("should treat an empty instruction as none", async () => {
    state.stores = [store(1, new Date(NOW.getTime() - 10 * MINUTE))];

    const { status, body } = await poll({ catchUpFrom: "" });

    expect(status).toBe(200);
    expect(body.catchUpRewind).toBeNull();
  });
});

describe("when a store has never synced", () => {
  it("should read the last day only — history is the install backfill's job", async () => {
    state.stores = [store(1, null)];

    await poll();

    expect(state.windows).toEqual([{ store: 1, from: new Date(NOW.getTime() - 24 * HOUR), to: NOW }]);
  });
});
