/**
 * End-to-end proof for Shopify Scope A's scheduled 90-day evidence-retention
 * control. It runs only against a locally classified, throwaway MySQL target;
 * production and Railway URLs are rejected before Vitest registers the suite.
 *
 * Every case seeds its own tenants, sweeps only their stores, asserts only on
 * their rows, and the suite removes everything it wrote, so it is safe to run
 * against a reused database and alongside other suites.
 */
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentActionDrafts,
  agentMemory,
  anomalyScores,
  auditChainLocks,
  auditLogs,
  channels,
  controlBatchManifests,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  sharedReportTokens,
  transactions,
  uploadBatches,
  users,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyEvidenceRetentionReceipts,
  shopifyPrivacyRequests,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { classifyDatabaseTarget } from "../../dbTarget";
import { createAppPool } from "../../dbSession";
import {
  purgeExpiredShopifyScopeAEvidence,
  resetShopifyScopeAEvidenceRetentionScheduleForTest,
  SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
  type ShopifyEvidenceRetentionDeps,
} from "./evidenceRetention";
import {
  shopifyOrdersChannelCode,
  shopifySettlementEvidenceChannelCode,
} from "./channelCodes";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const CUTOFF = new Date("2026-07-18T12:00:00.000Z");
const OLD = new Date("2026-07-17T11:59:59.000Z");
const RECENT = new Date("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

const insertId = (result: unknown) =>
  Number((result as [{ insertId: number }])[0].insertId);

interface Tenant {
  organizationId: number;
  userId: number;
  storeId: number;
  ordersChannelId: number;
  settlementChannelId: number;
  batchId: number;
}

describe.runIf(localDatabase)(
  "when Shopify Scope A evidence reaches 90 days in MySQL",
  () => {
    let pool: Pool;
    let db: MySql2Database;
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000)}`.slice(-12);
    const orgIds: number[] = [];
    let seq = 0;
    const tag = () => `${nonce}-${++seq}`;

    beforeAll(async () => {
      pool = createAppPool(url!).promise();
      db = drizzle(pool);
    });

    // Where an unfinished sweep stopped is process memory; no case inherits it.
    beforeEach(() => resetShopifyScopeAEvidenceRetentionScheduleForTest());

    afterAll(async () => {
      if (db && orgIds.length) {
        for (const table of [
          exceptionWorkflowEvents,
          exceptionWorkflows,
          agentActionDrafts,
          agentMemory,
          exceptions,
          anomalyScores,
          matches,
          sharedReportTokens,
          reconciliationReports,
          reconciliationJobs,
          transactions,
          controlBatchManifests,
          uploadBatches,
          shopifyWebhookEvents,
          shopifyPrivacyRequests,
          shopifyEvidenceRetentionReceipts,
          auditLogs,
          channels,
          shopifyConnectorStores,
          users,
        ] as const) {
          await db.delete(table).where(inArray(table.organizationId, orgIds));
        }
        await db.delete(auditChainLocks).where(inArray(auditChainLocks.chainKey, orgIds));
        await db.delete(organizations).where(inArray(organizations.id, orgIds));
      }
      await pool?.end();
    });

    async function seedTenant(): Promise<Tenant> {
      const label = tag();
      const organizationId = insertId(
        await db.insert(organizations).values({
          name: `Retention rehearsal ${label}`,
          code: `RETENTION_${label}`.slice(0, 50),
          segment: "retail_commerce",
          onboardingChannel: "shopify_public_app",
          deletionState: "active",
        })
      );
      orgIds.push(organizationId);
      const userId = insertId(
        await db.insert(users).values({
          openId: `retention_${label}`.slice(0, 64),
          name: "Masked retention rehearsal user",
          email: `retention-${label}@example.invalid`,
          role: "admin",
          organizationId,
        })
      );
      const storeId = insertId(
        await db.insert(shopifyConnectorStores).values({
          organizationId,
          shopDomain: `retention-${label}.myshopify.com`,
          shopId: `retention_shop_${label}`,
          displayName: "Masked retention rehearsal store",
          grantedScopes: "read_orders",
          requestedScopes: "read_orders",
          status: "active",
          claimedByUserId: userId,
        })
      );
      const ordersChannelId = insertId(
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
      const batchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId,
          userId,
          channelId: ordersChannelId,
          fileName: "masked-scope-a-input.csv",
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );
      return { organizationId, userId, storeId, ordersChannelId, settlementChannelId, batchId };
    }

    /** An order row, or with `settlement` a settlement-evidence row, dated `at`. */
    async function seedTransaction(
      t: Tenant,
      at: Date,
      options: {
        settlement?: boolean;
        status?: "unmatched" | "matched" | "exception";
        batchId?: number;
        matchId?: number;
      } = {}
    ): Promise<number> {
      const settlement = options.settlement ?? false;
      return insertId(
        await db.insert(transactions).values({
          organizationId: t.organizationId,
          userId: t.userId,
          batchId: options.batchId ?? t.batchId,
          channelId: settlement ? t.settlementChannelId : t.ordersChannelId,
          shopifyStoreId: settlement ? null : t.storeId,
          transactionRef: `order-${tag()}`,
          shopifyRefundId: "",
          amount: "110.00",
          currency: "USD",
          transactionDate: at,
          shopifyUpdatedAt: settlement ? null : at,
          debitCredit: "credit",
          status: options.status ?? "unmatched",
          matchId: options.matchId ?? null,
          createdAt: at,
        })
      );
    }

    async function seedJob(
      t: Tenant,
      status: "pending" | "running" | "completed" = "completed",
      completedAt: Date = OLD
    ): Promise<number> {
      return insertId(
        await db.insert(reconciliationJobs).values({
          organizationId: t.organizationId,
          userId: t.userId,
          name: "Masked Scope A reconciliation",
          sourceChannelId: t.ordersChannelId,
          targetChannelId: t.settlementChannelId,
          dateFrom: OLD,
          dateTo: OLD,
          status,
          createdAt: OLD,
          completedAt: status === "completed" ? completedAt : null,
        })
      );
    }

    async function seedMatch(
      t: Tenant,
      jobId: number,
      sourceTransactionId: number,
      targetTransactionId: number,
      status: "confirmed" | "pending_review" | "rejected" = "confirmed"
    ): Promise<number> {
      return insertId(
        await db.insert(matches).values({
          organizationId: t.organizationId,
          jobId,
          sourceTransactionId,
          targetTransactionId,
          matchType: "exact",
          confidenceScore: "100.00",
          status,
          createdAt: OLD,
        })
      );
    }

    const sweep = (
      tenants: Tenant[],
      deps: Partial<ShopifyEvidenceRetentionDeps> = {}
    ) =>
      purgeExpiredShopifyScopeAEvidence({
        db: db as never,
        now: () => NOW,
        onlyStoreIds: tenants.map(t => t.storeId),
        ...deps,
      });

    const transactionIds = async (ids: number[]) =>
      (await db.select({ id: transactions.id }).from(transactions).where(inArray(transactions.id, ids)))
        .map(row => row.id)
        .sort((a, b) => a - b);

    const receiptsFor = (t: Tenant) =>
      db
        .select()
        .from(shopifyEvidenceRetentionReceipts)
        .where(
          and(
            eq(shopifyEvidenceRetentionReceipts.organizationId, t.organizationId),
            eq(shopifyEvidenceRetentionReceipts.storeId, t.storeId)
          )
        );

    const auditsFor = (t: Tenant, action: string) =>
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, t.organizationId), eq(auditLogs.action, action)));

    it("should remove terminal evidence with everything derived from it, defer a live exception, and record only aggregate proof", async () => {
      const t = await seedTenant();
      const emptyBatchId = t.batchId;
      const rowsBatchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId: t.organizationId,
          userId: t.userId,
          channelId: t.ordersChannelId,
          fileName: "masked-rows.csv",
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );
      const fileBatchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId: t.organizationId,
          userId: t.userId,
          channelId: t.settlementChannelId,
          fileName: "masked-stored-file.csv",
          fileUrl: "https://storage.invalid/masked-object",
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );
      const jobId = await seedJob(t);

      const order = await seedTransaction(t, OLD, { status: "matched", batchId: rowsBatchId });
      const settlement = await seedTransaction(t, OLD, {
        settlement: true,
        status: "matched",
        batchId: rowsBatchId,
      });
      const matchId = await seedMatch(t, jobId, order, settlement);

      const terminal = await seedTransaction(t, OLD, { batchId: rowsBatchId });
      const terminalExceptionId = insertId(
        await db.insert(exceptions).values({
          organizationId: t.organizationId,
          jobId,
          transactionId: terminal,
          category: "unmatched",
          severity: "medium",
          currency: "USD",
          status: "resolved",
          createdAt: OLD,
        })
      );
      const workflowId = insertId(
        await db.insert(exceptionWorkflows).values({
          organizationId: t.organizationId,
          exceptionId: terminalExceptionId,
          attemptNumber: 1,
          ownerUserId: t.userId,
          dueAt: OLD,
          approvalRequired: true,
          status: "closed",
          finalOutcome: "resolved",
          startedByUserId: t.userId,
          startedAt: OLD,
          closedByUserId: t.userId,
          closedAt: OLD,
          updatedAt: OLD,
        })
      );
      await db.insert(exceptionWorkflowEvents).values({
        organizationId: t.organizationId,
        exceptionId: terminalExceptionId,
        workflowId,
        eventType: "closed",
        actorUserId: t.userId,
        outcome: "resolved",
        createdAt: OLD,
      });
      await db.insert(agentActionDrafts).values({
        organizationId: t.organizationId,
        exceptionId: terminalExceptionId,
        actionType: "no_action",
        subject: "Masked terminal action draft",
        body: "Synthetic test content only",
        status: "rejected",
        createdAt: OLD,
      });
      await db.insert(agentMemory).values({
        organizationId: t.organizationId,
        exceptionId: terminalExceptionId,
        exceptionCategory: "unmatched",
        amountRange: "0-100k",
        resolution: "Synthetic resolution",
        reasoning: "Synthetic reason",
        embeddingText: "Synthetic terminal control context",
        createdAt: OLD,
      });
      await db.insert(anomalyScores).values({
        organizationId: t.organizationId,
        transactionId: terminal,
        anomalyScore: "0.9000",
        detectionMethod: "statistical_iqr",
        isFlagged: true,
        reviewStatus: "resolved",
        createdAt: OLD,
      });

      const live = await seedTransaction(t, OLD, { status: "exception", batchId: rowsBatchId });
      const liveExceptionId = insertId(
        await db.insert(exceptions).values({
          organizationId: t.organizationId,
          jobId: 0,
          transactionId: live,
          category: "unmatched",
          severity: "high",
          currency: "USD",
          status: "open",
          createdAt: OLD,
        })
      );
      const reportId = insertId(
        await db.insert(reconciliationReports).values({
          organizationId: t.organizationId,
          userId: t.userId,
          jobId,
          reportType: "daily",
          title: "Masked terminal report",
          summary: { only: "aggregates" },
          format: "csv",
          createdAt: OLD,
        })
      );
      // A finished run whose report points at a stored file: deleting the rows
      // would orphan an object this control does not manage, so both stay.
      const fileJobId = await seedJob(t);
      const fileReportId = insertId(
        await db.insert(reconciliationReports).values({
          organizationId: t.organizationId,
          userId: t.userId,
          jobId: fileJobId,
          reportType: "daily",
          title: "Masked report with a stored file",
          summary: { only: "aggregates" },
          format: "pdf",
          fileUrl: "https://storage.invalid/masked-report",
          createdAt: OLD,
        })
      );
      await db.insert(sharedReportTokens).values({
        reportId,
        token: `masked-share-${tag()}`,
        createdByUserId: t.userId,
        organizationId: t.organizationId,
        recipientEmail: "recipient@example.invalid",
      });
      for (const status of ["processed", "received"] as const) {
        await db.insert(shopifyWebhookEvents).values({
          organizationId: t.organizationId,
          storeId: t.storeId,
          webhookId: `masked_webhook_${tag()}`,
          topic: "orders/updated",
          payloadSha256: "a".repeat(64),
          status,
          receivedAt: OLD,
          processedAt: status === "processed" ? OLD : null,
        });
      }

      const first = await sweep([t]);

      expect(first).toMatchObject({
        storesConsidered: 1,
        storesCompleted: 1,
        transactionsDeleted: 3,
        matchesDeleted: 1,
        exceptionsDeleted: 1,
        workflowsDeleted: 1,
        workflowEventsDeleted: 1,
        agentActionDraftsDeleted: 1,
        agentMemoryDeleted: 1,
        anomalyScoresDeleted: 1,
        reportsDeleted: 1,
        reportShareLinksDeleted: 1,
        jobsDeleted: 1,
        batchesDeleted: 1,
        blockedUploadFiles: 1,
        blockedReportFiles: 1,
        webhookEventsDeleted: 1,
        deferredUnprocessedWebhooks: 1,
        deferredActiveExceptions: 1,
        // The row kept here is kept for its open exception, not for a pairing.
        deferredPairedTransactions: 0,
      });
      expect(await transactionIds([order, settlement, terminal, live])).toEqual([live]);
      expect(await db.select().from(matches).where(eq(matches.id, matchId))).toEqual([]);
      expect(
        await db.select().from(exceptions).where(inArray(exceptions.id, [terminalExceptionId, liveExceptionId]))
      ).toMatchObject([{ id: liveExceptionId, status: "open" }]);
      expect(await db.select().from(exceptionWorkflows).where(eq(exceptionWorkflows.id, workflowId))).toEqual([]);
      expect(await db.select().from(reconciliationJobs).where(eq(reconciliationJobs.id, jobId))).toEqual([]);
      expect(await db.select().from(reconciliationReports).where(eq(reconciliationReports.id, reportId))).toEqual([]);
      expect(await db.select().from(sharedReportTokens).where(eq(sharedReportTokens.reportId, reportId))).toEqual([]);
      expect(await db.select({ id: reconciliationJobs.id }).from(reconciliationJobs).where(eq(reconciliationJobs.id, fileJobId))).toHaveLength(1);
      expect(
        await db.select({ id: reconciliationReports.id }).from(reconciliationReports).where(eq(reconciliationReports.id, fileReportId))
      ).toHaveLength(1);
      expect(
        (
          await db
            .select({ id: uploadBatches.id })
            .from(uploadBatches)
            .where(inArray(uploadBatches.id, [emptyBatchId, rowsBatchId, fileBatchId]))
        ).map(row => row.id)
      ).toEqual([rowsBatchId, fileBatchId].sort((a, b) => a - b));
      expect(
        await db
          .select({ status: shopifyWebhookEvents.status })
          .from(shopifyWebhookEvents)
          .where(eq(shopifyWebhookEvents.storeId, t.storeId))
      ).toEqual([{ status: "received" }]);

      const receipts = await receiptsFor(t);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
        cutoffAt: CUTOFF,
        completedAt: NOW,
      });
      expect(receipts[0]?.summary).toMatchObject({ transactionsDeleted: 3, deferredActiveExceptions: 1 });
      expect(JSON.stringify(receipts[0]?.summary)).not.toMatch(
        /order-|110|shopDomain|myshopify|example\.invalid|storage\.invalid/i
      );
      expect(await auditsFor(t, "shopify_scope_a_retention_sweep")).toHaveLength(1);
      const batchAudits = await auditsFor(t, "shopify_scope_a_retention_batch");
      expect(batchAudits.length).toBeGreaterThan(0);
      expect(JSON.stringify(batchAudits.map(row => row.details))).not.toMatch(/order-|example\.invalid/i);

      // The durable receipt makes a same-day re-run a no-op across restarts:
      // a store finished today is not even locked again.
      const second = await sweep([t]);
      expect(second).toMatchObject({ storesConsidered: 0, storesSkipped: 0, transactionsDeleted: 0 });
      expect(await receiptsFor(t)).toHaveLength(1);
      expect(await auditsFor(t, "shopify_scope_a_retention_sweep")).toHaveLength(1);
      expect(await transactionIds([live])).toEqual([live]);
    });

    it("should keep an expired transaction, and the run behind it, while the transaction it is reconciled with is kept", async () => {
      const t = await seedTenant();
      const jobId = await seedJob(t);
      // A run's own period starts from its completion, not its window.
      const lateJobId = await seedJob(t, "completed", RECENT);

      // The job engine records a pair as a match row and leaves matchId empty.
      const engineOrder = await seedTransaction(t, OLD, { status: "matched" });
      const engineSettlement = await seedTransaction(t, RECENT, { settlement: true, status: "matched" });
      const engineMatch = await seedMatch(t, jobId, engineOrder, engineSettlement);

      // Shopify's inline reconciliation records it by cross-pointing matchId.
      const inlineOrder = await seedTransaction(t, OLD, { status: "matched" });
      const inlineSettlement = await seedTransaction(t, RECENT, {
        settlement: true,
        status: "matched",
        matchId: inlineOrder,
      });
      await db.update(transactions).set({ matchId: inlineSettlement }).where(eq(transactions.id, inlineOrder));

      // A chain is one group: a is kept because b's other counterpart is recent.
      const a = await seedTransaction(t, OLD, { status: "matched" });
      const b = await seedTransaction(t, OLD, { settlement: true, status: "matched" });
      const c = await seedTransaction(t, RECENT, { status: "matched" });
      await seedMatch(t, jobId, a, b);
      await seedMatch(t, jobId, c, b);

      // A rejected match pairs nothing: d goes, its recent counterpart stays as it was.
      const d = await seedTransaction(t, OLD);
      const e = await seedTransaction(t, RECENT, { settlement: true });
      const rejected = await seedMatch(t, jobId, d, e, "rejected");

      // One candidate per batch, so a group is found by following its links
      // out of the batch rather than by both halves happening to be candidates.
      const report = await sweep([t], { batchSize: 1 });

      expect(report).toMatchObject({
        storesCompleted: 1,
        transactionsDeleted: 1,
        matchesDeleted: 1,
        deferredPairedTransactions: 4,
        jobsDeleted: 0,
      });
      expect(
        await transactionIds([engineOrder, engineSettlement, inlineOrder, inlineSettlement, a, b, c, d, e])
      ).toEqual([engineOrder, engineSettlement, inlineOrder, inlineSettlement, a, b, c, e].sort((x, y) => x - y));
      // No survivor was reset: a false "missing counterparty" needs an unmatched half.
      const survivors = await db
        .select({ id: transactions.id, status: transactions.status, matchId: transactions.matchId })
        .from(transactions)
        .where(inArray(transactions.id, [engineSettlement, inlineSettlement, b, c, e]));
      expect(Object.fromEntries(survivors.map(row => [row.id, [row.status, row.matchId]]))).toEqual({
        [engineSettlement]: ["matched", null],
        [inlineSettlement]: ["matched", inlineOrder],
        [b]: ["matched", null],
        [c]: ["matched", null],
        [e]: ["unmatched", null],
      });
      expect(
        (await db.select({ id: matches.id }).from(matches).where(inArray(matches.id, [engineMatch, rejected]))).map(
          row => row.id
        )
      ).toEqual([engineMatch]);
      // A run some retained match still names is kept with it, and so is one
      // that finished recently, whatever window it covered.
      expect(
        (
          await db
            .select({ id: reconciliationJobs.id })
            .from(reconciliationJobs)
            .where(inArray(reconciliationJobs.id, [jobId, lateJobId]))
        ).map(row => row.id)
      ).toEqual([jobId, lateJobId]);
    });

    it("should keep evidence that a queued run, a pending review, a governed control or an unanswered data request still needs", async () => {
      const queued = await seedTenant();
      const review = await seedTenant();
      const anomaly = await seedTenant();
      const governed = await seedTenant();
      const privacy = await seedTenant();

      await seedJob(queued, "pending");
      const queuedRow = await seedTransaction(queued, OLD);

      const reviewSource = await seedTransaction(review, OLD, { status: "exception" });
      const reviewTarget = await seedTransaction(review, OLD, { settlement: true, status: "exception" });
      await seedMatch(review, await seedJob(review), reviewSource, reviewTarget, "pending_review");

      const flagged = await seedTransaction(anomaly, OLD);
      const unflagged = await seedTransaction(anomaly, OLD);
      for (const [transactionId, isFlagged] of [[flagged, true], [unflagged, false]] as const) {
        await db.insert(anomalyScores).values({
          organizationId: anomaly.organizationId,
          transactionId,
          anomalyScore: "0.9000",
          detectionMethod: "statistical_iqr",
          isFlagged,
          reviewStatus: "pending",
          createdAt: OLD,
        });
      }

      const governedRow = await seedTransaction(governed, OLD);
      // A manifest can also name an upload that holds no rows (an empty
      // delivery is still a delivery the control accounted for).
      const governedEmptyBatchId = insertId(
        await db.insert(uploadBatches).values({
          organizationId: governed.organizationId,
          userId: governed.userId,
          channelId: governed.settlementChannelId,
          fileName: "masked-empty-delivery.csv",
          status: "completed",
          createdAt: OLD,
          completedAt: OLD,
        })
      );
      for (const uploadBatchId of [governed.batchId, governedEmptyBatchId]) {
        await db.insert(controlBatchManifests).values({
          organizationId: governed.organizationId,
          sourceContractId: 1,
          sourceContractVersion: 1,
          controlPeriod: "2026-07-17",
          deliveryIdentity: `masked-delivery-${tag()}`,
          uploadBatchId,
          receivedAt: OLD,
          mappingVersion: "v1",
          reconciliationPolicyVersion: "v1",
          schemaState: "accepted",
          duplicateDelivery: "none",
          receivedRecordCount: uploadBatchId === governed.batchId ? 1 : 0,
          receivedMonetaryTotal: uploadBatchId === governed.batchId ? "110.00" : "0.00",
          receivedCurrency: "USD",
          recordedByUserId: governed.userId,
          createdAt: OLD,
        });
      }

      const privacyRow = await seedTransaction(privacy, OLD);
      const requestId = insertId(
        await db.insert(shopifyPrivacyRequests).values({
          organizationId: privacy.organizationId,
          storeId: privacy.storeId,
          topic: "customers/data_request",
          requestHash: "b".repeat(64),
          status: "manual_review",
          receivedAt: RECENT,
        })
      );

      const report = await sweep([queued, review, anomaly, governed, privacy]);

      expect(report).toMatchObject({
        storesConsidered: 5,
        storesCompleted: 5,
        transactionsDeleted: 1,
        anomalyScoresDeleted: 1,
        deferredNonterminalJobs: 1,
        deferredPendingMatchReviews: 1,
        deferredAnomalyReviews: 1,
        deferredGovernedEvidence: 1,
        deferredPrivacyRequests: 1,
      });
      expect(
        await transactionIds([queuedRow, reviewSource, reviewTarget, flagged, unflagged, governedRow, privacyRow])
      ).toEqual([queuedRow, reviewSource, reviewTarget, flagged, governedRow, privacyRow].sort((x, y) => x - y));
      // A governed upload is the control's record, not an orphan, rows or none.
      expect(
        await db
          .select({ id: uploadBatches.id })
          .from(uploadBatches)
          .where(inArray(uploadBatches.id, [governed.batchId, governedEmptyBatchId]))
      ).toHaveLength(2);
      for (const tenant of [queued, review, anomaly, governed, privacy]) {
        expect(await receiptsFor(tenant)).toHaveLength(1);
      }

      // Once the request is answered, the next day's sweep takes the evidence.
      await db.update(shopifyPrivacyRequests).set({ status: "completed" }).where(eq(shopifyPrivacyRequests.id, requestId));
      const nextDay = await sweep([privacy], { now: () => new Date(NOW.getTime() + DAY) });
      expect(nextDay).toMatchObject({ storesCompleted: 1, transactionsDeleted: 1 });
      expect(await transactionIds([privacyRow])).toEqual([]);
    });

    it("should work through a backlog in bounded, separately audited batches", async () => {
      const t = await seedTenant();
      const rows: number[] = [];
      for (let i = 0; i < 7; i += 1) rows.push(await seedTransaction(t, OLD));

      const report = await sweep([t], { batchSize: 2 });

      expect(report).toMatchObject({ storesCompleted: 1, transactionsDeleted: 7 });
      expect(await transactionIds(rows)).toEqual([]);
      const evidenceBatches = (await auditsFor(t, "shopify_scope_a_retention_batch")).filter(
        row => (row.details as { phase?: string } | null)?.phase === "evidence"
      );
      expect(evidenceBatches.map(row => (row.details as { transactionsDeleted?: number }).transactionsDeleted)).toEqual([
        2, 2, 2, 1,
      ]);
    });

    it("should stop at its time budget without a receipt, and resume where it stopped", async () => {
      const t = await seedTenant();
      const jobId = await seedJob(t);
      // Candidates in id order: one that can go, three kept because each is
      // matched to a recent settlement, then one more that can go.
      const first = await seedTransaction(t, OLD);
      const kept: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const order = await seedTransaction(t, OLD, { status: "matched" });
        const settlement = await seedTransaction(t, RECENT, { settlement: true, status: "matched" });
        await seedMatch(t, jobId, order, settlement);
        kept.push(order);
      }
      const last = await seedTransaction(t, OLD);

      // Each read of this clock advances it by one. A sweep reads it once to
      // start, once per store, and once before every batch.
      let tick = 0;
      const clock = () => tick++;
      // Room for two batches of two: [first, kept0] and [kept1, kept2].
      const partial = await sweep([t], { batchSize: 2, budgetMs: 4, elapsed: clock });

      expect(partial).toMatchObject({ storesIncomplete: 1, storesCompleted: 0, transactionsDeleted: 1 });
      expect(await transactionIds([first, ...kept, last])).toEqual([...kept, last]);
      expect(await receiptsFor(t)).toEqual([]);
      // The part that ran is on the record even though the day is not finished.
      expect(await auditsFor(t, "shopify_scope_a_retention_batch")).toHaveLength(1);

      // Room for four batches: enough to finish from where it stopped, and not
      // enough to finish if it started again from the top.
      tick = 0;
      const rest = await sweep([t], { batchSize: 2, budgetMs: 6, elapsed: clock });

      expect(rest).toMatchObject({ storesCompleted: 1, transactionsDeleted: 1 });
      expect(await transactionIds([first, ...kept, last])).toEqual(kept);
      const receipts = await receiptsFor(t);
      expect(receipts).toHaveLength(1);
      // The receipt reports the whole day's pass, both runs of it.
      expect(receipts[0]?.summary).toMatchObject({ transactionsDeleted: 2, deferredPairedTransactions: 3 });
    });

    it("should report a whole day's deletions on its receipt when another process finishes the day, and only that day's", async () => {
      const t = await seedTenant();
      const rows: number[] = [];
      for (let i = 0; i < 3; i += 1) rows.push(await seedTransaction(t, OLD));

      // This process deletes one batch and stops.
      let tick = 0;
      const partial = await sweep([t], { batchSize: 1, budgetMs: 3, elapsed: () => tick++ });
      expect(partial).toMatchObject({ storesIncomplete: 1, transactionsDeleted: 1 });

      // A restart, or another instance: nothing of that run survives in memory.
      resetShopifyScopeAEvidenceRetentionScheduleForTest();
      const finish = await sweep([t]);
      expect(finish).toMatchObject({ storesCompleted: 1, transactionsDeleted: 2 });
      const [first] = await receiptsFor(t);
      // The receipt counts all three: it reads the batch entries, not memory.
      expect(first?.summary).toMatchObject({ transactionsDeleted: 3 });

      // The next day's receipt counts the next day's deletions, not these.
      const nextDayRow = await seedTransaction(t, OLD);
      const nextDay = await sweep([t], { now: () => new Date(NOW.getTime() + DAY) });
      expect(nextDay).toMatchObject({ storesCompleted: 1, transactionsDeleted: 1 });
      expect(await transactionIds([...rows, nextDayRow])).toEqual([]);
      const receipts = (await receiptsFor(t)).sort((a, b) => a.id - b.id);
      expect(receipts.map(receipt => (receipt.summary as { transactionsDeleted: number }).transactionsDeleted)).toEqual([3, 1]);
    });

    it("should start the next sweep with the stores after the one its budget stopped in", async () => {
      const earlier = await seedTenant();
      const later = await seedTenant();
      const earlierRow = await seedTransaction(earlier, OLD);
      const laterRow = await seedTransaction(later, OLD);

      // Room for the earlier store's evidence and runs, then the budget is out:
      // it stops inside the earlier store and never reaches the later one.
      let tick = 0;
      const clock = () => tick++;
      const first = await sweep([earlier, later], { budgetMs: 4, elapsed: clock });
      expect(first).toMatchObject({ storesIncomplete: 2, storesCompleted: 0, transactionsDeleted: 1 });
      expect(await transactionIds([earlierRow, laterRow])).toEqual([laterRow]);

      // The same budget again. Starting from the lowest id would finish the
      // earlier store and stop before the later one, every time.
      tick = 0;
      const second = await sweep([earlier, later], { budgetMs: 4, elapsed: clock });
      expect(second).toMatchObject({ transactionsDeleted: 1 });
      expect(await transactionIds([laterRow])).toEqual([]);
    });

    it("should finish a day while another audit writer holds the tenant's chain, without a deadlock", async () => {
      const t = await seedTenant();
      const expired = await seedTransaction(t, OLD);
      // Keeps the shared upload, so the finishing run has only its receipt left.
      await seedTransaction(t, RECENT);
      let tick = 0;
      const partial = await sweep([t], { budgetMs: 3, elapsed: () => tick++ });
      expect(partial).toMatchObject({ storesIncomplete: 1, transactionsDeleted: 1 });

      // An audit write takes the chain lock, then locks the chain's newest row,
      // which is now this store's batch entry. Do exactly that, in two steps.
      const writer = await pool.getConnection();
      try {
        await writer.beginTransaction();
        await writer.query("INSERT IGNORE INTO audit_chain_locks (chainKey) VALUES (?)", [t.organizationId]);
        await writer.query("SELECT chainKey FROM audit_chain_locks WHERE chainKey = ? FOR UPDATE", [t.organizationId]);
        const finishing = sweep([t]);
        // Give the finishing run time to reach the chain lock and wait on it.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        // A receipt that had locked the batch rows first would deadlock here.
        await writer.query(
          "SELECT id FROM audit_logs WHERE organizationId = ? ORDER BY sequenceNumber DESC LIMIT 1 FOR UPDATE",
          [t.organizationId]
        );
        await writer.commit();
        expect(await finishing).toMatchObject({ storesCompleted: 1, storesFailed: 0 });
      } catch (error) {
        await writer.rollback().catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
      expect((await receiptsFor(t))[0]?.summary).toMatchObject({ transactionsDeleted: 1 });
      expect(await transactionIds([expired])).toEqual([]);
    });
  }
);
