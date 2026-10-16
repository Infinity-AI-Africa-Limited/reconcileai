/**
 * End-to-end proof for Shopify Scope A's scheduled 90-day evidence-retention
 * control. It runs only against a locally classified, throwaway MySQL target;
 * production and Railway URLs are rejected before Vitest registers the suite.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentActionDrafts,
  agentMemory,
  anomalyScores,
  auditLogs,
  channels,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  transactions,
  uploadBatches,
  users,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyEvidenceRetentionReceipts,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { createAppPool } from "../../dbSession";
import {
  purgeExpiredShopifyScopeAEvidence,
  SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
} from "./evidenceRetention";
import {
  shopifyOrdersChannelCode,
  shopifySettlementEvidenceChannelCode,
} from "./channelCodes";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const OLD = new Date("2026-07-17T11:59:59.000Z");
const RECENT = new Date("2026-10-15T12:00:00.000Z");

const insertId = (result: unknown) =>
  Number((result as [{ insertId: number }])[0].insertId);

describe.runIf(localDatabase)(
  "when Shopify Scope A evidence reaches 90 days in MySQL",
  () => {
    let pool: Pool;
    let db: MySql2Database;
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000)}`.slice(
      -12
    );
    let organizationId = 0;
    let userId = 0;
    let storeId = 0;

    beforeAll(async () => {
      pool = createAppPool(url!).promise();
      db = drizzle(pool);

      organizationId = insertId(
        await db.insert(organizations).values({
          name: `Retention rehearsal ${nonce}`,
          code: `RETENTION_${nonce}`.slice(0, 50),
          segment: "retail_commerce",
          onboardingChannel: "shopify_public_app",
          deletionState: "active",
        })
      );
      userId = insertId(
        await db.insert(users).values({
          openId: `retention_${nonce}`.slice(0, 64),
          name: "Masked retention rehearsal user",
          email: `retention-${nonce}@example.invalid`,
          role: "admin",
          organizationId,
        })
      );
      storeId = insertId(
        await db.insert(shopifyConnectorStores).values({
          organizationId,
          shopDomain: `retention-${nonce}.myshopify.com`,
          shopId: `retention_shop_${nonce}`,
          displayName: "Masked retention rehearsal store",
          grantedScopes: "read_orders",
          requestedScopes: "read_orders",
          status: "active",
          claimedByUserId: userId,
        })
      );
    });

    afterAll(async () => {
      // The command that starts this rehearsal drops the entire dedicated schema.
      // Closing the pool is still required for an orderly local cleanup.
      await pool?.end();
    });

    it("should remove terminal evidence while deferring a live exception and recording only aggregate proof", async () => {
      const orderChannelId = insertId(
        await db.insert(channels).values({
          organizationId,
          name: "Synthetic Shopify orders",
          code: shopifyOrdersChannelCode(storeId),
          channelType: "ecommerce_gateway",
        })
      );
      const settlementChannelId = insertId(
        await db.insert(channels).values({
          organizationId,
          name: "Synthetic settlement evidence",
          code: shopifySettlementEvidenceChannelCode(storeId),
          channelType: "ecommerce_gateway",
        })
      );

      const staleBatchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId,
          userId,
          channelId: orderChannelId,
          fileName: "masked-scope-a-input.csv",
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );
      const retainedBatchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId,
          userId,
          channelId: settlementChannelId,
          fileName: "masked-recent-input.csv",
          status: "completed",
          createdAt: RECENT,
          completedAt: RECENT,
        })
      );

      const oldJobId = insertId(
        await db.insert(reconciliationJobs).values({
          organizationId,
          userId,
          name: "Masked terminal Scope A reconciliation",
          sourceChannelId: orderChannelId,
          targetChannelId: settlementChannelId,
          dateFrom: OLD,
          dateTo: OLD,
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );

      const staleOrderId = insertId(
        await db.insert(transactions).values({
          organizationId,
          userId,
          batchId: staleBatchId,
          channelId: orderChannelId,
          shopifyStoreId: storeId,
          transactionRef: `order-${nonce}-expired`,
          shopifyRefundId: "",
          amount: "110.00",
          currency: "USD",
          transactionDate: OLD,
          shopifyUpdatedAt: OLD,
          debitCredit: "credit",
          status: "matched",
          createdAt: OLD,
        })
      );
      const retainedSettlementId = insertId(
        await db.insert(transactions).values({
          organizationId,
          userId,
          batchId: retainedBatchId,
          channelId: settlementChannelId,
          amount: "110.00",
          currency: "USD",
          transactionDate: RECENT,
          debitCredit: "credit",
          status: "matched",
          createdAt: RECENT,
        })
      );
      const terminalExceptionTransactionId = insertId(
        await db.insert(transactions).values({
          organizationId,
          userId,
          batchId: staleBatchId,
          channelId: orderChannelId,
          shopifyStoreId: storeId,
          transactionRef: `order-${nonce}-terminal-exception`,
          shopifyRefundId: "",
          amount: "4.00",
          currency: "USD",
          transactionDate: OLD,
          shopifyUpdatedAt: OLD,
          debitCredit: "credit",
          createdAt: OLD,
        })
      );
      const liveExceptionTransactionId = insertId(
        await db.insert(transactions).values({
          organizationId,
          userId,
          // The control remains live, so its batch is deliberately retained. The
          // terminal batch can then prove orphan-batch deletion independently.
          batchId: retainedBatchId,
          channelId: orderChannelId,
          shopifyStoreId: storeId,
          transactionRef: `order-${nonce}-live-exception`,
          shopifyRefundId: "",
          amount: "6.00",
          currency: "USD",
          transactionDate: OLD,
          shopifyUpdatedAt: OLD,
          debitCredit: "credit",
          createdAt: OLD,
        })
      );

      const matchId = insertId(
        await db.insert(matches).values({
          organizationId,
          jobId: oldJobId,
          sourceTransactionId: staleOrderId,
          targetTransactionId: retainedSettlementId,
          matchType: "exact",
          confidenceScore: "100.00",
          status: "confirmed",
          createdAt: OLD,
        })
      );
      await db
        .update(transactions)
        .set({ matchId })
        .where(eq(transactions.id, staleOrderId));
      await db
        .update(transactions)
        .set({ matchId })
        .where(eq(transactions.id, retainedSettlementId));

      const terminalExceptionId = insertId(
        await db.insert(exceptions).values({
          organizationId,
          jobId: oldJobId,
          transactionId: terminalExceptionTransactionId,
          category: "unmatched",
          severity: "medium",
          currency: "USD",
          status: "resolved",
          createdAt: OLD,
        })
      );
      const terminalWorkflowId = insertId(
        await db.insert(exceptionWorkflows).values({
          organizationId,
          exceptionId: terminalExceptionId,
          attemptNumber: 1,
          ownerUserId: userId,
          dueAt: OLD,
          approvalRequired: true,
          status: "closed",
          finalOutcome: "resolved",
          startedByUserId: userId,
          startedAt: OLD,
          closedByUserId: userId,
          closedAt: OLD,
          updatedAt: OLD,
        })
      );
      await db.insert(exceptionWorkflowEvents).values({
        organizationId,
        exceptionId: terminalExceptionId,
        workflowId: terminalWorkflowId,
        eventType: "closed",
        actorUserId: userId,
        outcome: "resolved",
        createdAt: OLD,
      });
      await db.insert(agentActionDrafts).values({
        organizationId,
        exceptionId: terminalExceptionId,
        actionType: "no_action",
        subject: "Masked terminal action draft",
        body: "Synthetic test content only",
        status: "rejected",
        createdAt: OLD,
      });
      await db.insert(agentMemory).values({
        organizationId,
        exceptionId: terminalExceptionId,
        exceptionCategory: "unmatched",
        amountRange: "0-100k",
        resolution: "Synthetic resolution",
        reasoning: "Synthetic reason",
        embeddingText: "Synthetic terminal control context",
        createdAt: OLD,
      });
      await db.insert(anomalyScores).values({
        organizationId,
        transactionId: terminalExceptionTransactionId,
        anomalyScore: "0.9000",
        detectionMethod: "statistical_iqr",
        createdAt: OLD,
      });
      const liveExceptionId = insertId(
        await db.insert(exceptions).values({
          organizationId,
          jobId: 0,
          transactionId: liveExceptionTransactionId,
          category: "unmatched",
          severity: "high",
          currency: "USD",
          status: "open",
          createdAt: OLD,
        })
      );
      await db.insert(reconciliationReports).values({
        organizationId,
        userId,
        jobId: oldJobId,
        reportType: "daily",
        title: "Masked terminal report",
        summary: { only: "aggregates" },
        format: "csv",
        createdAt: OLD,
      });
      await db.insert(shopifyWebhookEvents).values({
        organizationId,
        storeId,
        webhookId: `masked_webhook_${nonce}`,
        topic: "orders/updated",
        payloadSha256: "a".repeat(64),
        status: "processed",
        receivedAt: OLD,
        processedAt: OLD,
      });

      const first = await purgeExpiredShopifyScopeAEvidence({
        db: db as never,
        now: () => NOW,
      });

      expect(first).toMatchObject({
        storesConsidered: 1,
        storesCompleted: 1,
        transactionsDeleted: 2,
        matchesDeleted: 1,
        exceptionsDeleted: 1,
        workflowsDeleted: 1,
        workflowEventsDeleted: 1,
        reportsDeleted: 1,
        jobsDeleted: 1,
        batchesDeleted: 1,
        webhookEventsDeleted: 1,
        deferredActiveExceptions: 1,
      });
      expect(
        await db
          .select()
          .from(transactions)
          .where(
            inArray(transactions.id, [
              staleOrderId,
              terminalExceptionTransactionId,
            ])
          )
      ).toEqual([]);
      expect(
        await db.select().from(matches).where(eq(matches.id, matchId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(exceptions)
          .where(eq(exceptions.id, terminalExceptionId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(exceptionWorkflows)
          .where(eq(exceptionWorkflows.id, terminalWorkflowId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(reconciliationJobs)
          .where(eq(reconciliationJobs.id, oldJobId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(reconciliationReports)
          .where(eq(reconciliationReports.jobId, oldJobId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(uploadBatches)
          .where(eq(uploadBatches.id, staleBatchId))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(shopifyWebhookEvents)
          .where(eq(shopifyWebhookEvents.storeId, storeId))
      ).toEqual([]);

      const [retained] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, retainedSettlementId));
      expect(retained).toMatchObject({ status: "unmatched", matchId: null });
      expect(
        await db
          .select()
          .from(exceptions)
          .where(eq(exceptions.id, liveExceptionId))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, liveExceptionTransactionId))
      ).toHaveLength(1);

      const receipts = await db
        .select()
        .from(shopifyEvidenceRetentionReceipts)
        .where(
          and(
            eq(shopifyEvidenceRetentionReceipts.organizationId, organizationId),
            eq(shopifyEvidenceRetentionReceipts.storeId, storeId)
          )
        );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
        cutoffAt: new Date("2026-07-18T12:00:00.000Z"),
        completedAt: NOW,
      });
      expect(JSON.stringify(receipts[0]?.summary)).toMatch(
        /"transactionsDeleted":2/
      );
      expect(JSON.stringify(receipts[0]?.summary)).not.toMatch(
        /order-|amount|shopDomain|example\.invalid/i
      );
      const audits = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.action, "shopify_scope_a_retention_sweep")
          )
        );
      expect(audits).toHaveLength(1);

      // A second process-level invocation on the same day does not re-run: the
      // durable receipt prevents duplicate proof or purge work across restarts.
      const second = await purgeExpiredShopifyScopeAEvidence({
        db: db as never,
        now: () => NOW,
      });
      expect(second).toMatchObject({
        storesConsidered: 1,
        storesSkipped: 1,
        transactionsDeleted: 0,
        matchesDeleted: 0,
        exceptionsDeleted: 0,
      });
      expect(
        await db
          .select()
          .from(shopifyEvidenceRetentionReceipts)
          .where(
            and(
              eq(
                shopifyEvidenceRetentionReceipts.organizationId,
                organizationId
              ),
              eq(shopifyEvidenceRetentionReceipts.storeId, storeId)
            )
          )
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(exceptions)
          .where(eq(exceptions.id, liveExceptionId))
      ).toHaveLength(1);
    });
  }
);
