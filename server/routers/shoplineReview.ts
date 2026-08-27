/**
 * Read-only, token-gated evidence view for SHOPLINE App Store reviewers.
 *
 * This is not a merchant installation or OAuth substitute. It exposes no raw
 * order/payment data, no credentials, and no mutation procedures. The shared
 * POC access token makes the link revocable without relying on a reviewer
 * account, inbox, or password.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { exceptions, organizations, reconciliationJobs, transactions } from "../../drizzle/schema";
import { slConnectorStores, slConnectorTokens, slConnectorWebhookEvents } from "../../drizzle/connector_schema";
import { getDb } from "../db";
import { assertPocAccess, tokenFromCtx } from "../pocAccess";
import { publicProcedure, router } from "../_core/trpc";

export const SHOPLINE_REVIEW_POC_KEY = "shopline_review";
const REVIEW_ORG_CODE = "SL_RECONCILEAI_DEV";

type SyncInputs = {
  lastSyncAt: Date | null;
  lastSyncAttemptAt: Date | null;
  lastSyncError: string | null;
  tokenRefreshedAt: Date | null;
};

export function reviewSyncStatus({
  lastSyncAt,
  lastSyncAttemptAt,
  lastSyncError,
  tokenRefreshedAt,
}: SyncInputs) {
  if (tokenRefreshedAt && (!lastSyncAttemptAt || tokenRefreshedAt > lastSyncAttemptAt)) {
    return {
      code: "reauthorized_pending" as const,
      label: "Reauthorized — synchronisation verification pending",
      detail: "The SHOPLINE OAuth connection was refreshed after the prior attempt. A new successful sync is required before health is shown as current.",
    };
  }
  if (lastSyncError && lastSyncAttemptAt && (!lastSyncAt || lastSyncAttemptAt > lastSyncAt)) {
    return {
      code: "attention" as const,
      label: "Synchronisation needs attention",
      detail: "The most recent synchronisation attempt did not complete. This review workspace does not conceal that condition.",
    };
  }
  if (lastSyncAt) {
    return {
      code: "current" as const,
      label: "Synchronisation current",
      detail: "The most recent synchronisation attempt completed successfully.",
    };
  }
  return {
    code: "pending" as const,
    label: "Synchronisation pending",
    detail: "The connection is active but no successful synchronisation has yet been recorded.",
  };
}

const reviewProcedure = publicProcedure.use(async ({ ctx, next }) => {
  await assertPocAccess(SHOPLINE_REVIEW_POC_KEY, tokenFromCtx(ctx));
  return next({ ctx });
});

export const shoplineReviewRouter = router({
  snapshot: reviewProcedure
    .input(z.void())
    .query(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Review workspace is temporarily unavailable." });

      const [store] = await db
        .select({
          organizationId: slConnectorStores.organizationId,
          storeId: slConnectorStores.id,
          storeHandle: slConnectorStores.storeHandle,
          status: slConnectorStores.status,
          grantedScopes: slConnectorStores.grantedScopes,
          installedAt: slConnectorStores.installedAt,
          lastSyncAt: slConnectorStores.lastSyncAt,
          lastSyncAttemptAt: slConnectorStores.lastSyncAttemptAt,
          lastSyncError: slConnectorStores.lastSyncError,
          tokenRefreshedAt: slConnectorTokens.refreshedAt,
        })
        .from(slConnectorStores)
        .innerJoin(organizations, eq(organizations.id, slConnectorStores.organizationId))
        .leftJoin(slConnectorTokens, eq(slConnectorTokens.slStoreId, slConnectorStores.id))
        .where(and(eq(organizations.code, REVIEW_ORG_CODE), eq(slConnectorStores.status, "active")))
        .limit(1);

      if (!store) throw new TRPCError({ code: "NOT_FOUND", message: "The ReconcileAI Dev Store review connection is not active." });

      const [webhookCounts] = await db
        .select({
          total: sql<number>`count(*)`,
          processed: sql<number>`sum(case when ${slConnectorWebhookEvents.status} = 'processed' then 1 else 0 end)`,
          pending: sql<number>`sum(case when ${slConnectorWebhookEvents.status} in ('pending', 'processing') then 1 else 0 end)`,
          attention: sql<number>`sum(case when ${slConnectorWebhookEvents.status} in ('failed', 'dlq') then 1 else 0 end)`,
        })
        .from(slConnectorWebhookEvents)
        .where(and(eq(slConnectorWebhookEvents.organizationId, store.organizationId), eq(slConnectorWebhookEvents.slStoreId, store.storeId)));

      const recentTopics = await db
        .select({ topic: slConnectorWebhookEvents.topic, receivedAt: slConnectorWebhookEvents.receivedAt })
        .from(slConnectorWebhookEvents)
        .where(and(eq(slConnectorWebhookEvents.organizationId, store.organizationId), eq(slConnectorWebhookEvents.slStoreId, store.storeId)))
        .orderBy(desc(slConnectorWebhookEvents.receivedAt))
        .limit(5);

      const [latestRun] = await db
        .select({
          status: reconciliationJobs.status,
          completedAt: reconciliationJobs.completedAt,
          sourceCount: reconciliationJobs.totalSourceTxns,
          targetCount: reconciliationJobs.totalTargetTxns,
          matchedCount: reconciliationJobs.matchedCount,
          exceptionCount: reconciliationJobs.exceptionCount,
          unmatchedCount: reconciliationJobs.unmatchedCount,
        })
        .from(reconciliationJobs)
        .where(and(eq(reconciliationJobs.organizationId, store.organizationId), eq(reconciliationJobs.moduleType, "settlement")))
        .orderBy(desc(reconciliationJobs.completedAt))
        .limit(1);

      const [recordCounts] = await db
        .select({
          transactions: sql<number>`count(distinct ${transactions.id})`,
          openExceptions: sql<number>`count(distinct case when ${exceptions.status} in ('open', 'in_review', 'escalated') then ${exceptions.id} end)`,
        })
        .from(transactions)
        .leftJoin(exceptions, eq(exceptions.transactionId, transactions.id))
        .where(eq(transactions.organizationId, store.organizationId));

      return {
        workspace: {
          title: "ReconcileAI Dev Store review workspace",
          accountRequired: false,
          writeAccess: false,
          dataNotice: "All figures in this workspace are controlled development-store evidence. They are not production-merchant results.",
        },
        connection: {
          storeHandle: store.storeHandle,
          status: store.status,
          installedAt: store.installedAt,
          scopes: store.grantedScopes?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? [],
          lastSyncAt: store.lastSyncAt,
          statusDetail: reviewSyncStatus(store),
        },
        webhookEvidence: {
          total: Number(webhookCounts?.total ?? 0),
          processed: Number(webhookCounts?.processed ?? 0),
          pending: Number(webhookCounts?.pending ?? 0),
          attention: Number(webhookCounts?.attention ?? 0),
          recentTopics: recentTopics.map((event) => ({ topic: event.topic, receivedAt: event.receivedAt })),
        },
        reconciliationEvidence: latestRun
          ? {
              status: latestRun.status,
              completedAt: latestRun.completedAt,
              sourceCount: latestRun.sourceCount,
              targetCount: latestRun.targetCount,
              matchedCount: latestRun.matchedCount,
              exceptionCount: latestRun.exceptionCount,
              unmatchedCount: latestRun.unmatchedCount,
            }
          : null,
        controlledDataCounts: {
          transactions: Number(recordCounts?.transactions ?? 0),
          openExceptions: Number(recordCounts?.openExceptions ?? 0),
        },
      };
    }),
});
