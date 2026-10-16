import crypto from "node:crypto";
import {
  and,
  count,
  eq,
  exists,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  QueryBuilder,
  type AnyMySqlColumn,
  type MySqlTable,
} from "drizzle-orm/mysql-core";
import {
  agentActionDrafts,
  agentMemory,
  anomalyScores,
  apiIngestionLogs,
  apiKeys,
  auditChainLocks,
  auditLogs,
  bucketIngestionLogs,
  bucketIngestionSources,
  cbnActionPlans,
  cbnAuditLog,
  cbnDeadlineSubmissions,
  cbnReportFindings,
  cbnReportRuns,
  cbnReportSettings,
  cbnReportSubmissions,
  cfoReportSchedules,
  channelAlertSettings,
  channels,
  complianceSettings,
  controlBatchManifests,
  controlFitBriefs,
  controlPolicies,
  controlSourceContracts,
  corporateB2BPilotConfigs,
  corporateB2BPilotSources,
  dashboardStatsCache,
  dataDeletionRequests,
  detectionRules,
  distributors,
  emailIngestionLogs,
  emailIngestionSources,
  emailPreferences,
  exceptionAgingSettings,
  exceptionIntelligenceSettings,
  exceptionPatternSignatures,
  exceptions,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  guestSessions,
  guestTokens,
  jobProgressEvents,
  magicLinkTokens,
  matches,
  moduleConfigurations,
  moduleOverrides,
  organizations,
  platformAuditLogs,
  reconciliationJobs,
  reconciliationReports,
  resolutionTemplates,
  reviewerAccessLinks,
  s3CsvExports,
  scheduleRunHistory,
  scheduledTasks,
  securityIncidents,
  sftpCredentials,
  sftpIngestionLogs,
  sharedReportTokens,
  transactions,
  uploadBatches,
  userRolePreferences,
  users,
  webhookDeliveries,
  webhooks,
} from "../../../drizzle/schema";
import {
  slConnectorGdprRequests,
  slConnectorStores,
  slConnectorSubscriptions,
  slConnectorTokens,
  slConnectorWebhookEvents,
  wcConnectorConfigs,
  wcConnectorDeadLetters,
  wcConnectorFieldMappings,
  wcConnectorSyncRuns,
  wcConnectorWebhookEvents,
} from "../../../drizzle/connector_schema";
import {
  shopifyConnectorStores,
  shopifyConnectorTokens,
  shopifyInstallLeases,
  shopifyOrderRedactionTombstones,
  shopifyPrivacyArtifacts,
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyRequests,
  shopifyPrivacyRequestSelectors,
  shopifyShopRedactionReceipts,
  shopifyShopRedactionJobs,
  shopifySyncCursors,
  shopifySyncRequests,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import {
  tenantEncryptionKeys,
  tenantQuotas,
} from "../../../drizzle/tenant_schema";
import { getDb, type DbExecutor } from "../../db";
import { storageDelete } from "../../storage";
import { affectedRows } from "./tokenStore";
import {
  shopifyOrdersChannelCode,
  shopifySettlementEvidenceChannelCode,
} from "./channelCodes";
import {
  claimableShopRedactionJob,
  isLiveShopRedactionJobStatus,
  ShopifyPrivacyJobNotClaimableError,
} from "./privacyJobState";

export const SHOPIFY_SHOP_REDACTION_MANIFEST_VERSION = 1;
export const SHOPIFY_SHOP_REDACTION_LEASE_MS = 5 * 60_000;
export const SHOPIFY_SHOP_REDACTION_MAX_ATTEMPTS = 6;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type ShopifyShopRedactionFailureCode =
  | "invalid_request_scope"
  | "manifest_version_unsupported"
  | "unmanaged_file_reference"
  | "object_deletion_failed"
  | "worker_failed";

/**
 * Immutable count-only inventory. Keys are fixed in code and values are finite,
 * non-negative integers. No identifier, hash, payload, key, URL, or free text is
 * ever projected into this document.
 */
export interface ShopifyShopRedactionManifestSummary {
  connectorStores: number;
  connectorTokens: number;
  privacyRequests: number;
  privacySelectors: number;
  dataRequestJobs: number;
  customerRedactionJobs: number;
  privacyArtifacts: number;
  webhookEvents: number;
  syncCursors: number;
  suppressionTombstones: number;
  orderTransactions: number;
  directShopifyChannels: number;
  directShopifyBatches: number;
  /** Merchant-provided settlement evidence (App Home import): its own channel, and rows without `shopifyStoreId`. */
  settlementEvidenceChannels: number;
  settlementEvidenceTransactions: number;
  settlementEvidenceBatches: number;
  /** Reconciliation output derived from the store's order and settlement rows. */
  reconciliationMatches: number;
  reconciliationExceptions: number;
  anomalyScores: number;
}

export interface ShopifyShopRedactionWorkerDeps {
  db?: Db;
  now?: () => Date;
  uuid?: () => string;
  /** Test-only storage boundary. Missing objects are treated as deleted by storageDelete. */
  deleteObject?: (key: string) => Promise<void>;
  /** Test-only checkpoint after counting and before storage is erased. */
  afterManifest?: (
    manifest: Readonly<ShopifyShopRedactionManifestSummary>
  ) => Promise<void> | void;
}
interface ClaimedShopRedactionJob {
  id: number;
  runId: string;
  organizationId: number;
  storeId: number;
  /** Exact internal parent request; null only for a pre-migration legacy job. */
  privacyRequestId: number | null;
  requestHash: string;
  attempts: number;
  leaseId: string;
  manifestVersion: number;
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

async function claimShopRedactionJob(
  db: Db,
  jobId: number,
  now: Date,
  leaseId: string
): Promise<ClaimedShopRedactionJob | null> {
  const claim = await db
    .update(shopifyShopRedactionJobs)
    .set({
      status: "processing",
      attempts: sql`${shopifyShopRedactionJobs.attempts} + 1`,
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + SHOPIFY_SHOP_REDACTION_LEASE_MS),
      nextAttemptAt: null,
      failureCode: null,
      lastCheckpoint: "claimed",
      startedAt: sql`COALESCE(${shopifyShopRedactionJobs.startedAt}, ${now})`,
    })
    .where(
      and(
        eq(shopifyShopRedactionJobs.id, jobId),
        claimableShopRedactionJob(now)
      )
    );
  if (affectedRows(claim) !== 1) return null;

  const [job] = await db
    .select({
      id: shopifyShopRedactionJobs.id,
      runId: shopifyShopRedactionJobs.runId,
      organizationId: shopifyShopRedactionJobs.organizationId,
      storeId: shopifyShopRedactionJobs.storeId,
      privacyRequestId: shopifyShopRedactionJobs.privacyRequestId,
      requestHash: shopifyShopRedactionJobs.requestHash,
      attempts: shopifyShopRedactionJobs.attempts,
      manifestVersion: shopifyShopRedactionJobs.manifestVersion,
    })
    .from(shopifyShopRedactionJobs)
    .where(
      and(
        eq(shopifyShopRedactionJobs.id, jobId),
        eq(shopifyShopRedactionJobs.leaseId, leaseId)
      )
    )
    .limit(1);
  return job ? { ...job, leaseId } : null;
}

function numericCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("invalid_count_result");
  return parsed;
}

