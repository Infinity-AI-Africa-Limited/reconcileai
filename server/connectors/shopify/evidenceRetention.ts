/**
 * Shopify Scope A's 90-day evidence-retention control.
 *
 * What it deletes, and what it refuses to, is the whole design:
 *
 *  - A record goes only when its status is on a list of FINISHED states. Any
 *    other status, including one added to an enum later, keeps it. Every hold
 *    below is an allow-list of what is provably finished, never a list of what
 *    is live, because a list of live states is silently wrong the day a state
 *    is added.
 *  - A reconciled pair is deleted together or kept together. Deleting one half
 *    and resetting the other to `unmatched` would make the next reconciliation
 *    raise a "no matching transaction" exception about money that WAS matched:
 *    a false exception, which on a reconciliation platform is worse than
 *    keeping the pair until both halves are past their period.
 *  - Work runs in bounded batches. Each batch is one short transaction that
 *    re-takes the tenant and store locks, re-checks every hold on locked rows,
 *    and writes its own audit entry, so no lock is held across a backlog and
 *    every deletion commits together with the record of it.
 *  - A sweep has a time budget. One that runs out stops between batches,
 *    writes no completion receipt, and continues shortly after.
 */
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/mysql-core";
import {
  agentActionDrafts,
  agentMemory,
  anomalyScores,
  auditLogs,
  channels,
  controlBatchManifests,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  jobProgressEvents,
  matches,
  organizations,
  reconciliationJobs,
  reconciliationReports,
  sharedReportTokens,
  transactions,
  uploadBatches,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyEvidenceRetentionReceipts,
  shopifyPrivacyRequests,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import {
  CLOSED_EXCEPTION_STATUSES,
  CLOSED_EXCEPTION_WORKFLOW_STATUS,
} from "../../../shared/exceptionWorkflowRules";
import {
  createAuditLog,
  getDb,
  lockAuditChain,
  type DbExecutor,
  type DbTransaction,
} from "../../db";
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

/** A store that completed a sweep is not swept again for a day. */
export const SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** A sweep that failed is retried in an hour, never on every privacy-loop tick. */
export const SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS = 60 * 60 * 1_000;
/** A sweep that ran out of time continues a minute later, so a backlog drains in steps. */
export const SHOPIFY_SCOPE_A_RETENTION_CONTINUE_INTERVAL_MS = 60 * 1_000;
/** Transactions examined per batch transaction. */
export const SHOPIFY_SCOPE_A_RETENTION_BATCH_SIZE = 500;
/** Wall-clock budget for one sweep, so it never holds the privacy loop for long. */
export const SHOPIFY_SCOPE_A_RETENTION_RUN_BUDGET_MS = 20_000;
/**
 * A group of linked transactions larger than this many batches is kept and
 * reported rather than explored further: the bound on one batch's work.
 */
const LINKED_GROUP_LIMIT_IN_BATCHES = 5;
/** Webhook ledger rows are small and have no dependants, so they go in larger batches. */
const WEBHOOK_BATCH_FACTOR = 10;

/** One audit entry per batch that deleted anything, in the batch's own transaction. */
const BATCH_AUDIT_ACTION = "shopify_scope_a_retention_batch";
/** One audit entry per finished day, next to its receipt. */
const SWEEP_AUDIT_ACTION = "shopify_scope_a_retention_sweep";
const RETENTION_AUDIT_ENTITY = "shopify_evidence_retention";

type JobStatus = (typeof reconciliationJobs.$inferSelect)["status"];
type MatchStatus = (typeof matches.$inferSelect)["status"];
type AnomalyReviewStatus = (typeof anomalyScores.$inferSelect)["reviewStatus"];
type PrivacyRequestStatus = (typeof shopifyPrivacyRequests.$inferSelect)["status"];
type WebhookStatus = (typeof shopifyWebhookEvents.$inferSelect)["status"];
type UploadStatus = (typeof uploadBatches.$inferSelect)["status"];

/** A run in any other state is queued or running, and reads its channels' rows. */
const TERMINAL_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];
/** Match states nobody still has to act on. `pending_review` holds both sides. */
const SETTLED_MATCH_STATUSES = [
  "confirmed",
  "rejected",
] as const satisfies readonly MatchStatus[];
/** The one match state that does not pair its two transactions. */
const UNPAIRED_MATCH_STATUS = "rejected" satisfies MatchStatus;
/** A flagged anomaly in any other state is still awaiting a person. */
const REVIEWED_ANOMALY_STATUSES = [
  "false_positive",
  "confirmed",
  "resolved",
] as const satisfies readonly AnomalyReviewStatus[];
/**
 * A customer data request in any other state still owes an answer, including
 * one handed to a person or one the worker gave up on: deleting the evidence
 * first would turn that answer into a false "we hold nothing".
 */
const ANSWERED_DATA_REQUEST_STATUSES = [
  "completed",
] as const satisfies readonly PrivacyRequestStatus[];
/** A webhook still `received` still owes work. */
const SETTLED_WEBHOOK_STATUSES = [
  "processed",
  "failed",
  "ignored",
] as const satisfies readonly WebhookStatus[];
/** An upload still pending or processing is an import in progress. */
const FINISHED_UPLOAD_STATUSES = [
  "completed",
  "failed",
] as const satisfies readonly UploadStatus[];

/** Store-level totals. The receipt holds exactly these: counts, never identifiers. */
export interface ShopifyEvidenceRetentionCounts {
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
  reportShareLinksDeleted: number;
  jobsDeleted: number;
  batchesDeleted: number;
  /** Past-retention transactions on an open exception. */
  deferredActiveExceptions: number;
  /** Governed workflows not yet closed on past-retention transactions. */
  deferredActiveWorkflows: number;
  /** Matches awaiting review that touch a past-retention transaction. */
  deferredPendingMatchReviews: number;
  /** Flagged anomaly scores not yet reviewed on past-retention transactions. */
  deferredAnomalyReviews: number;
  /** Queued or running reconciliation jobs that read this store's channels. */
  deferredNonterminalJobs: number;
  /** Past-retention transactions in an upload a governed control manifest names. */
  deferredGovernedEvidence: number;
  /** Customer data requests for this store that are not yet answered. */
  deferredPrivacyRequests: number;
  /** Past-retention transactions kept because a transaction linked to them is kept. */
  deferredPairedTransactions: number;
  /** Past-retention webhook ledger rows still awaiting processing. */
  deferredUnprocessedWebhooks: number;
  /** Reports kept because they point at a stored file this control does not manage. */
  blockedReportFiles: number;
  /** Uploads kept because they point at a stored file this control does not manage. */
  blockedUploadFiles: number;
}

export interface ShopifyEvidenceRetentionReport
  extends ShopifyEvidenceRetentionCounts {
  storesConsidered: number;
  storesCompleted: number;
  storesSkipped: number;
  /** Stores the time budget stopped before they finished; a sweep continues them shortly. */
  storesIncomplete: number;
  storesFailed: number;
}

export interface ShopifyEvidenceRetentionDeps {
  db?: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  now?: () => Date;
  audit?: typeof createAuditLog;
  /** Transactions examined per batch. */
  batchSize?: number;
  /** Time budget for the whole sweep, in milliseconds. */
  budgetMs?: number;
  /** Monotonic clock the budget is measured on, in milliseconds. */
  elapsed?: () => number;
  /**
   * Sweep only these stores: a targeted re-run of one tenant's control, and
   * what keeps a database-backed test from locking other suites' tenants.
   */
  onlyStoreIds?: readonly number[];
}

