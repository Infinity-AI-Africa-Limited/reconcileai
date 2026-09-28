import { publicProcedure, router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import {
  authenticateShopifyEmbeddedRequest,
  ShopifyEmbeddedAuthError,
  shopifyEmbeddedAuthHttpStatus,
} from "../connectors/shopify/embeddedAuth";
import {
  appHomeError,
  loadAppHomeView,
  safeSettlementEvidenceResult,
  safeSyncReport,
  settlementEvidenceFailure,
  settlementEvidenceInput,
  syncFailure,
} from "../connectors/shopify/appHome";
import { importShopifySettlementEvidence } from "../connectors/shopify/settlementEvidence";
import { runShopifyOrderSync } from "../connectors/shopify/syncOrchestrator";

/**
 * Shopify App Home: the workspace embedded in Shopify Admin.
 *
 * Its authority is a Shopify App Bridge ID token, sent fresh with every call as
 * `Authorization: Bearer …` — NOT the ReconcileAI session. So these procedures
 * never read `ctx.user`: a browser that also holds a ReconcileAI cookie gains
 * nothing here, and the tenant and store come only from the verified token.
 */
const embeddedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  try {
    const shopify = await authenticateShopifyEmbeddedRequest(ctx.req.headers?.authorization);
    return next({ ctx: { ...ctx, shopify } });
  } catch (error) {
    if (error instanceof ShopifyEmbeddedAuthError && shopifyEmbeddedAuthHttpStatus(error) === 401) {
      throw appHomeError("UNAUTHORIZED", "authentication_required");
    }
    if (!(error instanceof ShopifyEmbeddedAuthError)) console.error("[shopify-app-home] authentication service failed");
    throw appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
  }
});

async function database() {
  const db = await getDb();
  if (!db) throw appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
  return db;
}

export const shopifyAppHomeRouter = router({
  /** Public configuration: the app's API key, which App Bridge needs to start. */
  config: publicProcedure.query(() => {
    const apiKey = ENV.shopifyClientId.trim();
    if (!apiKey) throw appHomeError("SERVICE_UNAVAILABLE", "configuration_unavailable");
    return { apiKey };
  }),

  context: embeddedProcedure.query(async ({ ctx }) => {
    try {
      return await loadAppHomeView(await database(), ctx.shopify);
    } catch (error) {
      console.error("[shopify-app-home] context lookup failed", {
        storeId: ctx.shopify.storeId,
        organizationId: ctx.shopify.organizationId,
      });
      throw appHomeError("SERVICE_UNAVAILABLE", "service_unavailable");
    }
  }),

  syncNow: embeddedProcedure.mutation(async ({ ctx }) => {
    try {
      const report = await runShopifyOrderSync({
        storeId: ctx.shopify.storeId,
        organizationId: ctx.shopify.organizationId,
        trigger: "manual",
      });
      return safeSyncReport(report);
    } catch (error) {
      const refusal = syncFailure(error);
      console.error("[shopify-app-home] manual sync failed", {
        storeId: ctx.shopify.storeId,
        organizationId: ctx.shopify.organizationId,
        category: refusal.message,
      });
      throw refusal;
    }
  }),

  importSettlementEvidence: embeddedProcedure.input(settlementEvidenceInput).mutation(async ({ ctx, input }) => {
    try {
      return safeSettlementEvidenceResult(await importShopifySettlementEvidence(ctx.shopify, input, await database()));
    } catch (error) {
      const refusal = settlementEvidenceFailure(error);
      if (refusal.message === "service_unavailable") {
        console.error("[shopify-app-home] settlement evidence import failed", {
          storeId: ctx.shopify.storeId,
          organizationId: ctx.shopify.organizationId,
        });
      }
      throw refusal;
    }
  }),
});
