import { describe, expect, it } from "vitest";
import { SHOPIFY_INSTALL_ERROR_REASONS } from "@shared/shopifyInstall";
import {
  SHOPIFY_CONNECTION_MESSAGES,
  shopifyConnectionVerdict,
  shopifyInstallErrorMessage,
  type ShopifyStoreStatus,
} from "./shopifyConnection";

describe("shopifyConnectionVerdict", () => {
  it("should say it is checking while the store list loads, whatever it held before", () => {
    expect(shopifyConnectionVerdict({ isLoading: true, status: "active" })).toBe("checking");
  });

  it("should call only an active store connected", () => {
    expect(shopifyConnectionVerdict({ isLoading: false, status: "active" })).toBe("connected");
  });

  it.each<ShopifyStoreStatus>(["reauthorization_required", "uninstalled"])(
    "should call a %s store not connected — never 'being confirmed'",
    (status) => {
      // A store taken out of service is not going to come back by waiting;
      // telling the merchant to refresh would be a false promise.
      expect(shopifyConnectionVerdict({ isLoading: false, status })).toBe("not_connected");
    },
  );

  it.each([["pending_claim"], [null], [undefined]] as const)(
    "should still be confirming a store that is %s",
    (status) => {
      expect(shopifyConnectionVerdict({ isLoading: false, status })).toBe("confirming");
    },
  );

  it("should have copy for every verdict", () => {
    for (const message of Object.values(SHOPIFY_CONNECTION_MESSAGES)) expect(message.length).toBeGreaterThan(20);
  });
});

describe("shopifyInstallErrorMessage", () => {
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
