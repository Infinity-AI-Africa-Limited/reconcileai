import crypto from "node:crypto";
import { and, eq, exists, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/mysql-core";
import {
  anomalyScores,
  auditLogs,
  exceptions,
  matches,
  transactions,
  users,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyPrivacyArtifacts,
  shopifyPrivacyDataRequestJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequests,
  shopifyPrivacyRequestSelectors,
} from "../../../drizzle/shopify_schema";
import { decryptForTenantQuiet } from "../../_core/tenantKeys";
import { createAuditLog, getDb, type DbExecutor } from "../../db";
import { storageDelete, storagePutPrivate, storageReadPrivate } from "../../storage";
import { affectedRows } from "./tokenStore";

export const SHOPIFY_PRIVACY_MANIFEST_VERSION = 1;
export const SHOPIFY_PRIVACY_ARTIFACT_SCHEMA_VERSION = 1;
export const SHOPIFY_PRIVACY_JOB_MAX_ATTEMPTS = 6;
export const SHOPIFY_PRIVACY_LEASE_MS = 5 * 60_000;
export const SHOPIFY_PRIVACY_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;
const LOOKUP_CHUNK = 500;
const OUTBOX_BATCH_SIZE = 100;

export type ShopifyPrivacyQueuePayload = {
  kind: "customer_request";
  jobId: number;
};

export type ShopifyPrivacyFailureCode =
  | "artifact_expired"
  | "artifact_integrity_failed"
  | "artifact_storage_failed"
  | "delivery_evidence_failed"
  | "downstream_evidence_present"
  | "durable_queue_unavailable"
  | "invalid_request_scope"
  | "merchant_admin_unavailable"
  | "request_state_unavailable"
  | "selector_integrity_failed"
  | "worker_failed";

export interface PrivacyArtifactOrderEvidence {
  providerOrderGid: string;
  displayName: string | null;
  amount: string;
  currency: string;
  orderCurrency: string | null;
  createdAt: string;
  processedAt: string | null;
  updatedAt: string | null;
  cancelledAt: string | null;
  financialStatus: string | null;
  reconciliationStatus: string;
  debitCredit: "debit" | "credit";
  isReversal: boolean;
}

export type ShopifyPrivacyArtifactDocument =
  | {
      schema: "reconcileai.shopify.customer_data_request";
      version: 1;
      generatedAt: string;
      result: "order_evidence";
      recordsFound: number;
      orders: PrivacyArtifactOrderEvidence[];
    }
  | {
      schema: "reconcileai.shopify.customer_data_request";
      version: 1;
      generatedAt: string;
      result: "zero_record_attestation";
      recordsFound: 0;
      reasonCode: "no_customer_profile_fields_and_no_requested_orders_found";
      statement: string;
      selectorDisposition: "deleted_after_authenticated_delivery";
      dataClassesNotStored: string[];
    };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type PutObject = typeof storagePutPrivate;
type DeleteObject = typeof storageDelete;
type Decrypt = typeof decryptForTenantQuiet;

export interface ShopifyPrivacyWorkerDeps {
  db?: Db;
  now?: () => Date;
  uuid?: () => string;
  decrypt?: Decrypt;
  putObject?: PutObject;
}

export interface ShopifyPrivacyDispatcherDeps {
  db?: Db;
  now?: () => Date;
  uuid?: () => string;
  /**
   * `dispatchAttempt` makes each dispatch a distinct queue entry. With one fixed
   * id per job, a queue entry that had already settled — completed or failed —
   * would silently swallow a later re-dispatch of the same job.
   */
  enqueue: (payload: ShopifyPrivacyQueuePayload, dispatchAttempt: number) => Promise<void>;
}

/**
 * Thrown inside a transaction when this worker's lease has been taken over, to
 * roll the transaction back. The worker that owns the job now decides its state.
 */
class LeaseLostError extends Error {
  constructor() {
    super("Shopify privacy job lease was taken over");
    this.name = "LeaseLostError";
  }
}

/**
 * A job that is still live but cannot be claimed yet — another worker holds an
 * unexpired lease, or its retry is not due. The queue must keep such work
 * scheduled; returning would settle the queue entry while the job still needs
 * to run. (The recovery loop re-arms it from the database if the queue gives up.)
 */
export class ShopifyPrivacyJobNotClaimableError extends Error {
  constructor() {
    super("Shopify privacy job is live but not claimable yet");
    this.name = "ShopifyPrivacyJobNotClaimableError";
  }
}

/** Job states that still owe work. Anything else is terminal or awaiting a person. */
const LIVE_JOB_STATUSES = ["received", "failed_retryable", "processing"] as const;

export function canonicalShopifyOrderGid(decrypted: string): string | null {
  return /^[1-9]\d*$/.test(decrypted) ? `gid://shopify/Order/${decrypted}` : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

function due(now: Date) {
  return and(
    inArray(shopifyPrivacyQueueOutbox.status, ["pending", "failed_retryable"]),
    or(isNull(shopifyPrivacyQueueOutbox.nextAttemptAt), lte(shopifyPrivacyQueueOutbox.nextAttemptAt, now)),
  );
}

function claimableJob(now: Date) {
  return or(
    and(
      inArray(shopifyPrivacyDataRequestJobs.status, ["received", "failed_retryable"]),
      or(isNull(shopifyPrivacyDataRequestJobs.nextAttemptAt), lte(shopifyPrivacyDataRequestJobs.nextAttemptAt, now)),
    ),
    and(
      eq(shopifyPrivacyDataRequestJobs.status, "processing"),
      lte(shopifyPrivacyDataRequestJobs.leaseExpiresAt, now),
    ),
  );
}

/**
 * Recover pending admission intents and publish only the non-sensitive internal
 * handle. An enqueue/DB-ack crash is safe: the deterministic BullMQ id collapses
 * the replay and the database worker lease makes duplicate deliveries no-ops.
 */
export async function dispatchShopifyPrivacyOutbox(
  deps: ShopifyPrivacyDispatcherDeps,
): Promise<{ scanned: number; dispatched: number; failed: number }> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const makeUuid = deps.uuid ?? (() => crypto.randomUUID());
  await rearmStrandedPrivacyDispatches(db, now);
  const candidates = await db
    .select({
      id: shopifyPrivacyQueueOutbox.id,
      kind: shopifyPrivacyQueueOutbox.kind,
      jobId: shopifyPrivacyQueueOutbox.jobId,
      attempts: shopifyPrivacyQueueOutbox.attempts,
    })
    .from(shopifyPrivacyQueueOutbox)
    .where(
      or(
        due(now),
        and(
          eq(shopifyPrivacyQueueOutbox.status, "dispatching"),
          lte(shopifyPrivacyQueueOutbox.leaseExpiresAt, now),
        ),
      ),
    )
    .limit(OUTBOX_BATCH_SIZE);

  let dispatched = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const leaseId = makeUuid();
    const leaseExpiresAt = new Date(now.getTime() + SHOPIFY_PRIVACY_LEASE_MS);
    const claim = await db
      .update(shopifyPrivacyQueueOutbox)
      .set({
        status: "dispatching",
        leaseId,
        leaseExpiresAt,
        attempts: sql`${shopifyPrivacyQueueOutbox.attempts} + 1`,
        failureCode: null,
      })
      .where(
        and(
          eq(shopifyPrivacyQueueOutbox.id, candidate.id),
          or(
            due(now),
            and(
              eq(shopifyPrivacyQueueOutbox.status, "dispatching"),
              lte(shopifyPrivacyQueueOutbox.leaseExpiresAt, now),
            ),
          ),
        ),
      );
    if (affectedRows(claim) !== 1) continue;

    const attempt = candidate.attempts + 1;
    try {
      const payload: ShopifyPrivacyQueuePayload = { kind: "customer_request", jobId: candidate.jobId };
      await deps.enqueue(payload, attempt);
      await db
        .update(shopifyPrivacyQueueOutbox)
        .set({
          status: "dispatched",
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          failureCode: null,
          dispatchedAt: new Date(),
        })
        .where(
          and(
            eq(shopifyPrivacyQueueOutbox.id, candidate.id),
            eq(shopifyPrivacyQueueOutbox.leaseId, leaseId),
          ),
        );
      dispatched += 1;
    } catch {
      // Shopify has already received a 2xx only after the outbox committed. A
      // durable-queue outage must therefore remain recoverable: terminalising
      // this row would strand an acknowledged request when Redis returns. The
      // capped backoff protects the queue while the durable database state keeps
      // the request visible for an operator and eligible for later recovery.
      console.error("[shopify-privacy] durable dispatch unavailable", {
        code: "durable_queue_unavailable",
        attempts: attempt,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(shopifyPrivacyQueueOutbox)
          .set({
            status: "failed_retryable",
            leaseId: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempt)),
            failureCode: "durable_queue_unavailable",
          })
          .where(
            and(
              eq(shopifyPrivacyQueueOutbox.id, candidate.id),
              eq(shopifyPrivacyQueueOutbox.leaseId, leaseId),
            ),
          );
        await tx
          .update(shopifyPrivacyDataRequestJobs)
          .set({ status: "failed_retryable", failureCode: "durable_queue_unavailable", lastCheckpoint: "dispatch_failed" })
          .where(
            and(
              eq(shopifyPrivacyDataRequestJobs.requestId, candidate.jobId),
              inArray(shopifyPrivacyDataRequestJobs.status, ["received", "failed_retryable"]),
            ),
          );
        await tx
          .update(shopifyPrivacyRequests)
          .set({ status: "failed_retryable", completionNote: "durable_queue_unavailable" })
          .where(
            and(
              eq(shopifyPrivacyRequests.id, candidate.jobId),
              eq(shopifyPrivacyRequests.topic, "customers/data_request"),
              inArray(shopifyPrivacyRequests.status, ["received", "failed_retryable"]),
            ),
          );
      });
      failed += 1;
    }
  }
  return { scanned: candidates.length, dispatched, failed };
}