async function countRows(
  db: DbExecutor,
  table: MySqlTable,
  where: SQL | undefined
): Promise<number> {
  const [row] = await db.select({ count: count() }).from(table).where(where);
  return numericCount(row?.count);
}

async function buildManifest(
  db: DbExecutor,
  job: ClaimedShopRedactionJob
): Promise<ShopifyShopRedactionManifestSummary> {
  const organizationId = job.organizationId;
  const storeId = job.storeId;
  const storeScope = and(
    eq(shopifyConnectorStores.id, storeId),
    eq(shopifyConnectorStores.organizationId, organizationId)
  );
  const exactStoreScope = (table: {
    organizationId: AnyMySqlColumn;
    storeId: AnyMySqlColumn;
  }) =>
    and(eq(table.organizationId, organizationId), eq(table.storeId, storeId));
  const directChannelScope = and(
    eq(channels.organizationId, organizationId),
    eq(channels.code, shopifyOrdersChannelCode(storeId))
  );
  const settlementChannelScope = and(
    eq(channels.organizationId, organizationId),
    eq(channels.code, shopifySettlementEvidenceChannelCode(storeId))
  );
  // A row belongs to a channel through its channelId; correlated, so it counts
  // only rows of THIS tenant's channel with that code.
  const inChannel = (channelId: AnyMySqlColumn, scope: SQL | undefined) =>
    exists(
      new QueryBuilder()
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, channelId), scope))
    );
  // Every transaction the store's data produced: synced orders carry the store,
  // settlement evidence carries its channel instead.
  const storeTransactionIds = () =>
    new QueryBuilder()
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          or(
            eq(transactions.shopifyStoreId, storeId),
            inArray(
              transactions.channelId,
              new QueryBuilder()
                .select({ id: channels.id })
                .from(channels)
                .where(settlementChannelScope)
            )
          )
        )
      );

  const [
    connectorStores,
    connectorTokens,
    privacyRequests,
    privacySelectors,
    dataRequestJobs,
    customerRedactionJobs,
    privacyArtifacts,
    webhookEvents,
    syncCursors,
    suppressionTombstones,
    orderTransactions,
    directShopifyChannels,
    settlementEvidenceChannels,
    settlementEvidenceTransactions,
    reconciliationMatches,
    reconciliationExceptions,
    anomalyScoreRows,
  ] = await Promise.all([
    countRows(db, shopifyConnectorStores, storeScope),
    countRows(
      db,
      shopifyConnectorTokens,
      exactStoreScope(shopifyConnectorTokens)
    ),
    countRows(
      db,
      shopifyPrivacyRequests,
      exactStoreScope(shopifyPrivacyRequests)
    ),
    countRows(
      db,
      shopifyPrivacyRequestSelectors,
      and(
        eq(shopifyPrivacyRequestSelectors.organizationId, organizationId),
        // A selector belongs to this store through its parent request.
        exists(
          new QueryBuilder()
            .select({ id: shopifyPrivacyRequests.id })
            .from(shopifyPrivacyRequests)
            .where(
              and(
                eq(
                  shopifyPrivacyRequests.id,
                  shopifyPrivacyRequestSelectors.requestId
                ),
                eq(shopifyPrivacyRequests.organizationId, organizationId),
                eq(shopifyPrivacyRequests.storeId, storeId)
              )
            )
        )
      )
    ),
    countRows(
      db,
      shopifyPrivacyDataRequestJobs,
      exactStoreScope(shopifyPrivacyDataRequestJobs)
    ),
    countRows(
      db,
      shopifyPrivacyCustomerRedactionJobs,
      exactStoreScope(shopifyPrivacyCustomerRedactionJobs)
    ),
    countRows(
      db,
      shopifyPrivacyArtifacts,
      exactStoreScope(shopifyPrivacyArtifacts)
    ),
    countRows(db, shopifyWebhookEvents, exactStoreScope(shopifyWebhookEvents)),
    countRows(db, shopifySyncCursors, exactStoreScope(shopifySyncCursors)),
    countRows(
      db,
      shopifyOrderRedactionTombstones,
      exactStoreScope(shopifyOrderRedactionTombstones)
    ),
    countRows(
      db,
      transactions,
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.shopifyStoreId, storeId)
      )
    ),
    countRows(db, channels, directChannelScope),
    countRows(db, channels, settlementChannelScope),
    countRows(
      db,
      transactions,
      and(
        eq(transactions.organizationId, organizationId),
        inChannel(transactions.channelId, settlementChannelScope)
      )
    ),
    countRows(
      db,
      matches,
      and(
        eq(matches.organizationId, organizationId),
        or(
          inArray(matches.sourceTransactionId, storeTransactionIds()),
          inArray(matches.targetTransactionId, storeTransactionIds())
        )
      )
    ),
    countRows(
      db,
      exceptions,
      and(
        eq(exceptions.organizationId, organizationId),
        inArray(exceptions.transactionId, storeTransactionIds())
      )
    ),
    countRows(
      db,
      anomalyScores,
      and(
        eq(anomalyScores.organizationId, organizationId),
        inArray(anomalyScores.transactionId, storeTransactionIds())
      )
    ),
  ]);
  // A batch belongs to this store through one of its channels.
  const [directShopifyBatches, settlementEvidenceBatches] = await Promise.all([
    countRows(
      db,
      uploadBatches,
      and(
        eq(uploadBatches.organizationId, organizationId),
        inChannel(uploadBatches.channelId, directChannelScope)
      )
    ),
    countRows(
      db,
      uploadBatches,
      and(
        eq(uploadBatches.organizationId, organizationId),
        inChannel(uploadBatches.channelId, settlementChannelScope)
      )
    ),
  ]);

  return Object.freeze({
    connectorStores,
    connectorTokens,
    privacyRequests,
    privacySelectors,
    dataRequestJobs,
    customerRedactionJobs,
    privacyArtifacts,
    webhookEvents,
    syncCursors,
    suppressionTombstones,
    orderTransactions,
    directShopifyChannels,
    directShopifyBatches,
    settlementEvidenceChannels,
    settlementEvidenceTransactions,
    settlementEvidenceBatches,
    reconciliationMatches,
    reconciliationExceptions,
    anomalyScores: anomalyScoreRows,
  });
}

