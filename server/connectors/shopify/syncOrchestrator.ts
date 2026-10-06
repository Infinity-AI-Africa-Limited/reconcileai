import { and, eq, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  channels,
  exceptions,
  matches,
  transactions,
  uploadBatches,
  users,
  type InsertTransaction,
} from "../../../drizzle/schema";
import {
  shopifyConnectorStores,
  shopifyOrderRedactionTombstones,
  shopifySyncCursors,
  shopifyWebhookEvents,
} from "../../../drizzle/shopify_schema";
import { getDb, type DbExecutor } from "../../db";
import {
  shopifyOrderDescription,
  shopifyRefundTransactionFields,
  toShopifyOrderTransaction,
  toShopifyRefundTransaction,
} from "./ingest";
import {
  allShopifyOrderSuppressionDigests,
  type ShopifyPrivacySuppressionKey,
} from "./privacySuppression";
import {
  ShopifyOrderApiError,
  computeShopifyOrderWindow,
  fetchShopifyOrdersWindow,
  isPositiveAmount,
  type NormalizedShopifyOrder,
  type NormalizedShopifyRefund,
} from "./orders";
import { affectedRows } from "./tokenStore";
import { shopifyOrdersChannelCode, shopifySettlementEvidenceChannelCode } from "./channelCodes";
import { runReconciliationOnPersistedData } from "../shopline/syncOrchestrator";

const ORDER_RESOURCE = "orders" as const;
const TRANSACTION_LOOKUP_CHUNK = 500;

export type ShopifyOrderSyncTrigger = "manual" | "webhook" | "backstop";

export interface ShopifyOrderSyncReport {
  success: boolean;
  organizationId: number;
  storeId: number;
  window: { from: Date; to: Date };
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Refund rows written this cycle: each refund that returned money is its own row. */
  refundsInserted: number;
  refundsUpdated: number;
  /** Pairs matched against settlement evidence imported before these rows were written. */
  evidenceMatched: number;
  batchId: number | null;
  errorCode?: string;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ShopifyOrderSyncDeps {
  db?: Db;
  now?: () => Date;
  fetchOrders?: typeof fetchShopifyOrdersWindow;
  suppressionKeys?: ShopifyPrivacySuppressionKey[];
}

// Defined once in channelCodes.ts; re-exported for existing importers.
export { shopifyOrdersChannelCode };

interface ExistingOrderRow {
  id: number;
  transactionRef: string | null;
  shopifyUpdatedAt: Date | null;
  amount?: string | null;
  currency?: string | null;
  transactionDate?: Date | null;
  valueDate?: Date | null;
  shopifyOrderCurrency?: string | null;
  shopifyFinancialStatus?: string | null;
  shopifyCancelledAt?: Date | null;
  status?: string;
  matchId?: number | null;
  /** The upload batch that last wrote the row — identifies which sync inserted it. */
  batchId?: number | null;
}

/**
 * Partition fetched orders into inserts, monotonic updates, and exact/older
 * replays. It is pure so idempotency and late-event handling are DB-free tests.
 */
export function partitionShopifyOrders(
  orders: NormalizedShopifyOrder[],
  existing: ExistingOrderRow[],
): {
  inserts: NormalizedShopifyOrder[];
  updates: Array<{ transactionId: number; order: NormalizedShopifyOrder }>;
  unchanged: number;
} {
  const byGid = new Map(
    existing
      .filter((row): row is ExistingOrderRow & { transactionRef: string } => Boolean(row.transactionRef))
      .map((row) => [row.transactionRef, row]),
  );
  const inserts: NormalizedShopifyOrder[] = [];
  const updates: Array<{ transactionId: number; order: NormalizedShopifyOrder }> = [];
  let unchanged = 0;
  for (const order of orders) {
    const row = byGid.get(order.gid);
    if (!row) {
      inserts.push(order);
    } else if (!row.shopifyUpdatedAt || new Date(order.updatedAt) > row.shopifyUpdatedAt) {
      updates.push({ transactionId: row.id, order });
    } else if (restatesSameSnapshot(row, order)) {
      updates.push({ transactionId: row.id, order });
    } else {
      unchanged += 1;
    }
  }
  return { inserts, updates, unchanged };
}

/**
 * The same Shopify version of an order, stored with different evidence: the
 * projection changed under it — as when the amount moved from the total net of
 * refunds to the total before them. Rewriting it is safe: an older version is
 * still never written over a newer one. Rows read without their evidence (a
 * replay check) are never restated.
 */
function restatesSameSnapshot(row: ExistingOrderRow, order: NormalizedShopifyOrder): boolean {
  return (
    row.amount != null &&
    row.shopifyUpdatedAt?.getTime() === new Date(order.updatedAt).getTime() &&
    materialShopifyOrderEvidenceChanged(row, order)
  );
}

export function filterTombstonedShopifyOrders(
  orders: NormalizedShopifyOrder[],
  tombstoned: Set<string>,
): NormalizedShopifyOrder[] {
  return orders.filter((order) => !tombstoned.has(order.gid));
}

async function filterSuppressedOrders(
  db: DbExecutor,
  store: { id: number; organizationId: number },
  orders: NormalizedShopifyOrder[],
  keys?: ShopifyPrivacySuppressionKey[],
): Promise<NormalizedShopifyOrder[]> {
  if (orders.length === 0) return [];
  const candidates = orders.flatMap((order) =>
    allShopifyOrderSuppressionDigests(store.organizationId, store.id, order.gid, keys).map((digest) => ({
      gid: order.gid,
      ...digest,
    })),
  );
  const suppressed = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += TRANSACTION_LOOKUP_CHUNK) {
    const chunk = candidates.slice(offset, offset + TRANSACTION_LOOKUP_CHUNK);
    const rows = await db
      .select({
        keyVersion: shopifyOrderRedactionTombstones.keyVersion,
        orderDigest: shopifyOrderRedactionTombstones.orderDigest,
      })
      .from(shopifyOrderRedactionTombstones)
      .where(
        and(
          eq(shopifyOrderRedactionTombstones.organizationId, store.organizationId),
          eq(shopifyOrderRedactionTombstones.storeId, store.id),
          or(
            ...chunk.map((candidate) =>
              and(
                eq(shopifyOrderRedactionTombstones.keyVersion, candidate.keyVersion),
                eq(shopifyOrderRedactionTombstones.orderDigest, candidate.orderDigest),
              ),
            ),
          ),
        ),
      );
    const hits = new Set(rows.map((row) => `${row.keyVersion}:${row.orderDigest}`));
    for (const candidate of chunk) {
      if (hits.has(`${candidate.keyVersion}:${candidate.orderDigest}`)) suppressed.add(candidate.gid);
    }
  }
  return filterTombstonedShopifyOrders(orders, suppressed);
}

