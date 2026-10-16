import {
  and,
  desc,
  eq,
  exists,
  inArray,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/mysql-core";
import {
  agentActionDrafts,
  agentMemory,
  anomalyScores,
  channels,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  jobProgressEvents,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  transactions,
  uploadBatches,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyEvidenceRetentionReceipts,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { createAuditLog, getDb, type DbExecutor } from "../../db";
import { loggableError } from "../../dbErrors";
import {
  shopifyOrdersChannelCode,
  shopifySettlementEvidenceChannelCode,
} from "./channelCodes";

/**
 * Scope A's selected normal retention period for field-minimised financial
 * evidence. It is intentionally a code constant rather than a merchant input:
 * changing it is a product/legal decision that must receive its own review.
 */
export const SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS = 90;
export const SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_MS =
  SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

/** A successful process-local maintenance sweep is not repeated more often than daily. */
export const SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** A partial sweep is retried sooner but never on every 30-second privacy-loop tick. */
export const SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS = 60 * 60 * 1_000;

const terminalJobStates = ["completed", "failed", "cancelled"] as const;
const unresolvedExceptionStates = ["open", "in_review", "escalated"] as const;
const liveWorkflowStates = [
  "active",
  "escalated",
  "decision_recorded",
  "decision_submitted",
  "approved",
] as const;

/** Only the selected Scope A source evidence and its derived records are in scope. */
export interface ShopifyEvidenceRetentionReport {
  storesConsidered: number;
  storesCompleted: number;
  storesSkipped: number;
  storesFailed: number;
  webhookEventsDeleted: number;
  transactionsDeleted: number;
  matchesDeleted: number;
  exceptionsDeleted: number;
  workflowEventsDeleted: number;
  workflowsDeleted: number;
  anomalyScoresDeleted: number;
  agentActionDraftsDeleted: number;
  agentMemoryDeleted: number;
  reportsDeleted: number;
  jobsDeleted: number;
  batchesDeleted: number;
  deferredActiveExceptions: number;
  deferredActiveWorkflows: number;
  deferredNonterminalJobs: number;
  blockedReportFiles: number;
}

export interface ShopifyEvidenceRetentionDeps {
  db?: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  now?: () => Date;
  audit?: typeof createAuditLog;
}

export interface ShopifyEvidenceRetentionScheduledResult {
  ran: boolean;
  retryAt: Date | null;
  report?: ShopifyEvidenceRetentionReport;
}

function emptyReport(): ShopifyEvidenceRetentionReport {
  return {
    storesConsidered: 0,
    storesCompleted: 0,
    storesSkipped: 0,
    storesFailed: 0,
    webhookEventsDeleted: 0,
    transactionsDeleted: 0,
    matchesDeleted: 0,
    exceptionsDeleted: 0,
    workflowEventsDeleted: 0,
    workflowsDeleted: 0,
    anomalyScoresDeleted: 0,
    agentActionDraftsDeleted: 0,
    agentMemoryDeleted: 0,
    reportsDeleted: 0,
    jobsDeleted: 0,
    batchesDeleted: 0,
    deferredActiveExceptions: 0,
    deferredActiveWorkflows: 0,
    deferredNonterminalJobs: 0,
    blockedReportFiles: 0,
  };
}

export function shopifyScopeAEvidenceRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_MS);
}

/**
 * The most recent timestamp at which Scope A possessed the field-minimised
 * record. A resync must not shorten an order's retention period simply because
 * its original order date is older than its latest observed Shopify update.
 */
function evidenceAnchor(): SQL {
  return sql`GREATEST(${transactions.transactionDate}, COALESCE(${transactions.shopifyUpdatedAt}, ${transactions.transactionDate}), ${transactions.createdAt})`;
}

function affectedRows(result: unknown): number {
  return Number((result as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
}

function storeChannelCodes(storeId: number): [string, string] {
  return [
    shopifyOrdersChannelCode(storeId),
    shopifySettlementEvidenceChannelCode(storeId),
  ];
}

function storeEvidenceScope(storeId: number, organizationId: number): SQL {
  const channelIds = new QueryBuilder()
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        inArray(channels.code, storeChannelCodes(storeId))
      )
    );
  return and(
    eq(transactions.organizationId, organizationId),
    or(
      eq(transactions.shopifyStoreId, storeId),
      inArray(transactions.channelId, channelIds)
    )
  )!;
}

