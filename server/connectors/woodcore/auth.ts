/**
 * WoodCore API authentication & session management.
 *
 * Primary mode: OAuth2 client-credentials with an in-process token cache and
 * proactive refresh (60s expiry skew). Fallbacks, in order of configuration:
 *   - api_key  — static header (default `x-api-key`)
 *   - basic    — HTTP Basic (Fineract's default auth scheme)
 *
 * If the configured mode is oauth2 and the token endpoint is unreachable/rejects,
 * and an API key is also configured, the manager degrades to the API key and
 * reports `degraded: true` so the health dashboard can surface it.
 *
 * Every request also carries `Fineract-Platform-TenantId` (Fineract multi-tenancy).
 */
import { assertEgressAllowed } from "../../_core/egress";
import type { FetchLike, OAuthTokenResponse, WcConnection } from "./types";

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

/** 60s safety skew: refresh before the server-side expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** Tokens with no expires_in are re-fetched after 10 minutes. */
const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

export interface AuthResult {
  headers: Record<string, string>;
  /** The mode actually used (may differ from configured mode on fallback). */
  modeUsed: "oauth2" | "api_key" | "basic";
  /** True when we fell back from the configured mode. */
  degraded: boolean;
  degradedReason?: string;
}

export function resolveTokenUrl(conn: WcConnection): string {
  const t = conn.oauthTokenUrl?.trim() || conn.endpoints.tokenUrl;
  if (/^https?:\/\//i.test(t)) return t;
  return conn.baseUrl.replace(/\/+$/, "") + (t.startsWith("/") ? t : `/${t}`);
}

/** Drop any cached token for this connection (e.g. after a 401). */
export function invalidateToken(configId: number): void {
  tokenCache.delete(configId);
}

/** Test-only: reset all cached sessions. */
export function clearTokenCacheForTests(): void {
  tokenCache.clear();
}

async function fetchOAuthToken(
  conn: WcConnection,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<CachedToken> {
  if (!conn.oauthClientId || !conn.oauthClientSecret) {
    throw new Error("OAuth2 selected but client id/secret are not configured");
  }
  const url = resolveTokenUrl(conn);
  assertEgressAllowed(url, "WoodCore OAuth2 token request");

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (conn.oauthScope) body.set("scope", conn.oauthScope);

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // RFC 6749 §2.3.1 — client credentials via HTTP Basic
      Authorization:
        "Basic " + Buffer.from(`${conn.oauthClientId}:${conn.oauthClientSecret}`).toString("base64"),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth2 token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new Error("OAuth2 token response contained no access_token");
  }
  const ttlMs = data.expires_in ? data.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS;
  return {
    accessToken: data.access_token,
    expiresAt: now() + Math.max(ttlMs - EXPIRY_SKEW_MS, 30_000),
  };
}

function baseHeaders(conn: WcConnection): Record<string, string> {
  return {
    "Fineract-Platform-TenantId": conn.tenantId,
    Accept: "application/json",
  };
}

function apiKeyHeaders(conn: WcConnection): Record<string, string> | null {
  if (!conn.apiKey) return null;
  return { ...baseHeaders(conn), [conn.apiKeyHeader]: conn.apiKey };
}

function basicHeaders(conn: WcConnection): Record<string, string> | null {
  if (!conn.basicUsername || !conn.basicPassword) return null;
  return {
    ...baseHeaders(conn),
    Authorization:
      "Basic " + Buffer.from(`${conn.basicUsername}:${conn.basicPassword}`).toString("base64"),
  };
}

/**
 * Produce auth headers for a request, honouring the configured mode and the
 * OAuth2 → API key fallback chain.
 */
export async function getAuthHeaders(
  conn: WcConnection,
  deps: { fetchImpl: FetchLike; now?: () => number },
): Promise<AuthResult> {
  const now = deps.now ?? Date.now;

  if (conn.authMode === "api_key") {
    const headers = apiKeyHeaders(conn);
    if (!headers) throw new Error("API key auth selected but no API key is configured");
    return { headers, modeUsed: "api_key", degraded: false };
  }

  if (conn.authMode === "basic") {
    const headers = basicHeaders(conn);
    if (!headers) throw new Error("Basic auth selected but username/password are not configured");
    return { headers, modeUsed: "basic", degraded: false };
  }

  // oauth2 (primary)
  const cached = tokenCache.get(conn.configId);
  if (cached && cached.expiresAt > now()) {
    return {
      headers: { ...baseHeaders(conn), Authorization: `Bearer ${cached.accessToken}` },
      modeUsed: "oauth2",
      degraded: false,
    };
  }

  try {
    const token = await fetchOAuthToken(conn, deps.fetchImpl, now);
    tokenCache.set(conn.configId, token);
    return {
      headers: { ...baseHeaders(conn), Authorization: `Bearer ${token.accessToken}` },
      modeUsed: "oauth2",
      degraded: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Fallback chain: API key, then basic. Surface degradation to health.
    const viaKey = apiKeyHeaders(conn);
    if (viaKey) {
      console.warn(`[wc-connector] OAuth2 failed for config ${conn.configId}; falling back to API key: ${reason}`);
      return { headers: viaKey, modeUsed: "api_key", degraded: true, degradedReason: reason };
    }
    const viaBasic = basicHeaders(conn);
    if (viaBasic) {
      console.warn(`[wc-connector] OAuth2 failed for config ${conn.configId}; falling back to basic auth: ${reason}`);
      return { headers: viaBasic, modeUsed: "basic", degraded: true, degradedReason: reason };
    }
    throw new Error(`WoodCore authentication failed: ${reason}`);
  }
}
