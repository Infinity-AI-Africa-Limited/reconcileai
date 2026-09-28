import { describe, expect, it } from "vitest";
import {
  canRequestShopifySync,
  SHOPIFY_SYNC_STALL_MS,
  shopifySyncProgress,
  shouldPollShopifySync,
  type ShopifySyncCursorView,
  withLatestRequest,
} from "./shopifyOrderSyncProgress";

const REQUESTED = "2026-09-28T10:00:00.000Z";
const NOW = new Date("2026-09-28T10:05:00.000Z");

function cursor(overrides: Partial<ShopifySyncCursorView> = {}): ShopifySyncCursorView {
  return { lastSuccessfulAt: null, lastErrorCode: null, lastErrorAt: null, requestedAt: null, ...overrides };
}

describe("when a sync has been requested and nothing has been recorded since", () => {
  it("should be pending, and keep the page polling", () => {
    const progress = shopifySyncProgress(
      cursor({ requestedAt: REQUESTED, lastSuccessfulAt: "2026-09-27T10:00:00.000Z" }),
      NOW,
    );
    expect(progress).toBe("pending");
    expect(shouldPollShopifySync(progress)).toBe(true);
    expect(canRequestShopifySync(progress, false)).toBe(false);
  });

  it("should not let an error left over from an earlier run read as this request's outcome", () => {
    expect(
      shopifySyncProgress(
        cursor({ requestedAt: REQUESTED, lastErrorCode: "pagination_error", lastErrorAt: "2026-09-27T09:00:00.000Z" }),
        NOW,
      ),
    ).toBe("pending");
  });

  it("should call it stalled once it has been pending longer than any sync should take, and allow asking again", () => {
    const later = new Date(Date.parse(REQUESTED) + SHOPIFY_SYNC_STALL_MS + 1);
    const progress = shopifySyncProgress(cursor({ requestedAt: REQUESTED }), later);
    expect(progress).toBe("stalled");
    expect(shouldPollShopifySync(progress)).toBe(false);
    expect(canRequestShopifySync(progress, false)).toBe(true);
  });
});

describe("when an outcome has been recorded since the request", () => {
  it("should be current after a success", () => {
    expect(
      shopifySyncProgress(cursor({ requestedAt: REQUESTED, lastSuccessfulAt: "2026-09-28T10:03:00.000Z" }), NOW),
    ).toBe("current");
  });

  it("should be failed after a failure, and let the merchant ask again", () => {
    const progress = shopifySyncProgress(
      cursor({ requestedAt: REQUESTED, lastErrorCode: "pagination_error", lastErrorAt: "2026-09-28T10:03:00.000Z" }),
      NOW,
    );
    expect(progress).toBe("failed");
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
    const stale = cursor({ lastSuccessfulAt: "2026-09-28T09:00:00.000Z" });
    expect(shopifySyncProgress(withLatestRequest(stale, REQUESTED), NOW)).toBe("pending");
  });

  it("should keep the server's record when it is the newer of the two", () => {
    const newer = cursor({ requestedAt: "2026-09-28T10:04:00.000Z" });
    expect(withLatestRequest(newer, REQUESTED)).toBe(newer);
    expect(withLatestRequest(newer, null)).toBe(newer);
  });
});
