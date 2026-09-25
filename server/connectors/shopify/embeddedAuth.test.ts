import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { authenticateShopifyEmbeddedRequest, ShopifyEmbeddedAuthError } from "./embeddedAuth";
import { scriptedDb } from "./scriptedDb.testkit";

const CLIENT_ID = "shopify-client-id";
const CLIENT_SECRET = "shopify-client-secret";
const SHOP = "merchant.myshopify.com";
const NOW = new Date("2026-09-25T08:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const STORES = "shopify_connector_stores";

const activeStore = {
  storeId: 7,
  organizationId: 42,
  shopDomain: SHOP,
  displayName: "Merchant Store",
  currency: "USD",
};

async function idToken(overrides: {
  audience?: string | string[];
  destination?: string;
  issuer?: string;
  expiration?: number;
  notBefore?: number;
} = {}): Promise<string> {
  return new SignJWT({
    dest: overrides.destination ?? `https://${SHOP}`,
    sid: "session-id",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(overrides.issuer ?? `https://${SHOP}/admin`)
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setSubject("gid://shopify/User/123")
    .setJti("token-id")
    .setIssuedAt(NOW_SECONDS - 5)
    .setNotBefore(overrides.notBefore ?? NOW_SECONDS - 5)
    .setExpirationTime(overrides.expiration ?? NOW_SECONDS + 60)
    .sign(new TextEncoder().encode(CLIENT_SECRET));
}

function auth(token: string, db = scriptedDb({ select: { [STORES]: [[activeStore]] } })) {
  return {
    result: authenticateShopifyEmbeddedRequest(`Bearer ${token}`, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      getDatabase: async () => db.db as never,
      currentDate: NOW,
    }),
    db,
  };
}

async function expectCode(promise: Promise<unknown>, code: ShopifyEmbeddedAuthError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "ShopifyEmbeddedAuthError", code });
}

describe("Shopify embedded App Home authentication", () => {
  it("accepts a valid HS256 ID token and returns only the active store's minimal context", async () => {
    const { result, db } = auth(await idToken());

    await expect(result).resolves.toEqual(activeStore);
    const lookup = db.ops.find((op) => op.kind === "select" && op.table === STORES);
    expect(lookup?.where?.params).toEqual([SHOP, "active"]);
  });

  it("rejects malformed and expired tokens before any store lookup", async () => {
    const malformed = auth("not-a-jwt");
    await expectCode(malformed.result, "TOKEN_INVALID");
    expect(malformed.db.ops).toEqual([]);

    const expired = auth(await idToken({ expiration: NOW_SECONDS - 1 }));
    await expectCode(expired.result, "TOKEN_EXPIRED");
    expect(expired.db.ops).toEqual([]);

    const notActive = auth(await idToken({ notBefore: NOW_SECONDS + 30 }));
    await expectCode(notActive.result, "TOKEN_NOT_ACTIVE");
    expect(notActive.db.ops).toEqual([]);
  });

  it("requires the audience to be exactly the configured client id", async () => {
    const wrong = auth(await idToken({ audience: "another-client" }));
    await expectCode(wrong.result, "AUDIENCE_INVALID");
    expect(wrong.db.ops).toEqual([]);

    const ambiguous = auth(await idToken({ audience: [CLIENT_ID, "another-client"] }));
    await expectCode(ambiguous.result, "AUDIENCE_INVALID");
    expect(ambiguous.db.ops).toEqual([]);
  });

  it("rejects a destination/issuer shop mismatch and a non-/admin issuer", async () => {
    const mismatch = auth(await idToken({ issuer: "https://other.myshopify.com/admin" }));
    await expectCode(mismatch.result, "SHOP_MISMATCH");
    expect(mismatch.db.ops).toEqual([]);

    const wrongPath = auth(await idToken({ issuer: `https://${SHOP}/admin/oauth` }));
    await expectCode(wrongPath.result, "CLAIMS_INVALID");
    expect(wrongPath.db.ops).toEqual([]);
  });

  it("rejects a signed token whose exact normalized shop has no active store", async () => {
    const db = scriptedDb({ select: { [STORES]: [[]] } });
    const attempt = auth(await idToken(), db);
    await expectCode(attempt.result, "STORE_UNAVAILABLE");
    expect(db.ops[0]?.where?.params).toEqual([SHOP, "active"]);
  });

  it("fails closed when either required Shopify credential is absent", async () => {
    await expectCode(
      authenticateShopifyEmbeddedRequest(`Bearer ${await idToken()}`, {
        clientId: "",
        clientSecret: CLIENT_SECRET,
        getDatabase: async () => scriptedDb().db as never,
      }),
      "CONFIG_UNAVAILABLE",
    );
  });
});
