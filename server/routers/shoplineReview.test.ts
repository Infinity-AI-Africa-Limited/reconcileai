import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REVIEW_STORE_HANDLE, reviewerChannelCodes, SHOPLINE_REVIEW_POC_KEY, reviewSyncStatus } from "./shoplineReview";

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

describe("when the connector rotates a token during normal operation", () => {
  // tokenStore writes refreshedAt on EVERY rotation and the connector refreshes
  // proactively at ~9h against a 10h TTL, so on a healthy store the credential is
  // routinely newer than the last sync attempt. Treating that alone as
  // reauthorization labelled a working connection "verification pending" as a
  // matter of course — a fault reported to a reviewer that does not exist.
  it("should not report a healthy connection as awaiting verification", () => {
    expect(reviewSyncStatus({
      lastSyncAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncAttemptAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncError: null,
      tokenRefreshedAt: new Date("2026-08-27T22:40:30.000Z"), // routine 9h rotation
    })).toMatchObject({ code: "current" });
  });

  it("should still report pending verification when nothing has ever synced", () => {
    expect(reviewSyncStatus({
      lastSyncAt: null,
      lastSyncAttemptAt: null,
      lastSyncError: null,
      tokenRefreshedAt: new Date("2026-08-27T22:40:30.000Z"),
    })).toMatchObject({ code: "reauthorized_pending" });
  });
});

describe("when records exist but no sync has completed", () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, "shoplineReview.ts"), "utf8");

  it("should require a completed sync before presenting reconciliation evidence", () => {
    // Transactions can exist with no reconciliation behind them — the
    // settlement-file import writes rows without advancing lastSyncAt, and a
    // cycle can persist records then fail. Everything then sits at `unmatched`,
    // and showing that under "Reconciliation evidence" tells a reviewer the
    // engine ran and matched nothing, when it never finished.
    expect(ROUTER).toMatch(/const hasCompletedSync = store\.lastSyncAt !== null/);
    expect(ROUTER).toMatch(/canShowReconciliation = hasChannelPair && hasCompletedSync/);
    // And the gate must be the one the response actually consults.
    expect(ROUTER).toMatch(/reconciliationEvidence: canShowReconciliation && recordCounts/);
    expect(ROUTER).not.toMatch(/reconciliationEvidence: hasChannelPair && recordCounts/);
  });
});

describe("when the workspace picks which store to report on", () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, "shoplineReview.ts"), "utf8");

  it("should pin the canonical store by handle, not by recency", () => {
    // Two dev stores exist under the partner account — reconcileai-dev and the
    // secondary reconcileai (CLAUDE.md §2B.10B). "Newest active install in the
    // org" can therefore resolve to a different store than the one the page
    // titles itself after, and than the channels the counts are drawn from.
    expect(REVIEW_STORE_HANDLE).toBe("reconcileai-dev");
    expect(ROUTER).toMatch(/eq\(slConnectorStores\.storeHandle, REVIEW_STORE_HANDLE\)/);
  });

  it("should derive the evidence channels from that same store", () => {
    // The handle drives reviewerChannelCodes, so pinning it keeps the
    // connection, the channels and the counts describing ONE store.
    expect(reviewerChannelCodes(REVIEW_STORE_HANDLE)).toEqual([
      "sl_orders_reconcileai-dev",
      "sl_payments_reconcileai-dev",
    ]);
  });

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
