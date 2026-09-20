import crypto from "node:crypto";
import express, { type Request } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  SHOPIFY_OAUTH_STATE_TTL_MS,
  SHOPIFY_ORDER_LED_SCOPES,
  shopifyOauthStates,
} from "../../../drizzle/shopify_schema";
import { getSessionCookieOptions } from "../../_core/cookies";
import { ENV } from "../../_core/env";
import { getDb } from "../../db";
import {
  buildShopifyAuthorizationUrl,
  exchangeAuthorizationCode,
  makeState,
  normalizeShopDomain,
  parseUniqueQuery,
  requiredScopesGranted,
  secureEqualHex,
  sha256,
  verifyShopifyCallbackHmac,
} from "./auth";
import { fetchShopifyShopMetadata } from "./apiClient";
import { onboardShopifyMerchant } from "./onboarding";

const FLOW_COOKIE = "shopify_oauth_flow";

function appOrigin(req: Request): string {
  if (ENV.appUrl) return ENV.appUrl.replace(/\/+$/, "");
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
 */
export function createShopifyRouter(): express.Router {
  const router = express.Router();

  router.get("/api/shopify/install", async (req, res) => {
    const shopDomain = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : undefined);
    if (!shopDomain) return callbackError(res, "invalid_shop");
    if (!ENV.shopifyClientId || !ENV.shopifyClientSecret) return callbackError(res, "not_configured");

    const db = await getDb();
    if (!db) return callbackError(res, "temporarily_unavailable");

    const state = makeState();
    try {
      await db.insert(shopifyOauthStates).values({
        shopDomain,
        stateHash: sha256(state),
        expiresAt: new Date(Date.now() + SHOPIFY_OAUTH_STATE_TTL_MS),
      });
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
          redirectUri: redirectUri(req),
          scopes: SHOPIFY_ORDER_LED_SCOPES,
          state,
        }),
      );
    } catch (error) {
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

    const db = await getDb();
    if (!db) return callbackError(res, "temporarily_unavailable");
    try {
      const [stateRow] = await db
        .select()
        .from(shopifyOauthStates)
        .where(
          and(
            eq(shopifyOauthStates.shopDomain, shopDomain),
            eq(shopifyOauthStates.stateHash, sha256(state)),
            gt(shopifyOauthStates.expiresAt, new Date()),
            isNull(shopifyOauthStates.consumedAt),
          ),
        )
        .limit(1);
      if (!stateRow) return callbackError(res, "expired_or_replayed");

      // Consume before the external exchange so a retry cannot reuse the same
      // authorization code. The conditional update, not the earlier select, is
      // authoritative: two concurrent callbacks may both observe the row, but
      // exactly one can change `consumedAt` from NULL.
      const [consumeResult] = await db
        .update(shopifyOauthStates)
        .set({ consumedAt: new Date() })
        .where(and(eq(shopifyOauthStates.id, stateRow.id), isNull(shopifyOauthStates.consumedAt)));
      const affectedRows = Number((consumeResult as { affectedRows?: number }).affectedRows ?? 0);
      if (affectedRows !== 1) return callbackError(res, "expired_or_replayed");

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
      const result = await onboardShopifyMerchant({
        shopDomain,
        metadata,
        tokenResponse: tokens,
        origin: appOrigin(req),
      });
      const params = new URLSearchParams({
        shop: shopDomain,
        store: String(result.storeId),
        installed: result.isReinstallation ? "reconnected" : "connected",
        email: result.welcomeEmailSent ? "sent" : "pending",
      });
      return res.redirect(302, `/shopify/welcome?${params.toString()}`);
    } catch (error) {
      console.error("[shopify-oauth] callback failed", {
        shopDomain,
        message: error instanceof Error ? error.message : String(error),
      });
      return callbackError(res, "install_failed");
    }
  });

  return router;
}