export class ShopifyActorUnavailableError extends Error {
  constructor() {
    super("Shopify store has no authorised sync actor: active tenant administrator unavailable");
    this.name = "ShopifyActorUnavailableError";
  }
}

export async function resolveAuthorizedShopifyActor(
  db: DbExecutor,
  store: { id: number; organizationId: number; claimedByUserId: number | null },
): Promise<number> {
  if (store.claimedByUserId) {
    const [claimant] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, store.claimedByUserId),
          eq(users.organizationId, store.organizationId),
          eq(users.role, "admin"),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    if (claimant) return claimant.id;
  }

  // Store ownership remains tenant-bound even if its original claimant is later
  // deactivated. The deterministic fallback is another active administrator of
  // that SAME tenant; no ordinary role and no cross-tenant super-admin is valid.
  const [fallback] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, store.organizationId),
        eq(users.role, "admin"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.id)
    .limit(1);
  if (!fallback) throw new ShopifyActorUnavailableError();
  return fallback.id;
}

async function resolveOrdersChannel(
  db: DbExecutor,
  store: { id: number; organizationId: number; displayName: string; currency: string | null },
): Promise<number> {
  const code = shopifyOrdersChannelCode(store.id);
  const [existing] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organizationId, store.organizationId), eq(channels.code, code)))
    .limit(1);
  if (existing) return existing.id;

  // The code embeds the internal store id and channels.code is globally unique,
  // so concurrent provisioners converge. Re-read after the upsert rather than
  // trusting insertId, which is 0 on a duplicate update.
  await db
    .insert(channels)
    .values({
      organizationId: store.organizationId,
      name: `Shopify Orders — ${store.displayName}`.slice(0, 100),
      code,
      description: "Field-minimised Shopify financial order data",
      channelType: "ecommerce_gateway",
      country: "GLB",
      defaultCurrency: (store.currency ?? "USD").slice(0, 3),
      matchingConfig: {
        provider: "shopify",
        resource: "orders",
        refFormat: "shopify_order_gid",
        readOnly: true,
      },
      isActive: true,
    })
    .onDuplicateKeyUpdate({ set: { code: sql`${channels.code}` } });
  const [created] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organizationId, store.organizationId), eq(channels.code, code)))
    .limit(1);
  if (!created) throw new Error("Could not provision Shopify orders channel");
  return created.id;
}

