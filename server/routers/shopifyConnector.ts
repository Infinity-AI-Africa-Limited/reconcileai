import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { shopifyConnectorStores } from "../../drizzle/shopify_schema";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { resolveOrgScope } from "../_core/tenancy";

export const shopifyConnectorRouter = router({
  /** Merchant-safe connection summary; access tokens and contact details never leave the server. */
  listStores: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const organizationId = resolveOrgScope(ctx.user, input.organizationId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      return db
        .select({
          id: shopifyConnectorStores.id,
          shopDomain: shopifyConnectorStores.shopDomain,
          displayName: shopifyConnectorStores.displayName,
          currency: shopifyConnectorStores.currency,
          ianaTimezone: shopifyConnectorStores.ianaTimezone,
          requestedScopes: shopifyConnectorStores.requestedScopes,
          grantedScopes: shopifyConnectorStores.grantedScopes,
          status: shopifyConnectorStores.status,
          claimedAt: shopifyConnectorStores.claimedAt,
          uninstalledAt: shopifyConnectorStores.uninstalledAt,
          lastWebhookAt: shopifyConnectorStores.lastWebhookAt,
          createdAt: shopifyConnectorStores.createdAt,
        })
        .from(shopifyConnectorStores)
        .where(eq(shopifyConnectorStores.organizationId, organizationId))
        .orderBy(desc(shopifyConnectorStores.createdAt));
    }),
});
