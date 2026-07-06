/**
 * Enterprise SSO — Google OAuth2 (Phase 2) + Microsoft Entra ID (Phase 3).
 *
 * Implementation notes (deliberate deviations from the original roadmap):
 *  - No passport.js. passport-azure-ad is retired by Microsoft, and passport's
 *    session model duplicates what our JWT cookie already does. This is a
 *    dependency-free authorization-code + PKCE flow: `fetch` for the exchange,
 *    `jose` (already a dependency) for ID-token verification against each
 *    provider's JWKS.
 *  - B2B account policy: SSO signs in EXISTING users only (mapped by verified
 *    email, same posture as magic-link). There is no self-serve signup — users
 *    are invited by their organization's admin. Unknown emails bounce back to
 *    /login?error=no_account.
 *  - Tenant gate: members of a deactivated organization cannot mint a session
 *    (tenancy.isOrgLoginAllowed), on every login path.
 *
 * Flow state (state + PKCE verifier + nonce) travels in a short-lived signed
 * JWT cookie, so the callback is stateless server-side and CSRF-safe.
 *
 * Endpoints:  GET /api/oauth/google/start      GET /api/oauth/google/callback
 *             GET /api/oauth/microsoft/start   GET /api/oauth/microsoft/callback
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { getSessionCookieOptions } from "./cookies";
import { assertEgressAllowed } from "./egress";
import { ENV } from "./env";
import { sdk } from "./sdk";
import { isOrgLoginAllowed } from "./tenancy";

export type SsoProviderId = "google" | "microsoft";

const FLOW_COOKIE = "sso_flow";
const FLOW_TTL_SECONDS = 600; // 10 minutes to round-trip the provider

// ─── Provider definitions ────────────────────────────────────────────────────
interface ProviderDef {
  id: SsoProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Exact issuer, or prefix match when multi-tenant (Entra "common"). */
  issuer: { exact?: string; prefix?: string; suffix?: string };
  scope: string;
  clientId: string;
  clientSecret: string;
}

function msEndpoint(path: string): string {
  return `https://login.microsoftonline.com/${ENV.microsoftTenantId}${path}`;
}

export function getProviderDef(id: string): ProviderDef | null {
  if (id === "google" && ENV.googleClientId && ENV.googleClientSecret) {
    return {
      id: "google",
      label: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      issuer: { exact: "https://accounts.google.com" },
      scope: "openid email profile",
      clientId: ENV.googleClientId,
      clientSecret: ENV.googleClientSecret,
    };
  }
  if (id === "microsoft" && ENV.microsoftClientId && ENV.microsoftClientSecret) {
    const specificTenant = !["common", "organizations", "consumers"].includes(ENV.microsoftTenantId);
    return {
      id: "microsoft",
      label: "Microsoft",
      authorizeUrl: msEndpoint("/oauth2/v2.0/authorize"),
      tokenUrl: msEndpoint("/oauth2/v2.0/token"),
      jwksUrl: msEndpoint("/discovery/v2.0/keys"),
      // Multi-tenant: the issuer embeds the USER'S tenant id, so only the
      // scheme/host prefix and /v2.0 suffix are stable.
      issuer: specificTenant
        ? { exact: `https://login.microsoftonline.com/${ENV.microsoftTenantId}/v2.0` }
        : { prefix: "https://login.microsoftonline.com/", suffix: "/v2.0" },
      scope: "openid email profile",
      clientId: ENV.microsoftClientId,
      clientSecret: ENV.microsoftClientSecret,
    };
  }
  return null;
}

