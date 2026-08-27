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

  it("does not claim a current sync after a failed attempt, whatever the credential did", () => {
    // Kept from the original, with the assertion moved from "reauthorized_pending"
    // to "attention". The intent is unchanged and still holds: a failed attempt
    // must not be reported as health. What changed is the reason given for it.
    //
    // The old state claimed the store had been REAUTHORIZED, inferred from
    // slConnectorTokens.refreshedAt. That timestamp advances on every rotation,
    // and the connector rotates proactively at ~9h against a 10h TTL, so it
    // cannot distinguish a fresh OAuth grant from routine housekeeping. The
    // failure itself is the thing actually known, and "attention" says it.
    const priorAttempt = new Date("2026-08-27T14:19:28.000Z");

    expect(reviewSyncStatus({
      lastSyncAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncAttemptAt: priorAttempt,
      lastSyncError: "prior failure",
    })).toMatchObject({ code: "attention" });
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
  it("should report a healthy connection as current", () => {
    expect(reviewSyncStatus({
      lastSyncAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncAttemptAt: new Date("2026-08-27T13:40:30.000Z"),
      lastSyncError: null,
    })).toMatchObject({ code: "current" });
  });

  it("should report a never-synced connection as pending", () => {
    expect(reviewSyncStatus({
      lastSyncAt: null,
      lastSyncAttemptAt: null,
      lastSyncError: null,
    })).toMatchObject({ code: "pending" });
  });

  it("should take no credential timestamp as an input at all", () => {
    // The structural half. Two narrowings failed before the state was removed:
    // keying on "credential newer than the last attempt" flagged every healthy
    // store, and adding "and the last attempt failed" still flagged the routine
    // rotation that happens to follow a failure. Neither could work, because
    // refreshedAt advances on every rotation and nothing marks a real re-grant.
    // Reintroducing a token field is how the false alarm would come back.
    const ROUTER = fs.readFileSync(path.join(__dirname, "shoplineReview.ts"), "utf8");
    const inputs = ROUTER.slice(ROUTER.indexOf("type SyncInputs"), ROUTER.indexOf("export function reviewSyncStatus"));
    expect(inputs).not.toMatch(/token/i);
    expect(inputs).not.toMatch(/refreshedAt/);
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
    // The gate is the LATEST attempt succeeding, not a sync having succeeded
    // once. `lastSyncAt !== null` was too weak: a success followed by a cycle
    // that persists rows and then fails leaves the old timestamp in place, so
    // the gate stayed open and the aggregate swept in the newly unreconciled
    // rows — reporting them under a success that predates them.
    expect(ROUTER).toMatch(/canShowReconciliation = hasChannelPair && syncStatus\.code === "current"/);
    expect(ROUTER).not.toMatch(/hasCompletedSync/);
    // And the gate must be the one the response actually consults.
    expect(ROUTER).toMatch(/reconciliationEvidence: canShowReconciliation && recordCounts/);
    expect(ROUTER).not.toMatch(/reconciliationEvidence: hasChannelPair && recordCounts/);
  });

  it("should show the same health signal it gates on", () => {
    // One computation, used for both. Two rules could disagree, and the page
    // would then say "needs attention" beside figures implying all is well.
    expect(ROUTER).toMatch(/const syncStatus = reviewSyncStatus\(store\)/);
    expect(ROUTER).toMatch(/statusDetail: syncStatus,/);
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
