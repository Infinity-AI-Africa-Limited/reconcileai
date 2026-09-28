import { describe, expect, it } from "vitest";
import {
  canRequestShopifySync,
  SHOPIFY_SYNC_POLL_MS,
  SHOPIFY_SYNC_STALL_MS,
  SHOPIFY_SYNC_STALLED_POLL_MS,
  shopifySyncPollIntervalMs,
  shopifySyncProgress,
  type ShopifySyncView,
  withOwnRequest,
} from "./shopifyOrderSyncProgress";

const REQUESTED = "2026-09-28T10:00:00.000Z";
const NOW = new Date("2026-09-28T10:05:00.000Z");
const T1 = "2026-09-28T10:01:00.000Z";
const T2 = "2026-09-28T10:02:00.000Z";

function view(overrides: Partial<ShopifySyncView> = {}): ShopifySyncView {
  return {
    lastSuccessfulAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    latestRequest: null,
    pendingSince: null,
    ...overrides,
  };
}

const queued = { status: "queued" as const, answeredAt: null };
const succeededAt = (answeredAt: string) => ({ status: "succeeded" as const, answeredAt });
const failedAt = (answeredAt: string) => ({ status: "failed" as const, answeredAt });

describe("when a manual sync request is still queued", () => {
  it("should be pending, and keep the page polling", () => {
    const progress = shopifySyncProgress(view({ pendingSince: REQUESTED, latestRequest: queued, lastSuccessfulAt: T1 }), NOW);
    expect(progress).toBe("pending");
    expect(shopifySyncPollIntervalMs(progress)).toBe(SHOPIFY_SYNC_POLL_MS);
    expect(canRequestShopifySync(progress, false)).toBe(false);
  });

  it("should stay pending whatever other syncs record meanwhile", () => {
    expect(shopifySyncProgress(view({ pendingSince: REQUESTED, lastSuccessfulAt: T2 }), NOW)).toBe("pending");
    expect(shopifySyncProgress(view({ pendingSince: REQUESTED, lastErrorCode: "x", lastErrorAt: T2 }), NOW)).toBe("pending");
  });

  it("should stay pending while an earlier request is queued, even if a later one was refused", () => {
    // The refused request is the newest, and failed; the earlier one is still running.
    expect(shopifySyncProgress(view({ pendingSince: REQUESTED, latestRequest: failedAt(T1) }), NOW)).toBe("pending");
  });

  it("should call it stalled once it has waited longer than any sync should take, still checking but slowly", () => {
    const later = new Date(Date.parse(REQUESTED) + SHOPIFY_SYNC_STALL_MS + 1);
    const progress = shopifySyncProgress(view({ pendingSince: REQUESTED, latestRequest: queued }), later);
    expect(progress).toBe("stalled");
    // A slow run can still finish; the page must see it when it does.
    expect(shopifySyncPollIntervalMs(progress)).toBe(SHOPIFY_SYNC_STALLED_POLL_MS);
    expect(canRequestShopifySync(progress, false)).toBe(true);
  });
});

describe("when nothing is queued", () => {
  it("should report a settled request's outcome when it is the most recent", () => {
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T1, latestRequest: succeededAt(T1) }), NOW)).toBe("current");
    const failed = shopifySyncProgress(view({ lastSuccessfulAt: T1, latestRequest: failedAt(T2) }), NOW);
    expect(failed).toBe("failed");
    expect(shopifySyncPollIntervalMs(failed)).toBeNull();
    expect(canRequestShopifySync(failed, false)).toBe(true);
  });

  it("should keep a failed request failed when a webhook sync succeeded between the failure and its settling", () => {
    // The webhook success cleared the cursor's code at T1; the request was
    // settled failed at T2, so its failure is the latest outcome.
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T1, latestRequest: failedAt(T2) }), NOW)).toBe("failed");
  });

  it("should report a sync that succeeded after a failed request as current", () => {
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T2, latestRequest: failedAt(T1) }), NOW)).toBe("current");
  });

  it("should report a sync that failed after a successful request as failed", () => {
    expect(
      shopifySyncProgress(view({ lastSuccessfulAt: T1, lastErrorCode: "x", lastErrorAt: T2, latestRequest: succeededAt(T1) }), NOW),
    ).toBe("failed");
  });

  it("should call a tie failed — whole seconds cannot order it, and a false failure is fixed by asking again", () => {
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T1, latestRequest: failedAt(T1) }), NOW)).toBe("failed");
    expect(shopifySyncProgress(view({ lastErrorCode: "x", lastErrorAt: T1, latestRequest: succeededAt(T1) }), NOW)).toBe("failed");
  });

  it("should treat an error recorded without a time as no older than the last success", () => {
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T1, lastErrorCode: "x" }), NOW)).toBe("failed");
  });

  it("should report the latest sync, whatever triggered it, when no request was ever made", () => {
    expect(shopifySyncProgress(view({ lastSuccessfulAt: T1 }), NOW)).toBe("current");
    expect(shopifySyncProgress(view({ lastErrorCode: "sync_failed", lastErrorAt: T1 }), NOW)).toBe("failed");
    expect(shopifySyncProgress(view(), NOW)).toBe("never");
  });

  it("should not allow a second request while one is being sent", () => {
    expect(canRequestShopifySync("current", true)).toBe(false);
  });
});

describe("when the page made a request the view on screen does not show yet", () => {
  const onScreen = view({ lastSuccessfulAt: T1, latestRequest: succeededAt(T1) });

  it("should follow the page's own request until a later view loads, so polling starts even if the reload failed", () => {
    const judged = withOwnRequest(onScreen, { requestedAt: REQUESTED, loadedSince: false });
    expect(shopifySyncProgress(judged, NOW)).toBe("pending");
  });

  it("should let the server's record decide once a view loaded after the request", () => {
    expect(withOwnRequest(onScreen, { requestedAt: REQUESTED, loadedSince: true })).toBe(onScreen);
    expect(withOwnRequest(onScreen, null)).toBe(onScreen);
  });

  it("should keep the server's pending record when it is at least as recent", () => {
    const newer = view({ pendingSince: T1 });
    expect(withOwnRequest(newer, { requestedAt: REQUESTED, loadedSince: false })).toBe(newer);
  });
});
