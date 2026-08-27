import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

describe("when the workspace picks which store to report on", () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, "shoplineReview.ts"), "utf8");

  it("should order before limiting", () => {
    // `limit(1)` alone takes whatever row the engine returns first, which is not
    // a defined choice. A second active install under the review org would make
    // this page alternate between two stores' figures across refreshes, with
    // nothing on screen to say so — a reviewer reading numbers that change for
    // no visible reason.
    const storeQuery = ROUTER.slice(
      ROUTER.indexOf(".from(slConnectorStores)"),
      ROUTER.indexOf(".limit(1)", ROUTER.indexOf(".from(slConnectorStores)")),
    );
    expect(storeQuery).toMatch(/orderBy\(desc\(slConnectorStores\.installedAt\)\)/);
  });
});
