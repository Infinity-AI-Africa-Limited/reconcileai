import crypto from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  ne,
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
  complianceAssessments,
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
  slConnectorBillingCharges,
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
  shopifyEvidenceRetentionReceipts,
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
import {
  orgScopedKey,
  platformStorageLocation,
  sameStorageBucket,
  type StorageLocation,
  storageDelete,
  storageListKeys,
} from "../../storage";
import {
  legacyUserFilePrefixes,
  TENANT_UPLOAD_DEADLINE_MS,
} from "../../tenantStorage";
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
/**
 * How long after this job first ran its storage is left alone. A tenant upload
 * that passed its "is the tenant active?" check before admission fenced the
 * tenant ends within `TENANT_UPLOAD_DEADLINE_MS` of that check, which came
 * before this job existed. Waiting the deadline plus a margin (for clock skew
 * between instances) from the first claim means the folder listing sees every
 * such file, and no new one can start.
 */
export const SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS =
  TENANT_UPLOAD_DEADLINE_MS + 2 * 60_000;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type ShopifyShopRedactionFailureCode =
  | "invalid_request_scope"
  | "manifest_version_unsupported"
  | "unmanaged_file_reference"
  /** The organisation is live, not fenced for redaction: never erase it. */
  | "tenant_not_fenced"
  | "object_deletion_failed"
  /** A data-request export may still be uploading; retried once its lease ends. */
  | "export_in_flight"
  /** A stored file appeared or changed after the objects were deleted; retried. */
  | "storage_inventory_changed"
  /** Uploads that saw the tenant active may still be landing; retried once they cannot be. */
  | "uploads_settling"
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
  /** Test-only storage boundary: every key under a folder prefix. */
  listObjects?: (prefix: string) => Promise<string[]>;
  /** Test-only checkpoint after counting and before storage is erased. */
  afterManifest?: (
    manifest: Readonly<ShopifyShopRedactionManifestSummary>
  ) => Promise<void> | void;
  /** Test-only checkpoint after storage is erased and before the database transaction. */
  afterObjectsDeleted?: () => Promise<void> | void;
  /** Test-only: the platform's own bucket and endpoint (default: configured storage). */
  platformStorage?: StorageLocation;
}

/** What a manifest counts: one store of one tenant. */
interface ManifestScope {
  organizationId: number;
  storeId: number;
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
  /** When this job was first claimed — necessarily after admission committed. */
  startedAt: Date | null;
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
      startedAt: shopifyShopRedactionJobs.startedAt,
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
  job: ManifestScope
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

/** The organisation is live: erasing it would delete a tenant nobody asked to delete. */
class TenantNotFencedError extends Error {
  constructor() {
    super("tenant_not_fenced");
    this.name = "TenantNotFencedError";
  }
}

/** A data-request export holds a live lease, so its upload may still land. */
class ExportInFlightError extends Error {
  constructor(readonly leaseExpiresAt: Date) {
    super("export_in_flight");
    this.name = "ExportInFlightError";
  }
}

/** The stored files changed after they were deleted; the deletion must be redone. */
/** Tenant uploads may still be landing; storage is not touched until `settlesAt`. */
class UploadsSettlingError extends Error {
  constructor(readonly settlesAt: Date) {
    super("uploads_settling");
    this.name = "UploadsSettlingError";
  }
}

class StorageInventoryChangedError extends Error {
  constructor() {
    super("storage_inventory_changed");
    this.name = "StorageInventoryChangedError";
  }
}

/**
 * Redaction erases only a FENCED tenant — one admission marked `redacting`,
 * which stops new syncs, logins, exports and files. A live organisation is
 * refused. A missing one is allowed: everything is erased by its id, so a
 * retry after an erasure, or of a tenant deleted some other way, is the same work.
 */
function tenantFenced(organization: { deletionState: string } | undefined): boolean {
  return organization === undefined || organization.deletionState === "redacting";
}

async function assertTenantFenced(db: DbExecutor, organizationId: number): Promise<void> {
  const [organization] = await db
    .select({ deletionState: organizations.deletionState })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!tenantFenced(organization)) throw new TenantNotFencedError();
}