async function loadExistingOrders(
  db: DbExecutor,
  params: { organizationId: number; storeId: number; gids: string[] },
): Promise<ExistingOrderRow[]> {
  const out: ExistingOrderRow[] = [];
  for (let i = 0; i < params.gids.length; i += TRANSACTION_LOOKUP_CHUNK) {
    const chunk = params.gids.slice(i, i + TRANSACTION_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    out.push(
      ...(await db
        .select({
          id: transactions.id,
          transactionRef: transactions.transactionRef,
          shopifyUpdatedAt: transactions.shopifyUpdatedAt,
          amount: transactions.amount,
          currency: transactions.currency,
          transactionDate: transactions.transactionDate,
          valueDate: transactions.valueDate,
          shopifyOrderCurrency: transactions.shopifyOrderCurrency,
          shopifyFinancialStatus: transactions.shopifyFinancialStatus,
          shopifyCancelledAt: transactions.shopifyCancelledAt,
          status: transactions.status,
          matchId: transactions.matchId,
          batchId: transactions.batchId,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            eq(transactions.shopifyStoreId, params.storeId),
            inArray(transactions.transactionRef, chunk),
            // The order's own row; its refunds share its reference.
            eq(transactions.shopifyRefundId, ""),
          ),
        )
        .for("update")),
    );
  }
  return out;
}

interface ExistingRefundRow {
  id: number;
  transactionRef: string | null;
  shopifyRefundId: string;
  shopifyUpdatedAt: Date | null;
  amount: string | null;
  currency: string | null;
  transactionDate: Date | null;
  matchId: number | null;
}

async function loadExistingRefunds(
  db: DbExecutor,
  params: { organizationId: number; storeId: number; gids: string[] },
): Promise<ExistingRefundRow[]> {
  const out: ExistingRefundRow[] = [];
  for (let i = 0; i < params.gids.length; i += TRANSACTION_LOOKUP_CHUNK) {
    const chunk = params.gids.slice(i, i + TRANSACTION_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    out.push(
      ...(await db
        .select({
          id: transactions.id,
          transactionRef: transactions.transactionRef,
          shopifyRefundId: transactions.shopifyRefundId,
          shopifyUpdatedAt: transactions.shopifyUpdatedAt,
          amount: transactions.amount,
          currency: transactions.currency,
          transactionDate: transactions.transactionDate,
          matchId: transactions.matchId,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            eq(transactions.shopifyStoreId, params.storeId),
            inArray(transactions.transactionRef, chunk),
            ne(transactions.shopifyRefundId, ""),
          ),
        )
        .for("update")),
    );
  }
  return out;
}

/** Fields that can change whether, or to what, a refund row reconciles. */
export function materialShopifyRefundEvidenceChanged(
  existing: Pick<ExistingRefundRow, "amount" | "currency" | "transactionDate">,
  order: NormalizedShopifyOrder,
  refund: NormalizedShopifyRefund,
): boolean {
  const fields = shopifyRefundTransactionFields(order, refund);
  return (
    Number(existing.amount) !== Number(fields.amount) ||
    existing.currency !== fields.currency ||
    existing.transactionDate?.getTime() !== fields.transactionDate.getTime()
  );
}

/**
 * Which refunds to insert, which stored refund rows to restate, and how many
 * are unchanged. Pure. A refund is keyed by its order and its own id. One that
 * returned no money (a restock-only refund) is not recorded — but a stored row
 * whose refund now reads zero IS restated, so the ledger follows Shopify. A
 * stored row is never written over by an older version of its order.
 */
export function planShopifyRefundRows(
  orders: NormalizedShopifyOrder[],
  existing: ExistingRefundRow[],
): {
  inserts: Array<{ order: NormalizedShopifyOrder; refund: NormalizedShopifyRefund }>;
  updates: Array<{ transactionId: number; order: NormalizedShopifyOrder; refund: NormalizedShopifyRefund; current: ExistingRefundRow }>;
  unchanged: number;
} {
  const key = (orderGid: string, refundGid: string) => `${orderGid}|${refundGid}`;
  const stored = new Map(
    existing
      .filter((row): row is ExistingRefundRow & { transactionRef: string } => Boolean(row.transactionRef))
      .map((row) => [key(row.transactionRef, row.shopifyRefundId), row]),
  );
  const inserts: Array<{ order: NormalizedShopifyOrder; refund: NormalizedShopifyRefund }> = [];
  const updates: Array<{ transactionId: number; order: NormalizedShopifyOrder; refund: NormalizedShopifyRefund; current: ExistingRefundRow }> = [];
  let unchanged = 0;
  for (const order of orders) {
    const version = new Date(order.updatedAt).getTime();
    for (const refund of order.refunds) {
      const row = stored.get(key(order.gid, refund.gid));
      if (!row) {
        if (isPositiveAmount(refund.amount)) inserts.push({ order, refund });
        continue;
      }
      const storedVersion = row.shopifyUpdatedAt?.getTime() ?? null;
      if (
        storedVersion === null ||
        version > storedVersion ||
        (version === storedVersion && materialShopifyRefundEvidenceChanged(row, order, refund))
      ) {
        updates.push({ transactionId: row.id, order, refund, current: row });
      } else {
        unchanged += 1;
      }
    }
  }
  return { inserts, updates, unchanged };
}

function sameInstant(left: Date | null | undefined, right: string | null): boolean {
  return (left?.getTime() ?? null) === (right === null ? null : new Date(right).getTime());
}

/**
 * Fields that can change whether, or to what, this order reconciles.
 *
 * Not the financial status or the cancellation time: they are kept on the row,
 * but nothing that matches reads them, and a refund — which is what changes
 * them — is now its own row. Treated as material, every refund reopened the
 * order's match to its payment, which the refund does not affect, and nothing
 * re-matched it until another settlement file named the order.
 */
export function materialShopifyOrderEvidenceChanged(
  existing: ExistingOrderRow,
  order: NormalizedShopifyOrder,
): boolean {
  return (
    Number(existing.amount) !== Number(order.totalPrice.amount) ||
    existing.currency !== order.totalPrice.currencyCode ||
    !sameInstant(existing.transactionDate, order.createdAt) ||
    !sameInstant(existing.valueDate, order.processedAt) ||
    existing.shopifyOrderCurrency !== order.currencyCode
  );
}

const ACTIVE_MATCH_STATUSES = ["confirmed", "pending_review"] as const;
/** Statuses a match put there — the only ones a rejected match may take back. */
const MATCHED_STATUSES = ["matched", "manually_matched"] as const;
/** Exception records that still await a person, and so still back an `exception` status. */
const UNRESOLVED_EXCEPTION_STATUSES = ["open", "in_review", "escalated"] as const;

/**
 * Reopen the corrected transaction and the counterparts of the matches it was in.
 *
 * Match rows are the evidence; `transactions.status` is a summary of them. So a
 * correction rejects the order's active matches (kept as audit evidence) and
 * then takes back only the `matched` summaries those matches produced. It never
 * touches state that has a different source:
 *   - a counterpart still in another active match stays matched;
 *   - an `exception` status is taken back only where a rejected `pending_review`
 *     match put it there — the job engine marks both sides of a review match
 *     `exception` without writing any exception record — and only if no
 *     unresolved exception record backs it. A status an exception record owns
 *     is left for that workflow;
 *   - a counterpart whose legacy `matchId` points at some other transaction is
 *     paired elsewhere, and is left alone.
 */
async function reopenAffectedReconciliation(
  tx: DbExecutor,
  params: { organizationId: number; transactionId: number; legacyMatchId: number | null },
): Promise<void> {
  const activeMatches = await tx
    .select({
      id: matches.id,
      status: matches.status,
      sourceTransactionId: matches.sourceTransactionId,
      targetTransactionId: matches.targetTransactionId,
    })
    .from(matches)
    .where(
      and(
        eq(matches.organizationId, params.organizationId),
        inArray(matches.status, [...ACTIVE_MATCH_STATUSES]),
        or(
          eq(matches.sourceTransactionId, params.transactionId),
          eq(matches.targetTransactionId, params.transactionId),
        ),
      ),
    );

  const matchRowIds = activeMatches.map((match) => match.id);
  if (matchRowIds.length > 0) {
    await tx
      .update(matches)
      .set({ status: "rejected" })
      .where(
        and(
          eq(matches.organizationId, params.organizationId),
          inArray(matches.id, matchRowIds),
          inArray(matches.status, [...ACTIVE_MATCH_STATUSES]),
        ),
      );
  }

  const counterparts = [
    ...new Set(
      [
        ...activeMatches.map((match) =>
          match.sourceTransactionId === params.transactionId
            ? match.targetTransactionId
            : match.sourceTransactionId,
        ),
        ...(params.legacyMatchId ? [params.legacyMatchId] : []),
      ].filter((id) => id !== params.transactionId),
    ),
  ];

  const pairedElsewhere = new Set<number>();
  if (counterparts.length > 0) {
    // Read AFTER rejecting ours, so what remains is independent of this order.
    const stillMatched = await tx
      .select({ sourceTransactionId: matches.sourceTransactionId, targetTransactionId: matches.targetTransactionId })
      .from(matches)
      .where(
        and(
          eq(matches.organizationId, params.organizationId),
          inArray(matches.status, [...ACTIVE_MATCH_STATUSES]),
          or(inArray(matches.sourceTransactionId, counterparts), inArray(matches.targetTransactionId, counterparts)),
        ),
      );
    for (const match of stillMatched) {
      pairedElsewhere.add(match.sourceTransactionId);
      pairedElsewhere.add(match.targetTransactionId);
    }
    const reopenable = counterparts.filter((id) => !pairedElsewhere.has(id));
    if (reopenable.length > 0) {
      await tx
        .update(transactions)
        .set({ status: "unmatched", matchId: null })
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            inArray(transactions.id, reopenable),
            inArray(transactions.status, [...MATCHED_STATUSES]),
            or(isNull(transactions.matchId), eq(transactions.matchId, params.transactionId)),
          ),
        );
    }
  }

  // Both parties to a rejected review match were marked `exception` by it.
  // Take that back where nothing else still stands behind the status.
  const reviewMatches = activeMatches.filter((match) => match.status === "pending_review");
  const reviewCounterparts = [
    ...new Set(
      reviewMatches
        .map((match) =>
          match.sourceTransactionId === params.transactionId ? match.targetTransactionId : match.sourceTransactionId,
        )
        .filter((id) => id !== params.transactionId),
    ),
  ];
  const reviewParties = [
    ...new Set(
      reviewMatches
        .flatMap((match) => [match.sourceTransactionId, match.targetTransactionId])
        .filter((id) => !pairedElsewhere.has(id)),
    ),
  ];
  if (reviewParties.length > 0) {
    const backed = await tx
      .select({ transactionId: exceptions.transactionId })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.organizationId, params.organizationId),
          inArray(exceptions.transactionId, reviewParties),
          inArray(exceptions.status, [...UNRESOLVED_EXCEPTION_STATUSES]),
        ),
      );
    const backedIds = new Set(backed.map((row) => row.transactionId));
    const stale = reviewParties.filter((id) => !backedIds.has(id));
    // A legacy `matchId` naming some OTHER transaction is a pairing this
    // correction does not own, exactly as for the matched summaries above: a
    // row is released only while its pointer is empty or names the other side
    // of the review match being rejected.
    if (stale.includes(params.transactionId) && reviewCounterparts.length > 0) {
      await tx
        .update(transactions)
        .set({ status: "unmatched", matchId: null })
        .where(
          and(
            eq(transactions.id, params.transactionId),
            eq(transactions.organizationId, params.organizationId),
            eq(transactions.status, "exception"),
            or(isNull(transactions.matchId), inArray(transactions.matchId, reviewCounterparts)),
          ),
        );
    }
    const staleCounterparts = stale.filter((id) => id !== params.transactionId);
    if (staleCounterparts.length > 0) {
      await tx
        .update(transactions)
        .set({ status: "unmatched", matchId: null })
        .where(
          and(
            eq(transactions.organizationId, params.organizationId),
            inArray(transactions.id, staleCounterparts),
            eq(transactions.status, "exception"),
            or(isNull(transactions.matchId), eq(transactions.matchId, params.transactionId)),
          ),
        );
    }
  }

  // Every active match the corrected order was in is now rejected, so a matched
  // summary has nothing behind it. Any other status has its own source.
  await tx
    .update(transactions)
    .set({ status: "unmatched", matchId: null })
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.organizationId, params.organizationId),
        inArray(transactions.status, [...MATCHED_STATUSES]),
      ),
    );
}

