import crypto from "node:crypto";
import { and, eq, ne, or } from "drizzle-orm";
import { organizations, users } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyConnectorTokens,
  shopifyShopRedactionJobs,
  type ShopifyConnectorStore,
} from "../../../drizzle/shopify_schema";
import type { DbTransaction } from "../../db";

/**
 * Durable admission for Shopify's `shop/redact` compliance webhook.
 *
 * This deliberately performs only the reversible, safety-critical first stage:
 * create an idempotent job, fence the tenant, revoke Shopify credentials and
 * deactivate merchant identities. The separate processor is responsible for
 * completing the reviewed deletion manifest; this function must never claim
 * redaction is complete.
 */
export async function admitShopifyShopRedaction(
  tx: DbTransaction,
  params: {
    store: Pick<ShopifyConnectorStore, "id" | "organizationId" | "shopDomain">;
    requestHash: string;
    webhookId: string;
  },
): Promise<{ runId: string; status: "admitted" | "duplicate" }> {
  // Order against order syncs: they hold this same row for their whole write
  // (syncOrchestrator's per-store lock), so admission waits for an in-flight
  // sync to commit, and a sync that starts afterwards sees the fence.
  await tx
    .select({ id: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .where(and(eq(shopifyConnectorStores.id, params.store.id), eq(shopifyConnectorStores.organizationId, params.store.organizationId)))
    .limit(1)
    .for("update");

  const [existing] = await tx
    .select({ runId: shopifyShopRedactionJobs.runId })
    .from(shopifyShopRedactionJobs)
    .where(
      or(
        eq(shopifyShopRedactionJobs.requestHash, params.requestHash),
        eq(shopifyShopRedactionJobs.storeId, params.store.id),
      ),
    )
    .limit(1);
  if (existing) return { runId: existing.runId, status: "duplicate" };

  const runId = crypto.randomUUID();
  await tx.insert(shopifyShopRedactionJobs).values({
    runId,
    organizationId: params.store.organizationId,
    storeId: params.store.id,
    requestHash: params.requestHash,
    webhookId: params.webhookId,
    status: "admitted",
  });

  // The fence comes before deleting credentials or deactivating identities. A
  // request that races a reinstallation must fail closed rather than recreate
  // the merchant workspace while redaction is pending.
  await tx
    .update(organizations)
    .set({ isActive: false, deletionState: "redacting", redactionRunId: runId, redactingAt: new Date() })
    .where(and(eq(organizations.id, params.store.organizationId), eq(organizations.deletionState, "active")));
  await tx.update(users).set({ isActive: false }).where(eq(users.organizationId, params.store.organizationId));
  // The fence is tenant-wide, so the credentials are too. A multi-store tenant
  // keeping another store's token would leave a live credential inside a
  // workspace that is being deleted.
  await tx
    .delete(shopifyConnectorTokens)
    .where(eq(shopifyConnectorTokens.organizationId, params.store.organizationId));
  await tx
    .update(shopifyConnectorStores)
    .set({ status: "redacting", statusReason: "shop_redact_requested", lastWebhookAt: new Date() })
    .where(and(eq(shopifyConnectorStores.id, params.store.id), eq(shopifyConnectorStores.organizationId, params.store.organizationId)));
  // Every other store of the tenant stops syncing too: order sync and the token
  // reader both require an `active` store.
  await tx
    .update(shopifyConnectorStores)
    .set({ status: "redacting", statusReason: "organization_redacting" })
    .where(
      and(
        eq(shopifyConnectorStores.organizationId, params.store.organizationId),
        ne(shopifyConnectorStores.id, params.store.id),
        ne(shopifyConnectorStores.status, "redacting"),
      ),
    );

  return { runId, status: "admitted" };
}

/** Tenant work must not create, persist, or egress data after redaction begins. */
export function isOrganizationRedacting(state: string | null | undefined): boolean {
  return state === "redacting";
}
