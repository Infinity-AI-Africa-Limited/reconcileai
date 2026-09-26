import crypto from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { channels, transactions, uploadBatches } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyConnectorTokens,
  shopifyOrderRedactionTombstones,
  shopifyPrivacyArtifacts,
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyRequests,
  shopifyPrivacyRequestSelectors,
  shopifyShopRedactionJobs,
  shopifySyncCursors,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { getDb, type DbExecutor } from "../../db";
import { affectedRows } from "./tokenStore";
import { ShopifyPrivacyJobNotClaimableError } from "./privacyJobState";

export const SHOPIFY_SHOP_REDACTION_MANIFEST_VERSION = 1;
export const SHOPIFY_SHOP_REDACTION_LEASE_MS = 5 * 60_000;
export const SHOPIFY_SHOP_REDACTION_MAX_ATTEMPTS = 6;
export const SHOPIFY_SHOP_REDACTION_BLOCKER = "automatic_deletion_not_enabled" as const;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type ShopifyShopRedactionFailureCode =
  | typeof SHOPIFY_SHOP_REDACTION_BLOCKER
  | "invalid_request_scope"
  | "manifest_version_unsupported"
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
}

export interface ShopifyShopRedactionWorkerDeps {
  db?: Db;
  now?: () => Date;
  uuid?: () => string;
  /** Test-only checkpoint after counting and before the fenced final write. */
  afterManifest?: (manifest: Readonly<ShopifyShopRedactionManifestSummary>) => Promise<void> | void;
}

interface ClaimedShopRedactionJob {
  id: number;
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

function claimableShopRedactionJob(now: Date) {
  return or(
    and(
      inArray(shopifyShopRedactionJobs.status, ["admitted", "failed_retryable"]),
      or(isNull(shopifyShopRedactionJobs.nextAttemptAt), lte(shopifyShopRedactionJobs.nextAttemptAt, now)),
    ),
    and(
      eq(shopifyShopRedactionJobs.status, "processing"),
      lte(shopifyShopRedactionJobs.leaseExpiresAt, now),
    ),
  );
}

async function claimShopRedactionJob(
  db: Db,
  jobId: number,
  now: Date,
  leaseId: string,
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
    .where(and(eq(shopifyShopRedactionJobs.id, jobId), claimableShopRedactionJob(now)));
  if (affectedRows(claim) !== 1) return null;

  const [job] = await db
    .select({
      id: shopifyShopRedactionJobs.id,
      organizationId: shopifyShopRedactionJobs.organizationId,
      storeId: shopifyShopRedactionJobs.storeId,
      privacyRequestId: shopifyShopRedactionJobs.privacyRequestId,
      requestHash: shopifyShopRedactionJobs.requestHash,
      attempts: shopifyShopRedactionJobs.attempts,
      manifestVersion: shopifyShopRedactionJobs.manifestVersion,
    })
    .from(shopifyShopRedactionJobs)
    .where(and(eq(shopifyShopRedactionJobs.id, jobId), eq(shopifyShopRedactionJobs.leaseId, leaseId)))
    .limit(1);
  return job ? { ...job, leaseId } : null;
}

function numericCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_count_result");
  return parsed;
}

async function countRows(db: DbExecutor, table: MySqlTable, where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(where);
  return numericCount(row?.count);
}

async function buildManifest(
  db: DbExecutor,
  job: ClaimedShopRedactionJob,
): Promise<ShopifyShopRedactionManifestSummary> {
  const organizationId = job.organizationId;
  const storeId = job.storeId;
  const storeScope = and(
    eq(shopifyConnectorStores.id, storeId),
    eq(shopifyConnectorStores.organizationId, organizationId),
  );
  const exactStoreScope = <T extends { organizationId: any; storeId: any }>(table: T) =>
    and(eq(table.organizationId, organizationId), eq(table.storeId, storeId));
  const directChannelScope = and(
    eq(channels.organizationId, organizationId),
    eq(channels.code, `shopify_orders_${storeId}`),
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
  ] = await Promise.all([
    countRows(db, shopifyConnectorStores, storeScope),
    countRows(db, shopifyConnectorTokens, exactStoreScope(shopifyConnectorTokens)),
    countRows(db, shopifyPrivacyRequests, exactStoreScope(shopifyPrivacyRequests)),
    countRows(
      db,
      shopifyPrivacyRequestSelectors,
      and(
        eq(shopifyPrivacyRequestSelectors.organizationId, organizationId),
        sql`EXISTS (SELECT 1 FROM ${shopifyPrivacyRequests} AS scoped_request WHERE scoped_request.id = ${shopifyPrivacyRequestSelectors.requestId} AND scoped_request.organizationId = ${organizationId} AND scoped_request.storeId = ${storeId})`,
      ),
    ),
    countRows(db, shopifyPrivacyDataRequestJobs, exactStoreScope(shopifyPrivacyDataRequestJobs)),
    countRows(db, shopifyPrivacyCustomerRedactionJobs, exactStoreScope(shopifyPrivacyCustomerRedactionJobs)),
    countRows(db, shopifyPrivacyArtifacts, exactStoreScope(shopifyPrivacyArtifacts)),
    countRows(db, shopifyWebhookEvents, exactStoreScope(shopifyWebhookEvents)),
    countRows(db, shopifySyncCursors, exactStoreScope(shopifySyncCursors)),
    countRows(db, shopifyOrderRedactionTombstones, exactStoreScope(shopifyOrderRedactionTombstones)),
    countRows(
      db,
      transactions,
      and(eq(transactions.organizationId, organizationId), eq(transactions.shopifyStoreId, storeId)),
    ),
    countRows(db, channels, directChannelScope),
  ]);
  const directShopifyBatches = await countRows(
    db,
    uploadBatches,
    and(
      eq(uploadBatches.organizationId, organizationId),
      sql`EXISTS (SELECT 1 FROM ${channels} AS scoped_channel WHERE scoped_channel.id = ${uploadBatches.channelId} AND scoped_channel.organizationId = ${organizationId} AND scoped_channel.code = ${`shopify_orders_${storeId}`})`,
    ),
  );

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
  });
}