/**
 * The queue is a trigger; the job row is the truth. An outbox row marked
 * `dispatched` says only that a queue entry was created — not that the work
 * ran. If the queue settled that entry while the job still owed work (retries
 * exhausted against a lease, say), nothing would ever enqueue it again. So any
 * dispatched row whose job the database says is claimable NOW, dispatched
 * longer ago than a lease, goes back to `pending` for the next dispatch.
 */
async function rearmStrandedPrivacyDispatches(db: Db, now: Date): Promise<void> {
  const dispatchedBefore = new Date(now.getTime() - SHOPIFY_PRIVACY_LEASE_MS);
  await db
    .update(shopifyPrivacyQueueOutbox)
    .set({ status: "pending", nextAttemptAt: null, failureCode: null })
    .where(
      and(
        eq(shopifyPrivacyQueueOutbox.status, "dispatched"),
        lte(shopifyPrivacyQueueOutbox.dispatchedAt, dispatchedBefore),
        exists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(shopifyPrivacyDataRequestJobs)
            .where(and(eq(shopifyPrivacyDataRequestJobs.requestId, shopifyPrivacyQueueOutbox.jobId), claimableJob(now))),
        ),
      ),
    );
}

interface ClaimedJob {
  requestId: number;
  organizationId: number;
  storeId: number;
  attempts: number;
  leaseId: string;
  manifestVersion: number;
}

