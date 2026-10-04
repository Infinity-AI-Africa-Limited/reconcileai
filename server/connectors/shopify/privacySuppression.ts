import crypto from "node:crypto";
import { ENV } from "../../_core/env";

export interface ShopifyPrivacySuppressionKey {
  version: string;
  key: Buffer;
}

/**
 * Parse the retained privacy-suppression key ring. The first key is active for
 * new tombstones; every retained key is used for reads. Missing/malformed key
 * material throws so sync and redaction fail closed rather than re-importing an
 * order whose historical tombstone cannot be verified.
 */
export function shopifyPrivacySuppressionKeyRing(
  configured = ENV.shopifyPrivacySuppressionKeys,
): ShopifyPrivacySuppressionKey[] {
  if (!configured) throw new Error("shopify_privacy_suppression_key_unavailable");
  const versions = new Set<string>();
  const keys = configured.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const version = separator > 0 ? entry.slice(0, separator).trim() : "";
    const hex = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(version) || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("shopify_privacy_suppression_key_invalid");
    }
    if (versions.has(version)) throw new Error("shopify_privacy_suppression_key_duplicate");
    versions.add(version);
    return { version, key: Buffer.from(hex, "hex") };
  });
  if (keys.length === 0) throw new Error("shopify_privacy_suppression_key_unavailable");
  return keys;
}

/** Digest input is tenant + store + canonical order GID; output reveals none. */
export function computeShopifyOrderSuppressionDigest(
  key: Buffer,
  organizationId: number,
  storeId: number,
  orderGid: string,
): string {
  if (key.length !== 32 || !Number.isSafeInteger(organizationId) || organizationId <= 0 ||
      !Number.isSafeInteger(storeId) || storeId <= 0 || !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderGid)) {
    throw new Error("shopify_privacy_suppression_input_invalid");
  }
  return crypto
    .createHmac("sha256", key)
    .update(`reconcileai:shopify-order-suppression:v1\0${organizationId}\0${storeId}\0${orderGid}`, "utf8")
    .digest("hex");
}

export interface ShopifyOrderSuppressionDigest {
  keyVersion: string;
  orderDigest: string;
}

export function allShopifyOrderSuppressionDigests(
  organizationId: number,
  storeId: number,
  orderGid: string,
  keys = shopifyPrivacySuppressionKeyRing(),
): ShopifyOrderSuppressionDigest[] {
  if (keys.length === 0) throw new Error("shopify_privacy_suppression_key_unavailable");
  return keys.map(({ version, key }) => ({
    keyVersion: version,
    orderDigest: computeShopifyOrderSuppressionDigest(key, organizationId, storeId, orderGid),
  }));
}

export function activeShopifyOrderSuppressionDigest(
  organizationId: number,
  storeId: number,
  orderGid: string,
  keys = shopifyPrivacySuppressionKeyRing(),
): ShopifyOrderSuppressionDigest {
  const [active] = allShopifyOrderSuppressionDigests(organizationId, storeId, orderGid, keys);
  if (!active) throw new Error("shopify_privacy_suppression_key_unavailable");
  return active;
}