async function setNonTerminal(
  db: Db,
  job: ClaimedShopRedactionJob,
  status: "manual_review" | "blocked_dependency",
  failureCode: ShopifyShopRedactionFailureCode,
  manifestSummary: ShopifyShopRedactionManifestSummary | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const jobWrite = await tx
      .update(shopifyShopRedactionJobs)
      .set({
        status,
        failureCode,
        manifestSummary,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastCheckpoint: manifestSummary ? "report_only_manifest_recorded" : status,
        // Deliberately null: this worker did not delete the shop.
        completedAt: null,
      })
      .where(
        and(
          eq(shopifyShopRedactionJobs.id, job.id),
          eq(shopifyShopRedactionJobs.organizationId, job.organizationId),
          eq(shopifyShopRedactionJobs.storeId, job.storeId),
          eq(shopifyShopRedactionJobs.leaseId, job.leaseId),
          eq(shopifyShopRedactionJobs.status, "processing"),
        ),
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
            inArray(shopifyPrivacyRequests.status, ["received", "processing", "failed_retryable"]),
          ),
        );
    }
  });
}

async function setRetryableFailure(
  db: Db,
  job: ClaimedShopRedactionJob,
  now: Date,
): Promise<void> {
  const terminal = job.attempts >= SHOPIFY_SHOP_REDACTION_MAX_ATTEMPTS;
  const status = terminal ? "failed_terminal" : "failed_retryable";
  const nextAttemptAt = terminal ? null : new Date(now.getTime() + retryDelayMs(job.attempts));
  await db.transaction(async (tx) => {
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
          eq(shopifyShopRedactionJobs.status, "processing"),
        ),
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
            eq(shopifyPrivacyQueueOutbox.jobId, job.id),
          ),
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
            eq(shopifyPrivacyRequests.topic, "shop/redact"),
          ),
        );
    }
  });
}

/**
 * Process one internal shop-redact job handle. The only writes after claim are
 * bounded job/request state transitions; all tenant and connector data is read
 * exclusively for exact scoped counts.
 */
export async function handleShopifyShopRedactionJob(
  jobId: number,
  deps: ShopifyShopRedactionWorkerDeps = {},
): Promise<void> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("Invalid privacy job payload");
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
    if (current && ["admitted", "failed_retryable", "processing"].includes(current.status)) {
      throw new ShopifyPrivacyJobNotClaimableError();
    }
    return;
  }

  try {
    if (job.privacyRequestId === null) {
      await setNonTerminal(db, job, "manual_review", "invalid_request_scope", null);
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
          eq(shopifyPrivacyRequests.topic, "shop/redact"),
        ),
      )
      .limit(1);
    if (!request) {
      await setNonTerminal(db, job, "manual_review", "invalid_request_scope", null);
      return;
    }
    if (job.manifestVersion !== SHOPIFY_SHOP_REDACTION_MANIFEST_VERSION) {
      await setNonTerminal(db, job, "manual_review", "manifest_version_unsupported", null);
      return;
    }

    const manifest = await buildManifest(db, job);
    await deps.afterManifest?.(manifest);
    await setNonTerminal(db, job, "blocked_dependency", SHOPIFY_SHOP_REDACTION_BLOCKER, manifest);
  } catch {
    await setRetryableFailure(db, job, now);
  }
}