export interface ShopifyEvidenceRetentionScheduledResult {
  ran: boolean;
  retryAt: Date | null;
  report?: ShopifyEvidenceRetentionReport;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function emptyCounts(): ShopifyEvidenceRetentionCounts {
  return {
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
    reportShareLinksDeleted: 0,
    jobsDeleted: 0,
    batchesDeleted: 0,
    deferredActiveExceptions: 0,
    deferredActiveWorkflows: 0,
    deferredPendingMatchReviews: 0,
    deferredAnomalyReviews: 0,
    deferredNonterminalJobs: 0,
    deferredGovernedEvidence: 0,
    deferredPrivacyRequests: 0,
    deferredPairedTransactions: 0,
    deferredUnprocessedWebhooks: 0,
    blockedReportFiles: 0,
    blockedUploadFiles: 0,
  };
}

function emptyReport(): ShopifyEvidenceRetentionReport {
  return {
    storesConsidered: 0,
    storesCompleted: 0,
    storesSkipped: 0,
    storesIncomplete: 0,
    storesFailed: 0,
    ...emptyCounts(),
  };
}

function addCounts(
  into: ShopifyEvidenceRetentionCounts,
  from: Partial<ShopifyEvidenceRetentionCounts>
): void {
  for (const key of Object.keys(from) as (keyof ShopifyEvidenceRetentionCounts)[]) {
    into[key] += from[key] ?? 0;
  }
}

/** The deletions a batch made, non-zero only: what its audit entry says. */
function deletedCounts(
  counts: Partial<ShopifyEvidenceRetentionCounts>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter(
      ([key, value]) => key.endsWith("Deleted") && typeof value === "number" && value > 0
    )
  ) as Record<string, number>;
}

const DELETED_COUNT_KEYS = (
  Object.keys(emptyCounts()) as (keyof ShopifyEvidenceRetentionCounts)[]
).filter(key => key.endsWith("Deleted"));

/**
 * Add up the deletions that batch audit entries recorded for one store.
 * Anything that is not one of this store's entries, or not a finite positive
 * count, is ignored rather than trusted. Exported for tests.
 */
export function sumBatchDeletions(
  entries: readonly unknown[],
  storeId: number
): Partial<ShopifyEvidenceRetentionCounts> {
  const totals: Partial<ShopifyEvidenceRetentionCounts> = {};
  for (const raw of entries) {
    let entry: unknown = raw;
    if (typeof entry === "string") {
      try {
        entry = JSON.parse(entry);
      } catch {
        continue;
      }
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.storeId !== storeId) continue;
    for (const key of DELETED_COUNT_KEYS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  return totals;
}

export function shopifyScopeAEvidenceRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_MS);
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

interface StoreScope {
  organizationId: number;
  storeId: number;
  /** The store's Scope A channels that exist. May be empty. */
  channelIds: number[];
  cutoff: Date;
  now: Date;
}

const qb = () => new QueryBuilder();

/**
 * The most recent timestamp at which Scope A possessed the field-minimised
 * record. A resync must not shorten an order's retention period simply because
 * its original order date is older than its latest observed Shopify update.
 *
 * Only `shopifyUpdatedAt` is nullable, and COALESCE covers it: GREATEST with a
 * NULL argument is NULL, and a NULL anchor would hold the row for ever.
 */
function evidenceAnchor(): SQL {
  return sql`GREATEST(${transactions.transactionDate}, COALESCE(${transactions.shopifyUpdatedAt}, ${transactions.transactionDate}), ${transactions.createdAt})`;
}

function inStoreScope(scope: StoreScope): SQL {
  const ownedByStore = eq(transactions.shopifyStoreId, scope.storeId);
  return and(
    eq(transactions.organizationId, scope.organizationId),
    scope.channelIds.length > 0
      ? or(ownedByStore, inArray(transactions.channelId, scope.channelIds))
      : ownedByStore
  )!;
}

function pastRetention(cutoff: Date): SQL {
  // The anchor decides. The two plain bounds are implied by it and are there
  // so the optimiser can use an index instead of evaluating GREATEST per row.
  return and(
    lt(transactions.createdAt, cutoff),
    lt(transactions.transactionDate, cutoff),
    lt(evidenceAnchor(), cutoff)
  )!;
}

/**
 * Every reason a past-retention transaction is kept, each an EXISTS over the
 * records that still need it. The purge takes a transaction only when none is
 * true. Exported for tests.
 *
 * The record-level holds are keyed on the transaction's own id and are NOT
 * narrowed to the tenant: anything that points at the row keeps it, which is
 * the wider and therefore safer net. The two that read tenant-owned settings
 * (jobs, control manifests) are tenant-scoped, because a channel or upload id
 * means nothing outside its own tenant.
 */
export function scopeAEvidenceHolds(organizationId: number) {
  const openWorkflow = qb()
    .select({ id: exceptionWorkflows.id })
    .from(exceptionWorkflows)
    .where(
      and(
        eq(exceptionWorkflows.exceptionId, exceptions.id),
        ne(exceptionWorkflows.status, CLOSED_EXCEPTION_WORKFLOW_STATUS)
      )
    );
  const unsettledMatch = (
    side: typeof matches.sourceTransactionId | typeof matches.targetTransactionId
  ) =>
    exists(
      qb()
        .select({ id: matches.id })
        .from(matches)
        .where(
          and(
            eq(side, transactions.id),
            notInArray(matches.status, [...SETTLED_MATCH_STATUSES])
          )
        )
    );
  return {
    /** An exception not closed, or closed with a governed attempt still open. */
    investigation: exists(
      qb()
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(
          and(
            eq(exceptions.transactionId, transactions.id),
            or(
              notInArray(exceptions.status, [...CLOSED_EXCEPTION_STATUSES]),
              exists(openWorkflow)
            )
          )
        )
    ),
    /** A match on either side that a person has not yet confirmed or rejected. */
    matchReview: or(
      unsettledMatch(matches.sourceTransactionId),
      unsettledMatch(matches.targetTransactionId)
    )!,
    /** A flagged anomaly score not yet reviewed. */
    anomalyReview: exists(
      qb()
        .select({ id: anomalyScores.id })
        .from(anomalyScores)
        .where(
          and(
            eq(anomalyScores.transactionId, transactions.id),
            eq(anomalyScores.isFlagged, true),
            notInArray(anomalyScores.reviewStatus, [...REVIEWED_ANOMALY_STATUSES])
          )
        )
    ),
    /** A queued or running reconciliation that reads this row's channel. */
    queuedRun: exists(
      qb()
        .select({ id: reconciliationJobs.id })
        .from(reconciliationJobs)
        .where(
          and(
            eq(reconciliationJobs.organizationId, organizationId),
            notInArray(reconciliationJobs.status, [...TERMINAL_JOB_STATUSES]),
            or(
              eq(reconciliationJobs.sourceChannelId, transactions.channelId),
              eq(reconciliationJobs.targetChannelId, transactions.channelId)
            )
          )
        )
    ),
    /** An upload a governed control manifest names: that evidence has its own owner. */
    governedControl: exists(
      qb()
        .select({ id: controlBatchManifests.id })
        .from(controlBatchManifests)
        .where(
          and(
            eq(controlBatchManifests.organizationId, organizationId),
            eq(controlBatchManifests.uploadBatchId, transactions.batchId)
          )
        )
    ),
  };
}

/** In this store's scope, past its period, and held by nothing. */
function purgeable(scope: StoreScope): SQL {
  return and(
    inStoreScope(scope),
    pastRetention(scope.cutoff),
    ...Object.values(scopeAEvidenceHolds(scope.organizationId)).map(hold => not(hold))
  )!;
}

/**
 * Which eligible transactions can go: those whose every linked transaction,
 * followed transitively, can go too. A held transaction keeps its whole group,
 * and so does a linked transaction nobody classified, because unknown is kept.
 * Exported for tests.
 */
export function deletableAfterPairing(graph: {
  eligible: Iterable<number>;
  held: Iterable<number>;
  links: Iterable<readonly [number, number]>;
}): number[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) {
      root = up;
    }
    for (let node = id; node !== root; ) {
      const up = parent.get(node)!;
      parent.set(node, root);
      node = up;
    }
    return root;
  };
  const eligible = new Set(graph.eligible);
  const links = [...graph.links];
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const heldRoots = new Set<number>();
  for (const id of graph.held) heldRoots.add(find(id));
  for (const link of links) {
    for (const id of link) if (!eligible.has(id)) heldRoots.add(find(id));
  }
  return [...eligible].filter(id => !heldRoots.has(find(id))).sort((a, b) => a - b);
}

