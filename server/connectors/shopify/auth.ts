import crypto from "node:crypto";
import type { ReauthorizationTicket } from "./onboarding";

export const SHOPIFY_DOMAIN_SUFFIX = ".myshopify.com";

export interface ShopifyTokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

/**
 * Normalize and validate Shopify's canonical permanent shop hostname.
 * A public app must never let a callback-controlled hostname choose where server
 * credentials are posted, so custom domains, ports, paths and lookalikes reject.
 */
export function normalizeShopDomain(input: string | undefined | null): string | null {
  if (!input || input.length > 253) return null;
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  if (!domain.endsWith(SHOPIFY_DOMAIN_SUFFIX)) return null;
  const label = domain.slice(0, -SHOPIFY_DOMAIN_SUFFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  return domain;
}

/** A constant-time comparison that is safe for malformed or missing input. */
export function secureEqualHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The message Shopify signs for an Admin request (OAuth callback, install
 * link): every parameter but `hmac` and `signature`, sorted by key, URL-ENCODED
 * as `URLSearchParams` encodes it with spaces as `%20`.
 *
 * This is `stringifyQueryForAdmin` in Shopify's own library
 * (@shopify/shopify-api, lib/utils/hmac-validator.ts and processed-query.ts),
 * whose tests sign `code=some%20code%20goes%20here&shop=…`. Express hands us
 * DECODED values, so joining them raw only agrees when no value needs
 * encoding. The callback's `host` is standard base64 — it ends in `=` padding
 * for most shop names and may hold `/` or `+` — so a raw join rejected genuine
 * installs.
 */
export function shopifyAdminHmacMessage(params: Record<string, string>): string {
  const query = new URLSearchParams();
  Object.keys(params)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort((left, right) => left.localeCompare(right))
    .forEach((key) => query.append(key, params[key]));
  return query.toString().replace(/\+/g, "%20");
}

/**
 * Validates Shopify's OAuth callback HMAC. Duplicate keys are rejected before
 * this function is called, because Object.fromEntries would otherwise let a
 * callback smuggle an alternate `shop`, `state` or `hmac` value into validation.
 */
export function verifyShopifyCallbackHmac(
  params: Record<string, string>,
  clientSecret: string,
): boolean {
  const provided = params.hmac;
  if (!provided || !clientSecret) return false;
  const expected = crypto.createHmac("sha256", clientSecret).update(shopifyAdminHmacMessage(params)).digest("hex");
  return secureEqualHex(expected, provided);
}

/** Validates Shopify's base64 HMAC used for HTTPS webhook deliveries. */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  header: string | undefined,
  clientSecret: string,
): boolean {
  if (!header || !clientSecret) return false;
  const expected = crypto.createHmac("sha256", clientSecret).update(rawBody).digest("base64");
  return secureEqualHex(expected, header.trim());
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * A privacy-safe durable identity for a Shopify webhook body. A raw SHA-256 is
 * not sufficient here because a privacy body can contain low-entropy provider
 * identifiers that a database reader could confirm offline. This keyed digest is
 * used only for replay control; it is domain-separated from OAuth, token and
 * redaction-suppression MACs.
 */
const WEBHOOK_PAYLOAD_DIGEST_LABEL = "reconcileai:shopify-webhook-payload:v1";

export function shopifyWebhookPayloadDigest(rawBody: Buffer, digestKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(digestKey)) {
    throw new Error("Shopify webhook digest key is unavailable or invalid");
  }
  return crypto
    .createHmac("sha256", Buffer.from(digestKey, "hex"))
    .update(WEBHOOK_PAYLOAD_DIGEST_LABEL)
    .update("\0")
    .update(rawBody)
    .digest("hex");
}

export function makeState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Domain separation: this MAC must never be interchangeable with any other use of the secret. */
const OAUTH_STATE_MAC_LABEL = "reconcileai:shopify-oauth-state:v1";