class UnmanagedFileReferenceError extends Error {
  constructor() {
    super("unmanaged_file_reference");
    this.name = "UnmanagedFileReferenceError";
  }
}

/** Refuse completion if a legacy opaque URL may still point at merchant data. */
async function assertNoUnmanagedFileReferences(
  db: DbExecutor,
  organizationId: number
): Promise<void> {
  const [batchFiles, reportFiles] = await Promise.all([
    countRows(
      db,
      uploadBatches,
      and(
        eq(uploadBatches.organizationId, organizationId),
        sql`${uploadBatches.fileUrl} IS NOT NULL`
      )
    ),
    countRows(
      db,
      reconciliationReports,
      and(
        eq(reconciliationReports.organizationId, organizationId),
        sql`${reconciliationReports.fileUrl} IS NOT NULL`
      )
    ),
  ]);
  if (batchFiles > 0 || reportFiles > 0)
    throw new UnmanagedFileReferenceError();
}

/** Delete all objects for which ReconcileAI holds an authoritative storage key. */
async function deleteTenantObjects(
  db: DbExecutor,
  organizationId: number,
  deleteObject: (key: string) => Promise<void>
): Promise<void> {
  const [artifacts, exports] = await Promise.all([
    db
      .select({ key: shopifyPrivacyArtifacts.objectKey })
      .from(shopifyPrivacyArtifacts)
      .where(eq(shopifyPrivacyArtifacts.organizationId, organizationId)),
    db
      .select({ key: s3CsvExports.s3Key })
      .from(s3CsvExports)
      .where(eq(s3CsvExports.organizationId, organizationId)),
  ]);
  for (const key of new Set(
    [...artifacts, ...exports].map(({ key }) => key).filter(Boolean)
  ))
    await deleteObject(key);
}