interface MatchRow {
  id: number;
  organizationId: number | null;
  status: MatchStatus;
  sourceTransactionId: number;
  targetTransactionId: number;
}

interface LinkedGroup {
  eligible: Set<number>;
  held: Set<number>;
  links: Array<readonly [number, number]>;
  /** Every match touching an explored transaction, locked. */
  matchRows: MatchRow[];
}

/**
 * Follow every pairing out of the batch's candidates, locking as it goes.
 *
 * A pairing is a match that is not rejected, or a `transactions.matchId`
 * pointer. The job engine records a pair as a match row and leaves `matchId`
 * empty; Shopify's inline reconciliation records it by writing each side's id
 * into the other's `matchId` and writes no match row. Both are followed, in
 * both directions, because a pair recorded either way must not be split.
 *
 * A linked transaction is classified as eligible (explored further), held (it
 * exists in this tenant but may not go, so its group stays), or absent (no such
 * row in this tenant: a dangling pointer strands nothing, so it is ignored).
 */
async function collectLinkedGroup(
  tx: DbTransaction,
  scope: StoreScope,
  seeds: ReadonlyArray<{ id: number; matchId: number | null }>,
  limit: number
): Promise<LinkedGroup> {
  const eligible = new Set(seeds.map(row => row.id));
  const held = new Set<number>();
  const absent = new Set<number>();
  const links: Array<readonly [number, number]> = [];
  const matchRows = new Map<number, MatchRow>();
  const pointer = new Map(seeds.map(row => [row.id, row.matchId]));
  let frontier = seeds.map(row => row.id);

  while (frontier.length > 0) {
    const found = new Set<number>();
    const touching = await tx
      .select({
        id: matches.id,
        organizationId: matches.organizationId,
        status: matches.status,
        sourceTransactionId: matches.sourceTransactionId,
        targetTransactionId: matches.targetTransactionId,
      })
      .from(matches)
      .where(
        or(
          inArray(matches.sourceTransactionId, frontier),
          inArray(matches.targetTransactionId, frontier)
        )
      )
      .for("update");
    for (const row of touching) {
      matchRows.set(row.id, row);
      const ends = [row.sourceTransactionId, row.targetTransactionId] as const;
      // Another tenant's match cannot be deleted here, so neither side may go.
      const foreign =
        row.organizationId !== null && row.organizationId !== scope.organizationId;
      const settled = (SETTLED_MATCH_STATUSES as readonly string[]).includes(row.status);
      if (foreign || !settled) for (const id of ends) held.add(id);
      if (foreign || row.status !== UNPAIRED_MATCH_STATUS) {
        links.push(ends);
        for (const id of ends) found.add(id);
      }
    }
    for (const id of frontier) {
      const counterpart = pointer.get(id);
      if (counterpart != null && counterpart !== id) {
        links.push([id, counterpart]);
        found.add(counterpart);
      }
    }
    const pointingIn = await tx
      .select({ id: transactions.id, matchId: transactions.matchId })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, scope.organizationId),
          inArray(transactions.matchId, frontier)
        )
      )
      .for("update");
    for (const row of pointingIn) {
      if (row.matchId !== null && row.matchId !== row.id) {
        links.push([row.id, row.matchId]);
        found.add(row.id);
      }
    }

    const unseen = [...found].filter(
      id => !eligible.has(id) && !held.has(id) && !absent.has(id)
    );
    if (unseen.length === 0) break;
    if (eligible.size + held.size + unseen.length > limit) {
      // Too large to settle in one batch: keep the group and report it.
      for (const id of unseen) held.add(id);
      break;
    }
    const nowEligible = await tx
      .select({ id: transactions.id, matchId: transactions.matchId })
      .from(transactions)
      .where(and(inArray(transactions.id, unseen), purgeable(scope)))
      .for("update");
    const eligibleIds = new Set(nowEligible.map(row => row.id));
    const rest = unseen.filter(id => !eligibleIds.has(id));
    if (rest.length > 0) {
      // A locking read: a counterpart committed after this transaction began
      // must be seen, or its pair would be taken for a dangling pointer.
      const existing = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, scope.organizationId),
            inArray(transactions.id, rest)
          )
        )
        .for("update");
      const existingIds = new Set(existing.map(row => row.id));
      for (const id of rest) (existingIds.has(id) ? held : absent).add(id);
    }
    for (const row of nowEligible) {
      eligible.add(row.id);
      pointer.set(row.id, row.matchId);
    }
    frontier = nowEligible.map(row => row.id);
  }

  return {
    eligible,
    held,
    links: links.filter(([a, b]) => !absent.has(a) && !absent.has(b)),
    matchRows: [...matchRows.values()],
  };
}

type StoreLock = "ready" | "fenced" | "done_today";

/**
 * Take the tenant and store locks in shop redaction's order, and refuse a
 * fenced tenant, a redacting store, or a store another sweep already finished
 * today. Every batch starts here, so a redaction that begins mid-sweep stops
 * the next batch, and two instances never both complete one store's day.
 */
async function lockStoreForRetention(tx: DbTransaction, scope: StoreScope): Promise<StoreLock> {
  const [organization] = await tx
    .select({ deletionState: organizations.deletionState })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId))
    .limit(1)
    .for("update");
  if (organization?.deletionState !== "active") return "fenced";

  const [store] = await tx
    .select({ status: shopifyConnectorStores.status })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, scope.storeId),
        eq(shopifyConnectorStores.organizationId, scope.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!store || store.status === "redacting") return "fenced";

  // The process-local timer is only a convenience. The durable receipt is the
  // cross-instance boundary: a restart or a second instance must neither
  // repeat a finished day nor write a second receipt for it.
  const [latestReceipt] = await tx
    .select({ completedAt: shopifyEvidenceRetentionReceipts.completedAt })
    .from(shopifyEvidenceRetentionReceipts)
    .where(
      and(
        eq(shopifyEvidenceRetentionReceipts.organizationId, scope.organizationId),
        eq(shopifyEvidenceRetentionReceipts.storeId, scope.storeId)
      )
    )
    .orderBy(desc(shopifyEvidenceRetentionReceipts.completedAt))
    .limit(1)
    .for("update");
  if (
    latestReceipt &&
    latestReceipt.completedAt.getTime() >
      scope.now.getTime() - SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS
  ) {
    return "done_today";
  }
  return "ready";
}

