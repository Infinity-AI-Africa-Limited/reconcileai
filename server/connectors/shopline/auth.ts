/**
 * SHOPLINE OAuth 2.0 + Token Management
 *
 * OAuth flow (verified from SHOPLINE API docs §A2, v20260601):
 *
 * 1. Install request: SHOPLINE sends merchant to our App URL with
 *    `appkey`, `handle`, `timestamp`, `sign`. We verify `sign`, then
 *    redirect the merchant to the SHOPLINE authorize URL.
 *
 * 2. Authorize URL (merchant's browser):
 *    https://{handle}.myshopline.com/admin/oauth-web/#/oauth/authorize
 *      ?appKey={appKey}&responseType=code&scope={comma-separated}
 *      &redirectUri={urlencoded}&customField={optional}
 *
 * 3. Callback: SHOPLINE redirects to our redirectUri with:
 *    ?appkey&code&handle&timestamp&sign (+customField)
 *    Verify `sign`. Code expires in 10 minutes.
 *
 * 4. Token create:
 *    POST https://{handle}.myshopline.com/admin/oauth/token/create
 *    Headers: `appkey`, `timestamp`, `sign` (POST signature: body + timestamp)
 *    Body: {"code": "..."}
 *    Response data: { accessToken, expireTime (UTC ISO), scope }
 *
 * 5. Token refresh:
 *    POST https://{handle}.myshopline.com/admin/oauth/token/refresh
 *    Headers: `appkey`, `timestamp`, `sign` (POST signature: body + timestamp)
 *    Body: {} (empty or minimal)
 *    Token lifetime: 10 hours. Old token stays valid for 5 minutes after refresh.
 *    Do not refresh immediately after minting (rate-limited: REQUEST_FREQUENTLY).
 *
 * 6. Revoke: Cancel Authorization endpoint exists (call on tenant offboard).
 */

import { ENV } from "../../_core/env";
import {
  SHOPLINE_API_VERSION,
  SHOPLINE_REQUIRED_SCOPES,
  SHOPLINE_TOKEN_TTL_HOURS,
} from "../../../shared/shoplineConstants";
import { verifyOAuthSignature, buildPostSignature } from "./signature";

export interface ShoplineTokenResponse {
  /** The access token string */
  accessToken: string;
  /** UTC ISO-8601 expiry time (e.g. "2026-07-19T05:00:00Z") */
  expireTime: string;
  /** Comma-separated granted scopes */
  scope: string;
}

export interface ShoplineInstallParams {
  storeHandle: string;
  callbackUrl: string;
  state?: string; // optional customField for CSRF
}

/**
 * Build the OAuth authorization URL to redirect the merchant to SHOPLINE.
 *
 * Per spec §A2 step 2:
 *   https://{handle}.myshopline.com/admin/oauth-web/#/oauth/authorize
 *     ?appKey={appKey}&responseType=code&scope={scopes}&redirectUri={encoded}
 */
export function buildAuthorizationUrl(params: ShoplineInstallParams): string {
  const { storeHandle, callbackUrl, state } = params;
  const appKey = ENV.shoplineAppKey;
  const scopes = SHOPLINE_REQUIRED_SCOPES.join(",");

  // Note: this is a hash-based URL (#/oauth/authorize) — we build it manually
  const base = `https://${storeHandle}.myshopline.com/admin/oauth-web/#/oauth/authorize`;
  const qs = new URLSearchParams();
  qs.set("appKey", appKey);
  qs.set("responseType", "code");
  qs.set("scope", scopes);
  qs.set("redirectUri", callbackUrl);
  if (state) qs.set("customField", state);

  return `${base}?${qs.toString()}`;
}

/**
 * Verify the `sign` on an OAuth install request or callback.
 *
 * Per spec §A3 Mode 1: sorted query params (excluding `sign`), joined
 * as `k=v&k=v`, HMAC-SHA256 with app secret → hex.
 */
export function verifyCallbackSignature(queryParams: Record<string, string>): boolean {
  return verifyOAuthSignature(queryParams, ENV.shoplineAppSecret);
}