/** Providers with credentials configured — drives the /login buttons. */
export function enabledSsoProviders(): Array<{ id: SsoProviderId; label: string }> {
  return (["google", "microsoft"] as const)
    .map((id) => getProviderDef(id))
    .filter((p): p is ProviderDef => p !== null)
    .map((p) => ({ id: p.id, label: p.label }));
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────
export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkcePair(rand: (n: number) => Buffer = crypto.randomBytes): {
  verifier: string;
  challenge: string;
} {
  const verifier = b64url(rand(32)); // 43 chars, well within RFC 7636's 43–128
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  def: Pick<ProviderDef, "authorizeUrl" | "clientId" | "scope">,
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const q = new URLSearchParams({
    client_id: def.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: def.scope,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    // Let workspace users pick the right account instead of silently reusing one.
    prompt: "select_account",
  });
  return `${def.authorizeUrl}?${q.toString()}`;
}

export interface ValidatedIdentity {
  ok: boolean;
  email?: string;
  name?: string;
  errors: string[];
}

/**
 * Validate provider claims beyond signature/expiry (which jwtVerify enforces):
 * audience, nonce, issuer shape, verified email. Pure — unit-tested.
 */
export function validateIdentityClaims(
  def: Pick<ProviderDef, "id" | "clientId" | "issuer">,
  claims: Record<string, unknown>,
  expectedNonce: string,
): ValidatedIdentity {
  const errors: string[] = [];

  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(def.clientId) : aud === def.clientId;
  if (!audOk) errors.push("audience mismatch");

  if (claims.nonce !== expectedNonce) errors.push("nonce mismatch");

  const iss = typeof claims.iss === "string" ? claims.iss : "";
  if (def.issuer.exact) {
    if (iss !== def.issuer.exact) errors.push(`unexpected issuer "${iss}"`);
  } else {
    if (!iss.startsWith(def.issuer.prefix ?? "")) errors.push(`unexpected issuer "${iss}"`);
    if (def.issuer.suffix && !iss.endsWith(def.issuer.suffix)) errors.push(`unexpected issuer "${iss}"`);
  }

  let email: string | undefined;
  if (def.id === "google") {
    if (claims.email_verified !== true) errors.push("Google email is not verified");
    if (typeof claims.email === "string" && claims.email) email = claims.email.toLowerCase();
    else errors.push("no email claim");
  } else {
    // Entra: `email` when present; workplace accounts commonly carry the
    // sign-in address in `preferred_username`.
    const candidate =
      (typeof claims.email === "string" && claims.email) ||
      (typeof claims.preferred_username === "string" && claims.preferred_username) ||
      "";
    if (candidate.includes("@")) email = candidate.toLowerCase();
    else errors.push("no usable email claim");
  }

  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.given_name === "string" && claims.given_name) ||
    undefined;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, email, name, errors: [] };
}

// ─── Flow cookie (signed, short-lived) ───────────────────────────────────────
interface FlowPayload {
  p: SsoProviderId;
  s: string; // state
  v: string; // PKCE verifier
  n: string; // nonce
}

function flowSecret(): Uint8Array {
  return new TextEncoder().encode(`${ENV.cookieSecret}:sso-flow`);
}

async function signFlowCookie(payload: FlowPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS)
    .sign(flowSecret());
}

async function readFlowCookie(token: string | undefined): Promise<FlowPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, flowSecret(), { algorithms: ["HS256"] });
    const { p, s, v, n } = payload as Record<string, unknown>;
    if (typeof p !== "string" || typeof s !== "string" || typeof v !== "string" || typeof n !== "string") return null;
    if (p !== "google" && p !== "microsoft") return null;
    return { p, s, v, n };
  } catch {
    return null;
  }
}

// ─── JWKS caches (one remote set per provider process-wide) ─────────────────
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

// ─── Route handlers ──────────────────────────────────────────────────────────
function appOrigin(req: Request): string {
  if (ENV.appUrl) return ENV.appUrl.replace(/\/+$/, "");
  const host = req.get("host");
  return `${req.protocol}://${host}`;
}

function redirectUriFor(req: Request, provider: SsoProviderId): string {
  return `${appOrigin(req)}/api/oauth/${provider}/callback`;
}

function loginError(res: Response, code: string): void {
  res.redirect(302, `/login?error=${encodeURIComponent(code)}`);
}

