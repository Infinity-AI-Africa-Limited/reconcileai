import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildShopifyAuthorizationUrl,
  normalizeShopDomain,
  requiredScopesGranted,
  verifyShopifyCallbackHmac,
  verifyShopifyWebhookHmac,
} from "./auth";

describe("Shopify connector security helpers", () => {
  it("accepts only canonical myshopify.com store hostnames", () => {
    expect(normalizeShopDomain("My-Test-Shop.MYSHOPIFY.COM.")).toBe("my-test-shop.myshopify.com");
    expect(normalizeShopDomain("https://shop.myshopify.com")).toBeNull();
    expect(normalizeShopDomain("shop.myshopify.com.evil.example")).toBeNull();
    expect(normalizeShopDomain("shop.myshopify.com:443")).toBeNull();
  });

  it("builds an authorization URL with only the requested read scope", () => {
    const url = new URL(
      buildShopifyAuthorizationUrl({
        shopDomain: "merchant.myshopify.com",
        clientId: "client-id",
        redirectUri: "https://www.reconcileaiafrica.com/api/shopify/callback",
        scopes: ["read_orders"],
        state: "high-entropy-state",
      }),
    );
    expect(url.origin).toBe("https://merchant.myshopify.com");
    expect(url.searchParams.get("scope")).toBe("read_orders");
    expect(url.searchParams.get("state")).toBe("high-entropy-state");
  });

  it("verifies the exact OAuth callback HMAC and rejects altered parameters", () => {
    const secret = "shopify-secret";
    const params: Record<string, string> = {
      code: "authorization-code",
      shop: "merchant.myshopify.com",
      state: "state-value",
      timestamp: "1789940000",
    };
    const message = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    params.hmac = crypto.createHmac("sha256", secret).update(message).digest("hex");
    expect(verifyShopifyCallbackHmac(params, secret)).toBe(true);
    expect(verifyShopifyCallbackHmac({ ...params, shop: "attacker.myshopify.com" }, secret)).toBe(false);
  });

  it("verifies raw webhook bytes rather than reserialized JSON", () => {
    const raw = Buffer.from('{"shop_id":7,"customer":{"email":"not-stored@example.com"}}');
    const secret = "shopify-webhook-secret";
    const hmac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyShopifyWebhookHmac(raw, hmac, secret)).toBe(true);
    expect(verifyShopifyWebhookHmac(Buffer.from('{"shop_id":7}'), hmac, secret)).toBe(false);
  });

  it("requires the planned read scope and permits Shopify's write superscope", () => {
    expect(requiredScopesGranted("read_orders", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("write_orders,read_products", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("read_products", ["read_orders"])).toBe(false);
  });
});