/**
 * Exchange the authorization code for an access token.
 *
 * Per spec §A2 step 4:
 *   POST https://{handle}.myshopline.com/admin/oauth/token/create
 *   Headers: appkey, timestamp (ms), sign (HMAC of body + timestamp)
 *   Body: {"code": "..."}
 *   Response: { data: { accessToken, expireTime, scope } }
 */
export async function exchangeCodeForToken(
  storeHandle: string,
  code: string,
): Promise<ShoplineTokenResponse> {
  const url = `https://${storeHandle}.myshopline.com/admin/oauth/token/create`;
  const body = JSON.stringify({ code });
  const timestamp = Date.now();
  const sign = buildPostSignature(body, timestamp, ENV.shoplineAppSecret);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "appkey": ENV.shoplineAppKey,
      "timestamp": String(timestamp),
      "sign": sign,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SHOPLINE token create failed (${response.status}): ${text}`);
  }

  const json = await response.json() as { data?: ShoplineTokenResponse; code?: string; message?: string };

  if (!json.data?.accessToken) {
    throw new Error(`SHOPLINE token create returned error: ${json.code} — ${json.message}`);
  }

  return json.data;
}

/**
 * Refresh an expiring access token.
 *
 * Per spec §A2 step 5:
 *   POST https://{handle}.myshopline.com/admin/oauth/token/refresh
 *   Headers: appkey, timestamp (ms), sign (HMAC of body + timestamp)
 *   Body: {} (the current access token is identified server-side by the app session)
 *
 * Note: After refresh the old token stays valid for 5 minutes (grace window).
 * Do not refresh immediately after minting (rate-limited: REQUEST_FREQUENTLY).
 *
 * Call this proactively at ~9h (1h before the 10h expiry).
 */
export async function refreshAccessToken(
  storeHandle: string,
  _currentAccessToken: string,
): Promise<ShoplineTokenResponse> {
  const url = `https://${storeHandle}.myshopline.com/admin/oauth/token/refresh`;

  // The refresh endpoint documents headers only — no request body. The exact
  // signature source for a body-less POST is unverifiable from public docs
  // (HMAC of "" + timestamp, or of "{}" + timestamp), so try the docs-literal
  // empty body first and fall back to "{}". A wrong guess here would kill
  // every token at the 10-hour mark, so both are attempted.
  const attempt = async (body: string) => {
    const timestamp = Date.now();
    const sign = buildPostSignature(body, timestamp, ENV.shoplineAppSecret);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "appkey": ENV.shoplineAppKey,
        "timestamp": String(timestamp),
        "sign": sign,
      },
      body: body === "" ? undefined : body,
    });
    const text = await response.text();
    let json: { data?: ShoplineTokenResponse; code?: number | string; i18nCode?: string; message?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    return { ok: response.ok && !!json.data?.accessToken, status: response.status, json, text };
  };

  const first = await attempt("");
  if (first.ok) return first.json.data as ShoplineTokenResponse;

  const second = await attempt(JSON.stringify({}));
  if (second.ok) return second.json.data as ShoplineTokenResponse;

  throw new Error(
    `SHOPLINE token refresh failed (${second.status}): ${second.json.i18nCode ?? second.json.code ?? ""} ${second.json.message ?? second.text}`,
  );
}

/**
 * Calculate the expiry timestamp from the SHOPLINE `expireTime` ISO string.
 * Falls back to `now + 10h` if the string is unparseable.
 */
export function calculateTokenExpiry(expireTime?: string): Date {
  if (expireTime) {
    const parsed = new Date(expireTime);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + SHOPLINE_TOKEN_TTL_HOURS * 3600 * 1000);
}

/**
 * Check whether a token needs refreshing.
 * Returns true if the token expires within 1 hour (proactive refresh window).
 */
export function tokenNeedsRefresh(expiresAt: Date): boolean {
  const oneHourMs = 60 * 60 * 1000;
  return expiresAt.getTime() - Date.now() < oneHourMs;
}
