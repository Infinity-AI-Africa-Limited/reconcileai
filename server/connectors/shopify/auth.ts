import crypto from "node:crypto";

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
  // Code-unit order, as Shopify's own reference implementation sorts
  // (`Object.entries(params).sort()`). `localeCompare` is locale collation —
  // it orders case and punctuation differently — so a key set where the two
  // disagree would fail verification on a genuine callback.
  const message = Object.entries(params)
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
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
  const body = (await response.json()) as Partial<ShopifyTokenResponse>;
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

export async function exchangeAuthorizationCode(params: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<ShopifyTokenResponse> {
  const response = await shopifyFetch(`https://${params.shopDomain}/admin/oauth/access_token`, {
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
    response = await shopifyFetch(`https://${params.shopDomain}/admin/oauth/access_token`, {
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
  if (response.status === 429 || response.status >= 500) return { kind: "retry" };
  if (!response.ok) return { kind: "failed" };
  return { kind: "refreshed", token: await parseTokenResponse(response) };
}