function oauthStateMac(secret: string, shopDomain: string, expiresAtMs: number, nonce: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${OAUTH_STATE_MAC_LABEL}|${shopDomain}|${expiresAtMs}|${nonce}`)
    .digest("base64url");
}

/**
 * A self-verifying OAuth state: `<expiresAtMs>.<nonce>.<mac>`, bound to one shop.
 *
 * The install route used to store a row per state. That made an
 * UNAUTHENTICATED endpoint write to the database on every hit, and the only
 * brake was a per-client rate limit keyed on `X-Forwarded-For` — a header the
 * client writes itself, since Cloudflare and Railway append to it rather than
 * replace it. A signed state needs no row until the callback, where Shopify's
 * HMAC has already been verified; single use is enforced there.
 */
export function signOAuthState(params: { shopDomain: string; secret: string; ttlMs: number; now?: number }): {
  state: string;
  expiresAt: Date;
} {
  const expiresAtMs = (params.now ?? Date.now()) + params.ttlMs;
  const nonce = makeState();
  return {
    state: `${expiresAtMs}.${nonce}.${oauthStateMac(params.secret, params.shopDomain, expiresAtMs, nonce)}`,
    expiresAt: new Date(expiresAtMs),
  };
}

/** The state's expiry if it is authentic, unexpired, for this shop and within one TTL; otherwise null. */
export function verifyOAuthState(
  state: string,
  params: { shopDomain: string; secret: string; ttlMs: number; now?: number },
): Date | null {
  const parts = state.split(".");
  if (parts.length !== 3 || !params.secret) return null;
  const [expiry, nonce, mac] = parts;
  if (!/^[0-9]{1,15}$/.test(expiry) || !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) return null;
  const expiresAtMs = Number(expiry);
  const now = params.now ?? Date.now();
  // A genuine state is never valid for longer than one TTL from now.
  if (expiresAtMs <= now || expiresAtMs - now > params.ttlMs) return null;
  if (!secureEqualHex(oauthStateMac(params.secret, params.shopDomain, expiresAtMs, nonce), mac)) return null;
  return new Date(expiresAtMs);
}

export function buildShopifyAuthorizationUrl(params: {
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    scope: params.scopes.join(","),
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  return `https://${params.shopDomain}/admin/oauth/authorize?${query.toString()}`;
}

/**
 * Parse a callback query without accepting duplicate values. OAuth parameters
 * are singleton values; accepting the last repeated key is ambiguous and can
 * invalidate an otherwise sound HMAC/state check.
 */
export function parseUniqueQuery(input: Record<string, unknown>): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") return null;
    result[key] = value;
  }
  return result;
}

export function tokenExpiryFromSeconds(seconds: number | undefined, now = Date.now()): Date | null {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return null;
  return new Date(now + seconds * 1000);
}

export function requiredScopesGranted(granted: string, required: readonly string[]): boolean {
  const grantedSet = new Set(
    granted
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  return required.every((scope) =>
    grantedSet.has(scope) || (scope.startsWith("read_") && grantedSet.has(`write_${scope.slice(5)}`)),
  );
}

export class ShopifyTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ShopifyTransportError";
  }
}

async function shopifyFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (cause) {
    throw new ShopifyTransportError(`Could not reach ${new URL(url).hostname}`, cause);
  }
}

async function parseTokenResponse(response: Response): Promise<ShopifyTokenResponse> {
  let body: Partial<ShopifyTokenResponse>;
  try {
    body = (await response.json()) as Partial<ShopifyTokenResponse>;
  } catch {
    // Never the parser's own message: Node quotes the start of the input in it,
    // and the input is a token response, so a truncated body carries a token.
    throw new Error("Shopify returned an unreadable token response");
  }
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.scope !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("Shopify returned an incomplete expiring-token response");
  }
  return body as ShopifyTokenResponse;
}

/** Resolve the only endpoint that may receive ReconcileAI's Shopify credentials. */
function shopifyTokenEndpoint(shopDomain: string): string {
  const normalized = normalizeShopDomain(shopDomain);
  if (!normalized) throw new Error("Invalid Shopify shop domain");
  return `https://${normalized}/admin/oauth/access_token`;
}

export async function exchangeAuthorizationCode(params: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<ShopifyTokenResponse> {
  const response = await shopifyFetch(shopifyTokenEndpoint(params.shopDomain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      expiring: "1",
    }),
  });
  if (!response.ok) throw new Error(`Shopify authorization-code exchange failed (${response.status})`);
  return parseTokenResponse(response);
}

