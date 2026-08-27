import { describe, expect, it } from "vitest";
import { reviewerChannelCodes, SHOPLINE_REVIEW_POC_KEY, reviewSyncStatus } from "./shoplineReview";

describe("SHOPLINE review workspace", () => {
  it("uses a dedicated, revocable POC access key", () => {
    expect(SHOPLINE_REVIEW_POC_KEY).toBe("shopline_review");
  });

  it("derives reconciliation evidence only from the Dev Store's canonical SHOPLINE channel pair", () => {
    expect(reviewerChannelCodes("reconcileai-dev")).toEqual([
      "sl_orders_reconcileai-dev",
      "sl_payments_reconcileai-dev",
    ]);
  });

  it("does not claim a current sync after OAuth was refreshed following a failed attempt", () => {
    const priorAttempt = new Date("2026-08-27T14:19:28.000Z");
    const reauthorized = new Date("2026-08-27T15:38:33.000Z");

    expect(reviewSyncStatus({
      lastSyncAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncAttemptAt: priorAttempt,
      lastSyncError: "prior failure",
      tokenRefreshedAt: reauthorized,
    })).toMatchObject({ code: "reauthorized_pending" });
  });

  it("shows attention rather than hiding a newer failed synchronisation", () => {
    expect(reviewSyncStatus({
      lastSyncAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncAttemptAt: new Date("2026-08-27T14:19:28.000Z"),
      lastSyncError: "prior failure",
      tokenRefreshedAt: null,
    })).toMatchObject({ code: "attention" });
  });
});
