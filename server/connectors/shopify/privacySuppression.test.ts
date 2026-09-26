import { describe, expect, it } from "vitest";
import {
  allShopifyOrderSuppressionDigests,
  computeShopifyOrderSuppressionDigest,
  shopifyPrivacySuppressionKeyRing,
} from "./privacySuppression";

const ORDER = "gid://shopify/Order/501";
const KEY_ONE = "11".repeat(32);
const KEY_TWO = "22".repeat(32);

describe("Shopify order-redaction suppression digests", () => {
  it("retains every valid key generation for rotation-safe tombstone checks", () => {
    const keys = shopifyPrivacySuppressionKeyRing(`v2:${KEY_TWO},v1:${KEY_ONE}`);
    const digests = allShopifyOrderSuppressionDigests(42, 7, ORDER, keys);
    expect(digests).toHaveLength(2);
    expect(digests.map((digest) => digest.keyVersion)).toEqual(["v2", "v1"]);
    expect(digests.map((digest) => digest.orderDigest)).toEqual([
      computeShopifyOrderSuppressionDigest(Buffer.from(KEY_TWO, "hex"), 42, 7, ORDER),
      computeShopifyOrderSuppressionDigest(Buffer.from(KEY_ONE, "hex"), 42, 7, ORDER),
    ]);
  });

  it("separates identical Shopify order GIDs by tenant and store without retaining a provider identifier", () => {
    const key = Buffer.from(KEY_ONE, "hex");
    const tenantA = computeShopifyOrderSuppressionDigest(key, 42, 7, ORDER);
    const tenantB = computeShopifyOrderSuppressionDigest(key, 84, 7, ORDER);
    const storeB = computeShopifyOrderSuppressionDigest(key, 42, 8, ORDER);
    expect(tenantA).not.toBe(tenantB);
    expect(tenantA).not.toBe(storeB);
    expect(tenantA).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantA).not.toContain("501");
  });

  it("fails closed on an empty, malformed, duplicate, or absent retained key ring", () => {
    expect(() => shopifyPrivacySuppressionKeyRing("")).toThrow(/unavailable/);
    expect(() => shopifyPrivacySuppressionKeyRing("v1:not-a-key")).toThrow(/invalid/);
    expect(() => shopifyPrivacySuppressionKeyRing(`v1:${KEY_ONE},v1:${KEY_TWO}`)).toThrow(/duplicate/);
    expect(() => allShopifyOrderSuppressionDigests(42, 7, ORDER, [])).toThrow(/unavailable/);
  });
});