function noLiveExceptionOrWorkflow(organizationId: number): SQL {
  const liveWorkflow = new QueryBuilder()
    .select({ id: exceptionWorkflows.id })
    .from(exceptionWorkflows)
    .where(
      and(
        eq(exceptionWorkflows.organizationId, organizationId),
        eq(exceptionWorkflows.exceptionId, exceptions.id),
        inArray(exceptionWorkflows.status, liveWorkflowStates)
      )
    );
  const activeException = new QueryBuilder()
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        eq(exceptions.transactionId, transactions.id),
        or(
          inArray(exceptions.status, unresolvedExceptionStates),
          exists(liveWorkflow)
        )
      )
    );
  return notExists(activeException);
}

async function countDeferredControlItems(
  tx: DbExecutor,
  organizationId: number,
  storeId: number,
  cutoff: Date
): Promise<
  Pick<
    ShopifyEvidenceRetentionReport,
    "deferredActiveExceptions" | "deferredActiveWorkflows"
  >
> {
  const evidenceScope = storeEvidenceScope(storeId, organizationId);
  const [activeExceptions, activeWorkflows] = await Promise.all([
    tx
      .select({ id: exceptions.id })
      .from(exceptions)
      .innerJoin(transactions, eq(transactions.id, exceptions.transactionId))
      .where(
        and(
          evidenceScope,
          lt(evidenceAnchor(), cutoff),
          inArray(exceptions.status, unresolvedExceptionStates)
        )
      ),
    tx
      .select({ id: exceptionWorkflows.id })
      .from(exceptionWorkflows)
      .innerJoin(exceptions, eq(exceptions.id, exceptionWorkflows.exceptionId))
      .innerJoin(transactions, eq(transactions.id, exceptions.transactionId))
      .where(
        and(
          evidenceScope,
          lt(evidenceAnchor(), cutoff),
          inArray(exceptionWorkflows.status, liveWorkflowStates)
        )
      ),
  ]);
  return {
    deferredActiveExceptions: activeExceptions.length,
    deferredActiveWorkflows: activeWorkflows.length,
  };
}

