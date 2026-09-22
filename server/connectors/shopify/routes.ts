import crypto from "node:crypto";
import express, { type Request } from "express";
import { lt } from "drizzle-orm";
import {
  SHOPIFY_OAUTH_STATE_TTL_MS,
  SHOPIFY_ORDER_LED_SCOPES,
  shopifyOauthStates,
} from "../../../drizzle/shopify_schema";
import { getSessionCookieOptions } from "../../_core/cookies";
import { ENV } from "../../_core/env";
import { getDb } from "../../db";
import { isDuplicateKeyError } from "../../dbErrors";
import {
  buildShopifyAuthorizationUrl,
  exchangeAuthorizationCode,
  normalizeShopDomain,
  parseUniqueQuery,
  requiredScopesGranted,
  sha256,
  signOAuthState,
  verifyOAuthState,
  verifyShopifyCallbackHmac,
} from "./auth";
import { fetchShopifyShopMetadata } from "./apiClient";
import { onboardShopifyMerchant, ShopifyOnboardingError, suspendForReauthorization } from "./onboarding";

const FLOW_COOKIE = "shopify_oauth_flow";

/** Consumed states are kept this long past expiry for diagnosis, then purged. */
const STATE_RETENTION_AFTER_EXPIRY_MS = 60 * 60_000;

/** The error-page reason for a failed callback. Pure, so every mapping is testable. */
export function callbackReasonFor(error: unknown): string {
  if (!(error instanceof ShopifyOnboardingError)) return "install_failed";
  switch (error.code) {
    case "OWNERSHIP_UNVERIFIED":
      return "ownership_verification_required";
    case "EMAIL_CONFLICT":
      return "email_already_registered";
    case "MISSING_CONTACT_EMAIL":
      return "missing_contact_email";
    case "SHOP_IDENTITY_CONFLICT":
    case "WORKSPACE_CONFLICT":
      return "store_identity_conflict";
    default:
      return "install_failed";
  }
}

class ShopifyNotConfiguredError extends Error {}

/**
 * The canonical origin for OAuth redirects and emailed sign-in links.
 *
 * In production it must come from APP_URL. Derived from the request it would
 * trust the Host header, and — with no `trust proxy` set — read the protocol as
 * `http` behind Railway's proxy, producing a redirect URI Shopify rejects and
 * magic links on the wrong scheme.
 */
function appOrigin(req: Request): string {
  if (ENV.appUrl) return ENV.appUrl.replace(/\/+$/, "");
  if (ENV.isProduction) throw new ShopifyNotConfiguredError("APP_URL is not configured");
  const host = req.get("host");
  if (!host) throw new Error("Request has no host");
  return `${req.protocol}://${host}`;
}

function redirectUri(req: Request): string {
  return `${appOrigin(req)}/api/shopify/callback`;
}

