/**
 * SHOPLINE Signature Verification
 *
 * SHOPLINE uses three HMAC-SHA256 signature modes (verified from API docs §A3):
 *
 * Mode 1 — GET requests (install request, OAuth callback):
 *   Source string: URL-encoded query params, `sign` removed, remaining params
 *   sorted alphabetically, joined `k=v&k=v`. Key = app secret. Result = hex.
 *   The signature travels as the `sign` query param.
 *   Enforce a ±10-minute timestamp window for replay protection.
 *
 * Mode 2 — Webhook delivery:
 *   Source string: raw request body. Key = app secret.
 *   Signature in `X-Shopline-Hmac-Sha256` header.
 *   SHOPLINE's Go sample compares hex digests, but their header example looks
 *   base64 — implement a tolerant verifier that accepts either encoding.
 *
 * Mode 3 — POST requests (token create/refresh):
 *   Source string: `body + timestamp` (millisecond timestamp appended to raw
 *   JSON body string). Key = app secret. Result = hex.
 *   Signature travels in `sign` header alongside `timestamp` header.
 *
 * All comparisons use `timingSafeEqual` to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "crypto";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Compute HMAC-SHA256 and return as hex string. */
function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Compute HMAC-SHA256 and return as base64 string. */
function hmacBase64(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("base64");
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
 * Check whether a timestamp is within ±10 minutes of now.
 *
 * SHOPLINE sends `timestamp` in **milliseconds** (spec §A2: "The timestamp,
 * in milliseconds, indicates when the request was sent"). Values below 1e12
 * are treated as seconds so a unit change on SHOPLINE's side fails safe.
 */
export function isTimestampValid(timestamp: number, windowMs = 10 * 60 * 1000): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const tsMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return Math.abs(Date.now() - tsMs) <= windowMs;
}

// ─── Mode 1: OAuth GET request signature ────────────────────────────────────

/**
 * Verify the HMAC on an OAuth install/callback GET request.
 *
 * Per SHOPLINE spec §A3:
 *   - The signature param is named `sign` (not `hmac`)
 *   - Remove `sign` from the params, sort remaining alphabetically
 *   - Join as `key=value&key=value`
 *   - HMAC-SHA256 with app secret → hex
 *   - Enforce ±10 minute timestamp window
 *
 * @param queryParams - Raw query string params as a plain object (including `sign`)
 * @param appSecret   - The app secret from the SHOPLINE Partner Portal
 */
export function verifyOAuthSignature(
  queryParams: Record<string, string>,
  appSecret: string,
): boolean {
  const { sign, ...rest } = queryParams;
  if (!sign) return false;

  // Enforce timestamp window (SHOPLINE sends `timestamp` as seconds)
  const ts = rest["timestamp"];
  if (ts && !isTimestampValid(Number(ts))) return false;

  // Sort keys, join as key=value pairs, compute HMAC
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");

  const expected = hmacHex(appSecret, message);
  return safeEqual(sign, expected);
}

// ─── Mode 2: Webhook delivery signature ─────────────────────────────────────

/**
 * Verify the HMAC on an inbound webhook delivery.
 *
 * Per SHOPLINE spec §A3:
 *   - Source string = raw request body
 *   - Key = app secret
 *   - Signature is in `X-Shopline-Hmac-Sha256` header
 *   - Tolerant verifier: accept either hex or base64 encoding
 *
 * @param rawBody   - Raw request body as a Buffer or string
 * @param signature - Value of the `X-Shopline-Hmac-Sha256` header
 * @param appSecret - The app secret from the SHOPLINE Partner Portal
 */
export function verifyWebhookHmac(
  rawBody: Buffer | string,
  signature: string,
  appSecret: string,
): boolean {
  if (!signature) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  // Try base64 first (SHOPLINE's documented format)
  const expectedBase64 = hmacBase64(appSecret, body);
  if (safeEqual(signature, expectedBase64)) return true;

  // Fallback: try hex (SHOPLINE's Go sample uses hex)
  const expectedHex = hmacHex(appSecret, body);
  if (safeEqual(signature, expectedHex)) return true;

  return false;
}

// ─── Mode 3: POST request signature (token create/refresh) ──────────────────

/**
 * Build the HMAC signature for a POST request (token create or refresh).
 *
 * Per SHOPLINE spec §A3:
 *   Source string = `body + timestamp` (raw JSON body string concatenated
 *   with the millisecond timestamp). Key = app secret. Result = hex.
 *
 * @param bodyJson   - The raw JSON body string
 * @param timestamp  - Millisecond timestamp (Date.now())
 * @param appSecret  - The app secret from the SHOPLINE Partner Portal
 */
export function buildPostSignature(
  bodyJson: string,
  timestamp: number,
  appSecret: string,
): string {
  const message = `${bodyJson}${timestamp}`;
  return hmacHex(appSecret, message);
}

/**
 * Build the HMAC signature specifically for the token refresh endpoint.
 *
 * Per SHOPLINE spec §A2 step 5:
 *   POST /admin/oauth/token/refresh authenticated by app signature alone.
 *   The signature is computed over `body + timestamp` (same as Mode 3).
 *
 * @param bodyJson   - The raw JSON body string for the refresh request
 * @param timestamp  - Millisecond timestamp
 * @param appSecret  - The app secret from the SHOPLINE Partner Portal
 */
export function buildRefreshSignature(
  bodyJson: string,
  timestamp: number,
  appSecret: string,
): string {
  return buildPostSignature(bodyJson, timestamp, appSecret);
}