async function claimDataRequestJob(
  db: Db,
  jobId: number,
  now: Date,
  leaseId: string,
): Promise<ClaimedJob | null> {
  const result = await db
    .update(shopifyPrivacyDataRequestJobs)
    .set({
      status: "processing",
      attempts: sql`${shopifyPrivacyDataRequestJobs.attempts} + 1`,
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + SHOPIFY_PRIVACY_LEASE_MS),
      nextAttemptAt: null,
      failureCode: null,
      lastCheckpoint: "claimed",
      startedAt: sql`COALESCE(${shopifyPrivacyDataRequestJobs.startedAt}, ${now})`,
    })
    .where(
      and(
        eq(shopifyPrivacyDataRequestJobs.requestId, jobId),
        claimableJob(now),
      ),
    );
  if (affectedRows(result) !== 1) return null;

  const [job] = await db
    .select({
      requestId: shopifyPrivacyDataRequestJobs.requestId,
      organizationId: shopifyPrivacyDataRequestJobs.organizationId,
      storeId: shopifyPrivacyDataRequestJobs.storeId,
      attempts: shopifyPrivacyDataRequestJobs.attempts,
      manifestVersion: shopifyPrivacyDataRequestJobs.manifestVersion,
    })
    .from(shopifyPrivacyDataRequestJobs)
    .where(
      and(
        eq(shopifyPrivacyDataRequestJobs.requestId, jobId),
        eq(shopifyPrivacyDataRequestJobs.leaseId, leaseId),
      ),
    )
    .limit(1);
  return job ? { ...job, leaseId } : null;
}

/**
 * Move the job, and the request ONLY if the job moved. Every job transition is
 * guarded by this worker's lease; a worker whose lease was taken over matches
 * no job row, and must not then drag the request — which the owning worker may
 * already have delivered — back to an earlier state.
 */
async function setNonTerminalState(
  db: Db,
  job: ClaimedJob,
  status: "manual_review" | "blocked_dependency",
  failureCode: ShopifyPrivacyFailureCode,
): Promise<void> {
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(shopifyPrivacyDataRequestJobs)
      .set({
        status,
        failureCode,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastCheckpoint: status,
      })
      .where(
        and(
          eq(shopifyPrivacyDataRequestJobs.requestId, job.requestId),
          eq(shopifyPrivacyDataRequestJobs.organizationId, job.organizationId),
          eq(shopifyPrivacyDataRequestJobs.storeId, job.storeId),
          eq(shopifyPrivacyDataRequestJobs.leaseId, job.leaseId),
        ),
      );
    if (affectedRows(moved) !== 1) return; // lease lost: the owning worker decides
    await tx
      .update(shopifyPrivacyRequests)
      .set({ status, completionNote: failureCode })
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/data_request"),
        ),
      );
  });
}

async function setFailure(
  db: Db,
  job: ClaimedJob,
  code: ShopifyPrivacyFailureCode,
  now: Date,
): Promise<"terminal" | "retry" | "lease_lost"> {
  const terminal = job.attempts >= SHOPIFY_PRIVACY_JOB_MAX_ATTEMPTS;
  const status = terminal ? "failed_terminal" : "failed_retryable";
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(shopifyPrivacyDataRequestJobs)
      .set({
        status,
        failureCode: code,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: terminal ? null : new Date(now.getTime() + retryDelayMs(job.attempts)),
        lastCheckpoint: "failed",
      })
      .where(
        and(
          eq(shopifyPrivacyDataRequestJobs.requestId, job.requestId),
          eq(shopifyPrivacyDataRequestJobs.organizationId, job.organizationId),
          eq(shopifyPrivacyDataRequestJobs.storeId, job.storeId),
          eq(shopifyPrivacyDataRequestJobs.leaseId, job.leaseId),
        ),
      );
    // A stale worker must not regress a request the owning worker has moved on
    // — to awaiting_delivery or completed — back to a failure state.
    if (affectedRows(moved) !== 1) return "lease_lost";
    await tx
      .update(shopifyPrivacyRequests)
      .set({ status, completionNote: code })
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/data_request"),
        ),
      );
    return terminal ? "terminal" : "retry";
  });
}