async function deleteOrgRows(
  tx: DbExecutor,
  organizationId: number,
  tables: Array<MySqlTable & { organizationId: AnyMySqlColumn }>
): Promise<void> {
  for (const table of tables)
    await tx.delete(table).where(eq(table.organizationId, organizationId));
}

/**
 * Erase a tenant only while the originally claiming worker holds its lease.
 * Storage is erased first by the caller; all database writes below are atomic.
 */
async function eraseTenantWorkspace(
  db: Db,
  job: ClaimedShopRedactionJob,
  manifest: ShopifyShopRedactionManifestSummary,
  now: Date
): Promise<void> {
  const organizationId = job.organizationId;
  const userIds = new QueryBuilder()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.organizationId, organizationId));
  const jobIds = new QueryBuilder()
    .select({ id: reconciliationJobs.id })
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.organizationId, organizationId));
  const taskIds = new QueryBuilder()
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.organizationId, organizationId));
  const webhookIds = new QueryBuilder()
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(eq(webhooks.organizationId, organizationId));

  await db.transaction(async tx => {
    const [owned] = await tx
      .select({ shopDomain: shopifyConnectorStores.shopDomain })
      .from(shopifyShopRedactionJobs)
      .innerJoin(
        shopifyConnectorStores,
        and(
          eq(shopifyConnectorStores.id, shopifyShopRedactionJobs.storeId),
          eq(
            shopifyConnectorStores.organizationId,
            shopifyShopRedactionJobs.organizationId
          )
        )
      )
      .where(
        and(
          eq(shopifyShopRedactionJobs.id, job.id),
          eq(shopifyShopRedactionJobs.organizationId, organizationId),
          eq(shopifyShopRedactionJobs.storeId, job.storeId),
          eq(shopifyShopRedactionJobs.leaseId, job.leaseId),
          eq(shopifyShopRedactionJobs.status, "processing")
        )
      )
      .limit(1)
      .for("update");
    if (!owned) throw new Error("shopify_redaction_lease_lost");

    // Child records whose scope derives from a tenant-owned parent must go first.
    await tx
      .delete(webhookDeliveries)
      .where(inArray(webhookDeliveries.webhookId, webhookIds));
    await tx
      .delete(scheduleRunHistory)
      .where(
        or(
          inArray(scheduleRunHistory.scheduledTaskId, taskIds),
          inArray(scheduleRunHistory.jobId, jobIds)
        )
      );
    await tx
      .delete(jobProgressEvents)
      .where(inArray(jobProgressEvents.jobId, jobIds));
    await tx
      .delete(magicLinkTokens)
      .where(inArray(magicLinkTokens.userId, userIds));
    await tx
      .delete(platformAuditLogs)
      .where(
        or(
          and(
            eq(platformAuditLogs.targetType, "organization"),
            eq(platformAuditLogs.targetId, organizationId)
          ),
          and(
            eq(platformAuditLogs.targetType, "user"),
            inArray(platformAuditLogs.targetId, userIds)
          )
        )
      );
    await tx
      .delete(shopifyPrivacyQueueOutbox)
      .where(
        or(
          inArray(
            shopifyPrivacyQueueOutbox.jobId,
            new QueryBuilder()
              .select({ id: shopifyPrivacyDataRequestJobs.requestId })
              .from(shopifyPrivacyDataRequestJobs)
              .where(
                eq(shopifyPrivacyDataRequestJobs.organizationId, organizationId)
              )
          ),
          inArray(
            shopifyPrivacyQueueOutbox.jobId,
            new QueryBuilder()
              .select({ id: shopifyPrivacyCustomerRedactionJobs.requestId })
              .from(shopifyPrivacyCustomerRedactionJobs)
              .where(
                eq(
                  shopifyPrivacyCustomerRedactionJobs.organizationId,
                  organizationId
                )
              )
          ),
          inArray(
            shopifyPrivacyQueueOutbox.jobId,
            new QueryBuilder()
              .select({ id: shopifyShopRedactionJobs.id })
              .from(shopifyShopRedactionJobs)
              .where(
                eq(shopifyShopRedactionJobs.organizationId, organizationId)
              )
          )
        )
      );

    await deleteOrgRows(tx, organizationId, [
      matches,
      exceptionWorkflowEvents,
      exceptionWorkflows,
      agentActionDrafts,
      agentMemory,
      anomalyScores,
      exceptions,
      transactions,
      controlBatchManifests,
      controlSourceContracts,
      controlPolicies,
      controlFitBriefs,
      reconciliationReports,
      reconciliationJobs,
      uploadBatches,
      apiIngestionLogs,
      sftpIngestionLogs,
      bucketIngestionLogs,
      emailIngestionLogs,
      sftpCredentials,
      bucketIngestionSources,
      emailIngestionSources,
      scheduledTasks,
      webhooks,
      apiKeys,
      emailPreferences,
      userRolePreferences,
      channelAlertSettings,
      cfoReportSchedules,
      reviewerAccessLinks,
      guestTokens,
      s3CsvExports,
      sharedReportTokens,
      dashboardStatsCache,
      exceptionAgingSettings,
      detectionRules,
      resolutionTemplates,
      moduleConfigurations,
      moduleOverrides,
      distributors,
      corporateB2BPilotSources,
      corporateB2BPilotConfigs,
      exceptionPatternSignatures,
      exceptionIntelligenceSettings,
      complianceSettings,
      dataDeletionRequests,
      securityIncidents,
      cbnActionPlans,
      cbnReportFindings,
      cbnReportSubmissions,
      cbnAuditLog,
      cbnDeadlineSubmissions,
      cbnReportSettings,
      cbnReportRuns,
      wcConnectorDeadLetters,
      wcConnectorWebhookEvents,
      wcConnectorSyncRuns,
      wcConnectorFieldMappings,
      wcConnectorConfigs,
      slConnectorGdprRequests,
      slConnectorSubscriptions,
      slConnectorWebhookEvents,
      slConnectorTokens,
      slConnectorStores,
      shopifyPrivacyRequestSelectors,
      shopifyPrivacyArtifacts,
      shopifyPrivacyDataRequestJobs,
      shopifyPrivacyCustomerRedactionJobs,
      shopifyOrderRedactionTombstones,
      shopifySyncRequests,
      shopifySyncCursors,
      shopifyWebhookEvents,
      shopifyPrivacyRequests,
      shopifyConnectorTokens,
      channels,
    ]);
    await tx
      .delete(guestSessions)
      .where(eq(guestSessions.guestOrganizationId, organizationId));
    await tx
      .delete(shopifyConnectorStores)
      .where(eq(shopifyConnectorStores.organizationId, organizationId));
    await tx
      .delete(shopifyInstallLeases)
      .where(eq(shopifyInstallLeases.shopDomain, owned.shopDomain));
    await tx
      .delete(tenantQuotas)
      .where(eq(tenantQuotas.organizationId, organizationId));
    await tx
      .delete(tenantEncryptionKeys)
      .where(eq(tenantEncryptionKeys.organizationId, organizationId));
    await tx
      .delete(auditLogs)
      .where(eq(auditLogs.organizationId, organizationId));
    await tx
      .delete(auditChainLocks)
      .where(eq(auditChainLocks.chainKey, organizationId));
    await tx
      .insert(shopifyShopRedactionReceipts)
      .values({
        runId: job.runId,
        requestHash: job.requestHash,
        manifestVersion: job.manifestVersion,
        manifestSummary: manifest,
        completedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { runId: sql`${shopifyShopRedactionReceipts.runId}` },
      });
    await tx
      .delete(shopifyShopRedactionJobs)
      .where(
        and(
          eq(shopifyShopRedactionJobs.id, job.id),
          eq(shopifyShopRedactionJobs.leaseId, job.leaseId)
        )
      );
    await tx.delete(users).where(eq(users.organizationId, organizationId));
    await tx
      .delete(organizations)
      .where(
        and(
          eq(organizations.id, organizationId),
          eq(organizations.deletionState, "redacting")
        )
      );
  });
}

