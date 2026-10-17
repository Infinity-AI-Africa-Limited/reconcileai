import { describe, expect, it } from "vitest";
import { SHOPIFY_APP_DISPLAY_NAME } from "./shopifyAppIdentity";

describe("when the Shopify-facing application identity is rendered", () => {
  it("should use ReconcileAI Dev Store as the application name", () => {
    expect(SHOPIFY_APP_DISPLAY_NAME).toBe("ReconcileAI Dev Store");
  });
});
