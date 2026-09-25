import crypto from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { transactions } from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyOrderRedactionTombstones,
  shopifyPrivacyCustomerRedactionJobs,
  shopifyPrivacyQueueOutbox,
  shopifyPrivacyRequests,
  shopifyPrivacyRequestSelectors,
} from "../../../drizzle/shopify_schema";
import { decryptForTenantQuiet } from "../../_core/tenantKeys";
import { getDb, type DbExecutor } from "../../db";
import { affectedRows } from "./tokenStore";
import {
  activeShopifyOrderSuppressionDigest,
  type ShopifyPrivacySuppressionKey,
} from "./privacySuppression";
import { canonicalShopifyOrderGid } from "./privacyCompletion";

export const SHOPIFY_CUSTOMER_REDACTION_MANIFEST_VERSION = 1;
export const SHOPIFY_CUSTOMER_REDACTION_LEASE_MS = 5 * 60_000;
export const SHOPIFY_CUSTOMER_REDACTION_MAX_ATTEMPTS = 6;
const LOOKUP_CHUNK = 500;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Decrypt = typeof decryptForTenantQuiet;

export type ShopifyCustomerRedactionFailureCode =
  | "invalid_request_scope"
  | "selector_integrity_failed"
  | "suppression_key_unavailable"
  | "unsupported_transaction_footprint"
  | "worker_failed";

export interface ShopifyCustomerRedactionWorkerDeps {
  db?: Db;
  now?: () => Date;
  uuid?: () => string;
  decrypt?: Decrypt;
  suppressionKeys?: ShopifyPrivacySuppressionKey[];
}

interface ClaimedRedactionJob {
  requestId: number;
  organizationId: number;
  storeId: number;
  attempts: number;
  leaseId: string;
  manifestVersion: number;
}

interface SelectedOrderRow {
  id: number;
  transactionRef: string | null;
  externalRef: string | null;
  description: string | null;
  counterparty: string | null;
  originalTransactionRef: string | null;
  isReversal: boolean;
  shopifyOrderCurrency: string | null;
  shopifyUpdatedAt: Date | null;
  shopifyFinancialStatus: string | null;
  rawData: unknown;
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

function claimableRedactionJob(now: Date) {
  return or(
    and(
      inArray(shopifyPrivacyCustomerRedactionJobs.status, ["received", "failed_retryable"]),
      or(
        isNull(shopifyPrivacyCustomerRedactionJobs.nextAttemptAt),
        lte(shopifyPrivacyCustomerRedactionJobs.nextAttemptAt, now),
      ),
    ),
    and(
      eq(shopifyPrivacyCustomerRedactionJobs.status, "processing"),
      lte(shopifyPrivacyCustomerRedactionJobs.leaseExpiresAt, now),
    ),
  );
}

async function claimCustomerRedactionJob(
  db: Db,
  jobId: number,
  now: Date,
  leaseId: string,
): Promise<ClaimedRedactionJob | null> {
  const result = await db
    .update(shopifyPrivacyCustomerRedactionJobs)
    .set({
      status: "processing",
      attempts: sql`${shopifyPrivacyCustomerRedactionJobs.attempts} + 1`,
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + SHOPIFY_CUSTOMER_REDACTION_LEASE_MS),
      nextAttemptAt: null,
      failureCode: null,
      lastCheckpoint: "claimed",
      startedAt: sql`COALESCE(${shopifyPrivacyCustomerRedactionJobs.startedAt}, ${now})`,
    })
    .where(
      and(
        eq(shopifyPrivacyCustomerRedactionJobs.requestId, jobId),
        claimableRedactionJob(now),
      ),
    );
  if (affectedRows(result) !== 1) return null;

  const [job] = await db
    .select({
      requestId: shopifyPrivacyCustomerRedactionJobs.requestId,
      organizationId: shopifyPrivacyCustomerRedactionJobs.organizationId,
      storeId: shopifyPrivacyCustomerRedactionJobs.storeId,
      attempts: shopifyPrivacyCustomerRedactionJobs.attempts,
      manifestVersion: shopifyPrivacyCustomerRedactionJobs.manifestVersion,
    })
    .from(shopifyPrivacyCustomerRedactionJobs)
    .where(
      and(
        eq(shopifyPrivacyCustomerRedactionJobs.requestId, jobId),
        eq(shopifyPrivacyCustomerRedactionJobs.leaseId, leaseId),
      ),
    )
    .limit(1);
  return job ? { ...job, leaseId } : null;
}