async function setNonTerminal(
  db: Db,
  job: ClaimedShopRedactionJob,
  status: "manual_review" | "blocked_dependency",
  failureCode: ShopifyShopRedactionFailureCode,
  manifestSummary: ShopifyShopRedactionManifestSummary | null
): Promise<void> {
  await db.transaction(async tx => {
    const jobWrite = await tx
      .update(shopifyShopRedactionJobs)
      .set({
        status,
        failureCode,
        manifestSummary,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastCheckpoint: manifestSummary ? "manual_review" : status,
        // A non-terminal outcome never claims deletion completion.
        completedAt: null,
      })
      .where(
        and(
          eq(shopifyShopRedactionJobs.id, job.id),
          eq(shopifyShopRedactionJobs.organizationId, job.organizationId),
          eq(shopifyShopRedactionJobs.storeId, job.storeId),
          eq(shopifyShopRedactionJobs.leaseId, job.leaseId),
          eq(shopifyShopRedactionJobs.status, "processing")
        )
      );
    if (affectedRows(jobWrite) !== 1) return;
    if (job.privacyRequestId !== null) {
      await tx
        .update(shopifyPrivacyRequests)
        .set({ status, completionNote: failureCode, completedAt: null })
        .where(
          and(
            eq(shopifyPrivacyRequests.id, job.privacyRequestId),
            eq(shopifyPrivacyRequests.organizationId, job.organizationId),
            eq(shopifyPrivacyRequests.storeId, job.storeId),
            eq(shopifyPrivacyRequests.topic, "shop/redact"),
            inArray(shopifyPrivacyRequests.status, [
              "received",
              "processing",
              "failed_retryable",
            ])
          )
        );
    }
  });
}