async function loadOrderEvidence(
  db: DbExecutor,
  organizationId: number,
  storeId: number,
  gids: string[],
): Promise<Array<PrivacyArtifactOrderEvidence & { internalTransactionId: number; hasRawData: boolean; matchId: number | null }>> {
  const rows: Array<PrivacyArtifactOrderEvidence & { internalTransactionId: number; hasRawData: boolean; matchId: number | null }> = [];
  for (let offset = 0; offset < gids.length; offset += LOOKUP_CHUNK) {
    const chunk = gids.slice(offset, offset + LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    const selected = await db
      .select({
        id: transactions.id,
        providerOrderGid: transactions.transactionRef,
        displayName: transactions.externalRef,
        amount: transactions.amount,
        currency: transactions.currency,
        orderCurrency: transactions.shopifyOrderCurrency,
        createdAt: transactions.transactionDate,
        processedAt: transactions.valueDate,
        updatedAt: transactions.shopifyUpdatedAt,
        cancelledAt: transactions.shopifyCancelledAt,
        financialStatus: transactions.shopifyFinancialStatus,
        reconciliationStatus: transactions.status,
        debitCredit: transactions.debitCredit,
        isReversal: transactions.isReversal,
        matchId: transactions.matchId,
        rawData: transactions.rawData,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          eq(transactions.shopifyStoreId, storeId),
          inArray(transactions.transactionRef, chunk),
        ),
      );
    for (const row of selected) {
      if (!row.providerOrderGid) continue;
      rows.push({
        internalTransactionId: row.id,
        providerOrderGid: row.providerOrderGid,
        displayName: row.displayName,
        amount: String(row.amount),
        currency: row.currency,
        orderCurrency: row.orderCurrency,
        createdAt: iso(row.createdAt)!,
        processedAt: iso(row.processedAt),
        updatedAt: iso(row.updatedAt),
        cancelledAt: iso(row.cancelledAt),
        financialStatus: row.financialStatus,
        reconciliationStatus: row.reconciliationStatus,
        debitCredit: row.debitCredit,
        isReversal: row.isReversal,
        matchId: row.matchId,
        hasRawData: row.rawData !== null,
      });
    }
  }
  const order = new Map(gids.map((gid, position) => [gid, position]));
  rows.sort((left, right) => (order.get(left.providerOrderGid) ?? 0) - (order.get(right.providerOrderGid) ?? 0));
  return rows;
}

async function hasUnsupportedDownstreamEvidence(
  db: DbExecutor,
  organizationId: number,
  rows: Array<{
    internalTransactionId: number;
    hasRawData: boolean;
    matchId: number | null;
    reconciliationStatus: string;
  }>,
): Promise<boolean> {
  // Order sync creates pristine `unmatched` rows. Any other reconciliation state
  // means the row has participated in a workflow whose complete lineage is not
  // yet safely enumerable in this first increment.
  if (rows.some((row) => row.hasRawData || row.matchId !== null || row.reconciliationStatus !== "unmatched")) {
    return true;
  }
  const ids = rows.map((row) => row.internalTransactionId);
  if (ids.length === 0) return false;
  for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + LOOKUP_CHUNK);
    const [linkedMatch] = await db
      .select({ id: matches.id })
      .from(matches)
      .where(
        and(
          eq(matches.organizationId, organizationId),
          or(inArray(matches.sourceTransactionId, chunk), inArray(matches.targetTransactionId, chunk)),
        ),
      )
      .limit(1);
    if (linkedMatch) return true;
    const [linkedException] = await db
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(and(eq(exceptions.organizationId, organizationId), inArray(exceptions.transactionId, chunk)))
      .limit(1);
    if (linkedException) return true;
    const [linkedAnomaly] = await db
      .select({ id: anomalyScores.id })
      .from(anomalyScores)
      .where(and(eq(anomalyScores.organizationId, organizationId), inArray(anomalyScores.transactionId, chunk)))
      .limit(1);
    if (linkedAnomaly) return true;
    const [linkedAudit] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.entityType, "transaction"),
          inArray(auditLogs.entityId, chunk),
        ),
      )
      .limit(1);
    if (linkedAudit) return true;
  }
  return false;
}

function artifactDocument(
  generatedAt: Date,
  rows: PrivacyArtifactOrderEvidence[],
): ShopifyPrivacyArtifactDocument {
  if (rows.length > 0) {
    return {
      schema: "reconcileai.shopify.customer_data_request",
      version: SHOPIFY_PRIVACY_ARTIFACT_SCHEMA_VERSION,
      generatedAt: generatedAt.toISOString(),
      result: "order_evidence",
      recordsFound: rows.length,
      orders: rows,
    };
  }
  return {
    schema: "reconcileai.shopify.customer_data_request",
    version: SHOPIFY_PRIVACY_ARTIFACT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    result: "zero_record_attestation",
    recordsFound: 0,
    reasonCode: "no_customer_profile_fields_and_no_requested_orders_found",
    statement: "ReconcileAI found no stored financial order evidence for the exact orders selected by this request.",
    selectorDisposition: "deleted_after_authenticated_delivery",
    dataClassesNotStored: [
      "customer_profile",
      "email",
      "phone",
      "address",
      "note",
      "line_item",
      "checkout_token",
      "cart_token",
      "raw_shopify_payload",
    ],
  };
}

export function serializeShopifyPrivacyArtifact(document: ShopifyPrivacyArtifactDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
}