export function registerSsoRoutes(app: Express): void {
  app.get("/api/oauth/:provider/start", async (req, res) => {
    try {
      const def = getProviderDef(req.params.provider);
      if (!def) return loginError(res, "sso_not_configured");

      assertEgressAllowed(def.authorizeUrl, `${def.label} sign-in`);

      const { verifier, challenge } = generatePkcePair();
      const state = b64url(crypto.randomBytes(24));
      const nonce = b64url(crypto.randomBytes(24));

      const cookie = await signFlowCookie({ p: def.id, s: state, v: verifier, n: nonce });
      res.cookie(FLOW_COOKIE, cookie, {
        httpOnly: true,
        secure: req.protocol === "https",
        sameSite: "lax", // must survive the top-level redirect back from the IdP
        maxAge: FLOW_TTL_SECONDS * 1000,
        path: "/api/oauth",
      });

      res.redirect(
        302,
        buildAuthorizeUrl(def, {
          redirectUri: redirectUriFor(req, def.id),
          state,
          nonce,
          codeChallenge: challenge,
        }),
      );
    } catch (err) {
      console.error("[sso] start failed:", err);
      loginError(res, "sso_failed");
    }
  });

  app.get("/api/oauth/:provider/callback", async (req, res) => {
    try {
      const def = getProviderDef(req.params.provider);
      if (!def) return loginError(res, "sso_not_configured");

      const flow = await readFlowCookie(req.cookies?.[FLOW_COOKIE] ?? parseFlowFromHeader(req));
      res.clearCookie(FLOW_COOKIE, { path: "/api/oauth" });

      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      if (!flow || flow.p !== def.id || !state || flow.s !== state) {
        return loginError(res, "sso_state_mismatch");
      }
      if (!code) {
        // User cancelled at the provider, or the provider returned an error.
        return loginError(res, "sso_cancelled");
      }

      // ── Code exchange (PKCE) ──
      assertEgressAllowed(def.tokenUrl, `${def.label} token exchange`);
      const tokenRes = await fetch(def.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: def.clientId,
          client_secret: def.clientSecret,
          redirect_uri: redirectUriFor(req, def.id),
          code_verifier: flow.v,
        }).toString(),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => "");
        console.error(`[sso] ${def.id} token exchange failed (${tokenRes.status}): ${body.slice(0, 300)}`);
        return loginError(res, "sso_failed");
      }
      const tokenBody = (await tokenRes.json()) as { id_token?: string };
      if (!tokenBody.id_token) return loginError(res, "sso_failed");

      // ── ID token: signature + expiry via JWKS, then claim validation ──
      const { payload } = await jwtVerify(tokenBody.id_token, jwksFor(def.jwksUrl), {
        // issuer/audience are validated by validateIdentityClaims (Entra
        // multi-tenant issuers are per-tenant, so jose's exact match can't).
        clockTolerance: 60,
      });
      const identity = validateIdentityClaims(def, payload as Record<string, unknown>, flow.n);
      if (!identity.ok || !identity.email) {
        console.warn(`[sso] ${def.id} claim validation failed: ${identity.errors.join("; ")}`);
        return loginError(res, "sso_failed");
      }

      // ── Account mapping: existing, active, invited users only ──
      const db = await getDb();
      if (!db) return loginError(res, "sso_failed");
      const [user] = await db.select().from(users).where(eq(users.email, identity.email)).limit(1);
      if (!user || !user.isActive || user.isGuest) {
        return loginError(res, "no_account");
      }
      if (!(await isOrgLoginAllowed(user.organizationId))) {
        return loginError(res, "org_suspended");
      }

      // ── Mint the session (same shape as magic-link login) ──
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name || identity.name || "",
        expiresInMs: ONE_YEAR_MS,
      });
      await db
        .update(users)
        .set({ lastSignedIn: new Date(), loginMethod: def.id })
        .where(eq(users.id, user.id));

      try {
        const { createAuditLog } = await import("../db");
        const ip =
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "unknown";
        await createAuditLog({
          userId: user.id,
          organizationId: user.organizationId ?? null,
          action: `${def.id}_oauth_login`,
          entityType: "user_session",
          details: JSON.stringify({ email: user.email, provider: def.id }),
          ipAddress: ip,
          userAgent: (req.headers["user-agent"] || "unknown").substring(0, 500),
        });
      } catch {
        /* audit logging must never block login */
      }

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      return res.redirect(302, "/dashboard");
    } catch (err) {
      console.error("[sso] callback failed:", err);
      loginError(res, "sso_failed");
    }
  });
}

/** cookie-parser isn't installed; read the flow cookie from the raw header. */
function parseFlowFromHeader(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === FLOW_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