/**
 * The latest lease a data-request export holds in this tenant, or null.
 *
 * An export claimed before admission fenced the tenant passed its fence check
 * then, and may upload its file at any time until its lease ends. A file that
 * lands after this run deletes the tenant's objects would outlive the tenant,
 * and once its row is erased nothing could find it again. So the run waits for
 * that lease. Any export claimed later sees the fence and uploads nothing.
 */
async function liveExportLeaseExpiry(
  db: DbExecutor,
  organizationId: number,
  now: Date,
  lock = false
): Promise<Date | null> {
  const query = db
    .select({ leaseExpiresAt: shopifyPrivacyDataRequestJobs.leaseExpiresAt })
    .from(shopifyPrivacyDataRequestJobs)
    .where(
      and(
        eq(shopifyPrivacyDataRequestJobs.organizationId, organizationId),
        eq(shopifyPrivacyDataRequestJobs.status, "processing"),
        isNotNull(shopifyPrivacyDataRequestJobs.leaseExpiresAt),
        gt(shopifyPrivacyDataRequestJobs.leaseExpiresAt, now)
      )
    )
    .orderBy(desc(shopifyPrivacyDataRequestJobs.leaseExpiresAt))
    .limit(1);
  const [live] = await (lock ? query.for("update") : query);
  return live?.leaseExpiresAt ?? null;
}

/** The storage this worker erases: test doubles replace both halves. */
interface RedactionStorage {
  list: (prefix: string) => Promise<string[]>;
  delete: (key: string) => Promise<void>;
}

interface ArtifactState {
  key: string;
  status: string;
  sha256: string | null;
}

/** The tenant's storage as it stood when its objects were deleted. */
export interface ShopRedactionStorageInventory {
  /** Every key this run deleted. */
  deletedKeys: ReadonlySet<string>;
  /** Each privacy export's state by key: an upload that finished later changes it. */
  artifactStates: ReadonlyMap<string, string>;
}

const artifactState = (artifact: Pick<ArtifactState, "status" | "sha256">) =>
  `${artifact.status}:${artifact.sha256 ?? ""}`;

/**
 * The folders that hold a tenant's files: `org/<id>/` for everything stored
 * since files were keyed by tenant, and the per-user folders where the
 * tenant's own users' exports were kept before that.
 */
export function tenantStoragePrefixes(
  organizationId: number,
  userIds: readonly number[]
): string[] {
  return [
    orgScopedKey(organizationId, ""),
    ...userIds.flatMap(userId => legacyUserFilePrefixes(userId)),
  ];
}

/**
 * Has anything been stored, or finished uploading, since `inventory` was taken?
 *
 * Under the erasure's locks, a privacy export or tracked file whose key this
 * run did not delete means a file it never saw. A privacy export whose state
 * moved since — to `ready`, or back to `writing` because a late upload landed
 * — means an upload finished after its object was deleted, so the object may
 * exist again. Either way the deletion must be redone before the rows that
 * name those files are erased. An export since discarded (`deleted`) left
 * nothing behind.
 */
export function storageChangedSince(
  inventory: ShopRedactionStorageInventory,
  artifacts: readonly ArtifactState[],
  exportKeys: readonly (string | null)[]
): boolean {
  for (const key of exportKeys) {
    if (key && !inventory.deletedKeys.has(key)) return true;
  }
  for (const artifact of artifacts) {
    if (!artifact.key) continue;
    if (!inventory.deletedKeys.has(artifact.key)) return true;
    if (artifact.status === "deleted") continue;
    if (inventory.artifactStates.get(artifact.key) !== artifactState(artifact))
      return true;
  }
  return false;
}

/**
 * Refuse completion while merchant files may sit where this erasure cannot
 * safely reach them: a legacy opaque URL, or a bucket-ingestion source that
 * reads from the PLATFORM's own bucket. That source's files and archive live
 * under prefixes the tenant chose, not under `org/<id>/`, and deleting by a
 * tenant-chosen prefix (possibly empty) could reach other tenants' objects. A
 * source on the merchant's own bucket holds the merchant's files, not ours —
 * including one that shares our bucket's NAME on another service (R2 and
 * MinIO names are scoped to their endpoint), so a bucket is matched by its
 * service and name together (`sameStorageBucket`).
 */