/**
 * Serialise writers per store. A manual sync and a webhook sync can overlap;
 * holding the store row for the whole write means the second one's locking
 * reads see the first one's committed rows, rather than both deciding from the
 * same stale picture and racing on the unique key.
 */
async function lockStoreForSync(
  tx: DbExecutor,
  store: { id: number; organizationId: number },
): Promise<void> {
  const [locked] = await tx
    .select({ id: shopifyConnectorStores.id })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, store.id),
        eq(shopifyConnectorStores.organizationId, store.organizationId),
        eq(shopifyConnectorStores.status, "active"),
        // A customer redaction fences the store's writes; the API read may have
        // started before it was admitted, so this is re-checked under the lock.
        eq(shopifyConnectorStores.privacyRedactionState, "active"),
      ),
    )
    .limit(1)
    .for("update");
  if (!locked) throw new Error("Shopify store write fence is active or the store is not active");
}

function transactionFields(order: NormalizedShopifyOrder) {
  return {
    externalRef: order.name,
    description: shopifyOrderDescription(order.name),
    amount: order.totalPrice.amount,
    currency: order.totalPrice.currencyCode,
    transactionDate: new Date(order.createdAt),
    valueDate: order.processedAt ? new Date(order.processedAt) : null,
    shopifyOrderCurrency: order.currencyCode,
    shopifyUpdatedAt: new Date(order.updatedAt),
    shopifyFinancialStatus: order.displayFinancialStatus,
    shopifyCancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    rawData: null,
  };
}

