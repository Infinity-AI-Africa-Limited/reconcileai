import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyPrivacyArtifacts,
  shopifyPrivacyDataRequestJobs,
} from "../../drizzle/shopify_schema";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { loggableError } from "../dbErrors";
import { resolveOrgScope } from "../_core/tenancy";
import { canActOnTenant } from "./shared";
import { requestShopifyManualSync, ShopifyManualSyncError } from "../connectors/shopify/manualSync";

/**
 * The merchant-safe view of a store. Tokens live in another table and never
 * reach a projection; this also omits the claiming user id and the Shopify shop
 * id, which the page has no use for. Exported so a test can pin the allow-list.
 */
export const SHOPIFY_STORE_PUBLIC_FIELDS = {
  id: shopifyConnectorStores.id,
  shopDomain: shopifyConnectorStores.shopDomain,
  displayName: shopifyConnectorStores.displayName,
  currency: shopifyConnectorStores.currency,
  ianaTimezone: shopifyConnectorStores.ianaTimezone,
  requestedScopes: shopifyConnectorStores.requestedScopes,
  grantedScopes: shopifyConnectorStores.grantedScopes,
  status: shopifyConnectorStores.status,
  statusReason: shopifyConnectorStores.statusReason,
  claimedAt: shopifyConnectorStores.claimedAt,
  uninstalledAt: shopifyConnectorStores.uninstalledAt,
  lastWebhookAt: shopifyConnectorStores.lastWebhookAt,
  createdAt: shopifyConnectorStores.createdAt,
};

export const shopifyConnectorRouter = router({
  /** Merchant-safe connection summary; access tokens and contact details never leave the server. */
  listStores: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // Scope is decided before any connection is opened, so a refused call
      // never depends on the database being up.
      const organizationId = resolveOrgScope(ctx.user, input?.organizationId);
      // The override is staff-only (resolveOrgScope), but staff reach narrows to
      // the tenant on screen inside a portal — the rule canActOnTenant carries
      // (CLAUDE.md §6). Otherwise a stale id from tenant B, opened in tenant A's
      // portal, would list B's stores under A's banner.
      if (!canActOnTenant(ctx.user, organizationId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Leave this organisation's portal to view another" });
      }
      const db = await getDb();
      // Refuse rather than answer []: "no stores" would tell a merchant their
      // connection is gone when the database is merely unreachable.
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      return db
        .select(SHOPIFY_STORE_PUBLIC_FIELDS)
        .from(shopifyConnectorStores)
        .where(eq(shopifyConnectorStores.organizationId, organizationId))
        .orderBy(desc(shopifyConnectorStores.createdAt));
    }),

  /**
   * Authenticated portal delivery channel for privacy exports. No selector,
   * object key, digest, internal tenant/store id or presigned URL is projected.
   * Super admins are intentionally not a substitute for the merchant claimant.
   */
  listPrivacyDeliveries: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin" || !ctx.user.isActive || !ctx.user.organizationId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Merchant administrator access is required" });
    }
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return db
      .select({
        artifactId: shopifyPrivacyArtifacts.publicId,
        kind: shopifyPrivacyArtifacts.artifactKind,
        recordsFound: shopifyPrivacyArtifacts.recordsFound,
        generatedAt: shopifyPrivacyArtifacts.generatedAt,
        expiresAt: shopifyPrivacyArtifacts.expiresAt,
        deliveryStatus: shopifyPrivacyArtifacts.deliveryStatus,
      })
      .from(shopifyPrivacyArtifacts)
      .innerJoin(
        shopifyConnectorStores,
        and(
          eq(shopifyConnectorStores.id, shopifyPrivacyArtifacts.storeId),
          eq(shopifyConnectorStores.organizationId, shopifyPrivacyArtifacts.organizationId),
          eq(shopifyConnectorStores.claimedByUserId, ctx.user.id),
        ),
      )
      .innerJoin(
        shopifyPrivacyDataRequestJobs,
        and(
          eq(shopifyPrivacyDataRequestJobs.requestId, shopifyPrivacyArtifacts.requestId),
          eq(shopifyPrivacyDataRequestJobs.organizationId, shopifyPrivacyArtifacts.organizationId),
          eq(shopifyPrivacyDataRequestJobs.storeId, shopifyPrivacyArtifacts.storeId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, shopifyPrivacyArtifacts.organizationId))
      .where(
        and(
          eq(shopifyPrivacyArtifacts.organizationId, ctx.user.organizationId),
          eq(shopifyPrivacyArtifacts.recipientUserId, ctx.user.id),
          eq(shopifyPrivacyArtifacts.status, "ready"),
          gt(shopifyPrivacyArtifacts.expiresAt, new Date()),
          // The same rule as the download (mayDownloadShopifyPrivacyArtifact):
          // offered only once its job says so, and never after shop/redact
          // has fenced the tenant.
          eq(shopifyPrivacyDataRequestJobs.status, "awaiting_delivery"),
          eq(organizations.deletionState, "active"),
          ne(shopifyConnectorStores.status, "redacting"),
        ),
      )
      .orderBy(desc(shopifyPrivacyArtifacts.generatedAt));
  }),

  /**
   * Queues a merchant-authorised read-only order evidence sync and answers at
   * once; the sync runs on the job queue (connectors/shopify/manualSync.ts). It
   * does not mutate Shopify and it intentionally stays admin-gated because it
   * writes only the caller's tenant reconciliation workspace.
   */
  syncOrdersNow: protectedProcedure
    .input(z.object({ storeId: z.number().int().positive(), organizationId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Administrator access is required to start a Shopify sync" });
      }
      const organizationId = resolveOrgScope(ctx.user, input.organizationId);
      if (!canActOnTenant(ctx.user, organizationId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Leave this organisation's portal to sync another" });
      }
      try {
        const { requestNumber, requestedAt } = await requestShopifyManualSync({ storeId: input.storeId, organizationId });
        return { status: "queued" as const, requestNumber, requestedAt: requestedAt.toISOString() };
      } catch (error) {
        // The store is looked up by id, tenant and status together: another
        // tenant's store, an unknown id and a disconnected store get one answer.
        if (error instanceof ShopifyManualSyncError && error.code === "STORE_UNAVAILABLE") {
          throw new TRPCError({ code: "NOT_FOUND", message: "No connected Shopify store with that id in this organisation" });
        }
        // `code` is the operation that failed; loggableError adds the driver's
        // own code as `errorCode` and never a query or its parameters, which
        // for this procedure would carry a merchant's address.
        console.error("[shopify-sync] manual order sync could not be queued", {
          organizationId,
          storeId: input.storeId,
          code: error instanceof ShopifyManualSyncError ? error.code : "unexpected",
          ...loggableError(error),
        });
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The Shopify order sync could not be started. Try again shortly." });
      }
    }),
});