/** Process one confidential queue handle. Terminal/no-op states return normally. */
export async function handleShopifyPrivacyJob(
  payload: ShopifyPrivacyQueuePayload,
  deps: ShopifyPrivacyWorkerDeps = {},
): Promise<void> {
  if (payload.kind !== "customer_request" || !Number.isSafeInteger(payload.jobId) || payload.jobId <= 0) {
    throw new Error("Invalid privacy job payload");
  }
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const makeUuid = deps.uuid ?? (() => crypto.randomUUID());
  const leaseId = makeUuid();
  const job = await claimDataRequestJob(db, payload.jobId, now, leaseId);
  if (!job) {
    // Returning here settles the queue entry. That is right only when the job
    // owes no more work; a job that is still live — leased by a worker that may
    // have died, or waiting on a retry that is not due — must stay scheduled.
    const [current] = await db
      .select({ status: shopifyPrivacyDataRequestJobs.status })
      .from(shopifyPrivacyDataRequestJobs)
      .where(eq(shopifyPrivacyDataRequestJobs.requestId, payload.jobId))
      .limit(1);
    if (current && (LIVE_JOB_STATUSES as readonly string[]).includes(current.status)) {
      throw new ShopifyPrivacyJobNotClaimableError();
    }
    return;
  }

  try {
    const [request] = await db
      .select({ id: shopifyPrivacyRequests.id })
      .from(shopifyPrivacyRequests)
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/data_request"),
        ),
      )
      .limit(1);
    if (!request || job.manifestVersion !== SHOPIFY_PRIVACY_MANIFEST_VERSION) {
      await setNonTerminalState(db, job, "manual_review", "invalid_request_scope");
      return;
    }

    const [store] = await db
      .select({
        id: shopifyConnectorStores.id,
        organizationId: shopifyConnectorStores.organizationId,
        claimedByUserId: shopifyConnectorStores.claimedByUserId,
      })
      .from(shopifyConnectorStores)
      .where(
        and(
          eq(shopifyConnectorStores.id, job.storeId),
          eq(shopifyConnectorStores.organizationId, job.organizationId),
        ),
      )
      .limit(1);
    if (!store?.claimedByUserId) {
      await setNonTerminalState(db, job, "manual_review", "merchant_admin_unavailable");
      return;
    }
    const [recipient] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, store.claimedByUserId),
          eq(users.organizationId, job.organizationId),
          eq(users.role, "admin"),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    if (!recipient) {
      await setNonTerminalState(db, job, "manual_review", "merchant_admin_unavailable");
      return;
    }

    const selectors = await db
      .select({
        resourceType: shopifyPrivacyRequestSelectors.resourceType,
        position: shopifyPrivacyRequestSelectors.position,
        externalIdEnc: shopifyPrivacyRequestSelectors.externalIdEnc,
      })
      .from(shopifyPrivacyRequestSelectors)
      .where(
        and(
          eq(shopifyPrivacyRequestSelectors.requestId, job.requestId),
          eq(shopifyPrivacyRequestSelectors.organizationId, job.organizationId),
        ),
      )
      .orderBy(shopifyPrivacyRequestSelectors.resourceType, shopifyPrivacyRequestSelectors.position);
    if (!selectors.some((selector) => selector.resourceType === "customer")) {
      await setNonTerminalState(db, job, "manual_review", "selector_integrity_failed");
      return;
    }

    const decrypt = deps.decrypt ?? decryptForTenantQuiet;
    const gids: string[] = [];
    for (const selector of selectors) {
      const value = await decrypt(job.organizationId, selector.externalIdEnc);
      if (!value || !/^[1-9]\d*$/.test(value)) {
        await setNonTerminalState(db, job, "manual_review", "selector_integrity_failed");
        return;
      }
      if (selector.resourceType === "order") gids.push(`gid://shopify/Order/${value}`);
    }
    if (new Set(gids).size !== gids.length) {
      await setNonTerminalState(db, job, "manual_review", "selector_integrity_failed");
      return;
    }

    const storedRows = await loadOrderEvidence(db, job.organizationId, job.storeId, gids);
    if (await hasUnsupportedDownstreamEvidence(db, job.organizationId, storedRows)) {
      await setNonTerminalState(db, job, "blocked_dependency", "downstream_evidence_present");
      return;
    }
    const evidenceRows = storedRows.map(({ internalTransactionId: _id, hasRawData: _raw, matchId: _match, ...row }) => row);

    let [artifact] = await db
      .select()
      .from(shopifyPrivacyArtifacts)
      .where(
        and(
          eq(shopifyPrivacyArtifacts.requestId, job.requestId),
          eq(shopifyPrivacyArtifacts.organizationId, job.organizationId),
          eq(shopifyPrivacyArtifacts.storeId, job.storeId),
        ),
      )
      .limit(1);
    if (artifact?.status === "deleted") {
      await setNonTerminalState(db, job, "manual_review", "artifact_expired");
      return;
    }

    if (!artifact) {
      const publicId = makeUuid();
      const generatedAt = new Date(now);
      const expiresAt = new Date(now.getTime() + SHOPIFY_PRIVACY_ARTIFACT_TTL_MS);
      const objectKey = `org/${job.organizationId}/privacy/shopify/${job.requestId}/${makeUuid()}.json`;
      await db
        .insert(shopifyPrivacyArtifacts)
        .values({
          requestId: job.requestId,
          organizationId: job.organizationId,
          storeId: job.storeId,
          publicId,
          schemaVersion: SHOPIFY_PRIVACY_ARTIFACT_SCHEMA_VERSION,
          artifactKind: evidenceRows.length > 0 ? "order_evidence" : "zero_record_attestation",
          objectKey,
          sha256: null,
          sizeBytes: null,
          recordsFound: evidenceRows.length,
          zeroReasonCode: evidenceRows.length === 0 ? "no_customer_profile_fields_and_no_requested_orders_found" : null,
          status: "writing",
          recipientUserId: recipient.id,
          deliveryChannel: "authenticated_portal",
          deliveryStatus: "pending",
          generatedAt,
          expiresAt,
        })
        .onDuplicateKeyUpdate({ set: { requestId: sql`${shopifyPrivacyArtifacts.requestId}` } });
      [artifact] = await db
        .select()
        .from(shopifyPrivacyArtifacts)
        .where(
          and(
            eq(shopifyPrivacyArtifacts.requestId, job.requestId),
            eq(shopifyPrivacyArtifacts.organizationId, job.organizationId),
            eq(shopifyPrivacyArtifacts.storeId, job.storeId),
          ),
        )
        .limit(1);
    }
    if (!artifact || artifact.recipientUserId !== recipient.id || artifact.recordsFound !== evidenceRows.length) {
      await setNonTerminalState(db, job, "manual_review", "invalid_request_scope");
      return;
    }

    const document = artifactDocument(artifact.generatedAt, evidenceRows);
    const bytes = serializeShopifyPrivacyArtifact(document);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (artifact.status === "ready") {
      // A retry after upload must prove that the authoritative order snapshot is
      // still byte-for-byte the artifact already written. Same count is not enough.
      if (artifact.sha256 !== digest || artifact.sizeBytes !== bytes.length) {
        await setNonTerminalState(db, job, "manual_review", "artifact_integrity_failed");
        return;
      }
    } else {
      await (deps.putObject ?? storagePutPrivate)(artifact.objectKey, bytes, "application/json");
      const readyWrite = await db
        .update(shopifyPrivacyArtifacts)
        .set({ status: "ready", sha256: digest, sizeBytes: bytes.length })
        .where(
          and(
            eq(shopifyPrivacyArtifacts.requestId, job.requestId),
            eq(shopifyPrivacyArtifacts.organizationId, job.organizationId),
            eq(shopifyPrivacyArtifacts.storeId, job.storeId),
            eq(shopifyPrivacyArtifacts.status, "writing"),
          ),
        );
      if (affectedRows(readyWrite) !== 1) throw new Error("Artifact metadata write lost");
    }

    await db.transaction(async (tx) => {
      const moved = await tx
        .update(shopifyPrivacyDataRequestJobs)
        .set({
          status: "awaiting_delivery",
          artifactId: job.requestId,
          recordsFound: evidenceRows.length,
          recordsAffected: 0,
          failureCode: null,
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastCheckpoint: "artifact_ready",
        })
        .where(
          and(
            eq(shopifyPrivacyDataRequestJobs.requestId, job.requestId),
            eq(shopifyPrivacyDataRequestJobs.organizationId, job.organizationId),
            eq(shopifyPrivacyDataRequestJobs.storeId, job.storeId),
            eq(shopifyPrivacyDataRequestJobs.leaseId, job.leaseId),
          ),
        );
      if (affectedRows(moved) !== 1) throw new LeaseLostError(); // roll back; the owner decides
      await tx
        .update(shopifyPrivacyRequests)
        .set({
          status: "awaiting_delivery",
          recordsAffected: evidenceRows.length,
          completionNote: evidenceRows.length === 0 ? "zero_record_attestation_ready" : "order_evidence_ready",
        })
        .where(
          and(
            eq(shopifyPrivacyRequests.id, job.requestId),
            eq(shopifyPrivacyRequests.organizationId, job.organizationId),
            eq(shopifyPrivacyRequests.storeId, job.storeId),
            eq(shopifyPrivacyRequests.topic, "customers/data_request"),
          ),
        );
    });
  } catch (error) {
    // Another worker owns the job now; whatever it does, this one must not touch it.
    if (error instanceof LeaseLostError) return;
    const outcome = await setFailure(db, job, "worker_failed", now);
    if (outcome === "retry") throw new Error("Shopify privacy job retry required");
  }
}

