/**
 * Real-time reconciliation trigger — coalescing behaviour.
 *
 * The whole point of this module is that it must NOT run one reconciliation
 * per webhook: SHOPLINE allows ~4 req/s per store and a single sync makes
 * several paginated calls. These tests pin the debounce, the max-wait cap, the
 * in-flight guard and the topic filter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// runSyncCycle is mocked — we assert on HOW OFTEN it is called, not what it does.
const runSyncCycle = vi.fn();
vi.mock("./connectors/shopline/syncOrchestrator", () => ({
  runSyncCycle: (...args: unknown[]) => runSyncCycle(...args),
}));

import {
  scheduleReconciliation,
  isReconciliationTrigger,
  realtimeStatus,
  __resetRealtimeState,
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  RECONCILIATION_TRIGGER_TOPICS,
} from "./connectors/shopline/realtimeSync";

beforeEach(() => {
  vi.useFakeTimers();
  runSyncCycle.mockReset();
  runSyncCycle.mockResolvedValue({
    error: undefined,
    ordersIngested: 1,
    paymentsIngested: 1,
    matchedCount: 1,
    exceptionCount: 0,
  });
  __resetRealtimeState();
});

afterEach(() => {
  __resetRealtimeState();
  vi.useRealTimers();
});

describe("topic filter", () => {
  it("triggers on the reconciliation-relevant topics", () => {
    for (const t of RECONCILIATION_TRIGGER_TOPICS) {
      expect(isReconciliationTrigger(t)).toBe(true);
    }
  });

  it("does NOT trigger on orders/create (unpaid — nothing to match yet)", () => {
    expect(isReconciliationTrigger("orders/create")).toBe(false);
  });

  it("does NOT trigger on GDPR or billing topics", () => {
    for (const t of ["customers/redact", "shop/redact", "appsubscription/paid", "orders/delete"]) {
      expect(isReconciliationTrigger(t)).toBe(false);
    }
  });

  it("ignores a non-trigger topic entirely (nothing queued)", () => {
    scheduleReconciliation(1, 10, "orders/create");
    expect(realtimeStatus().pending).toEqual([]);
    vi.advanceTimersByTime(MAX_WAIT_MS * 2);
    expect(runSyncCycle).not.toHaveBeenCalled();
  });
});

describe("debounce + coalescing", () => {
  it("runs ONE sync for a burst of events on the same store", async () => {
    for (let i = 0; i < 50; i++) scheduleReconciliation(1, 10, "orders/paid");
    expect(runSyncCycle).not.toHaveBeenCalled(); // nothing before the quiet period

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
    expect(runSyncCycle).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 1, slStoreId: 10 }),
    );
  });

  it("each further event resets the quiet period", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    // Keep nudging just under the debounce — sync must not fire yet.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 5_000);
      scheduleReconciliation(1, 10, "orders/updated");
    }
    expect(runSyncCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
  });

  it("MAX_WAIT_MS caps the delay so a continuous stream cannot starve the sync", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    // A relentless stream: an event every second for well past the cap.
    for (let i = 0; i < 90; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      scheduleReconciliation(1, 10, "orders/paid");
    }
    // Without the cap this would still be pending; it must have fired.
    expect(runSyncCycle).toHaveBeenCalled();
  });

  it("keeps stores independent — one sync each", async () => {
    scheduleReconciliation(1, 10, "orders/paid");
    scheduleReconciliation(2, 20, "orders/paid");
    scheduleReconciliation(1, 10, "refunds/create");

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
    const storeIds = runSyncCycle.mock.calls.map((c) => (c[0] as { slStoreId: number }).slStoreId).sort();
    expect(storeIds).toEqual([10, 20]);
  });
});

describe("in-flight guard", () => {
  it("does not start a second concurrent sync for the same store", async () => {
    let release!: () => void;
    runSyncCycle.mockImplementation(
      () => new Promise((res) => { release = () => res({ error: undefined, ordersIngested: 0, paymentsIngested: 0, matchedCount: 0, exceptionCount: 0 }); }),
    );

    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);
    expect(realtimeStatus().inFlight).toContain(10);

    // Events arriving mid-run must not launch a parallel cycle.
    scheduleReconciliation(1, 10, "orders/paid");
    scheduleReconciliation(1, 10, "refunds/update");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(1);

    // …but they do earn exactly one follow-up pass once it completes.
    release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
  });
});

describe("failure isolation", () => {
  it("a thrown sync does not leave the store stuck in-flight", async () => {
    runSyncCycle.mockRejectedValueOnce(new Error("SHOPLINE 429"));
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);

    expect(realtimeStatus().inFlight).not.toContain(10);

    // A later event still schedules normally.
    scheduleReconciliation(1, 10, "orders/paid");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runSyncCycle).toHaveBeenCalledTimes(2);
  });

  it("a reported sync error is handled without throwing", async () => {
    runSyncCycle.mockResolvedValueOnce({ error: "no access token", ordersIngested: 0, paymentsIngested: 0, matchedCount: 0, exceptionCount: 0 });
    scheduleReconciliation(1, 10, "orders/paid");
    await expect(vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)).resolves.not.toThrow();
    expect(realtimeStatus().inFlight).not.toContain(10);
  });
});
