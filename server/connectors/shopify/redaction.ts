import crypto from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { organizations, users } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyConnectorTokens,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequests,
  shopifyShopRedactionJobs,
  type ShopifyConnectorStore,
} from "../../../drizzle/shopify_schema";
import type { DbTransaction } from "../../db";
import { affectedRows } from "./tokenStore";

/**
 * Durable admission for Shopify's `shop/redact` compliance webhook.
 *
 * This deliberately performs only the reversible, safety-critical first stage:
 * create an idempotent job and queue intent, fence the tenant, revoke Shopify
 * credentials and deactivate merchant identities. The separate processor is
 * report-only and must never claim redaction is complete.
 */
export async function admitShopifyShopRedaction(
  tx: DbTransaction,
  params: {
    store: Pick<ShopifyConnectorStore, "id" | "organizationId" | "shopDomain">;
    requestHash: string;
    webhookId: string;
  },
): Promise<{ jobId: number; runId: string; status: "admitted" | "duplicate" }> {
  // Organisation FIRST: it is where every credential write for this tenant
  // serialises. A reauthorization of any store either commits before this fence
  // (and its credential pair is deleted below), or waits and then sees it.
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, params.store.organizationId))
    .limit(1)
    .for("update");
  // Then against order syncs: they hold this same row for their whole write, so
  // admission waits for an in-flight sync to commit and later syncs see the fence.
  await tx
    .select({ id: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .where(and(eq(shopifyConnectorStores.id, params.store.id), eq(shopifyConnectorStores.organizationId, params.store.organizationId)))
    .limit(1)
    .for("update");

  const [existing] = await tx
    .select({
      jobId: shopifyShopRedactionJobs.id,
      runId: shopifyShopRedactionJobs.runId,
      privacyRequestId: shopifyShopRedactionJobs.privacyRequestId,
      status: shopifyShopRedactionJobs.status,
    })
    .from(shopifyShopRedactionJobs)
    .where(
      and(
        eq(shopifyShopRedactionJobs.organizationId, params.store.organizationId),
        or(
          eq(shopifyShopRedactionJobs.requestHash, params.requestHash),
          eq(shopifyShopRedactionJobs.storeId, params.store.id),
        ),
      ),
    )
    .limit(1);
  if (existing) {
    const dispatchable = ["admitted", "failed_retryable", "processing"];
    if (existing.privacyRequestId === null) {
      // `shop/redact` jobs admitted before the report-only worker had no parent
      // request or outbox intent. A verified redelivery is the only safe source
      // of the matching request hash, so backfill just those durable links and
      // resume the non-destructive inventory gate—never a deletion operation.
      const [legacyRequest] = await tx
        .select({ id: shopifyPrivacyRequests.id })
        .from(shopifyPrivacyRequests)
        .where(
          and(
            eq(shopifyPrivacyRequests.organizationId, params.store.organizationId),
            eq(shopifyPrivacyRequests.storeId, params.store.id),
            eq(shopifyPrivacyRequests.topic, "shop/redact"),
            eq(shopifyPrivacyRequests.requestHash, params.requestHash),
          ),
        )
        .limit(1)
        .for("update");
      if (!legacyRequest) throw new Error("Legacy Shopify shop-redact request could not be resolved");
      const backfill = await tx
        .update(shopifyShopRedactionJobs)
        .set({
          privacyRequestId: legacyRequest.id,
          status: "admitted",
          lastCheckpoint: "legacy_dispatch_backfilled",
          failureCode: null,
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        })
        .where(
          and(
            eq(shopifyShopRedactionJobs.id, existing.jobId),
            eq(shopifyShopRedactionJobs.organizationId, params.store.organizationId),
            eq(shopifyShopRedactionJobs.storeId, params.store.id),
            isNull(shopifyShopRedactionJobs.privacyRequestId),
          ),
        );
      if (affectedRows(backfill) !== 1) {
        throw new Error("Legacy Shopify shop-redact job changed during backfill");
      }
      await tx
        .insert(shopifyPrivacyQueueOutbox)
        .values({ kind: "shop_redact", jobId: existing.jobId, status: "pending" })
        .onDuplicateKeyUpdate({ set: { jobId: sql`${shopifyPrivacyQueueOutbox.jobId}` } });
    } else if (dispatchable.includes(existing.status)) {
      // Heal a missing outbox intent without resurrecting a terminal report-only
      // record. Queue payload remains internal job id only.
      await tx
        .insert(shopifyPrivacyQueueOutbox)
        .values({ kind: "shop_redact", jobId: existing.jobId, status: "pending" })
        .onDuplicateKeyUpdate({ set: { jobId: sql`${shopifyPrivacyQueueOutbox.jobId}` } });
    }
    return { jobId: existing.jobId, runId: existing.runId, status: "duplicate" };
  }

  const [request] = await tx
    .select({ id: shopifyPrivacyRequests.id })
    .from(shopifyPrivacyRequests)
    .where(
      and(
        eq(shopifyPrivacyRequests.organizationId, params.store.organizationId),
        eq(shopifyPrivacyRequests.storeId, params.store.id),
        eq(shopifyPrivacyRequests.topic, "shop/redact"),
        eq(shopifyPrivacyRequests.requestHash, params.requestHash),
      ),
    )
    .limit(1)
    .for("update");
  if (!request) throw new Error("Admitted Shopify shop-redact request could not be resolved");

  const runId = crypto.randomUUID();
  const inserted = await tx.insert(shopifyShopRedactionJobs).values({
    runId,
    organizationId: params.store.organizationId,
    storeId: params.store.id,
    privacyRequestId: request.id,
    requestHash: params.requestHash,
    webhookId: params.webhookId,
    status: "admitted",
    lastCheckpoint: "admitted",
    manifestVersion: 1,
  });
  const jobId = Number((inserted as unknown as [{ insertId?: number }])[0]?.insertId ?? 0);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error("Shopify shop-redact execution id unavailable");
  }
  await tx
    .insert(shopifyPrivacyQueueOutbox)
    .values({ kind: "shop_redact", jobId, status: "pending" })
    .onDuplicateKeyUpdate({ set: { jobId: sql`${shopifyPrivacyQueueOutbox.jobId}` } });

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
  // workspace that is being redacted.
  await tx
    .delete(shopifyConnectorTokens)
    .where(eq(shopifyConnectorTokens.organizationId, params.store.organizationId));
  await tx
    .update(shopifyConnectorStores)
    .set({ status: "redacting", statusReason: "shop_redact_requested", lastWebhookAt: new Date() })
    .where(and(eq(shopifyConnectorStores.id, params.store.id), eq(shopifyConnectorStores.organizationId, params.store.organizationId)));
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

  return { jobId, runId, status: "admitted" };
}

/** Tenant work must not create, persist, or egress data after redaction begins. */
export function isOrganizationRedacting(state: string | null | undefined): boolean {
  return state === "redacting";
}