async function purgeStoreEvidence(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  params: {
    storeId: number;
    organizationId: number;
    cutoff: Date;
    now: Date;
    audit: typeof createAuditLog;
  }
): Promise<Partial<ShopifyEvidenceRetentionReport> & { skipped?: boolean }> {
  return db.transaction(async tx => {
    // Shop redaction locks the tenant before the store. Retention follows that
    // order and does not write a receipt once either fence is in place.
    const [organization] = await tx
      .select({ deletionState: organizations.deletionState })
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1)
      .for("update");
    if (organization?.deletionState !== "active") return { skipped: true };

    const [store] = await tx
      .select({
        id: shopifyConnectorStores.id,
        status: shopifyConnectorStores.status,
      })
      .from(shopifyConnectorStores)
      .where(
        and(
          eq(shopifyConnectorStores.id, params.storeId),
          eq(shopifyConnectorStores.organizationId, params.organizationId)
        )
      )
      .limit(1)
      .for("update");
    if (!store || store.status === "redacting") return { skipped: true };

    // The process-local timer is only a convenience. The durable receipt is the
    // actual cross-instance idempotency boundary: Railway can restart or run
    // more than one process, and neither must produce duplicate daily evidence
    // or repeat a purge once another worker has succeeded.
    const [latestReceipt] = await tx
      .select({ completedAt: shopifyEvidenceRetentionReceipts.completedAt })
      .from(shopifyEvidenceRetentionReceipts)
      .where(
        and(
          eq(
            shopifyEvidenceRetentionReceipts.organizationId,
            params.organizationId
          ),
          eq(shopifyEvidenceRetentionReceipts.storeId, store.id)
        )
      )
      .orderBy(desc(shopifyEvidenceRetentionReceipts.completedAt))
      .limit(1)
      .for("update");
    if (
      latestReceipt &&
      latestReceipt.completedAt.getTime() >
        params.now.getTime() - SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS
    ) {
      return { skipped: true };
    }

    const evidenceScope = storeEvidenceScope(store.id, params.organizationId);
    const deferred = await countDeferredControlItems(
      tx,
      params.organizationId,
      store.id,
      params.cutoff
    );

    // A control that is still being investigated, approved, or worked must
    // retain the evidence it needs. It does not silently become a retention
    // deletion just because its normal 90-day period has passed.
    const staleTransactions = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          evidenceScope,
          lt(evidenceAnchor(), params.cutoff),
          noLiveExceptionOrWorkflow(params.organizationId)
        )
      )
      .for("update");
    const transactionIds = staleTransactions.map(row => row.id);

    let matchesDeleted = 0;
    let exceptionsDeleted = 0;
    let workflowEventsDeleted = 0;
    let workflowsDeleted = 0;
    let anomalyScoresDeleted = 0;
    let agentActionDraftsDeleted = 0;
    let agentMemoryDeleted = 0;
    if (transactionIds.length) {
      const linkedMatches = await tx
        .select({ id: matches.id })
        .from(matches)
        .where(
          and(
            eq(matches.organizationId, params.organizationId),
            or(
              inArray(matches.sourceTransactionId, transactionIds),
              inArray(matches.targetTransactionId, transactionIds)
            )
          )
        )
        .for("update");
      const matchIds = linkedMatches.map(row => row.id);
      if (matchIds.length) {
        // A retained counterpart must no longer point at a deleted match. It is
        // deliberately made visible for human review rather than re-matched by
        // this maintenance task.
        await tx
          .update(transactions)
          .set({ status: "unmatched", matchId: null })
          .where(
            and(
              eq(transactions.organizationId, params.organizationId),
              inArray(transactions.matchId, matchIds)
            )
        );
        matchesDeleted = affectedRows(
          await tx.delete(matches).where(
            and(
              eq(matches.organizationId, params.organizationId),
              inArray(matches.id, matchIds),
            ),
          )
        );
      }

      const linkedExceptions = await tx
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(
          and(
            eq(exceptions.organizationId, params.organizationId),
            inArray(exceptions.transactionId, transactionIds)
          )
        )
        .for("update");
      const exceptionIds = linkedExceptions.map(row => row.id);
      if (exceptionIds.length) {
        const workflows = await tx
          .select({ id: exceptionWorkflows.id })
          .from(exceptionWorkflows)
          .where(
            and(
              eq(exceptionWorkflows.organizationId, params.organizationId),
              inArray(exceptionWorkflows.exceptionId, exceptionIds)
            )
          )
          .for("update");
        const workflowIds = workflows.map(row => row.id);
        if (workflowIds.length) {
          workflowEventsDeleted = affectedRows(
            await tx
              .delete(exceptionWorkflowEvents)
              .where(
                and(
                  eq(
                    exceptionWorkflowEvents.organizationId,
                    params.organizationId
                  ),
                  inArray(exceptionWorkflowEvents.workflowId, workflowIds)
                )
              )
          );
          workflowsDeleted = affectedRows(
            await tx
              .delete(exceptionWorkflows)
              .where(
                and(
                  eq(exceptionWorkflows.organizationId, params.organizationId),
                  inArray(exceptionWorkflows.id, workflowIds)
                )
              )
          );
        }
        agentActionDraftsDeleted = affectedRows(
          await tx
            .delete(agentActionDrafts)
            .where(
              and(
                eq(agentActionDrafts.organizationId, params.organizationId),
                inArray(agentActionDrafts.exceptionId, exceptionIds)
              )
            )
        );
        agentMemoryDeleted = affectedRows(
          await tx
            .delete(agentMemory)
            .where(
              and(
                eq(agentMemory.organizationId, params.organizationId),
                inArray(agentMemory.exceptionId, exceptionIds)
              )
            )
        );
        exceptionsDeleted = affectedRows(
          await tx
            .delete(exceptions)
            .where(
              and(
                eq(exceptions.organizationId, params.organizationId),
                inArray(exceptions.id, exceptionIds)
              )
            )
        );
      }
      anomalyScoresDeleted = affectedRows(
        await tx
          .delete(anomalyScores)
          .where(
            and(
              eq(anomalyScores.organizationId, params.organizationId),
              inArray(anomalyScores.transactionId, transactionIds)
            )
          )
      );
    }

    const transactionsDeleted = transactionIds.length
      ? affectedRows(
          await tx
            .delete(transactions)
            .where(
              and(
                eq(transactions.organizationId, params.organizationId),
                inArray(transactions.id, transactionIds)
              )
            )
        )
      : 0;

    const sourceOrTargetChannel = or(
      inArray(
        reconciliationJobs.sourceChannelId,
        new QueryBuilder()
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.organizationId, params.organizationId),
              inArray(channels.code, storeChannelCodes(store.id))
            )
          )
      ),
      inArray(
        reconciliationJobs.targetChannelId,
        new QueryBuilder()
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.organizationId, params.organizationId),
              inArray(channels.code, storeChannelCodes(store.id))
            )
          )
      )
    );
    const jobsWithExceptions = new QueryBuilder()
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.organizationId, params.organizationId),
          eq(exceptions.jobId, reconciliationJobs.id)
        )
      );
    const oldJobs = await tx
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(
        and(
          eq(reconciliationJobs.organizationId, params.organizationId),
          sourceOrTargetChannel,
          inArray(reconciliationJobs.status, terminalJobStates),
          lt(reconciliationJobs.dateTo, params.cutoff),
          notExists(jobsWithExceptions)
        )
      )
      .for("update");
    const jobIds = oldJobs.map(row => row.id);

    let reportsDeleted = 0;
    let jobsDeleted = 0;
    let blockedReportFiles = 0;
    let deferredNonterminalJobs = 0;
    if (jobIds.length) {
      const reportsWithFiles = await tx
        .select({ id: reconciliationReports.id })
        .from(reconciliationReports)
        .where(
          and(
            eq(reconciliationReports.organizationId, params.organizationId),
            inArray(reconciliationReports.jobId, jobIds),
            sql`${reconciliationReports.fileUrl} IS NOT NULL`
          )
        )
        .for("update");
      const fileBlockedJobIds = new Set(
        (
          await tx
            .select({ jobId: reconciliationReports.jobId })
            .from(reconciliationReports)
            .where(
              and(
                eq(reconciliationReports.organizationId, params.organizationId),
                inArray(
                  reconciliationReports.id,
                  reportsWithFiles.map(row => row.id)
                )
              )
            )
        ).map(row => row.jobId)
      );
      blockedReportFiles = reportsWithFiles.length;
      const deletableJobIds = jobIds.filter(id => !fileBlockedJobIds.has(id));
      if (deletableJobIds.length) {
        reportsDeleted = affectedRows(
          await tx
            .delete(reconciliationReports)
            .where(
              and(
                eq(reconciliationReports.organizationId, params.organizationId),
                inArray(reconciliationReports.jobId, deletableJobIds)
              )
            )
        );
        await tx
          .delete(jobProgressEvents)
          .where(inArray(jobProgressEvents.jobId, deletableJobIds));
        jobsDeleted = affectedRows(
          await tx
            .delete(reconciliationJobs)
            .where(
              and(
                eq(reconciliationJobs.organizationId, params.organizationId),
                inArray(reconciliationJobs.id, deletableJobIds)
              )
            )
        );
      }
    }

    const nonterminalJobs = await tx
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(
        and(
          eq(reconciliationJobs.organizationId, params.organizationId),
          sourceOrTargetChannel,
          sql`${reconciliationJobs.dateTo} < ${params.cutoff}`,
          sql`${reconciliationJobs.status} NOT IN (${sql.join(
            terminalJobStates.map(state => sql`${state}`),
            sql`, `
          )})`
        )
      );
    deferredNonterminalJobs = nonterminalJobs.length;

    const batchesDeleted = affectedRows(
      await tx.delete(uploadBatches).where(
        and(
          eq(uploadBatches.organizationId, params.organizationId),
          inArray(
            uploadBatches.channelId,
            new QueryBuilder()
              .select({ id: channels.id })
              .from(channels)
              .where(
                and(
                  eq(channels.organizationId, params.organizationId),
                  inArray(channels.code, storeChannelCodes(store.id))
                )
              )
          ),
          lt(uploadBatches.createdAt, params.cutoff),
          notExists(
            new QueryBuilder()
              .select({ id: transactions.id })
              .from(transactions)
              .where(eq(transactions.batchId, uploadBatches.id))
          )
        )
      )
    );

    const webhookEventsDeleted = affectedRows(
      await tx
        .delete(shopifyWebhookEvents)
        .where(
          and(
            eq(shopifyWebhookEvents.organizationId, params.organizationId),
            eq(shopifyWebhookEvents.storeId, store.id),
            lt(shopifyWebhookEvents.receivedAt, params.cutoff)
          )
        )
    );

    const report = {
      webhookEventsDeleted,
      transactionsDeleted,
      matchesDeleted,
      exceptionsDeleted,
      workflowEventsDeleted,
      workflowsDeleted,
      anomalyScoresDeleted,
      agentActionDraftsDeleted,
      agentMemoryDeleted,
      reportsDeleted,
      jobsDeleted,
      batchesDeleted,
      ...deferred,
      deferredNonterminalJobs,
      blockedReportFiles,
    };

    // The receipt is aggregate-only: no Shopify IDs, domains, order references,
    // transaction amounts, URLs, or user identifiers are written here. It and
    // the audit entry commit atomically with the purge.
    const receiptResult = await tx
      .insert(shopifyEvidenceRetentionReceipts)
      .values({
        organizationId: params.organizationId,
        storeId: store.id,
        retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
        cutoffAt: params.cutoff,
        summary: report,
        completedAt: params.now,
      });
    const receiptId =
      Number(
        (receiptResult as unknown as [{ insertId?: number }])[0]?.insertId ?? 0
      ) || undefined;
    await params.audit(
      {
        userId: null,
        organizationId: params.organizationId,
        action: "shopify_scope_a_retention_sweep",
        entityType: "shopify_evidence_retention",
        entityId: receiptId,
        details: {
          retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
          // Counts are bounded operational evidence; no merchant/order values.
          transactionsDeleted,
          exceptionsDeferred: deferred.deferredActiveExceptions,
          workflowsDeferred: deferred.deferredActiveWorkflows,
          reportFilesBlocked: blockedReportFiles,
        },
      },
      tx
    );
    return report;
  });
}

