import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildShopifyAuthorizationUrl,
  normalizeShopDomain,
  requiredScopesGranted,
  signOAuthState,
  verifyOAuthState,
  verifyShopifyCallbackHmac,
  verifyShopifyWebhookHmac,
} from "./auth";

describe("when the state carried through an install is signed and read back", () => {
  const SECRET = "client-secret";
  const TTL = 10 * 60_000;
  const NOW = 1_790_000_000_000;
  const SHOP = "merchant.myshopify.com";
  const issue = () => signOAuthState({ shopDomain: SHOP, secret: SECRET, ttlMs: TTL, now: NOW });
  const check = (state: string, over: Partial<{ shopDomain: string; secret: string; now: number }> = {}) =>
    verifyOAuthState(state, { shopDomain: SHOP, secret: SECRET, ttlMs: TTL, now: NOW + 1_000, ...over });

  it("should verify a state it issued, for the same shop, returning its expiry", () => {
    const { state, expiresAt } = issue();
    expect(check(state)?.getTime()).toBe(expiresAt.getTime());
  });

  it("should refuse the state for a different shop", () => {
    expect(check(issue().state, { shopDomain: "attacker.myshopify.com" })).toBeNull();
  });

  it("should refuse it once expired", () => {
    expect(check(issue().state, { now: NOW + TTL })).toBeNull();
  });

  it("should refuse a state signed with another secret", () => {
    expect(check(issue().state, { secret: "someone-else" })).toBeNull();
  });

  it("should refuse a state whose expiry was extended after signing", () => {
    const [, nonce, mac] = issue().state.split(".");
    expect(check(`${NOW + TTL + 60_000}.${nonce}.${mac}`)).toBeNull();
  });

  it("should refuse a validly-signed state that claims to live longer than one TTL", () => {
    // Not forgeable without the secret, but a state is never legitimately
    // longer-lived than the TTL it was issued with, so none is accepted as one.
    const longLived = signOAuthState({ shopDomain: SHOP, secret: SECRET, ttlMs: TTL * 10, now: NOW });
    expect(check(longLived.state)).toBeNull();
  });

  it.each(["", "a.b", "1.2.3.4", "notanumber.nonce-nonce-nonce-nonce.mac", `${NOW + 1000}.short.mac`])(
    "should refuse the malformed state %j",
    (state) => {
      expect(check(state)).toBeNull();
    },
  );

  it("should issue a fresh nonce every time", () => {
    expect(issue().state).not.toBe(issue().state);
  });
});

describe("when a shop domain, callback signature or granted scope is checked", () => {
  it("should accept only canonical myshopify.com store hostnames", () => {
    expect(normalizeShopDomain("My-Test-Shop.MYSHOPIFY.COM.")).toBe("my-test-shop.myshopify.com");
    expect(normalizeShopDomain("https://shop.myshopify.com")).toBeNull();
    expect(normalizeShopDomain("shop.myshopify.com.evil.example")).toBeNull();
    expect(normalizeShopDomain("shop.myshopify.com:443")).toBeNull();
  });

  it("should build an authorization URL with only the requested read scope", () => {
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

  it("should verify the exact OAuth callback HMAC and reject altered parameters", () => {
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

  it("should sort callback parameters in code-unit order, as Shopify's reference does", () => {
    // "Z" (0x5A) sorts before "a" (0x61) by code unit, but after it under locale
    // collation. Shopify signs with `Object.entries(params).sort()`.
    const secret = "shopify-secret";
    const params: Record<string, string> = { a: "1", Z: "2", shop: "merchant.myshopify.com" };
    expect(["a", "Z"].sort()).toEqual(["Z", "a"]);
    expect("a".localeCompare("Z")).toBeLessThan(0); // the two orders genuinely disagree
    const codeUnitMessage = "Z=2&a=1&shop=merchant.myshopify.com";
    const hmac = crypto.createHmac("sha256", secret).update(codeUnitMessage).digest("hex");
    expect(verifyShopifyCallbackHmac({ ...params, hmac }, secret)).toBe(true);
  });

  it("should verify raw webhook bytes rather than reserialized JSON", () => {
    const raw = Buffer.from('{"shop_id":7,"customer":{"email":"not-stored@example.com"}}');
    const secret = "shopify-webhook-secret";
    const hmac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyShopifyWebhookHmac(raw, hmac, secret)).toBe(true);
    expect(verifyShopifyWebhookHmac(Buffer.from('{"shop_id":7}'), hmac, secret)).toBe(false);
  });

  it("should require the planned read scope and permit Shopify's write superscope", () => {
    expect(requiredScopesGranted("read_orders", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("write_orders,read_products", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("read_products", ["read_orders"])).toBe(false);
  });
});