function maxUpdatedAt(orders: NormalizedShopifyOrder[], fallback: Date): Date {
  return orders.reduce((latest, order) => {
    const updated = new Date(order.updatedAt);
    return updated > latest ? updated : latest;
  }, fallback);
}

/** The code recorded for a failed sync, on the cursor and on the manual requests a run settles. */
export function shopifySyncFailureCode(error: unknown): string {
  if (error instanceof ShopifyOrderApiError) return error.code.toLowerCase();
  if (error instanceof Error && /authorised sync actor/.test(error.message)) return "sync_actor_unavailable";
  if (error instanceof Error && /not an active member/.test(error.message)) return "sync_actor_invalid";
  return "sync_failed";
}

/**
 * Fetch and persist one tenant-owned store. The store lookup, token call,
 * transaction lookup, writes and cursor update all carry organizationId.
 */
export async function runShopifyOrderSync(
  params: {
    storeId: number;
    organizationId: number;
    trigger: ShopifyOrderSyncTrigger;
    webhookId?: string;
  },
  deps: ShopifyOrderSyncDeps = {},
): Promise<ShopifyOrderSyncReport> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable");
  const now = (deps.now ?? (() => new Date()))();

  const [store] = await db
    .select({
      id: shopifyConnectorStores.id,
      organizationId: shopifyConnectorStores.organizationId,
      shopDomain: shopifyConnectorStores.shopDomain,
      displayName: shopifyConnectorStores.displayName,
      currency: shopifyConnectorStores.currency,
      claimedByUserId: shopifyConnectorStores.claimedByUserId,
    })
    .from(shopifyConnectorStores)
    .where(
      and(
        eq(shopifyConnectorStores.id, params.storeId),
        eq(shopifyConnectorStores.organizationId, params.organizationId),
        eq(shopifyConnectorStores.status, "active"),
      ),
    )
    .limit(1);
  if (!store) throw new Error("Shopify store not found for tenant or inactive");

  const [cursor] = await db
    .select()
    .from(shopifySyncCursors)
    .where(
      and(
        eq(shopifySyncCursors.storeId, store.id),
        eq(shopifySyncCursors.organizationId, store.organizationId),
        eq(shopifySyncCursors.resource, ORDER_RESOURCE),
      ),
    )
    .limit(1);
  const window = computeShopifyOrderWindow({ now, watermark: cursor?.watermarkUpdatedAt ?? null });

  try {
    // Prove the actor before fetching protected order data. The actor was created
    // and bound to this tenant during OAuth onboarding; no synthetic user 0.
    const userId = await resolveAuthorizedShopifyActor(db, store);
    const fetched = await (deps.fetchOrders ?? fetchShopifyOrdersWindow)({
      storeId: store.id,
      organizationId: store.organizationId,
      shopDomain: store.shopDomain,
      ...window,
    });

    const result = await db.transaction(async (tx) => {
      // First statement: one writer per store from here to commit. The lock
      // also refuses a store fenced for redaction since the API read began.
      await lockStoreForSync(tx, store);
      // Computing every retained-key digest and loading tombstones happens under
      // the same lock. Missing rotation material throws and aborts fail-closed.
      const eligible = await filterSuppressedOrders(tx, store, fetched, deps.suppressionKeys);
      const channelId = await resolveOrdersChannel(tx, store);
      const existing = await loadExistingOrders(tx, {
        organizationId: store.organizationId,
        storeId: store.id,
        gids: eligible.map((order) => order.gid),
      });
      const partition = partitionShopifyOrders(eligible, existing);
      const refundPlan = planShopifyRefundRows(
        eligible,
        await loadExistingRefunds(tx, {
          organizationId: store.organizationId,
          storeId: store.id,
          gids: eligible.filter((order) => order.refunds.length > 0).map((order) => order.gid),
        }),
      );
      const changed =
        partition.inserts.length +
        partition.updates.length +
        refundPlan.inserts.length +
        refundPlan.updates.length;
      let batchId: number | null = null;
      let inserted = 0;
      let updated = 0;
      let unchanged = partition.unchanged;
      let refundsInserted = 0;
      let refundsUpdated = 0;
      let evidenceMatched = 0;
      // Orders whose ledger rows this cycle wrote, to reconcile against
      // evidence that arrived before them.
      const writtenOrders = new Set<string>();

      if (changed > 0) {
        const batch = await tx.insert(uploadBatches).values({
          userId,
          channelId,
          organizationId: store.organizationId,
          fileName: `shopify_orders_${store.id}_${window.from.toISOString()}`,
          fileHash: `shopify_orders_${store.id}_${window.from.getTime()}_${window.to.getTime()}`,
          detectedFormat: "shopify_graphql_orders",
          totalRows: eligible.length,
          validRows: changed,
          invalidRows: 0,
          status: "completed",
          completedAt: new Date(),
        });
        batchId = Number((batch as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
        if (!batchId) throw new Error("Could not create Shopify order upload batch");

        const rows: InsertTransaction[] = partition.inserts.map((order) =>
          toShopifyOrderTransaction(order, {
            organizationId: store.organizationId,
            storeId: store.id,
            channelId,
            batchId: batchId!,
            userId,
          }),
        );
        if (rows.length > 0) {
          // The unique key is the concurrency backstop. A racing cycle may have
          // inserted the same GID after our locking lookup. Do not overwrite any
          // evidence in the duplicate branch: re-read the winning row below and
          // route a genuinely newer correction through the same guarded update
          // and reconciliation-invalidation path as every ordinary update.
          await tx.insert(transactions).values(rows).onDuplicateKeyUpdate({
            set: {
              transactionRef: sql`${transactions.transactionRef}`,
            },
          });
        }

        const racedRows = await loadExistingOrders(tx, {
          organizationId: store.organizationId,
          storeId: store.id,
          gids: partition.inserts.map((order) => order.gid),
        });
        // A row this cycle inserted carries this cycle's batch. Anything else
        // was written by another sync first: it is not an insert of ours. It is
        // an update if our evidence is newer, and otherwise unchanged.
        const ours = racedRows.filter((row) => row.batchId === batchId);
        inserted = ours.length;
        for (const row of ours) if (row.transactionRef) writtenOrders.add(row.transactionRef);
        const raced = partitionShopifyOrders(
          partition.inserts,
          racedRows.filter((row) => row.batchId !== batchId),
        );
        const racedCorrections = raced.updates;
        unchanged += raced.unchanged;

        for (const update of [...partition.updates, ...racedCorrections]) {
          const current = [...existing, ...racedRows].find((row) => row.id === update.transactionId);
          const write = await tx
            .update(transactions)
            .set({ ...transactionFields(update.order), batchId, channelId, userId })
            .where(
              and(
                eq(transactions.id, update.transactionId),
                eq(transactions.organizationId, store.organizationId),
                eq(transactions.shopifyStoreId, store.id),
                eq(transactions.transactionRef, update.order.gid),
                eq(transactions.shopifyRefundId, ""),
                // Never an older version over a newer one. The same version is
                // written only when the plan found its evidence restated.
                or(
                  isNull(transactions.shopifyUpdatedAt),
                  lte(transactions.shopifyUpdatedAt, new Date(update.order.updatedAt)),
                ),
              ),
            );
          if (affectedRows(write) === 0) {
            unchanged += 1;
            continue;
          }
          updated += 1;
          writtenOrders.add(update.order.gid);
          if (current && materialShopifyOrderEvidenceChanged(current, update.order)) {
            await reopenAffectedReconciliation(tx, {
              organizationId: store.organizationId,
              transactionId: update.transactionId,
              legacyMatchId: current.matchId ?? null,
            });
          }
        }

        // Refunds after their orders. The store lock serialises every writer
        // of this store's ledger, so the plan's inserts are this cycle's; the
        // unique key (order, refund id) stays the backstop.
        if (refundPlan.inserts.length > 0) {
          await tx
            .insert(transactions)
            .values(
              refundPlan.inserts.map(({ order, refund }) =>
                toShopifyRefundTransaction(order, refund, {
                  organizationId: store.organizationId,
                  storeId: store.id,
                  channelId,
                  batchId: batchId!,
                  userId,
                }),
              ),
            )
            .onDuplicateKeyUpdate({ set: { transactionRef: sql`${transactions.transactionRef}` } });
          refundsInserted = refundPlan.inserts.length;
          for (const { order } of refundPlan.inserts) writtenOrders.add(order.gid);
        }
        for (const update of refundPlan.updates) {
          const write = await tx
            .update(transactions)
            .set({ ...shopifyRefundTransactionFields(update.order, update.refund), batchId, channelId, userId })
            .where(
              and(
                eq(transactions.id, update.transactionId),
                eq(transactions.organizationId, store.organizationId),
                eq(transactions.shopifyStoreId, store.id),
                eq(transactions.transactionRef, update.order.gid),
                eq(transactions.shopifyRefundId, update.refund.gid),
                or(
                  isNull(transactions.shopifyUpdatedAt),
                  lte(transactions.shopifyUpdatedAt, new Date(update.order.updatedAt)),
                ),
              ),
            );
          if (affectedRows(write) === 0) continue;
          refundsUpdated += 1;
          writtenOrders.add(update.order.gid);
          if (materialShopifyRefundEvidenceChanged(update.current, update.order, update.refund)) {
            await reopenAffectedReconciliation(tx, {
              organizationId: store.organizationId,
              transactionId: update.transactionId,
              legacyMatchId: update.current.matchId,
            });
          }
        }

        // The batch was sized from the plan; record what was actually written.
        // If another sync wrote everything first, this batch holds nothing.
        const written = inserted + updated + refundsInserted + refundsUpdated;
        if (written === 0) {
          await tx
            .delete(uploadBatches)
            .where(and(eq(uploadBatches.id, batchId), eq(uploadBatches.organizationId, store.organizationId)));
          batchId = null;
        } else if (written !== changed) {
          await tx
            .update(uploadBatches)
            .set({ validRows: written })
            .where(and(eq(uploadBatches.id, batchId), eq(uploadBatches.organizationId, store.organizationId)));
        }
      }

      if (writtenOrders.size > 0) {
        evidenceMatched = await reconcileWithWaitingEvidence(tx, {
          store,
          ordersChannelId: channelId,
          orderGids: [...writtenOrders],
        });
      }

      // Both branches fixed the same NULL-watermark bug: main inline here, this
      // branch by extracting `recordSuccessfulOrderSync` (same COALESCE/GREATEST
      // guard, asserted by orderBackstop.test.ts). The helper is kept, so the
      // upsert has one definition rather than two that can drift apart.
      await recordSuccessfulOrderSync(tx, store, maxUpdatedAt(fetched, window.to));

      if (params.webhookId) {
        await tx
          .update(shopifyWebhookEvents)
          .set({ status: "processed", errorCode: null, processedAt: new Date() })
          .where(
            and(
              eq(shopifyWebhookEvents.webhookId, params.webhookId),
              eq(shopifyWebhookEvents.storeId, store.id),
              eq(shopifyWebhookEvents.organizationId, store.organizationId),
            ),
          );
      }

      return {
        inserted,
        updated,
        unchanged,
        refundsInserted,
        refundsUpdated,
        evidenceMatched,
        batchId,
      };
    });

    return {
      success: true,
      organizationId: store.organizationId,
      storeId: store.id,
      window,
      fetched: fetched.length,
      ...result,
    };
  } catch (error) {
    const code = shopifySyncFailureCode(error);
    // With its time, so the failure can be told apart from an older one.
    const failedAt = new Date();
    await db
      .insert(shopifySyncCursors)
      .values({
        storeId: store.id,
        organizationId: store.organizationId,
        resource: ORDER_RESOURCE,
        lastErrorCode: code,
        lastErrorAt: failedAt,
      })
      .onDuplicateKeyUpdate({ set: { lastErrorCode: code, lastErrorAt: failedAt } });
    throw error;
  }
}

/** The import's own margin past the latest evidence it reconciles to. */
const EVIDENCE_DATE_MARGIN_MS = 3 * 24 * 60 * 60_000;

/**
 * Reconcile the orders this cycle wrote against settlement evidence already
 * imported for them, and return the pairs matched.
 *
 * The evidence import reconciles only what it imports. Evidence that arrived
 * BEFORE its Shopify row — a gateway's refund line imported before the refund
 * synced, an order that synced late, a match reopened by a correction — would
 * otherwise stay unmatched for good: importing the file again adds nothing, so
 * reconciles nothing. Only orders with evidence still unmatched are in scope.
 *
 * It only MATCHES. Judging what a settlement file lacks is the import's job,
 * against the file's own period; here there is no file, and a refund whose line
 * has simply not arrived yet would be flagged — and stay flagged after it did.
 *
 * Runs inside the sync's transaction, under its store lock, which the import
 * also takes: the two never reconcile one store's ledger at once.
 */
async function reconcileWithWaitingEvidence(
  tx: DbExecutor,
  params: {
    store: { id: number; organizationId: number; currency: string | null };
    ordersChannelId: number;
    orderGids: string[];
  },
): Promise<number> {
  const { store } = params;
  const [evidenceChannel] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, store.organizationId),
        eq(channels.code, shopifySettlementEvidenceChannelCode(store.id)),
      ),
    )
    .limit(1);
  if (!evidenceChannel) return 0;

  const waiting = new Set<string>();
  // Up to the latest evidence waiting, never to the sync's own clock: a refund
  // made after the evidence's period is not something it could show.
  let latest = 0;
  for (let i = 0; i < params.orderGids.length; i += TRANSACTION_LOOKUP_CHUNK) {
    const chunk = params.orderGids.slice(i, i + TRANSACTION_LOOKUP_CHUNK);
    const rows = await tx
      .select({ transactionRef: transactions.transactionRef, transactionDate: transactions.transactionDate })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, store.organizationId),
          eq(transactions.channelId, evidenceChannel.id),
          eq(transactions.status, "unmatched"),
          inArray(transactions.transactionRef, chunk),
        ),
      );
    for (const row of rows) {
      if (!row.transactionRef) continue;
      waiting.add(row.transactionRef);
      if (row.transactionDate) latest = Math.max(latest, new Date(row.transactionDate).getTime());
    }
  }
  if (waiting.size === 0) return 0;

  const result = await runReconciliationOnPersistedData(
    tx,
    store.organizationId,
    params.ordersChannelId,
    evidenceChannel.id,
    // Any earlier date: the scope is these orders, and their evidence may
    // follow them by weeks.
    new Date(0),
    new Date(latest + EVIDENCE_DATE_MARGIN_MS),
    store.currency ?? "USD",
    { orderRefs: [...waiting], flag: "none" },
  );
  return result.matchedCount;
}