export interface PrivacyDownloadActor {
  id: number;
  organizationId: number | null;
  role: string;
  isActive: boolean;
}

export interface AuthorizedPrivacyArtifact {
  requestId: number;
  organizationId: number;
  storeId: number;
  objectKey: string;
  expiresAt: Date;
  recipientUserId: number;
  claimedByUserId: number | null;
  status: string;
  deliveryStatus: string;
  schemaVersion: number;
  sha256: string | null;
  sizeBytes: number | null;
}

export function mayDownloadShopifyPrivacyArtifact(
  actor: PrivacyDownloadActor | null,
  artifact: AuthorizedPrivacyArtifact | null,
  now = new Date(),
): boolean {
  return Boolean(
    actor &&
      artifact &&
      actor.isActive &&
      actor.role === "admin" &&
      actor.organizationId === artifact.organizationId &&
      actor.id === artifact.recipientUserId &&
      actor.id === artifact.claimedByUserId &&
      artifact.status === "ready" &&
      artifact.schemaVersion === SHOPIFY_PRIVACY_ARTIFACT_SCHEMA_VERSION &&
      typeof artifact.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(artifact.sha256) &&
      typeof artifact.sizeBytes === "number" &&
      artifact.sizeBytes > 0 &&
      artifact.expiresAt > now,
  );
}

