import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { errors as joseErrors, jwtVerify } from "jose";
import { shopifyConnectorStores } from "../../../drizzle/shopify_schema";
import { ENV } from "../../_core/env";
import { getDb } from "../../db";
import { normalizeShopDomain } from "./auth";

export interface ShopifyEmbeddedContext {
  storeId: number;
  organizationId: number;
  shopDomain: string;
  displayName: string;
  currency: string | null;
}

export type ShopifyEmbeddedAuthErrorCode =
  | "CONFIG_UNAVAILABLE"
  | "AUTHORIZATION_REQUIRED"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_NOT_ACTIVE"
  | "AUDIENCE_INVALID"
  | "CLAIMS_INVALID"
  | "SHOP_MISMATCH"
  | "STORE_UNAVAILABLE"
  | "SERVICE_UNAVAILABLE";

/**
 * A non-sensitive failure that an HTTP caller can map without inspecting a JOSE
 * error (whose payload may contain token claims). Token text and JOSE causes are
 * deliberately not retained on this error.
 */
export class ShopifyEmbeddedAuthError extends Error {
  constructor(public readonly code: ShopifyEmbeddedAuthErrorCode) {
    super(code);
    this.name = "ShopifyEmbeddedAuthError";
  }
}

export function shopifyEmbeddedAuthHttpStatus(error: ShopifyEmbeddedAuthError): 401 | 503 {
  return error.code === "CONFIG_UNAVAILABLE" || error.code === "SERVICE_UNAVAILABLE" ? 503 : 401;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyEmbeddedAuthDeps {
  /** Test seam; production always reads the deployment's SHOPIFY_CLIENT_ID. */
  clientId?: string;
  /** Test seam; production always reads the deployment's SHOPIFY_CLIENT_SECRET. */
  clientSecret?: string;
  getDatabase?: () => Promise<Db | null>;
  currentDate?: Date;
}

function configuredValue(override: string | undefined, configured: string): string {
  return (override === undefined ? configured : override).trim();
}

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) throw new ShopifyEmbeddedAuthError("AUTHORIZATION_REQUIRED");
  return match[1];
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Authenticate one Shopify App Bridge ID token and bind it to the active store
 * selected by its signed `dest`/`iss` claims. This performs no provider call and
 * keeps neither the bearer token nor its decoded claims after returning.
 */
export async function authenticateShopifyEmbeddedRequest(
  authorization: Request["headers"]["authorization"],
  deps: ShopifyEmbeddedAuthDeps = {},
): Promise<ShopifyEmbeddedContext> {
  const clientId = configuredValue(deps.clientId, ENV.shopifyClientId);
  const clientSecret = configuredValue(deps.clientSecret, ENV.shopifyClientSecret);
  if (!clientId || !clientSecret) throw new ShopifyEmbeddedAuthError("CONFIG_UNAVAILABLE");

  const token = bearerToken(authorization);
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(clientSecret), {
      algorithms: ["HS256"],
      audience: clientId,
      requiredClaims: ["iss", "dest", "aud", "sub", "exp", "nbf", "iat", "jti", "sid"],
      currentDate: deps.currentDate,
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new ShopifyEmbeddedAuthError("TOKEN_EXPIRED");
    }
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      if (error.claim === "aud") throw new ShopifyEmbeddedAuthError("AUDIENCE_INVALID");
      if (error.claim === "nbf") throw new ShopifyEmbeddedAuthError("TOKEN_NOT_ACTIVE");
      throw new ShopifyEmbeddedAuthError("CLAIMS_INVALID");
    }
    throw new ShopifyEmbeddedAuthError("TOKEN_INVALID");
  }

  // jose's audience option accepts an array containing the expected value. App
  // Bridge tokens for this boundary must instead name exactly this one app.
  if (payload.aud !== clientId) throw new ShopifyEmbeddedAuthError("AUDIENCE_INVALID");

  const destination = httpsUrl(payload.dest);
  const issuer = httpsUrl(payload.iss);
  if (!destination || !issuer || issuer.pathname !== "/admin" || issuer.search || issuer.hash) {
    throw new ShopifyEmbeddedAuthError("CLAIMS_INVALID");
  }

  const destinationShop = normalizeShopDomain(destination.hostname);
  const issuerShop = normalizeShopDomain(issuer.hostname);
  if (!destinationShop || !issuerShop || destinationShop !== issuerShop) {
    throw new ShopifyEmbeddedAuthError("SHOP_MISMATCH");
  }

  let db: Db | null;
  try {
    db = await (deps.getDatabase ?? getDb)();
  } catch {
    throw new ShopifyEmbeddedAuthError("SERVICE_UNAVAILABLE");
  }
  if (!db) throw new ShopifyEmbeddedAuthError("SERVICE_UNAVAILABLE");

  try {
    const [store] = await db
      .select({
        storeId: shopifyConnectorStores.id,
        organizationId: shopifyConnectorStores.organizationId,
        shopDomain: shopifyConnectorStores.shopDomain,
        displayName: shopifyConnectorStores.displayName,
        currency: shopifyConnectorStores.currency,
      })
      .from(shopifyConnectorStores)
      .where(
        and(
          eq(shopifyConnectorStores.shopDomain, destinationShop),
          eq(shopifyConnectorStores.status, "active"),
        ),
      )
      .limit(1);
    if (!store) throw new ShopifyEmbeddedAuthError("STORE_UNAVAILABLE");
    return {
      storeId: store.storeId,
      organizationId: store.organizationId,
      shopDomain: store.shopDomain,
      displayName: store.displayName,
      currency: store.currency,
    };
  } catch (error) {
    if (error instanceof ShopifyEmbeddedAuthError) throw error;
    throw new ShopifyEmbeddedAuthError("SERVICE_UNAVAILABLE");
  }
}
