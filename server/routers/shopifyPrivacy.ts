/**
 * The Shopify privacy procedures, split out of shopifyConnector.ts to keep
 * that router under the 150-line rule in CLAUDE.md section 16.
 *
 * They are exported as procedures rather than as a router of their own, and
 * spread back into `shopifyConnectorRouter`, so the client-facing tRPC path
 * `shopifyConnector.listPrivacyDeliveries` is unchanged by the move.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { organizations } from "../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyPrivacyArtifacts,
  shopifyPrivacyDataRequestJobs,
} from "../../drizzle/shopify_schema";
import { protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";

export const shopifyPrivacyProcedures = {
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
};