async function assertNoUnmanagedFileReferences(
  db: DbExecutor,
  organizationId: number,
  platform: StorageLocation
): Promise<void> {
  const sameName = platform.bucket
    ? await db
        .select({
          bucket: bucketIngestionSources.bucket,
          endpoint: bucketIngestionSources.endpoint,
        })
        .from(bucketIngestionSources)
        .where(
          and(
            eq(bucketIngestionSources.organizationId, organizationId),
            eq(bucketIngestionSources.bucket, platform.bucket)
          )
        )
    : [];
  if (sameName.some(source => sameStorageBucket(platform, source)))
    throw new UnmanagedFileReferenceError();
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

/** The privacy exports and tracked files that name this tenant's stored objects. */
async function readStorageRows(
  db: DbExecutor,
  organizationId: number,
  lock: boolean
): Promise<{ artifacts: ArtifactState[]; exportKeys: Array<string | null> }> {
  const artifactQuery = db
    .select({
      key: shopifyPrivacyArtifacts.objectKey,
      status: shopifyPrivacyArtifacts.status,
      sha256: shopifyPrivacyArtifacts.sha256,
    })
    .from(shopifyPrivacyArtifacts)
    .where(eq(shopifyPrivacyArtifacts.organizationId, organizationId));
  const exportQuery = db
    .select({ key: s3CsvExports.s3Key })
    .from(s3CsvExports)
    .where(eq(s3CsvExports.organizationId, organizationId));
  // One after the other: inside the erasure these are locking reads on one connection.
  const artifacts = await (lock ? artifactQuery.for("update") : artifactQuery);
  const exportRows = await (lock ? exportQuery.for("update") : exportQuery);
  return { artifacts, exportKeys: exportRows.map(row => row.key) };
}

/**
 * Delete every object the tenant owns: those its rows name, and everything in
 * its folders — including files no row records, such as downloads written
 * straight to storage. Returns what was deleted, so the erasure can prove,
 * under its locks, that nothing was stored after this ran.
 *
 * The rows are read BEFORE the folders are listed and the objects deleted: an
 * upload that lands after the read changes its row, which the erasure sees.
 */
async function deleteTenantObjects(
  db: DbExecutor,
  organizationId: number,
  storage: RedactionStorage
): Promise<ShopRedactionStorageInventory> {
  const { artifacts, exportKeys } = await readStorageRows(
    db,
    organizationId,
    false
  );
  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.organizationId, organizationId));
  const keys = new Set<string>();
  for (const key of [...artifacts.map(a => a.key), ...exportKeys])
    if (key) keys.add(key);
  for (const prefix of tenantStoragePrefixes(
    organizationId,
    members.map(member => member.id)
  ))
    for (const key of await storage.list(prefix)) keys.add(key);
  for (const key of keys) await storage.delete(key);
  return {
    deletedKeys: keys,
    artifactStates: new Map(
      artifacts.map(artifact => [artifact.key, artifactState(artifact)])
    ),
  };
}

/**
 * After the erasure commits, the tenant no longer exists and nothing may store
 * a file for it. Whatever is in its folder now came from an upload that
 * outlived its lease; delete it. Best effort — the receipt already stands, and
 * a failure is logged without identifiers.
 */
async function sweepStragglers(
  storage: RedactionStorage,
  organizationId: number
): Promise<void> {
  try {
    for (const key of await storage.list(orgScopedKey(organizationId, "")))
      await storage.delete(key);
  } catch {
    console.error("[shopify-shop-redaction] post-erasure storage sweep failed", {
      code: "straggler_sweep_failed",
    });
  }
}

/**
 * This tenant's privacy-queue outbox rows. An outbox row's `jobId` means a
 * different thing per kind — a privacy REQUEST id for the customer kinds, the
 * shop-redaction JOB's own id for `shop_redact` — and the two id sequences
 * overlap. So each kind is matched only against its own ids: a bare
 * `jobId IN (…)` would also delete another tenant's row of a different kind
 * that happens to carry the same number, silently dropping its work.
 */