/**
 * The cursor's watermark after a successful sync: never behind where it was,
 * and never left NULL.
 *
 * GREATEST is NULL when either argument is, and a cursor can exist with no
 * watermark: a first sync that failed writes one carrying only its error code,
 * and the scheduled backstop records its turn on the cursor before syncing. A
 * bare GREATEST would pin such a watermark at NULL for good, so every later sync
 * would re-read the default first window instead of advancing, and orders
 * missed for longer than that window would never be recovered.
 */
export function advancedOrderWatermark(): SQL {
  const current = shopifySyncCursors.watermarkUpdatedAt;
  return sql`COALESCE(GREATEST(${current}, VALUES(${current})), VALUES(${current}))`;
}

/** Record a successful order sync on the store's cursor, advancing its watermark. */
export async function recordSuccessfulOrderSync(
  db: DbExecutor,
  store: { id: number; organizationId: number },
  watermark: Date,
): Promise<void> {
  await db
    .insert(shopifySyncCursors)
    .values({
      storeId: store.id,
      organizationId: store.organizationId,
      resource: ORDER_RESOURCE,
      cursor: null,
      watermarkUpdatedAt: watermark,
      lastSuccessfulAt: new Date(),
      lastErrorCode: null,
    })
    .onDuplicateKeyUpdate({
      set: {
        cursor: null,
        watermarkUpdatedAt: advancedOrderWatermark(),
        lastSuccessfulAt: new Date(),
        lastErrorCode: null,
      },
    });
}