async function setBlocked(
  db: Db,
  job: ClaimedRedactionJob,
  status: "manual_review" | "blocked_dependency",
  failureCode: ShopifyCustomerRedactionFailureCode,
): Promise<void> {
  await db.transaction(async (tx) => {
    const jobWrite = await tx
      .update(shopifyPrivacyCustomerRedactionJobs)
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
          eq(shopifyPrivacyCustomerRedactionJobs.requestId, job.requestId),
          eq(shopifyPrivacyCustomerRedactionJobs.organizationId, job.organizationId),
          eq(shopifyPrivacyCustomerRedactionJobs.storeId, job.storeId),
          eq(shopifyPrivacyCustomerRedactionJobs.leaseId, job.leaseId),
        ),
      );
    // A lease that expired while this worker ran may now belong to a newer
    // executor. Never let the stale worker overwrite that executor's request
    // state (or a successful completion) after its conditional job write lost.
    if (affectedRows(jobWrite) !== 1) return;
    await tx
      .update(shopifyPrivacyRequests)
      .set({ status, completionNote: failureCode })
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/redact"),
        ),
      );
  });
}

async function setRetryableFailure(
  db: Db,
  job: ClaimedRedactionJob,
  failureCode: ShopifyCustomerRedactionFailureCode,
  now: Date,
): Promise<void> {
  const terminal = job.attempts >= SHOPIFY_CUSTOMER_REDACTION_MAX_ATTEMPTS;
  const nextAttemptAt = new Date(
    now.getTime() + retryDelayMs(Math.min(job.attempts, SHOPIFY_CUSTOMER_REDACTION_MAX_ATTEMPTS)),
  );
  await db.transaction(async (tx) => {
    const jobWrite = await tx
      .update(shopifyPrivacyCustomerRedactionJobs)
      .set({
        status: terminal ? "failed_terminal" : "failed_retryable",
        failureCode,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: terminal ? null : nextAttemptAt,
        lastCheckpoint: terminal ? "failed_terminal" : "failed",
      })
      .where(
        and(
          eq(shopifyPrivacyCustomerRedactionJobs.requestId, job.requestId),
          eq(shopifyPrivacyCustomerRedactionJobs.organizationId, job.organizationId),
          eq(shopifyPrivacyCustomerRedactionJobs.storeId, job.storeId),
          eq(shopifyPrivacyCustomerRedactionJobs.leaseId, job.leaseId),
        ),
      );
    // Preserve a newer worker's state on stale-lease failure. The transactional
    // outbox is created only by the worker that still owns this job lease.
    if (affectedRows(jobWrite) !== 1) return;
    if (!terminal) {
      await tx
        .insert(shopifyPrivacyQueueOutbox)
        .values({
          kind: "customer_redact",
          jobId: job.requestId,
          status: "failed_retryable",
          nextAttemptAt,
          failureCode: "worker_failed",
        })
        .onDuplicateKeyUpdate({
          set: {
            status: "failed_retryable",
            nextAttemptAt,
            failureCode: "worker_failed",
            leaseId: null,
            leaseExpiresAt: null,
          },
        });
    }
    await tx
      .update(shopifyPrivacyRequests)
      .set({ status: terminal ? "failed_terminal" : "failed_retryable", completionNote: failureCode })
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/redact"),
        ),
      );
  });
}

async function loadSelectedOrders(
  db: DbExecutor,
  organizationId: number,
  storeId: number,
  gids: string[],
): Promise<SelectedOrderRow[]> {
  const rows: SelectedOrderRow[] = [];
  for (let offset = 0; offset < gids.length; offset += LOOKUP_CHUNK) {
    const chunk = gids.slice(offset, offset + LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    rows.push(
      ...(await db
        .select({
          id: transactions.id,
          transactionRef: transactions.transactionRef,
          externalRef: transactions.externalRef,
          description: transactions.description,
          counterparty: transactions.counterparty,
          originalTransactionRef: transactions.originalTransactionRef,
          isReversal: transactions.isReversal,
          shopifyOrderCurrency: transactions.shopifyOrderCurrency,
          shopifyUpdatedAt: transactions.shopifyUpdatedAt,
          shopifyFinancialStatus: transactions.shopifyFinancialStatus,
          rawData: transactions.rawData,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, organizationId),
            eq(transactions.shopifyStoreId, storeId),
            inArray(transactions.transactionRef, chunk),
          ),
        )),
    );
  }
  return rows;
}

