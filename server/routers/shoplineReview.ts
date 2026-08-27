/**
 * Read-only, token-gated evidence view for SHOPLINE App Store reviewers.
 *
 * This is not a merchant installation or OAuth substitute. It exposes no raw
 * order/payment data, no credentials, and no mutation procedures. The shared
 * POC access token makes the link revocable without relying on a reviewer
 * account, inbox, or password.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { channels, exceptions, organizations, transactions } from "../../drizzle/schema";
import { slConnectorStores, slConnectorWebhookEvents } from "../../drizzle/connector_schema";
import { shoplineOrdersChannelCode, shoplinePaymentsChannelCode } from "../connectors/shopline/onboarding";
import { getDb } from "../db";
import { assertPocAccess, tokenFromCtx } from "../pocAccess";
import { publicProcedure, router } from "../_core/trpc";

export const SHOPLINE_REVIEW_POC_KEY = "shopline_review";
const REVIEW_ORG_CODE = "SL_RECONCILEAI_DEV";

/**
 * The canonical dev store this workspace speaks for (CLAUDE.md §2B.10B).
 *
 * Pinned by HANDLE, not by whichever install happens to be newest. Two
 * development stores exist under the partner account — `reconcileai-dev` and the
 * secondary `reconcileai` — so "newest active install in the org" can silently
 * become a different store than the one every other piece of evidence, and the
 * page's own title, refers to. The handle also drives `reviewerChannelCodes`,
 * so pinning it keeps the connection, the channels and the counts describing one
 * store rather than three possibly-different ones.
 */
export const REVIEW_STORE_HANDLE = "reconcileai-dev";

export function reviewerChannelCodes(storeHandle: string) {
  return [shoplineOrdersChannelCode(storeHandle), shoplinePaymentsChannelCode(storeHandle)] as const;
}

/**
 * Note the absence of a token timestamp.
 *
 * This used to report a "reauthorized — verification pending" state derived from
 * `slConnectorTokens.refreshedAt`, and the state has been removed rather than
 * narrowed a third time, because the data cannot support the claim it makes.
 * `refreshedAt` advances on EVERY rotation — tokenStore writes it on each one,
 * and the connector rotates proactively at ~9h against a 10h TTL — while a real
 * reauthorization is a fresh OAuth grant. Nothing in the schema separates the
 * two.
 *
 * Two successive narrowings each removed some false positives and left the class
 * intact: gating on "newer than the last attempt" still fired for the routine
 * rotation that follows a failure, which is a normal event being reported to an
 * App Store reviewer as a credential problem.
 *
 * Nothing is lost by dropping it. Its purpose was to avoid claiming health that
 * had not been verified, and `attention` already covers exactly that from a
 * signal that means what it says: the last attempt failed. A state that asserts
 * something the data does not know is worse than one fewer state.
 */
type SyncInputs = {
  lastSyncAt: Date | null;
  lastSyncAttemptAt: Date | null;
  lastSyncError: string | null;
};

export function reviewSyncStatus({
  lastSyncAt,
  lastSyncAttemptAt,
  lastSyncError,
}: SyncInputs) {
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
        })
        .from(slConnectorStores)
        .innerJoin(organizations, eq(organizations.id, slConnectorStores.organizationId))
        .where(and(
          eq(organizations.code, REVIEW_ORG_CODE),
          // Pinned to the canonical handle. Without it, a super admin
          // provisioning a second SHOPLINE store under this org would have its
          // connection, webhooks and counts presented as the Dev Store's.
          eq(slConnectorStores.storeHandle, REVIEW_STORE_HANDLE),
          eq(slConnectorStores.status, "active"),
        ))
        // Ordered before limiting. `limit(1)` on its own takes whatever row the
        // engine returns first, which is not a defined choice — so a second
        // active install under the review org (a reinstall that left the prior
        // row active, say) would make this page alternate between two stores'
        // figures across refreshes, with nothing on screen to indicate it. The
        // reviewer would be reading numbers that changed for no visible reason.
        // Newest install wins, and the same store is reported every time.
        .orderBy(desc(slConnectorStores.installedAt))
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

      const channelCodes = reviewerChannelCodes(store.storeHandle);
      const reviewChannels = await db
        .select({
          id: channels.id,
          code: channels.code,
        })
        .from(channels)
        .where(and(
          eq(channels.organizationId, store.organizationId),
          inArray(channels.code, [...channelCodes]),
        ));

      const channelIds = reviewChannels.map((channel) => channel.id);
      const hasChannelPair = channelCodes.every((code) => reviewChannels.some((channel) => channel.code === code));

      // Reconciliation evidence requires a sync that actually FINISHED, not just
      // channels that exist.
      //
      // Rows can be present without any reconciliation having completed: the
      // settlement-file import writes transactions without touching lastSyncAt,
      // and a cycle can persist records and then fail. In both cases everything
      // sits at `unmatched`, and reporting that under "Reconciliation evidence"
      // tells a reviewer the engine ran and matched nothing — when it did not
      // run to completion at all.
      //
      // The gate is "the LATEST attempt succeeded", not "a sync succeeded once".
      //
      // `lastSyncAt !== null` was too weak: a successful sync followed by a cycle
      // that persists transactions and then fails leaves the old timestamp in
      // place, so the gate stayed open and the aggregate swept in the newly
      // unreconciled rows — reporting them as reconciliation results under a
      // success that predates them.
      //
      // Reusing the status the reviewer is shown, rather than a second rule that
      // could disagree with it: the page can no longer display "needs attention"
      // beside a set of reconciliation figures implying everything is fine.
      const syncStatus = reviewSyncStatus(store);
      const canShowReconciliation = hasChannelPair && syncStatus.code === "current";
      const [recordCounts] = canShowReconciliation
        ? await db
        .select({
          transactions: sql<number>`count(distinct ${transactions.id})`,
          matchedTransactions: sql<number>`count(distinct case when ${transactions.status} in ('matched', 'manually_matched') then ${transactions.id} end)`,
          unmatchedTransactions: sql<number>`count(distinct case when ${transactions.status} = 'unmatched' then ${transactions.id} end)`,
          openExceptions: sql<number>`count(distinct case when ${exceptions.status} in ('open', 'in_review', 'escalated') then ${exceptions.id} end)`,
        })
        .from(transactions)
        .leftJoin(exceptions, and(
          eq(exceptions.transactionId, transactions.id),
          eq(exceptions.organizationId, store.organizationId),
        ))
        .where(and(
          eq(transactions.organizationId, store.organizationId),
          inArray(transactions.channelId, channelIds),
        ))
        : [];

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
          statusDetail: syncStatus,
        },
        webhookEvidence: {
          total: Number(webhookCounts?.total ?? 0),
          processed: Number(webhookCounts?.processed ?? 0),
          pending: Number(webhookCounts?.pending ?? 0),
          attention: Number(webhookCounts?.attention ?? 0),
          recentTopics: recentTopics.map((event) => ({ topic: event.topic, receivedAt: event.receivedAt })),
        },
        reconciliationEvidence: canShowReconciliation && recordCounts
          ? {
              transactionCount: Number(recordCounts.transactions ?? 0),
              matchedCount: Number(recordCounts.matchedTransactions ?? 0),
              exceptionCount: Number(recordCounts.openExceptions ?? 0),
              unmatchedCount: Number(recordCounts.unmatchedTransactions ?? 0),
            }
          : null,
      };
    }),
});