/** 60 days in 7-day steps is 9 cycles; the rest is headroom for overlap and clock drift. */
const MAX_CATCH_UP_CYCLES = 16;

/**
 * Run sync cycles until the store's orders are current. Each cycle reads at
 * most one bounded window and commits its watermark (computeShopifyOrderWindow),
 * so a first sync or a long-idle store walks forward step by step, and a failure
 * part-way resumes from the last committed step rather than from the start. A
 * store already current takes one cycle, as before.
 *
 * `budgetMs` bounds the time spent, for a caller sharing its turn with other
 * stores: no further cycle STARTS once it is spent, and the first always runs,
 * so a store is never given less than one cycle. What is left resumes from the
 * committed watermark next time.
 */
export async function runShopifyOrderSyncToNow(
  params: Parameters<typeof runShopifyOrderSync>[0],
  deps: ShopifyOrderSyncDeps & { runCycle?: typeof runShopifyOrderSync; budgetMs?: number } = {},
): Promise<ShopifyOrderSyncReport[]> {
  const runCycle = deps.runCycle ?? runShopifyOrderSync;
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock().getTime();
  const reports: ShopifyOrderSyncReport[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (let cycle = 0; cycle < MAX_CATCH_UP_CYCLES; cycle += 1) {
    const cycleStart = clock().getTime();
    if (cycle > 0 && deps.budgetMs !== undefined && cycleStart - startedAt >= deps.budgetMs) break;
    const report = await runCycle(params, deps);
    reports.push(report);
    const end = report.window.to.getTime();
    // Current once a window reaches the moment its cycle began. Stop, too, if a
    // window failed to move forward — never spin on a stuck watermark.
    if (end >= cycleStart || end <= previousEnd) break;
    previousEnd = end;
  }
  return reports;
}

type ShopifyWebhookSyncPayload = { storeId: number; organizationId: number; webhookId: string };

/**
 * A webhook worker hook; queue integration stays injectable and independently
 * testable. Catches up in steps, like a manual sync: a store whose FIRST sync is
 * triggered by a webhook has the same 60-day backfill ahead of it.
 */
export async function handleShopifyWebhookSync(payload: ShopifyWebhookSyncPayload): Promise<void> {
  await runShopifyOrderSyncToNow({ ...payload, trigger: "webhook" });
}

/** Terminal queue evidence: retained for operators and eligible for redelivery. */
export async function markShopifyWebhookSyncFailed(
  payload: ShopifyWebhookSyncPayload,
  deps: { db?: Db } = {},
): Promise<void> {
  const db = deps.db ?? (await getDb());
  if (!db) throw new Error("Database unavailable while recording failed Shopify order sync");
  await db
    .update(shopifyWebhookEvents)
    .set({ status: "failed", errorCode: "order_sync_attempts_exhausted", processedAt: new Date() })
    .where(
      and(
        eq(shopifyWebhookEvents.webhookId, payload.webhookId),
        eq(shopifyWebhookEvents.storeId, payload.storeId),
        eq(shopifyWebhookEvents.organizationId, payload.organizationId),
        eq(shopifyWebhookEvents.status, "received"),
      ),
    );
}

/**
 * Durable trigger interface used by the verified webhook route. The generic queue
 * is enabled only when Redis is configured; without it the webhook ledger stays
 * `received` and Shopify is answered 503, so no event is falsely acknowledged.
 */
export async function enqueueShopifyWebhookSync(payload: ShopifyWebhookSyncPayload): Promise<void> {
  const { enqueueShopifyOrderSync } = await import("./syncQueue");
  await enqueueShopifyOrderSync(payload);
}