/**
 * Scope A never stores Shopify customer personal data: only the fixed order-led
 * projection in `ingest.ts` is allowed. A legacy or future row that deviates
 * from that projection is not silently treated as redacted; it remains in
 * manual review until a separately reviewed, record-specific remediation exists.
 *
 * This makes customer-redact completion a non-destructive proof of data
 * minimisation, rather than a dangerous attempt to erase financial evidence
 * while reconciliation, audit, or report writers may be active.
 */
function isFieldMinimizedScopeAOrder(row: SelectedOrderRow): boolean {
  if (
    typeof row.transactionRef !== "string" ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(row.transactionRef) ||
    typeof row.externalRef !== "string" ||
    !/^#[A-Za-z0-9][A-Za-z0-9-]*$/.test(row.externalRef) ||
    row.description !== `Shopify Order ${row.externalRef}` ||
    row.counterparty !== "Shopify" ||
    row.originalTransactionRef !== null ||
    row.isReversal !== false ||
    typeof row.shopifyOrderCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(row.shopifyOrderCurrency) ||
    !(row.shopifyUpdatedAt instanceof Date) ||
    typeof row.shopifyFinancialStatus !== "string" ||
    !/^[A-Z_]{1,64}$/.test(row.shopifyFinancialStatus)
  ) {
    return false;
  }
  return row.rawData === null;
}