/** Unanswered customer data requests for this store, or for this tenant with no store named. */
function unansweredDataRequests(scope: StoreScope): SQL {
  return and(
    eq(shopifyPrivacyRequests.organizationId, scope.organizationId),
    or(
      eq(shopifyPrivacyRequests.storeId, scope.storeId),
      isNull(shopifyPrivacyRequests.storeId)
    ),
    eq(shopifyPrivacyRequests.topic, "customers/data_request"),
    notInArray(shopifyPrivacyRequests.status, [...ANSWERED_DATA_REQUEST_STATUSES])
  )!;
}

interface PhaseBatch {
  /** Highest id examined; the phase's next batch starts after it. */
  cursor: number;
  /** Nothing is left past the cursor. */
  exhausted: boolean;
  counts: Partial<ShopifyEvidenceRetentionCounts>;
}

type Phase = (
  tx: DbTransaction,
  scope: StoreScope,
  cursor: number,
  batchSize: number
) => Promise<PhaseBatch>;

/**
 * One batch of past-retention transactions and everything derived from them.
 *
 * The SQL filter is the first pass. The authority is the second pass over the
 * rows this transaction has locked: a person can open an exception, start a
 * review or flag an anomaly between the two, and a row whose state changed is
 * kept, with its whole group.
 */
const purgeEvidenceBatch: Phase = async (tx, scope, cursor, batchSize) => {
  // The selectors are keyed HMACs, so which orders a data request names cannot
  // be told in SQL. Until every one is answered, the store's evidence stays.
  const [pendingRequest] = await tx
    .select({ id: shopifyPrivacyRequests.id })
    .from(shopifyPrivacyRequests)
    .where(unansweredDataRequests(scope))
    .limit(1)
    .for("update");
  if (pendingRequest) return { cursor, exhausted: true, counts: {} };

  const seeds = await tx
    .select({ id: transactions.id, matchId: transactions.matchId })
    .from(transactions)
    .where(and(purgeable(scope), gt(transactions.id, cursor)))
    .orderBy(asc(transactions.id))
    .limit(batchSize)
    .for("update");
  if (seeds.length === 0) return { cursor, exhausted: true, counts: {} };
  const next = { cursor: seeds[seeds.length - 1]!.id, exhausted: seeds.length < batchSize };

  const group = await collectLinkedGroup(
    tx,
    scope,
    seeds,
    batchSize * LINKED_GROUP_LIMIT_IN_BATCHES
  );
  let deletable = deletableAfterPairing(group);

  const lockedExceptions = deletable.length
    ? await tx
        .select({
          id: exceptions.id,
          organizationId: exceptions.organizationId,
          transactionId: exceptions.transactionId,
          status: exceptions.status,
        })
        .from(exceptions)
        .where(inArray(exceptions.transactionId, deletable))
        .for("update")
    : [];
  const lockedWorkflows = lockedExceptions.length
    ? await tx
        .select({
          id: exceptionWorkflows.id,
          organizationId: exceptionWorkflows.organizationId,
          exceptionId: exceptionWorkflows.exceptionId,
          status: exceptionWorkflows.status,
        })
        .from(exceptionWorkflows)
        .where(
          inArray(
            exceptionWorkflows.exceptionId,
            lockedExceptions.map(row => row.id)
          )
        )
        .for("update")
    : [];
  const lockedAnomalies = deletable.length
    ? await tx
        .select({
          id: anomalyScores.id,
          organizationId: anomalyScores.organizationId,
          transactionId: anomalyScores.transactionId,
          isFlagged: anomalyScores.isFlagged,
          reviewStatus: anomalyScores.reviewStatus,
        })
        .from(anomalyScores)
        .where(inArray(anomalyScores.transactionId, deletable))
        .for("update")
    : [];

  const heldNow = new Set<number>();
  const exceptionTransaction = new Map(lockedExceptions.map(row => [row.id, row.transactionId]));
  for (const row of lockedExceptions) {
    const closed = (CLOSED_EXCEPTION_STATUSES as readonly string[]).includes(row.status);
    if (row.organizationId !== scope.organizationId || !closed) heldNow.add(row.transactionId);
  }
  for (const row of lockedWorkflows) {
    if (
      row.organizationId !== scope.organizationId ||
      row.status !== CLOSED_EXCEPTION_WORKFLOW_STATUS
    ) {
      heldNow.add(exceptionTransaction.get(row.exceptionId)!);
    }
  }
  for (const row of lockedAnomalies) {
    const foreign = row.organizationId !== null && row.organizationId !== scope.organizationId;
    const reviewed = (REVIEWED_ANOMALY_STATUSES as readonly string[]).includes(row.reviewStatus);
    if (foreign || (row.isFlagged && !reviewed)) heldNow.add(row.transactionId);
  }
  if (heldNow.size > 0) {
    deletable = deletableAfterPairing({
      eligible: group.eligible,
      held: [...group.held, ...heldNow],
      links: group.links,
    });
  }

  const going = new Set(deletable);
  const keptForOwnReason = new Set([...group.held, ...heldNow]);
  const deferredPairedTransactions = seeds.filter(
    row => !going.has(row.id) && !keptForOwnReason.has(row.id)
  ).length;
  if (going.size === 0) return { ...next, counts: { deferredPairedTransactions } };

  const exceptionIds = lockedExceptions
    .filter(row => going.has(row.transactionId))
    .map(row => row.id);
  const exceptionIdSet = new Set(exceptionIds);
  const workflowIds = lockedWorkflows
    .filter(row => exceptionIdSet.has(row.exceptionId))
    .map(row => row.id);
  const anomalyIds = lockedAnomalies
    .filter(row => going.has(row.transactionId))
    .map(row => row.id);
  // Every remaining match touching a deleted row is either inside its group
  // (both sides go) or rejected (an audit note about a row that no longer
  // exists). Another tenant's match never reaches here: it held its group.
  const matchIds = group.matchRows
    .filter(
      row =>
        (going.has(row.sourceTransactionId) || going.has(row.targetTransactionId)) &&
        (row.organizationId === null || row.organizationId === scope.organizationId)
    )
    .map(row => row.id);

  const org = scope.organizationId;
  const counts: Partial<ShopifyEvidenceRetentionCounts> = { deferredPairedTransactions };
  if (exceptionIds.length) {
    counts.workflowEventsDeleted = affectedRows(
      await tx
        .delete(exceptionWorkflowEvents)
        .where(
          and(
            eq(exceptionWorkflowEvents.organizationId, org),
            inArray(exceptionWorkflowEvents.exceptionId, exceptionIds)
          )
        )
    );
    if (workflowIds.length) {
      counts.workflowsDeleted = affectedRows(
        await tx
          .delete(exceptionWorkflows)
          .where(
            and(
              eq(exceptionWorkflows.organizationId, org),
              inArray(exceptionWorkflows.id, workflowIds)
            )
          )
      );
    }
    counts.agentActionDraftsDeleted = affectedRows(
      await tx
        .delete(agentActionDrafts)
        .where(
          and(
            eq(agentActionDrafts.organizationId, org),
            inArray(agentActionDrafts.exceptionId, exceptionIds)
          )
        )
    );
    counts.agentMemoryDeleted = affectedRows(
      await tx
        .delete(agentMemory)
        .where(
          and(
            eq(agentMemory.organizationId, org),
            inArray(agentMemory.exceptionId, exceptionIds)
          )
        )
    );
    counts.exceptionsDeleted = affectedRows(
      await tx
        .delete(exceptions)
        .where(and(eq(exceptions.organizationId, org), inArray(exceptions.id, exceptionIds)))
    );
  }
  if (anomalyIds.length) {
    counts.anomalyScoresDeleted = affectedRows(
      await tx
        .delete(anomalyScores)
        .where(
          and(
            or(eq(anomalyScores.organizationId, org), isNull(anomalyScores.organizationId)),
            inArray(anomalyScores.id, anomalyIds)
          )
        )
    );
  }
  if (matchIds.length) {
    counts.matchesDeleted = affectedRows(
      await tx
        .delete(matches)
        .where(
          and(
            or(eq(matches.organizationId, org), isNull(matches.organizationId)),
            inArray(matches.id, matchIds)
          )
        )
    );
  }
  counts.transactionsDeleted = affectedRows(
    await tx
      .delete(transactions)
      .where(and(eq(transactions.organizationId, org), inArray(transactions.id, deletable)))
  );
  return { ...next, counts };
};