async function setRetryableFailure(
  db: Db,
  job: ClaimedShopRedactionJob,
  now: Date
): Promise<void> {
  const terminal = job.attempts >= SHOPIFY_SHOP_REDACTION_MAX_ATTEMPTS;
  const status = terminal ? "failed_terminal" : "failed_retryable";
  const nextAttemptAt = terminal
    ? null
    : new Date(now.getTime() + retryDelayMs(job.attempts));
  await db.transaction(async tx => {
    const jobWrite = await tx
      .update(shopifyShopRedactionJobs)
      .set({
        status,
        failureCode: "worker_failed",
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        lastCheckpoint: status,
        completedAt: null,
      })
      .where(
        and(
          eq(shopifyShopRedactionJobs.id, job.id),
          eq(shopifyShopRedactionJobs.organizationId, job.organizationId),
          eq(shopifyShopRedactionJobs.storeId, job.storeId),
          eq(shopifyShopRedactionJobs.leaseId, job.leaseId),
          eq(shopifyShopRedactionJobs.status, "processing")
        )
      );
    if (affectedRows(jobWrite) !== 1) return;
    if (!terminal) {
      // BullMQ de-duplication is not the retry authority. Re-arm the exact
      // internal outbox row under the leased job transition, then return from
      // the worker normally; recovery will publish a fresh minimal handle only
      // when the database-controlled due time is reached.
      await tx
        .update(shopifyPrivacyQueueOutbox)
        .set({
          status: "failed_retryable",
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt,
          failureCode: "worker_failed",
        })
        .where(
          and(
            eq(shopifyPrivacyQueueOutbox.kind, "shop_redact"),
            eq(shopifyPrivacyQueueOutbox.jobId, job.id)
          )
        );
    }
    if (job.privacyRequestId !== null) {
      await tx
        .update(shopifyPrivacyRequests)
        .set({ status, completionNote: "worker_failed", completedAt: null })
        .where(
          and(
            eq(shopifyPrivacyRequests.id, job.privacyRequestId),
            eq(shopifyPrivacyRequests.organizationId, job.organizationId),
            eq(shopifyPrivacyRequests.storeId, job.storeId),
            eq(shopifyPrivacyRequests.topic, "shop/redact")
          )
        );
    }
  });
}