export function tenantOutboxRows(organizationId: number): SQL | undefined {
  const requestIds = new QueryBuilder()
    .select({ id: shopifyPrivacyRequests.id })
    .from(shopifyPrivacyRequests)
    .where(eq(shopifyPrivacyRequests.organizationId, organizationId));
  const shopRedactionJobIds = new QueryBuilder()
    .select({ id: shopifyShopRedactionJobs.id })
    .from(shopifyShopRedactionJobs)
    .where(eq(shopifyShopRedactionJobs.organizationId, organizationId));
  return or(
    and(
      inArray(shopifyPrivacyQueueOutbox.kind, [
        "customer_request",
        "customer_redact",
      ]),
      inArray(shopifyPrivacyQueueOutbox.jobId, requestIds)
    ),
    and(
      eq(shopifyPrivacyQueueOutbox.kind, "shop_redact"),
      inArray(shopifyPrivacyQueueOutbox.jobId, shopRedactionJobIds)
    )
  );
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
 *
 * The erasure is tenant-wide, so it settles every shop/redact the tenant has:
 * a tenant with several stores receives one per store, and each such job gets
 * its own receipt here and is removed with the tenant. A job left behind would
 * name an organisation that no longer exists and could never complete.
 */
async function eraseTenantWorkspace(
  db: Db,
  job: ClaimedShopRedactionJob,
  manifest: ShopifyShopRedactionManifestSummary,
  inventory: ShopRedactionStorageInventory,
  clock: () => Date
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
    // Organisation first, then the job and its store: admission's lock order,
    // and the data-request export's. Holding it, no new shop/redact can be
    // admitted for this tenant and no export can finish its transition.
    const [organization] = await tx
      .select({ deletionState: organizations.deletionState })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
      .for("update");
    if (!tenantFenced(organization)) throw new TenantNotFencedError();
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
    // Every other shop/redact of this tenant, whatever its state; a worker
    // running one is fenced out by its lease, which this deletes.
    const siblings = await tx
      .select({
        id: shopifyShopRedactionJobs.id,
        runId: shopifyShopRedactionJobs.runId,
        storeId: shopifyShopRedactionJobs.storeId,
        requestHash: shopifyShopRedactionJobs.requestHash,
      })
      .from(shopifyShopRedactionJobs)
      .where(
        and(
          eq(shopifyShopRedactionJobs.organizationId, organizationId),
          ne(shopifyShopRedactionJobs.id, job.id)
        )
      )
      .for("update");
    const stores = await tx
      .select({ shopDomain: shopifyConnectorStores.shopDomain })
      .from(shopifyConnectorStores)
      .where(eq(shopifyConnectorStores.organizationId, organizationId))
      .for("update");

    // The clock is read after the locks: a check made under them must not use
    // a time from before the wait for them.
    const at = clock();
    const liveExport = await liveExportLeaseExpiry(tx, organizationId, at, true);
    if (liveExport) throw new ExportInFlightError(liveExport);
    const storageNow = await readStorageRows(tx, organizationId, true);
    if (
      storageChangedSince(inventory, storageNow.artifacts, storageNow.exportKeys)
    )
      throw new StorageInventoryChangedError();
    // Count each sibling's store before its rows go, for its own receipt.
    const siblingManifests: ShopifyShopRedactionManifestSummary[] = [];
    for (const sibling of siblings)
      siblingManifests.push(
        await buildManifest(tx, { organizationId, storeId: sibling.storeId })
      );

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
    // A self-assessment a tenant user took signed in: it names them and their institution.
    await tx
      .delete(complianceAssessments)
      .where(inArray(complianceAssessments.userId, userIds));
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
      .where(tenantOutboxRows(organizationId));

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
      // Subscriptions before their charges: a paid webhook locks a store's
      // subscription row before its charge rows, so erasure takes the same order.
      slConnectorSubscriptions,
      slConnectorBillingCharges,
      slConnectorWebhookEvents,
      slConnectorTokens,
      slConnectorStores,
      // These receipts remain tenant-linked only while the workspace exists.
      shopifyEvidenceRetentionReceipts,
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
    // Every store's install lease, not only the claimed store's.
    const shopDomains = [
      ...new Set([owned.shopDomain, ...stores.map(store => store.shopDomain)]),
    ];
    await tx
      .delete(shopifyInstallLeases)
      .where(inArray(shopifyInstallLeases.shopDomain, shopDomains));
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
      .values([
        {
          runId: job.runId,
          requestHash: job.requestHash,
          manifestVersion: job.manifestVersion,
          manifestSummary: manifest,
          completedAt: at,
        },
        ...siblings.map((sibling, index) => ({
          runId: sibling.runId,
          requestHash: sibling.requestHash,
          // The summary below is this code's shape, whatever the sibling was admitted with.
          manifestVersion: SHOPIFY_SHOP_REDACTION_MANIFEST_VERSION,
          manifestSummary: siblingManifests[index],
          completedAt: at,
        })),
      ])
      .onDuplicateKeyUpdate({
        set: { runId: sql`${shopifyShopRedactionReceipts.runId}` },
      });
    await tx
      .delete(shopifyShopRedactionJobs)
      .where(eq(shopifyShopRedactionJobs.organizationId, organizationId));
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

/**
 * Release the lease and schedule a retry — or end the job once its attempts are
 * spent. `notBefore` holds the retry back until a blocker is known to clear: a
 * retry while an export's lease is still live would only be refused again.
 */
async function setRetryableFailure(
  db: Db,
  job: ClaimedShopRedactionJob,
  now: Date,
  failureCode: ShopifyShopRedactionFailureCode = "worker_failed",
  notBefore?: Date
): Promise<void> {
  const terminal = job.attempts >= SHOPIFY_SHOP_REDACTION_MAX_ATTEMPTS;
  const status = terminal ? "failed_terminal" : "failed_retryable";
  const backoff = now.getTime() + retryDelayMs(job.attempts);
  const nextAttemptAt = terminal
    ? null
    : new Date(Math.max(backoff, (notBefore?.getTime() ?? 0) + 1_000));
  await db.transaction(async tx => {
    const jobWrite = await tx
      .update(shopifyShopRedactionJobs)
      .set({
        status,
        failureCode,
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
          failureCode,
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
        .set({ status, completionNote: failureCode, completedAt: null })
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
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const leaseId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const storage: RedactionStorage = {
    list: deps.listObjects ?? storageListKeys,
    delete: deps.deleteObject ?? storageDelete,
  };
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

    // Before anything is deleted: never erase a live tenant.
    await assertTenantFenced(db, job.organizationId);
    const manifest = await buildManifest(db, job);
    await deps.afterManifest?.(manifest);
    await assertNoUnmanagedFileReferences(
      db,
      job.organizationId,
      deps.platformStorage ?? platformStorageLocation()
    );
    const exportLease = await liveExportLeaseExpiry(
      db,
      job.organizationId,
      clock()
    );
    if (exportLease) throw new ExportInFlightError(exportLease);
    const settlesAt = new Date(
      (job.startedAt ?? now).getTime() + SHOPIFY_SHOP_REDACTION_UPLOAD_SETTLE_MS
    );
    if (clock() < settlesAt) throw new UploadsSettlingError(settlesAt);

    let inventory: ShopRedactionStorageInventory;
    try {
      inventory = await deleteTenantObjects(db, job.organizationId, storage);
    } catch {
      await setRetryableFailure(db, job, clock(), "object_deletion_failed");
      return;
    }
    await deps.afterObjectsDeleted?.();
    await eraseTenantWorkspace(db, job, manifest, inventory, clock);
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
    if (error instanceof TenantNotFencedError) {
      await setNonTerminal(db, job, "manual_review", "tenant_not_fenced", null);
      return;
    }
    if (error instanceof ExportInFlightError) {
      await setRetryableFailure(
        db,
        job,
        clock(),
        "export_in_flight",
        error.leaseExpiresAt
      );
      return;
    }
    if (error instanceof UploadsSettlingError) {
      await setRetryableFailure(
        db,
        job,
        clock(),
        "uploads_settling",
        error.settlesAt
      );
      return;
    }
    if (error instanceof StorageInventoryChangedError) {
      await setRetryableFailure(db, job, clock(), "storage_inventory_changed");
      return;
    }
    await setRetryableFailure(db, job, clock());
    return;
  }
  await sweepStragglers(storage, job.organizationId);
}