/** A job's own retention anchor: the latest of its window, its creation and its completion. */
function jobAnchor(): SQL {
  return sql`GREATEST(${reconciliationJobs.dateTo}, ${reconciliationJobs.createdAt}, COALESCE(${reconciliationJobs.completedAt}, ${reconciliationJobs.createdAt}))`;
}

/**
 * Finished runs whose two channels are both this store's and that no match or
 * exception still names. A run against another channel is also that channel's
 * record and is not Scope A's to delete. Callers must check `channelIds` is
 * not empty first.
 */
function expiredRuns(scope: StoreScope): SQL {
  return and(
    eq(reconciliationJobs.organizationId, scope.organizationId),
    inArray(reconciliationJobs.sourceChannelId, scope.channelIds),
    inArray(reconciliationJobs.targetChannelId, scope.channelIds),
    inArray(reconciliationJobs.status, [...TERMINAL_JOB_STATUSES]),
    lt(jobAnchor(), scope.cutoff),
    notExists(
      qb()
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.jobId, reconciliationJobs.id))
    ),
    notExists(
      qb()
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(eq(exceptions.jobId, reconciliationJobs.id))
    )
  )!;
}

/**
 * Finished uploads on this store's channels, past their own anchor, that no
 * transaction and no governed control manifest still names. Callers must check
 * `channelIds` is not empty first.
 */
function expiredUploads(scope: StoreScope): SQL {
  return and(
    eq(uploadBatches.organizationId, scope.organizationId),
    inArray(uploadBatches.channelId, scope.channelIds),
    inArray(uploadBatches.status, [...FINISHED_UPLOAD_STATUSES]),
    lt(uploadBatches.createdAt, scope.cutoff),
    lt(
      sql`GREATEST(${uploadBatches.createdAt}, COALESCE(${uploadBatches.completedAt}, ${uploadBatches.createdAt}))`,
      scope.cutoff
    ),
    notExists(
      qb()
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.batchId, uploadBatches.id))
    ),
    notExists(
      qb()
        .select({ id: controlBatchManifests.id })
        .from(controlBatchManifests)
        .where(eq(controlBatchManifests.uploadBatchId, uploadBatches.id))
    )
  )!;
}

/**
 * Expired runs, with their reports and share links. A report pointing at a
 * stored file keeps its run: deleting the row would orphan an object this
 * control does not manage.
 */
const purgeJobBatch: Phase = async (tx, scope, cursor, batchSize) => {
  if (scope.channelIds.length === 0) return { cursor, exhausted: true, counts: {} };
  const jobs = await tx
    .select({ id: reconciliationJobs.id })
    .from(reconciliationJobs)
    .where(and(expiredRuns(scope), gt(reconciliationJobs.id, cursor)))
    .orderBy(asc(reconciliationJobs.id))
    .limit(batchSize)
    .for("update");
  if (jobs.length === 0) return { cursor, exhausted: true, counts: {} };
  const next = { cursor: jobs[jobs.length - 1]!.id, exhausted: jobs.length < batchSize };

  const jobIds = jobs.map(row => row.id);
  const reports = await tx
    .select({
      id: reconciliationReports.id,
      jobId: reconciliationReports.jobId,
      organizationId: reconciliationReports.organizationId,
      fileUrl: reconciliationReports.fileUrl,
    })
    .from(reconciliationReports)
    .where(inArray(reconciliationReports.jobId, jobIds))
    .for("update");
  const keptJobs = new Set<number>();
  let blockedReportFiles = 0;
  for (const report of reports) {
    if (report.fileUrl !== null) blockedReportFiles += 1;
    const foreign =
      report.organizationId !== null && report.organizationId !== scope.organizationId;
    if (report.fileUrl !== null || foreign) keptJobs.add(report.jobId);
  }
  const deletableJobs = jobIds.filter(id => !keptJobs.has(id));
  const counts: Partial<ShopifyEvidenceRetentionCounts> = { blockedReportFiles };
  if (deletableJobs.length === 0) return { ...next, counts };

  const going = new Set(deletableJobs);
  const reportIds = reports.filter(row => going.has(row.jobId)).map(row => row.id);
  const org = scope.organizationId;
  if (reportIds.length) {
    // A share link to a report that no longer exists is a bearer credential to
    // nothing, and it carries the recipient's address.
    counts.reportShareLinksDeleted = affectedRows(
      await tx
        .delete(sharedReportTokens)
        .where(
          and(
            or(eq(sharedReportTokens.organizationId, org), isNull(sharedReportTokens.organizationId)),
            inArray(sharedReportTokens.reportId, reportIds)
          )
        )
    );
    counts.reportsDeleted = affectedRows(
      await tx
        .delete(reconciliationReports)
        .where(
          and(
            or(eq(reconciliationReports.organizationId, org), isNull(reconciliationReports.organizationId)),
            inArray(reconciliationReports.id, reportIds)
          )
        )
    );
  }
  // Progress events carry no tenant column; the job ids are this tenant's.
  await tx.delete(jobProgressEvents).where(inArray(jobProgressEvents.jobId, deletableJobs));
  counts.jobsDeleted = affectedRows(
    await tx
      .delete(reconciliationJobs)
      .where(
        and(
          eq(reconciliationJobs.organizationId, org),
          inArray(reconciliationJobs.id, deletableJobs)
        )
      )
  );
  return { ...next, counts };
};

