import { and, eq } from "drizzle-orm";
import {
  SHOPIFY_ORDER_LED_SCOPES,
  shopifyConnectorStores,
  shopifyConnectorTokens,
} from "../../../drizzle/shopify_schema";
import { ENV } from "../../_core/env";
import { getDb } from "../../db";
import { loggableError } from "../../dbErrors";
import {
  exchangeShopifyIdTokenForOfflineAccess,
  requiredScopesGranted,
} from "./auth";
import { fetchShopifyShopMetadata } from "./apiClient";
import { verifyShopifyIdToken } from "./embeddedAuth";
import { acquireInstallLease, releaseInstallLease } from "./installLease";
import {
  failClosedAfterTokenExchange,
  onboardShopifyMerchant,
  suspendForReauthorization,
  type ShopifyOnboardingResult,
} from "./onboarding";
import { confirmShopifyRuntimeQueues } from "./runtimeQueueReadiness";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type ShopifyManagedInstallErrorCode =
  | "DURABLE_QUEUE_UNAVAILABLE"
  | "INSTALLATION_IN_PROGRESS"
  | "ID_TOKEN_REJECTED"
  | "TOKEN_EXCHANGE_RETRY"
  | "TOKEN_EXCHANGE_FAILED"
  | "REQUIRED_PERMISSIONS_NOT_GRANTED"
  | "SHOP_METADATA_UNAVAILABLE";

/** A stable, non-sensitive managed-install failure for the App Home boundary. */
export class ShopifyManagedInstallError extends Error {
  constructor(public readonly code: ShopifyManagedInstallErrorCode) {
    super(code);
    this.name = "ShopifyManagedInstallError";
  }
}

export type ShopifyManagedInstallResult = {
  status: "already_connected" | "connected" | "reconnected";
};

/**
 * Completes Shopify-managed installation only when a verified App Bridge request
 * names a store without an active ReconcileAI connection.
 *
 * It intentionally keeps the bearer token, provider tokens, contact email,
 * tenant ids and store ids inside server boundaries. A current active connection
 * returns before the token exchange, so reopening App Home cannot churn the
 * expiring offline token pair used by workers and webhooks.
 */
export async function completeShopifyManagedInstall(params: {
  authorization: string | undefined;
  origin: string;
}): Promise<ShopifyManagedInstallResult> {
  const identity = await verifyShopifyIdToken(params.authorization);
  const queueReadiness = await confirmShopifyRuntimeQueues();
  if (!queueReadiness.durable)
    throw new ShopifyManagedInstallError("DURABLE_QUEUE_UNAVAILABLE");

  const db = await getDb();
  if (!db) throw new ShopifyManagedInstallError("TOKEN_EXCHANGE_RETRY");
  if (await hasActiveStore(db, identity.shopDomain))
    return { status: "already_connected" };

  const leaseId = await acquireInstallLease(db, identity.shopDomain);
  if (!leaseId)
    throw new ShopifyManagedInstallError("INSTALLATION_IN_PROGRESS");
  const lease = { shopDomain: identity.shopDomain, leaseId };

  try {
    // A callback may have completed while this request waited for the lease. The
    // lease serializes both legacy callbacks and managed exchanges, so after this
    // second check no other installation can make the store active behind us.
    if (await hasActiveStore(db, identity.shopDomain))
      return { status: "already_connected" };

    const reauthorization = await suspendForReauthorization(lease);
    if (!reauthorization)
      throw new ShopifyManagedInstallError("INSTALLATION_IN_PROGRESS");

    const exchange = await exchangeShopifyIdTokenForOfflineAccess({
      shopDomain: identity.shopDomain,
      clientId: ENV.shopifyClientId,
      clientSecret: ENV.shopifyClientSecret,
      idToken: bearerToken(params.authorization),
      reauthorization,
    });
    if (exchange.kind === "id_token_rejected")
      throw new ShopifyManagedInstallError("ID_TOKEN_REJECTED");
    if (exchange.kind === "retry")
      throw new ShopifyManagedInstallError("TOKEN_EXCHANGE_RETRY");
    if (exchange.kind === "failed")
      throw new ShopifyManagedInstallError("TOKEN_EXCHANGE_FAILED");

    // Shopify has issued a new offline pair at this point, retiring any prior
    // refresh token for this app. Every refusal below therefore removes only the
    // exact retired generation while the lease is still held.
    if (
      !requiredScopesGranted(exchange.token.scope, SHOPIFY_ORDER_LED_SCOPES)
    ) {
      await failClosedAfterTokenExchange(lease, reauthorization);
      throw new ShopifyManagedInstallError("REQUIRED_PERMISSIONS_NOT_GRANTED");
    }

    let metadata;
    try {
      metadata = await fetchShopifyShopMetadata({
        shopDomain: identity.shopDomain,
        accessToken: exchange.token.access_token,
      });
    } catch {
      await failClosedAfterTokenExchange(lease, reauthorization);
      throw new ShopifyManagedInstallError("SHOP_METADATA_UNAVAILABLE");
    }

    const onboarding = await onboardShopifyMerchant({
      shopDomain: identity.shopDomain,
      metadata,
      tokenResponse: exchange.token,
      origin: params.origin,
      reauthorization,
      lease,
    });
    return managedInstallResult(onboarding);
  } finally {
    await releaseInstallLease(db, identity.shopDomain, leaseId).catch(
      (error: unknown) => {
        console.warn("[shopify-managed-install] lease release failed", {
          code: "lease_release_failed",
          ...loggableError(error),
        });
      }
    );
  }
}

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  // verifyShopifyIdToken already made this exact check. Repeating it prevents a
  // refactor from ever forwarding a malformed header to Shopify's token endpoint.
  if (!match) throw new ShopifyManagedInstallError("ID_TOKEN_REJECTED");
  return match[1];
}

async function hasActiveStore(db: Db, shopDomain: string): Promise<boolean> {
  const [store] = await db
    .select({ id: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .innerJoin(shopifyConnectorTokens, eq(shopifyConnectorTokens.storeId, shopifyConnectorStores.id))
    .where(
      and(
        eq(shopifyConnectorStores.shopDomain, shopDomain),
        eq(shopifyConnectorStores.status, "active")
      )
    )
    .limit(1);
  return Boolean(store);
}

function managedInstallResult(
  result: ShopifyOnboardingResult
): ShopifyManagedInstallResult {
  return { status: result.isReinstallation ? "reconnected" : "connected" };
}