export async function loadPrivacyArtifactForDownload(
  db: Db,
  publicId: string,
): Promise<AuthorizedPrivacyArtifact | null> {
  const [row] = await db
    .select({
      requestId: shopifyPrivacyArtifacts.requestId,
      organizationId: shopifyPrivacyArtifacts.organizationId,
      storeId: shopifyPrivacyArtifacts.storeId,
      objectKey: shopifyPrivacyArtifacts.objectKey,
      expiresAt: shopifyPrivacyArtifacts.expiresAt,
      recipientUserId: shopifyPrivacyArtifacts.recipientUserId,
      status: shopifyPrivacyArtifacts.status,
      deliveryStatus: shopifyPrivacyArtifacts.deliveryStatus,
      schemaVersion: shopifyPrivacyArtifacts.schemaVersion,
      sha256: shopifyPrivacyArtifacts.sha256,
      sizeBytes: shopifyPrivacyArtifacts.sizeBytes,
      claimedByUserId: shopifyConnectorStores.claimedByUserId,
    })
    .from(shopifyPrivacyArtifacts)
    .innerJoin(
      shopifyConnectorStores,
      and(
        eq(shopifyConnectorStores.id, shopifyPrivacyArtifacts.storeId),
        eq(shopifyConnectorStores.organizationId, shopifyPrivacyArtifacts.organizationId),
      ),
    )
    .where(eq(shopifyPrivacyArtifacts.publicId, publicId))
    .limit(1);
  return row ?? null;
}

/** Raised inside the delivery transaction when a required transition matched nothing. */
class DeliveryNotConfirmedError extends Error {
  constructor(step: string) {
    super(`Shopify privacy delivery could not be confirmed at ${step}`);
    this.name = "DeliveryNotConfirmedError";
  }
}

export type PrivacyDeliveryOutcome = "completed" | "already_completed" | "not_confirmed";

/**
 * Record that the artifact was DELIVERED — called only after its bytes were
 * written to the network in full — then destroy the selectors and complete
 * the request.
 *
 * Every transition is checked. If cleanup expired the artifact in the
 * meantime, or the job or request is no longer where delivery expects it, the
 * transaction rolls back: no selector is destroyed and nothing is completed.
 * A second download of an already-delivered artifact changes nothing.
 */
export async function confirmPrivacyArtifactDelivery(
  db: Db,
  artifact: AuthorizedPrivacyArtifact,
  actorId: number,
  now: Date,
): Promise<PrivacyDeliveryOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const accepted = await tx
        .update(shopifyPrivacyArtifacts)
        .set({ deliveryStatus: "acknowledged", deliveryAcceptedAt: now, downloadedAt: now })
        .where(
          and(
            eq(shopifyPrivacyArtifacts.requestId, artifact.requestId),
            eq(shopifyPrivacyArtifacts.organizationId, artifact.organizationId),
            eq(shopifyPrivacyArtifacts.storeId, artifact.storeId),
            eq(shopifyPrivacyArtifacts.recipientUserId, actorId),
            eq(shopifyPrivacyArtifacts.status, "ready"),
            eq(shopifyPrivacyArtifacts.deliveryStatus, "pending"),
          ),
        );
      if (affectedRows(accepted) !== 1) {
        const [current] = await tx
          .select({ deliveryStatus: shopifyPrivacyArtifacts.deliveryStatus, status: shopifyPrivacyArtifacts.status })
          .from(shopifyPrivacyArtifacts)
          .where(
            and(
              eq(shopifyPrivacyArtifacts.requestId, artifact.requestId),
              eq(shopifyPrivacyArtifacts.organizationId, artifact.organizationId),
              eq(shopifyPrivacyArtifacts.storeId, artifact.storeId),
            ),
          )
          .limit(1);
        if (current?.deliveryStatus === "acknowledged" && current.status === "ready") return "already_completed";
        throw new DeliveryNotConfirmedError("artifact");
      }
      await tx
        .delete(shopifyPrivacyRequestSelectors)
        .where(
          and(
            eq(shopifyPrivacyRequestSelectors.requestId, artifact.requestId),
            eq(shopifyPrivacyRequestSelectors.organizationId, artifact.organizationId),
          ),
        );
      const jobCompleted = await tx
        .update(shopifyPrivacyDataRequestJobs)
        .set({
          status: "completed",
          completedAt: now,
          selectorDestroyedAt: now,
          recordsAffected: sql`${shopifyPrivacyDataRequestJobs.recordsFound}`,
          failureCode: null,
          lastCheckpoint: "delivery_acknowledged",
        })
        .where(
          and(
            eq(shopifyPrivacyDataRequestJobs.requestId, artifact.requestId),
            eq(shopifyPrivacyDataRequestJobs.organizationId, artifact.organizationId),
            eq(shopifyPrivacyDataRequestJobs.storeId, artifact.storeId),
            eq(shopifyPrivacyDataRequestJobs.status, "awaiting_delivery"),
            eq(shopifyPrivacyDataRequestJobs.artifactId, artifact.requestId),
          ),
        );
      if (affectedRows(jobCompleted) !== 1) throw new DeliveryNotConfirmedError("job");
      const requestCompleted = await tx
        .update(shopifyPrivacyRequests)
        .set({ status: "completed", completedAt: now, completionNote: "authenticated_portal_delivery_confirmed" })
        .where(
          and(
            eq(shopifyPrivacyRequests.id, artifact.requestId),
            eq(shopifyPrivacyRequests.organizationId, artifact.organizationId),
            eq(shopifyPrivacyRequests.storeId, artifact.storeId),
            eq(shopifyPrivacyRequests.topic, "customers/data_request"),
            eq(shopifyPrivacyRequests.status, "awaiting_delivery"),
          ),
        );
      if (affectedRows(requestCompleted) !== 1) throw new DeliveryNotConfirmedError("request");
      return "completed";
    });
  } catch (error) {
    if (error instanceof DeliveryNotConfirmedError) return "not_confirmed";
    throw error;
  }
}

