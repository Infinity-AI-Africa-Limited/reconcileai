import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHOPIFY_APP_DISPLAY_NAME } from "./shopifyAppIdentity";

describe("when the Shopify-facing application identity is rendered", () => {
  it("should be the name the Shopify app configuration declares, which Shopify Admin shows the merchant", () => {
    // The app's name lives in shopify.app.toml and reaches Shopify through the
    // CLI release. App Home must say what Admin says, so a rename in either
    // place fails here until the other follows.
    const toml = fs.readFileSync(path.resolve(__dirname, "../../../shopify.app.toml"), "utf8");
    const declared = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    expect(declared, "shopify.app.toml must declare the app's name").toBeDefined();
    expect(SHOPIFY_APP_DISPLAY_NAME).toBe(declared);
  });
});