/** cookie-parser is not installed; parse one named cookie without decoding other values. */
function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function sameState(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function callbackError(res: express.Response, reason: string): void {
  res.redirect(302, `/shopify/error?reason=${encodeURIComponent(reason)}`);
}

/**
 * OAuth endpoints are HTTP rather than tRPC because Shopify initiates the
 * install flow. All callback-controlled values are validated before any token
 * exchange, database write, or external API call.
 *
 * Every `await` sits inside a try. Express 4 does not catch a rejected async
 * handler, and this server registers no `unhandledRejection` handler, so on
 * Node 22 one database error escaping a route would exit the process.
 */
export function createShopifyRouter(): express.Router {
  const router = express.Router();

  // No database access and no rate limit, deliberately: the state is signed,
  // not stored, so an unauthenticated hit costs one HMAC and a redirect. A
  // limiter here could only have been keyed on a client-written header.
  router.get("/api/shopify/install", (req, res) => {
    const shopDomain = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : undefined);
    if (!shopDomain) return callbackError(res, "invalid_shop");
    if (!ENV.shopifyClientId || !ENV.shopifyClientSecret) {
      console.error("[shopify-oauth] SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not configured");
      return callbackError(res, "not_configured");
    }

    try {
      const callbackUri = redirectUri(req);
      const { state } = signOAuthState({ shopDomain, secret: ENV.shopifyClientSecret, ttlMs: SHOPIFY_OAUTH_STATE_TTL_MS });
      const baseCookie = getSessionCookieOptions(req);
      res.cookie(FLOW_COOKIE, state, {
        ...baseCookie,
        sameSite: "lax",
        path: "/api/shopify",
        maxAge: SHOPIFY_OAUTH_STATE_TTL_MS,
      });
      return res.redirect(
        302,
        buildShopifyAuthorizationUrl({
          shopDomain,
          clientId: ENV.shopifyClientId,
          redirectUri: callbackUri,
          scopes: SHOPIFY_ORDER_LED_SCOPES,
          state,
        }),
      );
    } catch (error) {
      if (error instanceof ShopifyNotConfiguredError) {
        console.error("[shopify-oauth] install refused: APP_URL is not configured in production");
        return callbackError(res, "not_configured");
      }
      console.error("[shopify-oauth] install start failed", {
        shopDomain,
        message: error instanceof Error ? error.message : String(error),
      });
      return callbackError(res, "temporarily_unavailable");
    }
  });

  router.get("/api/shopify/callback", async (req, res) => {
    const query = parseUniqueQuery(req.query as Record<string, unknown>);
    if (!query || !ENV.shopifyClientId || !ENV.shopifyClientSecret) return callbackError(res, "invalid_callback");

    const shopDomain = normalizeShopDomain(query.shop);
    const state = query.state;
    const code = query.code;
    const cookieState = cookieValue(req, FLOW_COOKIE);
    res.clearCookie(FLOW_COOKIE, { path: "/api/shopify" });
    if (!shopDomain || !state || !code || !sameState(cookieState, state)) {
      return callbackError(res, "security_check_failed");
    }
    if (!verifyShopifyCallbackHmac(query, ENV.shopifyClientSecret)) {
      return callbackError(res, "security_check_failed");
    }

    // Authentic, unexpired and issued for THIS shop — checked without the database.
    const stateExpiresAt = verifyOAuthState(state, {
      shopDomain,
      secret: ENV.shopifyClientSecret,
      ttlMs: SHOPIFY_OAUTH_STATE_TTL_MS,
    });
    if (!stateExpiresAt) return callbackError(res, "expired_or_replayed");

    try {
      const db = await getDb();
      if (!db) return callbackError(res, "temporarily_unavailable");
      const origin = appOrigin(req);

      // Consume before the external exchange so a retry cannot reuse the same
      // authorization code. The unique index on stateHash is the arbiter: of
      // two concurrent callbacks carrying one state, exactly one insert lands.
      // This is the first write in the flow, and it happens only after Shopify's
      // HMAC and our own signature have both verified.
      try {
        await db.insert(shopifyOauthStates).values({
          shopDomain,
          stateHash: sha256(state),
          expiresAt: stateExpiresAt,
          consumedAt: new Date(),
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) return callbackError(res, "expired_or_replayed");
        throw error;
      }
      await purgeExpiredStates(db);

      // Last write before the exchange, and deliberately so: the exchange
      // retires the shop's stored refresh token, so its live connection goes
      // out of service first. If this fails we stop here, with nothing retired.
      const reauthorization = await suspendForReauthorization(shopDomain);

      const tokens = await exchangeAuthorizationCode({
        shopDomain,
        clientId: ENV.shopifyClientId,
        clientSecret: ENV.shopifyClientSecret,
        code,
      });
      if (!requiredScopesGranted(tokens.scope, SHOPIFY_ORDER_LED_SCOPES)) {
        return callbackError(res, "required_permissions_not_granted");
      }
      const metadata = await fetchShopifyShopMetadata({ shopDomain, accessToken: tokens.access_token });
      const result = await onboardShopifyMerchant({ shopDomain, metadata, tokenResponse: tokens, origin, reauthorization });
      // No internal store id in the URL: the page needs only the shop, and an
      // id in a shareable link is an enumeration handle with no purpose.
      const params = new URLSearchParams({
        shop: shopDomain,
        installed: result.isReinstallation ? "reconnected" : "connected",
        email: result.welcomeEmailSent ? "sent" : "pending",
      });
      return res.redirect(302, `/shopify/welcome?${params.toString()}`);
    } catch (error) {
      if (error instanceof ShopifyNotConfiguredError) {
        console.error("[shopify-oauth] callback refused: APP_URL is not configured in production");
        return callbackError(res, "not_configured");
      }
      console.error("[shopify-oauth] callback failed", {
        shopDomain,
        code: error instanceof ShopifyOnboardingError ? error.code : undefined,
        storeFailClosed: error instanceof ShopifyOnboardingError ? error.storeFailClosed : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
      return callbackError(res, callbackReasonFor(error));
    }
  });

  return router;
}

/** Best-effort housekeeping: OAuth states are single-use and short-lived. */
async function purgeExpiredStates(db: NonNullable<Awaited<ReturnType<typeof getDb>>>): Promise<void> {
  try {
    await db
      .delete(shopifyOauthStates)
      .where(lt(shopifyOauthStates.expiresAt, new Date(Date.now() - STATE_RETENTION_AFTER_EXPIRY_MS)));
  } catch (error) {
    console.warn("[shopify-oauth] expired state purge failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
