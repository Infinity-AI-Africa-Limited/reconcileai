import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ shopifyClientId: "client-id", shopifyClientSecret: "client-secret" }));
vi.mock("../../_core/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../_core/env")>();
  return {
    ...mod,
    ENV: {
      ...mod.ENV,
      get shopifyClientId() {
        return env.shopifyClientId;
      },
      get shopifyClientSecret() {
        return env.shopifyClientSecret;
      },
    },
  };
});

import {
  runShopifyOrderBackstop,
  SHOPIFY_ORDER_BACKSTOP_BATCH,
  SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS,
  startShopifyOrderBackstopLoop,
  stopShopifyOrderBackstopLoop,
} from "./orderBackstop";
import { scriptedDb } from "./scriptedDb.testkit";

const STORES = "shopify_connector_stores";
const NOW = new Date("2026-09-28T12:00:00.000Z");

afterEach(() => {
  stopShopifyOrderBackstopLoop();
  vi.useRealTimers();
  env.shopifyClientId = "client-id";
  env.shopifyClientSecret = "client-secret";
});

describe("when the order sync backstop ticks", () => {
  it("should pick only stores a sync would accept that have not synced within the interval, stalest first", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[]] } });

    await runShopifyOrderBackstop({ db: fake.db as never, now: () => NOW, sync: vi.fn() });

    const [pick] = fake.ops.filter((op) => op.kind === "select" && op.table === STORES);
    // Active store, no customer-redaction fence, tenant not being redacted.
    expect(pick?.where?.sql).toMatch(/`shopify_connector_stores`\.`status` = \?/);
    expect(pick?.where?.sql).toMatch(/`shopify_connector_stores`\.`privacyRedactionState` = \?/);
    expect(pick?.where?.sql).toMatch(/`organizations`\.`deletionState` = \?/);
    expect(pick?.where?.params.filter((param) => param === "active")).toHaveLength(3);
    // Never synced, or last synced before now - interval.
    expect(pick?.where?.sql).toMatch(/`shopify_sync_cursors`\.`lastSuccessfulAt` is null or `shopify_sync_cursors`\.`lastSuccessfulAt` <= \?/);
    const staleBefore = new Date(NOW.getTime() - SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS);
    expect(pick?.where?.params).toContain(staleBefore.toISOString().slice(0, -1).replace("T", " "));
  });

  it("should sync each store in turn as the backstop, and let one failure stop none of the rest", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = scriptedDb({
      select: { [STORES]: [[{ storeId: 7, organizationId: 42 }, { storeId: 8, organizationId: 43 }, { storeId: 9, organizationId: 44 }]] },
    });
    const sync = vi.fn(async ({ storeId }: { storeId: number }) => {
      if (storeId === 8) {
        throw Object.assign(new Error("Failed query: update … params: owner@merchant.com"), {
          name: "DrizzleQueryError",
          cause: Object.assign(new Error("Lock wait timeout exceeded"), { code: "ER_LOCK_WAIT_TIMEOUT" }),
        });
      }
      return {} as never;
    });

    const report = await runShopifyOrderBackstop({ db: fake.db as never, now: () => NOW, sync: sync as never });

    expect(report).toEqual({ scanned: 3, synced: 2, failed: 1 });
    expect(sync.mock.calls.map(([params]) => params)).toEqual([
      { storeId: 7, organizationId: 42, trigger: "backstop" },
      { storeId: 8, organizationId: 43, trigger: "backstop" },
      { storeId: 9, organizationId: 44, trigger: "backstop" },
    ]);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({
      code: "shopify_backstop_store_failed",
      storeId: 8,
      organizationId: 43,
      error: "database",
      errorCode: "ER_LOCK_WAIT_TIMEOUT",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/owner@merchant\.com|Failed query|Lock wait/);
    vi.restoreAllMocks();
  });

  it("should never sync one store twice at once: stores run one after another", async () => {
    const fake = scriptedDb({ select: { [STORES]: [[{ storeId: 7, organizationId: 42 }, { storeId: 8, organizationId: 42 }]] } });
    let running = 0;
    let overlapped = false;
    const sync = vi.fn(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return {} as never;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runShopifyOrderBackstop({ db: fake.db as never, now: () => NOW, sync: sync as never });

    expect(sync).toHaveBeenCalledTimes(2);
    expect(overlapped).toBe(false);
    vi.restoreAllMocks();
  });

  it("should bound each tick to its batch", async () => {
    const limits: number[] = [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) chain[step] = () => chain;
    chain.limit = async (n: number) => {
      limits.push(n);
      return [];
    };
    const db = { select: () => chain };

    await runShopifyOrderBackstop({ db: db as never, now: () => NOW, sync: vi.fn() });
    await runShopifyOrderBackstop({ db: db as never, now: () => NOW, sync: vi.fn(), batchSize: 3 });

    expect(limits).toEqual([SHOPIFY_ORDER_BACKSTOP_BATCH, 3]);
  });

  it("should log by code and not throw when the stores cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = scriptedDb({ select: { [STORES]: [new Error("Failed query: select … params: owner@merchant.com")] } });

    await expect(runShopifyOrderBackstop({ db: fake.db as never, now: () => NOW, sync: vi.fn() }))
      .resolves.toEqual({ scanned: 0, synced: 0, failed: 0 });
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ code: "shopify_backstop_unavailable" });
    vi.restoreAllMocks();
  });
});

describe("when the backstop loop starts", () => {
  it("should not start without Shopify app credentials", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    env.shopifyClientSecret = "";
    const run = vi.fn(async () => {});

    expect(startShopifyOrderBackstopLoop({ run, firstDelayMs: 0 })).toBe(false);
    vi.restoreAllMocks();
  });

  it("should wait for its first tick, then tick every interval, never overlapping itself", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    expect(startShopifyOrderBackstopLoop({ run, firstDelayMs: 1_000, intervalMs: 10_000 })).toBe(true);
    expect(startShopifyOrderBackstopLoop({ run, firstDelayMs: 1_000, intervalMs: 10_000 })).toBe(true); // once per process
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    // Still running when the interval fires: the tick is skipped.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