/** Process one confidential internal redaction handle. */
export async function handleShopifyCustomerRedactionJob(
  jobId: number,
  deps: ShopifyCustomerRedactionWorkerDeps = {},
): Promise<void> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("Invalid privacy job payload");
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();
  const leaseId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const job = await claimCustomerRedactionJob(db, jobId, now, leaseId);
  if (!job) return;

  try {
    const [request] = await db
      .select({ id: shopifyPrivacyRequests.id })
      .from(shopifyPrivacyRequests)
      .where(
        and(
          eq(shopifyPrivacyRequests.id, job.requestId),
          eq(shopifyPrivacyRequests.organizationId, job.organizationId),
          eq(shopifyPrivacyRequests.storeId, job.storeId),
          eq(shopifyPrivacyRequests.topic, "customers/redact"),
        ),
      )
      .limit(1);
    if (!request || job.manifestVersion !== SHOPIFY_CUSTOMER_REDACTION_MANIFEST_VERSION) {
      await setBlocked(db, job, "manual_review", "invalid_request_scope");
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
      await setBlocked(db, job, "manual_review", "selector_integrity_failed");
      return;
    }

    const decrypt = deps.decrypt ?? decryptForTenantQuiet;
    const gids: string[] = [];
    for (const selector of selectors) {
      const value = await decrypt(job.organizationId, selector.externalIdEnc);
      if (!value || !/^[1-9]\d*$/.test(value)) {
        await setBlocked(db, job, "manual_review", "selector_integrity_failed");
        return;
      }
      if (selector.resourceType === "order") {
        const gid = canonicalShopifyOrderGid(value);
        if (!gid) {
          await setBlocked(db, job, "manual_review", "selector_integrity_failed");
          return;
        }
        gids.push(gid);
      }
    }
    if (new Set(gids).size !== gids.length) {
      await setBlocked(db, job, "manual_review", "selector_integrity_failed");
      return;
    }

    let digests: Array<{ gid: string; keyVersion: string; orderDigest: string }>;
    try {
      digests = gids.map((gid) => ({
        gid,
        ...activeShopifyOrderSuppressionDigest(job.organizationId, job.storeId, gid, deps.suppressionKeys),
      }));
    } catch {
      await setBlocked(db, job, "manual_review", "suppression_key_unavailable");
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      // Serialize with sync and reauthorization. The precise request-id fence is
      // rechecked under the row lock immediately before any tombstone/write.
      const [store] = await tx
        .select({
          id: shopifyConnectorStores.id,
          status: shopifyConnectorStores.status,
          privacyRedactionState: shopifyConnectorStores.privacyRedactionState,
          privacyRedactionRequestId: shopifyConnectorStores.privacyRedactionRequestId,
        })
        .from(shopifyConnectorStores)
        .where(
          and(
            eq(shopifyConnectorStores.id, job.storeId),
            eq(shopifyConnectorStores.organizationId, job.organizationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!store || store.privacyRedactionState !== "customer_redacting" ||
          store.privacyRedactionRequestId !== job.requestId) {
        return { blocked: "invalid_request_scope" as const };
      }

      const selected = await loadSelectedOrders(tx, job.organizationId, job.storeId, gids);
      // The only permissible Scope A completion is a proof that no customer
      // personal data was persisted. Do not delete ledger, match, exception,
      // audit, report, or learning evidence: those systems may be active and
      // their records are intentionally outside this narrow merchant-order app.
      if (!selected.every(isFieldMinimizedScopeAOrder)) {
        return { blocked: "unsupported_transaction_footprint" as const };
      }

      if (digests.length > 0) {
        await tx
          .insert(shopifyOrderRedactionTombstones)
          .values(digests.map(({ keyVersion, orderDigest }) => ({
            organizationId: job.organizationId,
            storeId: job.storeId,
            keyVersion,
            orderDigest,
            sourceRequestId: job.requestId,
          })))
          .onDuplicateKeyUpdate({ set: { sourceRequestId: sql`${shopifyOrderRedactionTombstones.sourceRequestId}` } });
      }

      await tx
        .delete(shopifyPrivacyRequestSelectors)
        .where(
          and(
            eq(shopifyPrivacyRequestSelectors.requestId, job.requestId),
            eq(shopifyPrivacyRequestSelectors.organizationId, job.organizationId),
          ),
        );
      const completionWrite = await tx
        .update(shopifyPrivacyCustomerRedactionJobs)
        .set({
          status: "completed",
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          failureCode: null,
          lastCheckpoint: "field_minimization_verified",
          completedAt: now,
          recordsFound: selected.length,
          tombstonesWritten: digests.length,
          transactionsDeleted: 0,
          anomalyScoresDeleted: 0,
          orphanBatchesDeleted: 0,
          remainingTransactions: selected.length,
          selectorDestroyedAt: now,
        })
        .where(
          and(
            eq(shopifyPrivacyCustomerRedactionJobs.requestId, job.requestId),
            eq(shopifyPrivacyCustomerRedactionJobs.organizationId, job.organizationId),
            eq(shopifyPrivacyCustomerRedactionJobs.storeId, job.storeId),
            eq(shopifyPrivacyCustomerRedactionJobs.leaseId, job.leaseId),
          ),
        );
      // A late worker must not complete a request after its lease has been
      // reclaimed. Throwing rolls back tombstones and selector destruction in
      // this transaction; the current owner remains responsible for the request.
      if (affectedRows(completionWrite) !== 1) throw new Error("customer_redaction_lease_lost");
      await tx
        .update(shopifyPrivacyRequests)
        .set({
          status: "completed",
          completedAt: now,
          recordsAffected: 0,
          completionNote: "scope_a_no_personal_data_persisted",
        })
        .where(
          and(
            eq(shopifyPrivacyRequests.id, job.requestId),
            eq(shopifyPrivacyRequests.organizationId, job.organizationId),
            eq(shopifyPrivacyRequests.storeId, job.storeId),
            eq(shopifyPrivacyRequests.topic, "customers/redact"),
          ),
        );
      // Restore only this exact temporary fence. Lifecycle status is not touched,
      // so a concurrent uninstall/shop-redact remains authoritative.
      await tx
        .update(shopifyConnectorStores)
        .set({ privacyRedactionState: "active", privacyRedactionRequestId: null })
        .where(
          and(
            eq(shopifyConnectorStores.id, job.storeId),
            eq(shopifyConnectorStores.organizationId, job.organizationId),
            eq(shopifyConnectorStores.privacyRedactionState, "customer_redacting"),
            eq(shopifyConnectorStores.privacyRedactionRequestId, job.requestId),
          ),
        );
      return { blocked: null };
    });

    if (outcome.blocked) {
      await setBlocked(db, job, outcome.blocked === "invalid_request_scope" ? "manual_review" : "blocked_dependency", outcome.blocked);
    }
  } catch (error) {
    await setRetryableFailure(db, job, "worker_failed", now);
    throw new Error("Shopify customer redaction retry required");
  }
}
