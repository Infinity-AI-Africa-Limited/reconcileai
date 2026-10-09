import { describe, expect, it } from "vitest";
import { SHOPIFY_INSTALL_ERROR_REASONS } from "@shared/shopifyInstall";
import { shopifyInstallErrorMessage } from "./shopifyConnection";

describe("when an install attempt comes back with a server reason", () => {
  it.each(SHOPIFY_INSTALL_ERROR_REASONS.map((reason) => [reason]))(
    "should explain the server reason %s specifically",
    (reason) => {
      const message = shopifyInstallErrorMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      if (reason !== "install_failed") expect(message).not.toBe(shopifyInstallErrorMessage("install_failed"));
    },
  );

  it("should read an unknown or missing reason as a generic failure", () => {
    const generic = shopifyInstallErrorMessage("install_failed");
    expect(shopifyInstallErrorMessage("made_up")).toBe(generic);
    expect(shopifyInstallErrorMessage(null)).toBe(generic);
    expect(shopifyInstallErrorMessage("toString")).toBe(generic); // not a prototype key
  });
});