/** Expired uploads that point at no stored file. */
const purgeUploadBatch: Phase = async (tx, scope, cursor, batchSize) => {
  if (scope.channelIds.length === 0) return { cursor, exhausted: true, counts: {} };
  const uploads = await tx
    .select({ id: uploadBatches.id, fileUrl: uploadBatches.fileUrl })
    .from(uploadBatches)
    .where(and(expiredUploads(scope), gt(uploadBatches.id, cursor)))
    .orderBy(asc(uploadBatches.id))
    .limit(batchSize)
    .for("update");
  if (uploads.length === 0) return { cursor, exhausted: true, counts: {} };
  const next = { cursor: uploads[uploads.length - 1]!.id, exhausted: uploads.length < batchSize };
  const deletable = uploads.filter(row => row.fileUrl === null).map(row => row.id);
  const counts: Partial<ShopifyEvidenceRetentionCounts> = {
    blockedUploadFiles: uploads.length - deletable.length,
  };
  if (deletable.length) {
    counts.batchesDeleted = affectedRows(
      await tx
        .delete(uploadBatches)
        .where(
          and(
            eq(uploadBatches.organizationId, scope.organizationId),
            inArray(uploadBatches.id, deletable)
          )
        )
    );
  }
  return { ...next, counts };
};

/** The digest-only webhook ledger, once each delivery has been settled. */
const purgeWebhookBatch: Phase = async (tx, scope, cursor, batchSize) => {
  const limit = batchSize * WEBHOOK_BATCH_FACTOR;
  const events = await tx
    .select({ id: shopifyWebhookEvents.id })
    .from(shopifyWebhookEvents)
    .where(
      and(
        eq(shopifyWebhookEvents.organizationId, scope.organizationId),
        eq(shopifyWebhookEvents.storeId, scope.storeId),
        gt(shopifyWebhookEvents.id, cursor),
        lt(shopifyWebhookEvents.receivedAt, scope.cutoff),
        inArray(shopifyWebhookEvents.status, [...SETTLED_WEBHOOK_STATUSES])
      )
    )
    .orderBy(asc(shopifyWebhookEvents.id))
    .limit(limit)
    .for("update");
  if (events.length === 0) return { cursor, exhausted: true, counts: {} };
  const webhookEventsDeleted = affectedRows(
    await tx.delete(shopifyWebhookEvents).where(
      and(
        eq(shopifyWebhookEvents.organizationId, scope.organizationId),
        eq(shopifyWebhookEvents.storeId, scope.storeId),
        inArray(
          shopifyWebhookEvents.id,
          events.map(row => row.id)
        )
      )
    )
  );
  return {
    cursor: events[events.length - 1]!.id,
    exhausted: events.length < limit,
    counts: { webhookEventsDeleted },
  };
};

/**
 * In dependency order: transactions first (their matches and exceptions keep
 * runs alive), then the runs and uploads they leave without dependants.
 */
const PHASES: ReadonlyArray<readonly [string, Phase]> = [
  ["evidence", purgeEvidenceBatch],
  ["jobs", purgeJobBatch],
  ["uploads", purgeUploadBatch],
  ["webhooks", purgeWebhookBatch],
];

async function countOne(query: Promise<Array<{ n: number }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

/**
 * What is still being held, for the receipt. Counts only, and all of them
 * measured here from the database rather than added up by the sweep, so a day
 * finished by another instance or after a restart reports the same thing.
 */
async function countDeferred(
  tx: DbExecutor,
  scope: StoreScope
): Promise<Partial<ShopifyEvidenceRetentionCounts>> {
  const stale = and(inStoreScope(scope), pastRetention(scope.cutoff))!;
  const holds = scopeAEvidenceHolds(scope.organizationId);
  const [
    deferredActiveExceptions,
    deferredActiveWorkflows,
    deferredPendingMatchReviews,
    deferredAnomalyReviews,
    deferredNonterminalJobs,
    deferredGovernedEvidence,
    deferredPrivacyRequests,
    deferredUnprocessedWebhooks,
    unheldPastRetention,
    blockedReportFiles,
    blockedUploadFiles,
  ] = await Promise.all([
    countOne(
      tx
        .select({ n: count() })
        .from(exceptions)
        .innerJoin(transactions, eq(transactions.id, exceptions.transactionId))
        .where(
          and(stale, notInArray(exceptions.status, [...CLOSED_EXCEPTION_STATUSES]))
        )
    ),
    countOne(
      tx
        .select({ n: count() })
        .from(exceptionWorkflows)
        .innerJoin(exceptions, eq(exceptions.id, exceptionWorkflows.exceptionId))
        .innerJoin(transactions, eq(transactions.id, exceptions.transactionId))
        .where(and(stale, ne(exceptionWorkflows.status, CLOSED_EXCEPTION_WORKFLOW_STATUS)))
    ),
    countOne(
      tx
        .select({ n: countDistinct(matches.id) })
        .from(matches)
        .innerJoin(
          transactions,
          or(
            eq(transactions.id, matches.sourceTransactionId),
            eq(transactions.id, matches.targetTransactionId)
          )
        )
        .where(and(stale, notInArray(matches.status, [...SETTLED_MATCH_STATUSES])))
    ),
    countOne(
      tx
        .select({ n: count() })
        .from(anomalyScores)
        .innerJoin(transactions, eq(transactions.id, anomalyScores.transactionId))
        .where(
          and(
            stale,
            eq(anomalyScores.isFlagged, true),
            notInArray(anomalyScores.reviewStatus, [...REVIEWED_ANOMALY_STATUSES])
          )
        )
    ),
    scope.channelIds.length
      ? countOne(
          tx
            .select({ n: count() })
            .from(reconciliationJobs)
            .where(
              and(
                eq(reconciliationJobs.organizationId, scope.organizationId),
                notInArray(reconciliationJobs.status, [...TERMINAL_JOB_STATUSES]),
                or(
                  inArray(reconciliationJobs.sourceChannelId, scope.channelIds),
                  inArray(reconciliationJobs.targetChannelId, scope.channelIds)
                )
              )
            )
        )
      : Promise.resolve(0),
    countOne(
      tx.select({ n: count() }).from(transactions).where(and(stale, holds.governedControl))
    ),
    countOne(
      tx
        .select({ n: count() })
        .from(shopifyPrivacyRequests)
        .where(unansweredDataRequests(scope))
    ),
    countOne(
      tx
        .select({ n: count() })
        .from(shopifyWebhookEvents)
        .where(
          and(
            eq(shopifyWebhookEvents.organizationId, scope.organizationId),
            eq(shopifyWebhookEvents.storeId, scope.storeId),
            lt(shopifyWebhookEvents.receivedAt, scope.cutoff),
            notInArray(shopifyWebhookEvents.status, [...SETTLED_WEBHOOK_STATUSES])
          )
        )
    ),
    // Past retention and held by no record of its own, yet still here once the
    // pass is done: kept because a transaction linked to it is kept.
    countOne(tx.select({ n: count() }).from(transactions).where(purgeable(scope))),
    scope.channelIds.length
      ? countOne(
          tx
            .select({ n: countDistinct(reconciliationReports.id) })
            .from(reconciliationReports)
            .innerJoin(reconciliationJobs, eq(reconciliationJobs.id, reconciliationReports.jobId))
            .where(and(expiredRuns(scope), isNotNull(reconciliationReports.fileUrl)))
        )
      : Promise.resolve(0),
    scope.channelIds.length
      ? countOne(
          tx
            .select({ n: count() })
            .from(uploadBatches)
            .where(and(expiredUploads(scope), isNotNull(uploadBatches.fileUrl)))
        )
      : Promise.resolve(0),
  ]);
  return {
    deferredActiveExceptions,
    deferredActiveWorkflows,
    deferredPendingMatchReviews,
    deferredAnomalyReviews,
    deferredNonterminalJobs,
    deferredGovernedEvidence,
    deferredPrivacyRequests,
    deferredUnprocessedWebhooks,
    // A store held for a data request keeps every row for that reason instead.
    deferredPairedTransactions: deferredPrivacyRequests > 0 ? 0 : unheldPastRetention,
    blockedReportFiles,
    blockedUploadFiles,
  };
}

/**
 * The deletions of the pass this receipt closes, rebuilt from the batch audit
 * entries written since the store's previous receipt. They are durable and
 * commit with each deletion, so the total is the same whichever instance, or
 * whichever run after a restart, finishes the day.
 *
 * Locking reads: on TiDB a plain read sees the snapshot from BEGIN, which
 * would miss a batch another instance committed just before this one took the
 * tenant lock.
 *
 * The tenant's audit-chain lock comes first, as it does for every audit write.
 * Those writers take it and then lock the chain's newest row, which may be one
 * of the batch entries read here. Reading them under lock before taking it
 * would let each side hold what the other waits for.
 */
async function deletionsSinceLastReceipt(
  tx: DbTransaction,
  scope: StoreScope
): Promise<Partial<ShopifyEvidenceRetentionCounts>> {
  await lockAuditChain(tx, scope.organizationId);
  const [previous] = await tx
    .select({
      id: shopifyEvidenceRetentionReceipts.id,
      createdAt: shopifyEvidenceRetentionReceipts.createdAt,
    })
    .from(shopifyEvidenceRetentionReceipts)
    .where(
      and(
        eq(shopifyEvidenceRetentionReceipts.organizationId, scope.organizationId),
        eq(shopifyEvidenceRetentionReceipts.storeId, scope.storeId)
      )
    )
    .orderBy(desc(shopifyEvidenceRetentionReceipts.id))
    .limit(1)
    .for("update");
  let since: SQL | undefined;
  if (previous) {
    // A receipt and its sweep entry commit together, so the entry is the exact
    // boundary in the tenant's audit chain. The receipt's own time is only a
    // fallback, and a strict one: never count a batch twice.
    const [marker] = await tx
      .select({ sequenceNumber: auditLogs.sequenceNumber })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, scope.organizationId),
          eq(auditLogs.action, SWEEP_AUDIT_ACTION),
          eq(auditLogs.entityType, RETENTION_AUDIT_ENTITY),
          eq(auditLogs.entityId, previous.id)
        )
      )
      .limit(1)
      .for("update");
    since =
      marker?.sequenceNumber != null
        ? gt(auditLogs.sequenceNumber, marker.sequenceNumber)
        : gt(auditLogs.createdAt, previous.createdAt);
  }
  const entries = await tx
    .select({ details: auditLogs.details })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, scope.organizationId),
        eq(auditLogs.action, BATCH_AUDIT_ACTION),
        since
      )
    )
    .for("update");
  return sumBatchDeletions(
    entries.map(row => row.details),
    scope.storeId
  );
}

