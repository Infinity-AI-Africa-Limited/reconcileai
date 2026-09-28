import { describe, expect, it } from "vitest";
import {
  canRequestShopifySync,
  SHOPIFY_SYNC_POLL_MS,
  SHOPIFY_SYNC_STALL_MS,
  SHOPIFY_SYNC_STALLED_POLL_MS,
  shopifySyncPollIntervalMs,
  shopifySyncProgress,
  type ShopifySyncCursorView,
  withLatestRequest,
} from "./shopifyOrderSyncProgress";

const REQUESTED = "2026-09-28T10:00:00.000Z";
const NOW = new Date("2026-09-28T10:05:00.000Z");

function cursor(overrides: Partial<ShopifySyncCursorView> = {}): ShopifySyncCursorView {
  return {
    lastSuccessfulAt: null,
    lastErrorCode: null,
    requestedAt: null,
    answeredAt: null,
    syncedThrough: null,
    ...overrides,
  };
}

describe("when a sync has been requested and not yet answered", () => {
  it("should be pending, and keep the page polling", () => {
    const progress = shopifySyncProgress(
      cursor({ requestedAt: REQUESTED, lastSuccessfulAt: "2026-09-27T10:00:00.000Z", syncedThrough: "2026-09-27T10:00:00.000Z" }),
      NOW,
    );
    expect(progress).toBe("pending");
    expect(shopifySyncPollIntervalMs(progress)).toBe(SHOPIFY_SYNC_POLL_MS);
    expect(canRequestShopifySync(progress, false)).toBe(false);
  });

  it("should stay pending when a webhook sync that began before the request finishes after it", () => {
    // Its success is recorded after the request, but it only covered orders up
    // to when IT began — the request is not answered by it.
    expect(
      shopifySyncProgress(
        cursor({
          requestedAt: REQUESTED,
          lastSuccessfulAt: "2026-09-28T10:02:00.000Z",
          syncedThrough: "2026-09-28T09:59:00.000Z",
        }),
        NOW,
      ),
    ).toBe("pending");
  });

  it("should stay pending when another sync's failure is recorded after the request", () => {
    expect(
      shopifySyncProgress(cursor({ requestedAt: REQUESTED, lastErrorCode: "pagination_error" }), NOW),
    ).toBe("pending");
  });

  it("should call it stalled once it has waited longer than any sync should take, still checking but slowly", () => {
    const later = new Date(Date.parse(REQUESTED) + SHOPIFY_SYNC_STALL_MS + 1);
    const progress = shopifySyncProgress(cursor({ requestedAt: REQUESTED }), later);
    expect(progress).toBe("stalled");
    // A slow run can still finish; the page must see it when it does.
    expect(shopifySyncPollIntervalMs(progress)).toBe(SHOPIFY_SYNC_STALLED_POLL_MS);
    expect(canRequestShopifySync(progress, false)).toBe(true);
  });
});

describe("when the request has been answered", () => {
  it("should be current once orders are synced through the request, whichever sync did it", () => {
    expect(
      shopifySyncProgress(
        cursor({ requestedAt: REQUESTED, syncedThrough: REQUESTED, lastSuccessfulAt: "2026-09-28T10:03:00.000Z" }),
        NOW,
      ),
    ).toBe("current");
  });

  it("should be current in the same second the request was made — times are whole seconds", () => {
    expect(
      shopifySyncProgress(
        cursor({ requestedAt: REQUESTED, answeredAt: REQUESTED, lastSuccessfulAt: REQUESTED, syncedThrough: REQUESTED }),
        NOW,
      ),
    ).toBe("current");
  });

  it("should be failed when the manual run for it failed, and let the merchant ask again", () => {
    const progress = shopifySyncProgress(
      cursor({ requestedAt: REQUESTED, answeredAt: REQUESTED, lastErrorCode: "pagination_error" }),
      NOW,
    );
    expect(progress).toBe("failed");
    expect(shopifySyncPollIntervalMs(progress)).toBeNull();
    expect(canRequestShopifySync(progress, false)).toBe(true);
  });
});

describe("when no manual sync is outstanding", () => {
  it("should report the latest outcome, whatever triggered it", () => {
    expect(shopifySyncProgress(cursor({ lastSuccessfulAt: "2026-09-28T09:00:00.000Z" }), NOW)).toBe("current");
    expect(shopifySyncProgress(cursor({ lastErrorCode: "sync_failed" }), NOW)).toBe("failed");
    expect(shopifySyncProgress(cursor(), NOW)).toBe("never");
  });

  it("should not allow a second request while one is being sent", () => {
    expect(canRequestShopifySync("current", true)).toBe(false);
  });
});

describe("when the page made a request the loaded cursor does not show yet", () => {
  it("should follow the page's own request, so polling starts even if the reload after it failed", () => {
    const stale = cursor({ lastSuccessfulAt: "2026-09-28T09:00:00.000Z", syncedThrough: "2026-09-28T09:00:00.000Z" });
    expect(shopifySyncProgress(withLatestRequest(stale, REQUESTED), NOW)).toBe("pending");
  });

  it("should keep the server's record when it is the newer of the two", () => {
    const newer = cursor({ requestedAt: "2026-09-28T10:04:00.000Z" });
    expect(withLatestRequest(newer, REQUESTED)).toBe(newer);
    expect(withLatestRequest(newer, null)).toBe(newer);
  });
});
