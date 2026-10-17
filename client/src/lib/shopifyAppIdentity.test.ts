import { describe, expect, it } from "vitest";
import { SHOPIFY_APP_DISPLAY_NAME } from "./shopifyAppIdentity";

describe("Shopify App Store identity", () => {
  it("uses ReconcileAI Dev Store as the Shopify-facing application name", () => {
    expect(SHOPIFY_APP_DISPLAY_NAME).toBe("ReconcileAI Dev Store");
  });
});