type StoreOutcome = {
  status: "completed" | "skipped" | "incomplete";
  /** Deletions made by this run; what is still held, as of the end of the day's pass. */
  counts: ShopifyEvidenceRetentionCounts;
};

/**
 * Where an unfinished pass over a store stopped, so the next sweep continues
 * from there instead of re-reading what it already settled. Without it, a
 * store holding more kept rows than one budget can read would be re-scanned
 * from the top every minute and never finish. Process-local on purpose:
 * another instance, or this one after a restart, starts the pass again from
 * the top, which costs time and never correctness. The receipt does not depend
 * on it: its totals are rebuilt from the batch audit entries.
 */
interface UnfinishedPass {
  startedAt: number;
  phase: number;
  cursor: number;
}
const unfinishedPasses = new Map<string, UnfinishedPass>();
/** The store a budget-stopped sweep last entered; the next sweep starts after it. */
let resumeAfterStoreId = 0;

async function sweepStore(
  db: Db,
  params: {
    storeId: number;
    organizationId: number;
    cutoff: Date;
    now: Date;
    audit: typeof createAuditLog;
    batchSize: number;
    budgetSpent: () => boolean;
  }
): Promise<StoreOutcome> {
  const channelRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, params.organizationId),
        inArray(channels.code, storeChannelCodes(params.storeId))
      )
    );
  const scope: StoreScope = {
    organizationId: params.organizationId,
    storeId: params.storeId,
    channelIds: channelRows.map(row => row.id),
    cutoff: params.cutoff,
    now: params.now,
  };
  const passKey = `${params.organizationId}:${params.storeId}`;
  const saved = unfinishedPasses.get(passKey);
  unfinishedPasses.delete(passKey);
  const resumed =
    saved && params.now.getTime() - saved.startedAt < SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS
      ? saved
      : undefined;
  const startedAt = resumed?.startedAt ?? params.now.getTime();
  const thisRun = emptyCounts();

  for (let phaseIndex = resumed?.phase ?? 0; phaseIndex < PHASES.length; phaseIndex += 1) {
    const [phaseName, phase] = PHASES[phaseIndex]!;
    let cursor = phaseIndex === resumed?.phase ? resumed.cursor : 0;
    for (;;) {
      if (params.budgetSpent()) {
        unfinishedPasses.set(passKey, { startedAt, phase: phaseIndex, cursor });
        return { status: "incomplete", counts: thisRun };
      }
      const step = await db.transaction(async tx => {
        const lock = await lockStoreForRetention(tx, scope);
        if (lock !== "ready") return lock;
        const batch = await phase(tx, scope, cursor, params.batchSize);
        const deleted = deletedCounts(batch.counts);
        // Each batch's deletions commit together with the record of them, so a
        // sweep that stops part-way, for any reason, still leaves its trail.
        if (Object.keys(deleted).length > 0) {
          await params.audit(
            {
              userId: null,
              organizationId: scope.organizationId,
              action: BATCH_AUDIT_ACTION,
              entityType: RETENTION_AUDIT_ENTITY,
              details: {
                phase: phaseName,
                // The internal store row, so the receipt can add up its own
                // store's batches. Not a Shopify identifier.
                storeId: scope.storeId,
                retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
                ...deleted,
              },
            },
            tx
          );
        }
        return batch;
      });
      if (step === "fenced" || step === "done_today") {
        return { status: "skipped", counts: thisRun };
      }
      addCounts(thisRun, step.counts);
      if (step.exhausted) break;
      cursor = step.cursor;
    }
  }

  const completed = await db.transaction(async tx => {
    const lock = await lockStoreForRetention(tx, scope);
    if (lock !== "ready") return null;
    const summary: ShopifyEvidenceRetentionCounts = {
      ...emptyCounts(),
      ...(await deletionsSinceLastReceipt(tx, scope)),
      ...(await countDeferred(tx, scope)),
    };
    // The receipt is aggregate-only: no Shopify IDs, domains, order
    // references, amounts, URLs or user identifiers. It records that a day's
    // pass finished; the batch audit entries record each deletion.
    const receiptResult = await tx.insert(shopifyEvidenceRetentionReceipts).values({
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
      cutoffAt: scope.cutoff,
      summary,
      completedAt: scope.now,
    });
    const receiptId =
      Number((receiptResult as unknown as [{ insertId?: number }])[0]?.insertId ?? 0) ||
      undefined;
    await params.audit(
      {
        userId: null,
        organizationId: scope.organizationId,
        action: SWEEP_AUDIT_ACTION,
        entityType: RETENTION_AUDIT_ENTITY,
        entityId: receiptId,
        details: {
          retentionDays: SHOPIFY_SCOPE_A_EVIDENCE_RETENTION_DAYS,
          transactionsDeleted: summary.transactionsDeleted,
          exceptionsDeferred: summary.deferredActiveExceptions,
          workflowsDeferred: summary.deferredActiveWorkflows,
          matchReviewsDeferred: summary.deferredPendingMatchReviews,
          anomalyReviewsDeferred: summary.deferredAnomalyReviews,
          runsDeferred: summary.deferredNonterminalJobs,
          privacyRequestsDeferred: summary.deferredPrivacyRequests,
          pairedTransactionsDeferred: summary.deferredPairedTransactions,
          reportFilesBlocked: summary.blockedReportFiles,
          uploadFilesBlocked: summary.blockedUploadFiles,
        },
      },
      tx
    );
    return summary;
  });
  if (!completed) return { status: "skipped", counts: thisRun };
  const counts = { ...thisRun };
  for (const key of Object.keys(counts) as (keyof ShopifyEvidenceRetentionCounts)[]) {
    if (!key.endsWith("Deleted")) counts[key] = completed[key];
  }
  return { status: "completed", counts };
}