export interface PrivacyDownloadDeps {
  db: Db;
  actor: PrivacyDownloadActor;
  artifact: AuthorizedPrivacyArtifact;
  now?: Date;
  readObject?: typeof storageReadPrivate;
  audit?: typeof createAuditLog;
}

export interface PreparedPrivacyDownload {
  bytes: Buffer;
  filename: string;
}

/** The stored bytes did not match the digest and size recorded when they were written. */
export class PrivacyArtifactIntegrityError extends Error {
  constructor() {
    super("Stored Shopify privacy artifact failed its integrity check");
    this.name = "PrivacyArtifactIntegrityError";
  }
}

/**
 * Authorize, read and integrity-check the artifact for the SERVER to send.
 *
 * Nothing is completed here. Issuing a presigned URL used to count as delivery
 * — selectors destroyed and the request completed before the browser had
 * fetched anything — so a dropped connection or a failed download left a
 * "completed" request whose data never arrived. The route now sends these
 * bytes itself and calls confirmPrivacyArtifactDelivery only once they have
 * all been written. Each access is audited here, before any byte is sent.
 */
export async function authorizeAndReadPrivacyArtifact(
  deps: PrivacyDownloadDeps,
): Promise<PreparedPrivacyDownload | null> {
  const now = deps.now ?? new Date();
  if (!mayDownloadShopifyPrivacyArtifact(deps.actor, deps.artifact, now)) return null;
  // Throws if cleanup has already deleted the object: nothing is sent, nothing completes.
  const bytes = await (deps.readObject ?? storageReadPrivate)(deps.artifact.objectKey);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== deps.artifact.sha256 || bytes.length !== deps.artifact.sizeBytes) {
    throw new PrivacyArtifactIntegrityError();
  }
  // Disclosure fails closed when its audit evidence cannot be written.
  await (deps.audit ?? createAuditLog)({
    userId: deps.actor.id,
    organizationId: deps.artifact.organizationId,
    action: "shopify_privacy_artifact_access",
    entityType: "shopify_privacy_artifact",
    entityId: deps.artifact.requestId,
    details: { decision: "allowed", channel: "authenticated_portal" },
  });
  return { bytes, filename: `shopify-customer-data-request-${deps.artifact.requestId}.json` };
}

export interface PrivacyCleanupDeps {
  db?: Db;
  now?: () => Date;
  deleteObject?: DeleteObject;
}

/** Delete expired objects idempotently; an undelivered expiry can never complete. */
export async function cleanupExpiredShopifyPrivacyArtifacts(
  deps: PrivacyCleanupDeps = {},
): Promise<number> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db
    .select({
      requestId: shopifyPrivacyArtifacts.requestId,
      organizationId: shopifyPrivacyArtifacts.organizationId,
      storeId: shopifyPrivacyArtifacts.storeId,
      objectKey: shopifyPrivacyArtifacts.objectKey,
      deliveryStatus: shopifyPrivacyArtifacts.deliveryStatus,
    })
    .from(shopifyPrivacyArtifacts)
    .where(
      and(
        inArray(shopifyPrivacyArtifacts.status, ["writing", "ready"]),
        lte(shopifyPrivacyArtifacts.expiresAt, now),
      ),
    )
    .limit(OUTBOX_BATCH_SIZE);

  let deleted = 0;
  for (const row of rows) {
    await (deps.deleteObject ?? storageDelete)(row.objectKey);
    await db.transaction(async (tx) => {
      await tx
        .update(shopifyPrivacyArtifacts)
        .set({ status: "deleted", deletedAt: now })
        .where(
          and(
            eq(shopifyPrivacyArtifacts.requestId, row.requestId),
            eq(shopifyPrivacyArtifacts.organizationId, row.organizationId),
            eq(shopifyPrivacyArtifacts.storeId, row.storeId),
          ),
        );
      if (row.deliveryStatus !== "acknowledged") {
        await tx
          .update(shopifyPrivacyDataRequestJobs)
          .set({ status: "manual_review", failureCode: "artifact_expired", lastCheckpoint: "artifact_deleted" })
          .where(
            and(
              eq(shopifyPrivacyDataRequestJobs.requestId, row.requestId),
              eq(shopifyPrivacyDataRequestJobs.organizationId, row.organizationId),
              eq(shopifyPrivacyDataRequestJobs.storeId, row.storeId),
              eq(shopifyPrivacyDataRequestJobs.status, "awaiting_delivery"),
            ),
          );
        await tx
          .update(shopifyPrivacyRequests)
          .set({ status: "manual_review", completionNote: "artifact_expired" })
          .where(
            and(
              eq(shopifyPrivacyRequests.id, row.requestId),
              eq(shopifyPrivacyRequests.organizationId, row.organizationId),
              eq(shopifyPrivacyRequests.storeId, row.storeId),
              eq(shopifyPrivacyRequests.topic, "customers/data_request"),
              eq(shopifyPrivacyRequests.status, "awaiting_delivery"),
            ),
          );
      }
    });
    deleted += 1;
  }
  return deleted;
}
