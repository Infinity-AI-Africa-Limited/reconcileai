/**
 * SHOPLINE Payments leg — best-effort behaviour.
 *
 * `/payments/store/*` belongs to the SHOPLINE Payments product. A store only
 * has a Payments merchant record if it is onboarded onto it; stores on an
 * external gateway — and every blank dev store — answer
 * `404 {"errors":"Resource not found: merchant"}`.
 *
 * Two regressions are locked down here:
 *
 *  1. That 404 must not abort the sync. It used to throw at Step 1, before the
 *     upload batch existed, so orders were never persisted and `lastSyncAt`
 *     never advanced — any merchant not on SHOPLINE Payments got a permanently
 *     empty dashboard.
 *  2. Only 404 may be tolerated. A 401/429/5xx must still throw, or a real
 *     outage would be laundered into a green sync reporting zero activity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  insertTransactions: vi.fn(),
  createUploadBatch: vi.fn(),
  updateUploadBatch: vi.fn(),
  insertExceptionsBatch: vi.fn(),
}));

import { bestEffortLeg } from "./connectors/shopline/syncOrchestrator";
import { ShoplineApiError } from "./connectors/shopline/apiClient";

describe("bestEffortLeg", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("passes data through untouched when the leg succeeds", async () => {
    const res = await bestEffortLeg("payments", "acme", async () => [{ id: "p1" }, { id: "p2" }]);
    expect(res.unavailable).toBe(false);
    expect(res.data).toHaveLength(2);
  });

  it("treats 404 as 'store does not have SHOPLINE Payments' and degrades", async () => {
    const res = await bestEffortLeg("payments", "reconcileai-dev", async () => {
      throw new ShoplineApiError(
        404,
        undefined,
        "trace-1",
        'SHOPLINE API 404 on /payments/store/transactions.json [trace:trace-1]: {"errors":"Resource not found: merchant"}',
      );
    });
    expect(res.unavailable).toBe(true);
    expect(res.data).toEqual([]);
  });

  it("degrades the payouts leg on 404 as well", async () => {
    const res = await bestEffortLeg("payouts", "reconcileai-dev", async () => {
      throw new ShoplineApiError(404, undefined, "trace-2", "SHOPLINE API 404 on /payments/store/payouts.json");
    });
    expect(res.unavailable).toBe(true);
    expect(res.data).toEqual([]);
  });

  // The important half: a genuine outage must NOT look like an empty leg.
  it.each([
    [401, "unauthorised"],
    [429, "rate limited"],
    [500, "server error"],
    [503, "unavailable"],
  ])("rethrows on %i (%s) rather than silently returning empty", async (status) => {
    await expect(
      bestEffortLeg("payments", "acme", async () => {
        throw new ShoplineApiError(status, undefined, "t", `SHOPLINE API ${status}`);
      }),
    ).rejects.toBeInstanceOf(ShoplineApiError);
  });

  it("rethrows non-API errors (network, bugs) untouched", async () => {
    await expect(
      bestEffortLeg("payments", "acme", async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toThrow("fetch failed");
  });
});