/**
 * Purge selected *terminal* Scope A financial evidence after its 90-day period.
 * Anything still needed (see `scopeAEvidenceHolds`, unanswered data requests,
 * redacting tenants, and stored files this control does not manage) fails
 * closed: it is kept and counted rather than silently discarded.
 */
export async function purgeExpiredShopifyScopeAEvidence(
  deps: ShopifyEvidenceRetentionDeps = {}
): Promise<ShopifyEvidenceRetentionReport> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("shopify_retention_database_unavailable");
  const now = deps.now?.() ?? new Date();
  const cutoff = shopifyScopeAEvidenceRetentionCutoff(now);
  const elapsed = deps.elapsed ?? (() => performance.now());
  const startedAt = elapsed();
  const budgetMs = deps.budgetMs ?? SHOPIFY_SCOPE_A_RETENTION_RUN_BUDGET_MS;
  const budgetSpent = () => elapsed() - startedAt >= budgetMs;
  const batchSize = Math.max(1, Math.floor(deps.batchSize ?? SHOPIFY_SCOPE_A_RETENTION_BATCH_SIZE));
  const report = emptyReport();

  // A store whose day is already finished costs nothing here: it is left out
  // of the list rather than locked and skipped, so finished stores can never
  // use up the budget that later stores need. The check under the store lock
  // stays the authority; this only keeps the budget for real work.
  const finishedToday = qb()
    .select({ id: shopifyEvidenceRetentionReceipts.id })
    .from(shopifyEvidenceRetentionReceipts)
    .where(
      and(
        eq(shopifyEvidenceRetentionReceipts.organizationId, shopifyConnectorStores.organizationId),
        eq(shopifyEvidenceRetentionReceipts.storeId, shopifyConnectorStores.id),
        gt(
          shopifyEvidenceRetentionReceipts.completedAt,
          new Date(now.getTime() - SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS)
        )
      )
    );
  const stores = await db
    .select({
      id: shopifyConnectorStores.id,
      organizationId: shopifyConnectorStores.organizationId,
    })
    .from(shopifyConnectorStores)
    .innerJoin(organizations, eq(organizations.id, shopifyConnectorStores.organizationId))
    .where(
      and(
        eq(organizations.deletionState, "active"),
        ne(shopifyConnectorStores.status, "redacting"),
        notExists(finishedToday),
        deps.onlyStoreIds ? inArray(shopifyConnectorStores.id, [...deps.onlyStoreIds]) : undefined
      )
    )
    .orderBy(asc(shopifyConnectorStores.id));

  // A sweep the budget stopped starts the next one with the stores after the
  // one it stopped in, so no store waits behind the same others every time.
  const ordered = [
    ...stores.filter(store => store.id > resumeAfterStoreId),
    ...stores.filter(store => store.id <= resumeAfterStoreId),
  ];
  let lastEntered: number | null = null;
  report.storesConsidered = stores.length;
  for (const store of ordered) {
    if (budgetSpent()) {
      report.storesIncomplete += 1;
      continue;
    }
    lastEntered = store.id;
    try {
      const outcome = await sweepStore(db, {
        storeId: store.id,
        organizationId: store.organizationId,
        cutoff,
        now,
        audit: deps.audit ?? createAuditLog,
        batchSize,
        budgetSpent,
      });
      if (outcome.status === "completed") report.storesCompleted += 1;
      else if (outcome.status === "incomplete") report.storesIncomplete += 1;
      else report.storesSkipped += 1;
      addCounts(report, outcome.counts);
    } catch (error) {
      report.storesFailed += 1;
      console.error("[shopify-retention] store sweep failed", {
        code: "shopify_scope_a_retention_sweep_failed",
        ...loggableError(error),
      });
    }
  }
  if (report.storesIncomplete === 0) resumeAfterStoreId = 0;
  else if (lastEntered !== null) resumeAfterStoreId = lastEntered;
  if (report.storesIncomplete > 0) {
    console.warn("[shopify-retention] sweep stopped at its time budget", {
      code: "shopify_scope_a_retention_incomplete",
      storesIncomplete: report.storesIncomplete,
    });
  }
  return report;
}

let nextScheduledSweepAt = 0;

/**
 * Application-owned schedule used by the existing privacy maintenance loop. A
 * restart may run an extra sweep, which the receipts make a no-op. A failed
 * sweep — including one that fails before it reaches any store — retries in an
 * hour, and one that ran out of time continues in a minute.
 */
export async function runShopifyScopeAEvidenceRetentionIfDue(
  deps: ShopifyEvidenceRetentionDeps = {}
): Promise<ShopifyEvidenceRetentionScheduledResult> {
  const now = deps.now?.() ?? new Date();
  if (now.getTime() < nextScheduledSweepAt) {
    return { ran: false, retryAt: new Date(nextScheduledSweepAt) };
  }
  let report: ShopifyEvidenceRetentionReport;
  try {
    report = await purgeExpiredShopifyScopeAEvidence({ ...deps, now: () => now });
  } catch (error) {
    nextScheduledSweepAt = now.getTime() + SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS;
    throw error;
  }
  const interval =
    report.storesFailed > 0
      ? SHOPIFY_SCOPE_A_RETENTION_RETRY_INTERVAL_MS
      : report.storesIncomplete > 0
        ? SHOPIFY_SCOPE_A_RETENTION_CONTINUE_INTERVAL_MS
        : SHOPIFY_SCOPE_A_RETENTION_SWEEP_INTERVAL_MS;
  nextScheduledSweepAt = now.getTime() + interval;
  return { ran: true, retryAt: new Date(nextScheduledSweepAt), report };
}

/** Test-only reset for the process-local scheduler guard and unfinished passes. */
export function resetShopifyScopeAEvidenceRetentionScheduleForTest(): void {
  nextScheduledSweepAt = 0;
  unfinishedPasses.clear();
  resumeAfterStoreId = 0;
}
