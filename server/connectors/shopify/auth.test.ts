import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildShopifyAuthorizationUrl,
  normalizeShopDomain,
  refreshExpiringOfflineToken,
  requiredScopesGranted,
  signOAuthState,
  shopifyWebhookPayloadDigest,
  verifyOAuthState,
  shopifyAdminHmacMessage,
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

  it("should accept Shopify's own signed fixture, whose values are URL-encoded before signing", () => {
    // Verbatim from @shopify/shopify-api lib/utils/__tests__/hmac-validator.test.ts.
    const secret = "my super secret key";
    const params: Record<string, string> = {
      code: "some code goes here",
      shop: "the shop URL",
      state: "some nonce passed from auth",
      timestamp: "1789940000",
    };
    const signed = "code=some%20code%20goes%20here&shop=the%20shop%20URL&state=some%20nonce%20passed%20from%20auth&timestamp=1789940000";
    expect(shopifyAdminHmacMessage(params)).toBe(signed);
    const hmac = crypto.createHmac("sha256", secret).update(signed).digest("hex");
    expect(verifyShopifyCallbackHmac({ ...params, hmac }, secret)).toBe(true);
  });

  it("should accept a genuine callback whose base64 host carries padding and a slash", () => {
    // `host` is base64("admin.shopify.com/store/<handle>"); for most handles it
    // ends in "=", and Express hands it over decoded. Joined raw it signs
    // differently from the URL-encoded form Shopify signs.
    const secret = "shopify-secret";
    const host = Buffer.from("admin.shopify.com/store/abcd").toString("base64");
    expect(host).toMatch(/=$/);
    const params: Record<string, string> = {
      code: "0907a61c0c8d55e99db179b68161bc00",
      host,
      shop: "abcd.myshopify.com",
      state: "1789940000000.nonce_nonce_nonce.mac",
      timestamp: "1789940000",
    };
    const signed =
      `code=0907a61c0c8d55e99db179b68161bc00&host=${encodeURIComponent(host)}` +
      "&shop=abcd.myshopify.com&state=1789940000000.nonce_nonce_nonce.mac&timestamp=1789940000";
    expect(signed).toContain("%3D");
    const hmac = crypto.createHmac("sha256", secret).update(signed).digest("hex");
    expect(verifyShopifyCallbackHmac({ ...params, hmac }, secret)).toBe(true);

    const rawJoin = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
    const rawHmac = crypto.createHmac("sha256", secret).update(rawJoin).digest("hex");
    expect(verifyShopifyCallbackHmac({ ...params, hmac: rawHmac }, secret)).toBe(false);
  });

  it("should leave out a signature parameter, as Shopify does for Admin requests", () => {
    expect(shopifyAdminHmacMessage({ shop: "a.myshopify.com", hmac: "x", signature: "y", code: "c" })).toBe(
      "code=c&shop=a.myshopify.com",
    );
  });

  it("should verify raw webhook bytes rather than reserialized JSON", () => {
    const raw = Buffer.from('{"shop_id":7,"customer":{"email":"not-stored@example.com"}}');
    const secret = "shopify-webhook-secret";
    const hmac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    expect(verifyShopifyWebhookHmac(raw, hmac, secret)).toBe(true);
    expect(verifyShopifyWebhookHmac(Buffer.from('{"shop_id":7}'), hmac, secret)).toBe(false);
  });

  it("should create a domain-separated keyed digest for durable webhook replay control", () => {
    const raw = Buffer.from('{"shop_id":7,"customer":{"id":41}}');
    const key = "ab".repeat(32);
    const digest = shopifyWebhookPayloadDigest(raw, key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(digest).not.toBe(shopifyWebhookPayloadDigest(raw, "cd".repeat(32)));
    expect(() => shopifyWebhookPayloadDigest(raw, "not-a-valid-key")).toThrow(/digest key/i);
  });

  it("should require the planned read scope and permit Shopify's write superscope", () => {
    expect(requiredScopesGranted("read_orders", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("write_orders,read_products", ["read_orders"])).toBe(true);
    expect(requiredScopesGranted("read_products", ["read_orders"])).toBe(false);
  });
});

describe("when Shopify answers a refresh-token request", () => {
  const params = { shopDomain: "merchant.myshopify.com", clientId: "id", clientSecret: "secret", refreshToken: "rt" };
  const answer = (status: number, body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );

  afterEach(() => vi.restoreAllMocks());

  it("should ask for reauthorization when the refresh token itself is rejected — 401, or 400 naming the token", async () => {
    answer(401, {});
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "reauthorize" });
    // Shopify's own library tests model an expired or revoked refresh token so.
    answer(400, { error: "invalid_subject_token" });
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "reauthorize" });
    // RFC 6749 §5.2's generic name for the same thing.
    answer(400, { error: "invalid_grant", error_description: "expired" });
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "reauthorize" });
  });

  it("should not take a store out of service over any other 400, which may be a fault of ours", async () => {
    answer(400, { error: "invalid_request" });
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "failed" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad request</html>", { status: 400 }));
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "failed" });
  });

  it("should retry a throttle or a server error", async () => {
    answer(429, {});
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "retry" });
    answer(503, {});
    expect(await refreshExpiringOfflineToken(params)).toEqual({ kind: "retry" });
  });
});
