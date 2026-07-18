/**
 * SHOPLINE Signature Verification
 *
 * SHOPLINE uses three HMAC-SHA256 signature modes (verified from API docs):
 *
 * Mode 1 — OAuth install/callback: HMAC-SHA256 of the sorted query params
 *   (excluding `hmac` itself), joined as `key=value&key=value`, keyed by app secret.
 *
 * Mode 2 — Webhook delivery: HMAC-SHA256 of the raw request body, keyed by
 *   app secret. Signature is in the `X-Shopline-Hmac-Sha256` header (base64).
 *
 * Mode 3 — Token refresh: HMAC-SHA256 of `access_token + app_key + timestamp`,
 *   keyed by app secret. Used to authenticate the refresh request.
 *
 * All comparisons use `timingSafeEqual` to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Compute HMAC-SHA256 and return as hex string. */
function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Compute HMAC-SHA256 and return as base64 string. */
function hmacBase64(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64");
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Mode 1: Verify the HMAC on an OAuth install/callback request.
 *
 * @param queryParams - Raw query string params as a plain object (including `hmac`)
 * @param appSecret   - The app secret from the SHOPLINE Partner Portal
 */
export function verifyOAuthHmac(
  queryParams: Record<string, string>,
  appSecret: string,
): boolean {
  const { hmac, ...rest } = queryParams;
  if (!hmac) return false;

  // Sort keys, join as key=value pairs, compute HMAC
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");

  const expected = hmacHex(appSecret, message);
  return safeEqual(hmac, expected);
}

/**
 * Mode 2: Verify the HMAC on an inbound webhook delivery.
 *
 * @param rawBody   - Raw request body as a Buffer or string
 * @param signature - Value of the `X-Shopline-Hmac-Sha256` header (base64)
 * @param appSecret - The app secret from the SHOPLINE Partner Portal
 */
export function verifyWebhookHmac(
  rawBody: Buffer | string,
  signature: string,
  appSecret: string,
): boolean {
  if (!signature) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = hmacBase64(appSecret, body);
  return safeEqual(signature, expected);
}

/**
 * Mode 3: Generate the HMAC signature for a token refresh request.
 *
 * The refresh endpoint requires:
 *   signature = HMAC-SHA256(accessToken + appKey + timestamp, appSecret)
 *
 * @param accessToken - The current (expiring) access token
 * @param appKey      - The app key from the SHOPLINE Partner Portal
 * @param timestamp   - Unix timestamp in seconds (use Math.floor(Date.now() / 1000))
 * @param appSecret   - The app secret from the SHOPLINE Partner Portal
 */
export function buildRefreshSignature(
  accessToken: string,
  appKey: string,
  timestamp: number,
  appSecret: string,
): string {
  const message = `${accessToken}${appKey}${timestamp}`;
  return hmacHex(appSecret, message);
}