export type TokenExchangeResult =
  | { kind: "exchanged"; token: ShopifyTokenResponse }
  /** The ID token was expired or invalid: have App Bridge issue a fresh one and try again. */
  | { kind: "id_token_rejected" }
  /** Shopify was unreachable, rate limiting or failing: try again later. */
  | { kind: "retry" }
  /** Shopify refused a request of ours (configuration, or a bug): retrying will not help. */
  | { kind: "failed" };

/**
 * Exchange a verified, fresh App Bridge ID token for Shopify's expiring offline
 * access-token pair. The caller owns ID-token verification, browser input,
 * onboarding, persistence and authorization policy.
 *
 * ── This exchange retires the store's stored credentials ──────────────────
 *
 * Every grant of a new offline pair retires the other refresh tokens the app
 * holds for the store (shopify.dev, "How refresh token rotation works"; the
 * authorization-code path in onboarding.ts is built on the same fact). Called
 * for a store that is already connected, it kills the stored refresh token,
 * and the connection fails within the hour unless the new pair is stored under
 * the same fences as the callback's. So it demands `reauthorization`: the
 * ticket only `suspendForReauthorization` issues. Holding one proves the
 * caller took the store out of service first, under its install lease, AND
 * passed the redaction fence that keeps a tenant being deleted from acquiring
 * new credentials. Pass the same ticket on to `onboardShopifyMerchant`.
 *
 * Failures come back by kind, never as Shopify's text. An expired ID token is
 * the usual case (they live about a minute), and it calls for a fresh token,
 * not an error page.
 */
export async function exchangeShopifyIdTokenForOfflineAccess(params: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  idToken: string;
  /** Not read here: having one is the point. See above. */
  reauthorization: ReauthorizationTicket;
}): Promise<TokenExchangeResult> {
  if (!params.clientId.trim() || !params.clientSecret.trim() || !params.idToken.trim()) {
    throw new Error("Shopify token exchange is not configured");
  }
  let response: Response;
  try {
    response = await shopifyFetch(shopifyTokenEndpoint(params.shopDomain), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: params.idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
        expiring: "1",
      }),
    });
  } catch (error) {
    if (error instanceof ShopifyTransportError) return { kind: "retry" };
    throw error;
  }

  if (response.status === 429 || response.status >= 500) return { kind: "retry" };
  if ((response.status === 400 || response.status === 401) && (await presentedTokenRejected(response))) {
    return { kind: "id_token_rejected" };
  }
  if (!response.ok) return { kind: "failed" };
  return { kind: "exchanged", token: await parseTokenResponse(response) };
}

export type RefreshResult =
  | { kind: "refreshed"; token: ShopifyTokenResponse }
  | { kind: "reauthorize" }
  | { kind: "retry" }
  | { kind: "failed" };

export async function refreshExpiringOfflineToken(params: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await shopifyFetch(shopifyTokenEndpoint(params.shopDomain), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: params.clientId,
        client_secret: params.clientSecret,
        refresh_token: params.refreshToken,
      }),
    });
  } catch (error) {
    if (error instanceof ShopifyTransportError) return { kind: "retry" };
    throw error;
  }

  if (response.status === 401) return { kind: "reauthorize" };
  if (response.status === 400 && (await presentedTokenRejected(response))) return { kind: "reauthorize" };
  if (response.status === 429 || response.status >= 500) return { kind: "retry" };
  if (!response.ok) return { kind: "failed" };
  return { kind: "refreshed", token: await parseTokenResponse(response) };
}

/**
 * OAuth errors that say the token we presented, whether a refresh token or an
 * App Bridge ID token, is itself no longer good.
 * Shopify answers an expired, revoked or rotated-away refresh token with HTTP
 * 400 — its own library tests model it as `{ error: "invalid_subject_token" }`
 * — and RFC 6749 §5.2 names the generic case `invalid_grant`. Treated as a
 * transient failure, such a store read `active` while every sync failed, and
 * the merchant was never asked to reconnect.
 *
 * Any OTHER 400 (a malformed request is ours to fix) stays `failed`: taking
 * every store out of service over a bug of ours would be the worse error.
 */
const REJECTED_PRESENTED_TOKEN_ERRORS = new Set(["invalid_subject_token", "invalid_grant"]);

/** Whether Shopify rejected the token we presented: a refresh token, or an App Bridge ID token. */
async function presentedTokenRejected(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" && REJECTED_PRESENTED_TOKEN_ERRORS.has(body.error);
  } catch {
    return false;
  }
}