/**
 * Purge selected *terminal* Scope A financial evidence after its 90-day period.
 * Active exception investigation, active workflow, non-terminal jobs, redacting
 * tenants, and unmanaged report files all fail closed: their records remain and
 * are reported rather than being silently discarded.
 */
export async function purgeExpiredShopifyScopeAEvidence(
  deps: ShopifyEvidenceRetentionDeps = {}
): Promise<ShopifyEvidenceRetentionReport> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("shopify_retention_database_unavailable");
  const now = deps.now?.() ?? new Date();
  const cutoff = shopifyScopeAEvidenceRetentionCutoff(now);
  const report = emptyReport();
  const stores = await db
    .select({
      id: shopifyConnectorStores.id,
      organizationId: shopifyConnectorStores.organizationId,
    })
    .from(shopifyConnectorStores)
    .innerJoin(
      organizations,
      eq(organizations.id, shopifyConnectorStores.organizationId)
    )
    .where(
      and(
        eq(organizations.deletionState, "active"),
        sql`${shopifyConnectorStores.status} <> 'redacting'`
      )
    );

  report.storesConsidered = stores.length;
  for (const store of stores) {
    try {
      const result = await purgeStoreEvidence(db, {
        storeId: store.id,
        organizationId: store.organizationId,
        cutoff,
        now,
        audit: deps.audit ?? createAuditLog,
      });
      if (result.skipped) {
        report.storesSkipped += 1;
        continue;
      }
      report.storesCompleted += 1;
      for (const [key, value] of Object.entries(result)) {
        if (key !== "skipped" && typeof value === "number") {
          report[key as keyof ShopifyEvidenceRetentionReport] += value as never;
        }
      }
    } catch (error) {
      report.storesFailed += 1;
      console.error("[shopify-retention] store sweep failed", {
        code: "shopify_scope_a_retention_sweep_failed",
        ...loggableError(error),
      });
    }
  }
  return report;
}

let nextScheduledSweepAt = 0;

/**
 * Application-owned schedule used by the existing privacy maintenance loop. A
 * restart may run an extra idempotent sweep; a partial sweep retries in one hour.
 */
export async function runShopifyScopeAEvidenceRetentionIfDue(
  deps: ShopifyEvidenceRetentionDeps = {}
): Promise<ShopifyEvidenceRetentionScheduledResult> {
  const now = deps.now?.() ?? new Date();
  if (now.getTime() < nextScheduledSweepAt) {
    return { ran: false, retryAt: new Date(nextScheduledSweepAt) };
  }
  const report = await purgeExpiredShopifyScopeAEvidence({
    ...deps,
    now: () => now,
  });
  const interval =
    report.storesFailed > 0
      ? SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS
      : SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS;
  nextScheduledSweepAt = now.getTime() + interval;
  return { ran: true, retryAt: new Date(nextScheduledSweepAt), report };
}

/** Test-only reset for the process-local scheduler guard. */
export function resetShopifyScopeAEvidenceRetentionScheduleForTest(): void {
  nextScheduledSweepAt = 0;
}