/**
 * Process one internal shop-redact job handle. Storage is erased before the
 * database transaction so a crash can only leave a fenced retryable tenant, not
 * a completed record that still points at data. The storage deleter is idempotent
 * for missing objects, making recovery safe after an interrupted attempt.
 */
export async function handleShopifyShopRedactionJob(
  jobId: number,
  deps: ShopifyShopRedactionWorkerDeps = {}
): Promise<void> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0)
    throw new Error("Invalid privacy job payload");
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const leaseId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const job = await claimShopRedactionJob(db, jobId, now, leaseId);
  if (!job) {
    // An at-least-once queue delivery can arrive while the original worker's
    // database lease is still live. Returning would settle this delivery while
    // the outbox already says `dispatched`; throwing retains the durable queue
    // retry until that lease is either released or expires and becomes claimable.
    const [current] = await db
      .select({ status: shopifyShopRedactionJobs.status })
      .from(shopifyShopRedactionJobs)
      .where(eq(shopifyShopRedactionJobs.id, jobId))
      .limit(1);
    if (current && isLiveShopRedactionJobStatus(current.status)) {
      throw new ShopifyPrivacyJobNotClaimableError();
    }
    return;
  }

  try {
    if (job.privacyRequestId === null) {
      await setNonTerminal(
        db,
        job,
        "manual_review",
        "invalid_request_scope",
        null
      );
      return;
    }
    const [request] = await db
      .select({ id: shopifyPrivacyRequests.id })
      .from(shopifyPrivacyRequests)
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.privacyRequestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "shop/redact")
        )
      )
      .limit(1);
    if (!request) {
      await setNonTerminal(
        db,
        job,
        "manual_review",
        "invalid_request_scope",
        null
      );
      return;
    }
    if (job.manifestVersion !== SHOPIFY_SHOP_REDACTION_MANIFEST_VERSION) {
      await setNonTerminal(
        db,
        job,
        "manual_review",
        "manifest_version_unsupported",
        null
      );
      return;
    }

    const manifest = await buildManifest(db, job);
    await deps.afterManifest?.(manifest);
    await assertNoUnmanagedFileReferences(db, job.organizationId);
    try {
      await deleteTenantObjects(
        db,
        job.organizationId,
        deps.deleteObject ?? storageDelete
      );
    } catch {
      await setRetryableFailure(db, job, now);
      return;
    }
    await eraseTenantWorkspace(db, job, manifest, now);
  } catch (error) {
    if (error instanceof UnmanagedFileReferenceError) {
      await setNonTerminal(
        db,
        job,
        "manual_review",
        "unmanaged_file_reference",
        null
      );
      return;
    }
    await setRetryableFailure(db, job, now);
  }
}
