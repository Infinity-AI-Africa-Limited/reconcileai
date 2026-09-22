import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { shopifyConnectorStores } from "../../drizzle/shopify_schema";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { resolveOrgScope } from "../_core/tenancy";
import { canActOnTenant } from "./shared";

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
});
