/**
 * Real-time reconciliation trigger — coalescing behaviour.
 *
 * The whole point of this module is that it must NOT run one reconciliation
 * per webhook: SHOPLINE allows ~4 req/s per store and a single sync makes
 * several paginated calls. These run the real trigger on the in-process queue
 * (no REDIS_URL) and pin what a store sees: one sync per window, a window that
 * does not move, one store never synced twice at once, and a failure that never
 * reaches the webhook path. The BullMQ contract is pinned in
 * shoplineRealtimeSync.bullmq.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// runSyncCycle is mocked — we assert on HOW OFTEN it is called, not what it does.
const runSyncCycle = vi.fn();
vi.mock("./connectors/shopline/syncOrchestrator", () => ({
  runSyncCycle: (...args: unknown[]) => runSyncCycle(...args),
}));

/** Failure injection for the queue, around the real factory. */
const queueFaults = vi.hoisted(() => ({ create: false, enqueue: false }));
vi.mock("./jobQueue", async importOriginal => {
  const real = await importOriginal<typeof import("./jobQueue")>();
  return {
    ...real,
    createQueue: async (...args: Parameters<typeof real.createQueue>) => {
      if (queueFaults.create) throw new Error("connect ECONNREFUSED");
      const queue = await real.createQueue(...args);
      // Delegate explicitly: the in-process queue is a class, so a spread would
      // drop its methods.
      return {
        backend: queue.backend,
        stats: () => queue.stats(),
        close: () => queue.close(),
        enqueue: (...enqueueArgs: Parameters<typeof queue.enqueue>) =>
          queueFaults.enqueue
            ? Promise.reject(new real.QueueOperationTimeoutError(args[0], "enqueue", 3_000))
            : queue.enqueue(...enqueueArgs),
      };
    },
  };
});

import {
  scheduleReconciliation,
  isReconciliationTrigger,
  __resetRealtimeQueue,
  COALESCE_WINDOW_MS,
  RECONCILIATION_TRIGGER_TOPICS,
} from "./connectors/shopline/realtimeSync";

const done = { error: undefined, ordersIngested: 1, paymentsIngested: 1, matchedCount: 1, exceptionCount: 0 };

beforeEach(async () => {
  await __resetRealtimeQueue();
  // In-process, always: with REDIS_URL set these would open the PRODUCTION
  // queue name on that Redis, where fake timers cannot move jobs and the mocked
  // worker could consume an app's real requests.
  vi.stubEnv("REDIS_URL", "");
  queueFaults.create = false;
  queueFaults.enqueue = false;
  vi.useFakeTimers();
  runSyncCycle.mockReset();
  runSyncCycle.mockResolvedValue(done);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await __resetRealtimeQueue();
  vi.unstubAllEnvs();
});

describe("when a webhook topic is or is not a reconciliation event", () => {
  it("should treat the reconciliation-relevant topics as triggers", () => {
    for (const t of RECONCILIATION_TRIGGER_TOPICS) {
      expect(isReconciliationTrigger(t)).toBe(true);
    }
  });

  it("should not treat orders/create as a trigger (unpaid — nothing to match yet)", () => {
    expect(isReconciliationTrigger("orders/create")).toBe(false);
  });

  it("should not treat GDPR, billing or delete topics as triggers", () => {
    for (const t of ["customers/redact", "shop/redact", "appsubscription/paid", "orders/delete"]) {
      expect(isReconciliationTrigger(t)).toBe(false);
    }
  });

  it("should queue nothing for a non-trigger topic", async () => {
    scheduleReconciliation(1, 10, "orders/create");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS * 3);
    expect(runSyncCycle).not.toHaveBeenCalled();
  });
});

describe("when a burst of events arrives for one store", () => {
  it("should run ONE sync, when the window closes", async () => {
    for (let i = 0; i < 50; i++) scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS - 1_000);
    expect(runSyncCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
    expect(runSyncCycle).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 1, slStoreId: 10 }));
  });
});

describe("when events keep arriving inside a store's window", () => {
  it("should not move the window: the sync runs when it closes, not after the last event", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      scheduleReconciliation(1, 10, "orders/updated");
    }
    // 15s in, three more events absorbed; the window opened at 0s.
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS - 15_000 + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
  });

  it("should service a never-ending stream once per window, never closer together", async () => {
    const ranAt: number[] = [];
    runSyncCycle.mockImplementation(async () => {
      ranAt.push(Date.now());
      return done;
    });
    for (let i = 0; i < 90; i++) {
      scheduleReconciliation(1, 10, "orders/paid");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(ranAt.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ranAt.length; i++) {
      expect(ranAt[i] - ranAt[i - 1]).toBeGreaterThanOrEqual(COALESCE_WINDOW_MS);
    }
  });
});

describe("when several stores have events", () => {
  it("should give each store its own sync", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    scheduleReconciliation(2, 20, "orders/paid");
    scheduleReconciliation(1, 10, "refunds/create");

    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
    const storeIds = runSyncCycle.mock.calls.map(c => (c[0] as { slStoreId: number }).slStoreId).sort();
    expect(storeIds).toEqual([10, 20]);
  });

  it("should keep two tenants' stores apart even when their store ids match", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    scheduleReconciliation(2, 10, "orders/paid");

    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    const tenants = runSyncCycle.mock.calls.map(c => (c[0] as { organizationId: number }).organizationId).sort();
    expect(tenants).toEqual([1, 2]);
  });
});

describe("when events arrive while a store's sync is running", () => {
  it("should not start a second sync for that store, and should run exactly one follow-up after it", async () => {
    let release!: () => void;
    runSyncCycle.mockImplementationOnce(
      () =>
        new Promise(res => {
          release = () => res(done);
        })
    );

    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);

    // Mid-run events must not launch a parallel cycle, however long it runs.
    scheduleReconciliation(1, 10, "orders/paid");
    scheduleReconciliation(1, 10, "refunds/update");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS * 2);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);

    // …but they earn exactly one follow-up, a window after the run ends.
    release();
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS * 3);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
  });
});

describe("when a sync fails", () => {
  it("should not leave the store stuck after a thrown sync", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runSyncCycle.mockRejectedValueOnce(new Error("SHOPLINE 429"));
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);

    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
  });

  it("should handle a reported sync error without throwing or retrying it", async () => {
    // One attempt: the 15-minute poll is the retry, with fresh data.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runSyncCycle.mockResolvedValueOnce({ ...done, error: "no access token" });
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS * 4);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
  });
});

describe("when the queue cannot accept a request", () => {
  it("should never throw on the webhook path, log it, and leave the store to the poll", async () => {
    queueFaults.enqueue = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => scheduleReconciliation(1, 10, "orders/paid")).not.toThrow();
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);

    expect(runSyncCycle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not schedule a sync"),
      expect.objectContaining({ organizationId: 1, slStoreId: 10, error: "QueueOperationTimeoutError" })
    );
  });

  it("should try to build the queue again on the next request, rather than keep a failed one", async () => {
    queueFaults.create = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(10);

    queueFaults.create = false;
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 100);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
  });
});
