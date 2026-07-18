/**
 * SHOPLINE OAuth 2.0 + Token Management
 *
 * OAuth flow (verified from SHOPLINE API docs, v20260601):
 *
 * 1. Install request: redirect merchant to SHOPLINE authorization URL
 *    GET https://{store}.myshopline.com/admin/oauth/authorize
 *        ?app_key={appKey}&scope={scopes}&redirect_uri={callbackUrl}&state={nonce}
 *
 * 2. Callback: SHOPLINE redirects to callbackUrl with `code` + `hmac` + store params.
 *    Verify HMAC (Mode 1), then exchange code for token.
 *
 * 3. Token exchange:
 *    POST https://{store}.myshopline.com/admin/oauth/token
 *    Body: { app_key, app_secret, code }
 *    Response: { access_token, scope, expires_in (36000 = 10h) }
 *
 * 4. Token refresh (before expiry, within 5-minute grace):
 *    POST https://{store}.myshopline.com/admin/oauth/token/refresh
 *    Body: { app_key, access_token, timestamp, signature }
 *    signature = HMAC-SHA256(accessToken + appKey + timestamp, appSecret) [Mode 3]
 *
 * Token TTL: 10 hours (36000 seconds). Refresh proactively at 9h to stay within grace.
 */

import { ENV } from "../../_core/env";
import { SHOPLINE_API_VERSION, SHOPLINE_REQUIRED_SCOPES, SHOPLINE_TOKEN_TTL_HOURS } from "../../../shared/shoplineConstants";
import { buildRefreshSignature, verifyOAuthHmac } from "./signature";

export interface ShoplineTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number; // seconds (36000 = 10h)
}

export interface ShoplineInstallParams {
  storeHandle: string;
  callbackUrl: string;
  state: string;
}

/**
 * Build the OAuth authorization URL to redirect the merchant to SHOPLINE.
 */
export function buildAuthorizationUrl(params: ShoplineInstallParams): string {
  const { storeHandle, callbackUrl, state } = params;
  const appKey = ENV.shoplineAppKey;
  const scopes = SHOPLINE_REQUIRED_SCOPES.join(",");

  const url = new URL(`https://${storeHandle}.myshopline.com/admin/oauth/authorize`);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Verify the HMAC on the OAuth callback and return whether it is valid.
 */
export function verifyCallbackHmac(queryParams: Record<string, string>): boolean {
  return verifyOAuthHmac(queryParams, ENV.shoplineAppSecret);
}

/**
 * Exchange the authorization code for an access token.
 */
export async function exchangeCodeForToken(
  storeHandle: string,
  code: string,
): Promise<ShoplineTokenResponse> {
  const url = `https://${storeHandle}.myshopline.com/admin/oauth/token`;
  const body = {
    app_key: ENV.shoplineAppKey,
    app_secret: ENV.shoplineAppSecret,
    code,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SHOPLINE token exchange failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<ShoplineTokenResponse>;
}

/**
 * Refresh an expiring access token using HMAC-authenticated refresh.
 * Call this proactively at ~9h (1h before the 10h expiry).
 */
export async function refreshAccessToken(
  storeHandle: string,
  currentAccessToken: string,
): Promise<ShoplineTokenResponse> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildRefreshSignature(
    currentAccessToken,
    ENV.shoplineAppKey,
    timestamp,
    ENV.shoplineAppSecret,
  );

  const url = `https://${storeHandle}.myshopline.com/admin/oauth/token/refresh`;
  const body = {
    app_key: ENV.shoplineAppKey,
    access_token: currentAccessToken,
    timestamp,
    signature,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SHOPLINE token refresh failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<ShoplineTokenResponse>;
}

/**
 * Calculate the expiry timestamp for a new token.
 * Returns a Date object set to `now + expires_in seconds`.
 */
export function calculateTokenExpiry(expiresIn: number = SHOPLINE_TOKEN_TTL_HOURS * 3600): Date {
  return new Date(Date.now() + expiresIn * 1000);
}

/**
 * Check whether a token needs refreshing.
 * Returns true if the token expires within 1 hour (proactive refresh window).
 */
export function tokenNeedsRefresh(expiresAt: Date): boolean {
  const oneHourMs = 60 * 60 * 1000;
  return expiresAt.getTime() - Date.now() < oneHourMs;
}
