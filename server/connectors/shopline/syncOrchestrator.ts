/**
 * SHOPLINE Sync Orchestrator
 *
 * Coordinates the full ingest → persist → reconcile → exception pipeline:
 *
 *   1. Fetch data from SHOPLINE APIs (orders, payments, payouts)
 *   2. Normalise to canonical InsertTransaction rows via ingest.ts
 *   3. Persist to the `transactions` table (creates an upload batch)
 *   4. Run the retail reconciliation engine on the persisted data
 *   5. Persist exceptions to the `reconciliation_exceptions` table
 *
 * This replaces the in-memory-only `settlementSync.ts` approach with a
 * full persistence pipeline suitable for production.
 *
 * Called by:
 *   - The webhook handler (on orders/paid, order_transactions/create)
 *   - The scheduled polling job (every 15 min)
 *   - Manual "Sync Now" from the merchant dashboard
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../../db";
import { insertTransactions, createUploadBatch, insertExceptionsBatch } from "../../db";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { transactions, channels } from "../../../drizzle/schema";
import { getValidToken } from "./tokenStore";
import {
  fetchOrders,
  fetchPaymentTransactions,
  fetchPayouts,
  type ShoplineOrder,
  type ShoplinePaymentTransaction,
  type ShoplinePayout,
  type ShoplineApiOptions,
} from "./apiClient";
import {
  normaliseOrder,
  normalisePaymentTransaction,
  normalisePayout,
  type IngestContext,
} from "./ingest";
import {
  shoplineOrdersChannelCode,
  shoplinePaymentsChannelCode,
} from "./onboarding";
import { isSyncBlockedBySubscription } from "./billingWebhook";
import {
  runRetailReconciliation,
  type RetailReconciliationConfig,
} from "../../retailReconciliationEngine";
import type { Transaction } from "../../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── Public interface ───────────────────────────────────────────────────────
export interface SyncOptions {
  organizationId: number;
  slStoreId: number;
  /** Time window to sync (defaults to last 24h) */
  from?: Date;
  to?: Date;
  /** User who triggered the sync (0 = system) */
  triggeredBy?: number;
  /** If true, skip reconciliation (just ingest) */
  ingestOnly?: boolean;
}

export interface SyncReport {
  success: boolean;
  organizationId: number;
  storeHandle: string;
  window: { from: Date; to: Date };
  ordersIngested: number;
  paymentsIngested: number;
  payoutsIngested: number;
  totalPersisted: number;
  matchedCount: number;
  exceptionCount: number;
  durationMs: number;
  error?: string;
}

/**
 * Run a full sync cycle for a single SHOPLINE store.
 */
export async function runSyncCycle(opts: SyncOptions): Promise<SyncReport> {
  const startedAt = Date.now();
  const db = await getDb();
  if (!db) {
    return errorReport(opts, "Database unavailable", startedAt);
  }

  // Resolve store
  const stores = await db
    .select()
    .from(slConnectorStores)
    .where(
      and(
        eq(slConnectorStores.id, opts.slStoreId),
        eq(slConnectorStores.organizationId, opts.organizationId),
        eq(slConnectorStores.status, "active"),
      ),
    )
    .limit(1);

  if (stores.length === 0) {
    return errorReport(opts, `Store ${opts.slStoreId} not found or inactive`, startedAt);
  }

  const store = stores[0];
  const storeHandle = store.storeHandle;

  // Gate on subscription state — a churned (expired/cancelled) store should not
  // consume SHOPLINE API quota. Lenient: no-subscription and trialing/active/
  // past_due all proceed (see isSyncBlockedBySubscription).
  const gate = await isSyncBlockedBySubscription(db, opts.slStoreId);
  if (gate.blocked) {
    return errorReport(opts, `Sync skipped — subscription ${gate.status}`, startedAt, storeHandle);
  }

  // Time window (default: last 24h)
  const to = opts.to ?? new Date();
  const from = opts.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);

  try {
    // Get valid access token
    const accessToken = await getValidToken(db, opts.slStoreId, opts.organizationId, storeHandle);
    if (!accessToken) {
      return errorReport(opts, `No access token for store ${storeHandle} — re-install required`, startedAt);
    }

    const apiOpts: ShoplineApiOptions = { storeHandle, accessToken };
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // ── Step 1: Fetch from SHOPLINE APIs ────────────────────────────────────
    const orders = await fetchAllOrders(apiOpts, fromIso, toIso);
    const payments = await fetchAllPayments(apiOpts, fromIso, toIso);
    const payouts = await fetchAllPayouts(apiOpts, fromIso, toIso);

    // ── Step 2: Resolve channel IDs for this store ──────────────────────────
    const { ordersChannelId, paymentsChannelId } = await resolveChannelIds(
      db,
      opts.organizationId,
      storeHandle,
    );

    // ── Step 3: Create upload batch ─────────────────────────────────────────
    const batchId = await createUploadBatch({
      userId: opts.triggeredBy ?? 0,
      organizationId: opts.organizationId,
      channelId: ordersChannelId,
      fileName: `shopline_sync_${storeHandle}_${fromIso}`,
      fileHash: `shopline_sync_${store.id}_${from.getTime()}_${to.getTime()}`,
      status: "processing",
      totalRows: orders.length + payments.length + payouts.length,
      validRows: 0,
      invalidRows: 0,
    });

    if (!batchId) {
      return errorReport(opts, "Failed to create upload batch", startedAt);
    }

    // ── Step 4: Normalise and persist ───────────────────────────────────────
    const ctx: IngestContext = {
      organizationId: opts.organizationId,
      ordersChannelId,
      paymentsChannelId,
      batchId,
      userId: opts.triggeredBy ?? 0,
      defaultCurrency: store.currency ?? "USD",
    };

    const orderRows = orders.map((o) => normaliseOrder(o, ctx));
    const paymentRows = payments.map((p) => normalisePaymentTransaction(p, ctx));
    const payoutRows = payouts.map((p) => normalisePayout(p, ctx));

    const allRows = [...orderRows, ...paymentRows, ...payoutRows];
    if (allRows.length > 0) {
      await insertTransactions(allRows);
    }

    // ── Step 5: Run reconciliation (unless ingestOnly) ──────────────────────
    let matchedCount = 0;
    let exceptionCount = 0;

    if (!opts.ingestOnly && allRows.length > 0) {
      const result = await runReconciliationOnPersistedData(
        db,
        opts.organizationId,
        ordersChannelId,
        paymentsChannelId,
        from,
        to,
        store.currency ?? "USD",
      );
      matchedCount = result.matchedCount;
      exceptionCount = result.exceptionCount;
    }

    // ── Step 6: Update store lastSyncAt ─────────────────────────────────────
    await db
      .update(slConnectorStores)
      .set({ lastSyncAt: new Date() })
      .where(eq(slConnectorStores.id, opts.slStoreId));

    return {
      success: true,
      organizationId: opts.organizationId,
      storeHandle,
      window: { from, to },
      ordersIngested: orders.length,
      paymentsIngested: payments.length,
      payoutsIngested: payouts.length,
      totalPersisted: allRows.length,
      matchedCount,
      exceptionCount,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorReport(opts, message, startedAt, storeHandle);
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function fetchAllOrders(
  opts: ShoplineApiOptions,
  from: string,
  to: string,
): Promise<ShoplineOrder[]> {
  const results: ShoplineOrder[] = [];
  let pageInfo: string | null = null;
  do {
    const page = await fetchOrders(opts, {
      financialStatus: "paid",
      updatedAtMin: from,
      updatedAtMax: to,
      limit: 250,
      pageInfo: pageInfo ?? undefined,
    });
    results.push(...page.data);
    pageInfo = page.nextPageInfo;
  } while (pageInfo);
  return results;
}

async function fetchAllPayments(
  opts: ShoplineApiOptions,
  from: string,
  to: string,
): Promise<ShoplinePaymentTransaction[]> {
  const results: ShoplinePaymentTransaction[] = [];
  let pageInfo: string | null = null;
  do {
    const page = await fetchPaymentTransactions(opts, {
      dateMin: from,
      dateMax: to,
      // Gateway capture leg only — REFUND/DISPUTE rows are ingested via their
      // own paths (refunds channel / dispute exceptions), not as captures.
      transactionType: "PAYMENT",
      limit: 250,
      pageInfo: pageInfo ?? undefined,
    });
    results.push(...page.data);
    pageInfo = page.nextPageInfo;
  } while (pageInfo);
  return results;
}

async function fetchAllPayouts(
  opts: ShoplineApiOptions,
  from: string,
  to: string,
): Promise<ShoplinePayout[]> {
  const results: ShoplinePayout[] = [];
  let pageInfo: string | null = null;
  do {
    const page = await fetchPayouts(opts, {
      startTime: from,
      endTime: to,
      limit: 50,
      pageInfo: pageInfo ?? undefined,
    });
    results.push(...page.data);
    pageInfo = page.nextPageInfo;
  } while (pageInfo);
  return results;
}

/**
 * Resolve (or create) the orders and payments channel IDs for a SHOPLINE store.
 *
 * Channels are keyed by their deterministic UNIQUE codes (shared with the
 * onboarding provisioner). Matching by code — not by display name — is what
 * keeps this idempotent: onboarding already created these channels, so a name
 * mismatch here would collide on the unique code and throw on the first sync.
 */
async function resolveChannelIds(
  db: Db,
  organizationId: number,
  storeHandle: string,
): Promise<{ ordersChannelId: number; paymentsChannelId: number }> {
  const ordersCode = shoplineOrdersChannelCode(storeHandle);
  const paymentsCode = shoplinePaymentsChannelCode(storeHandle);

  const existingChannels = await db
    .select({ id: channels.id, code: channels.code })
    .from(channels)
    .where(eq(channels.organizationId, organizationId));

  let ordersChannelId = existingChannels.find((c) => c.code === ordersCode)?.id ?? 0;
  let paymentsChannelId = existingChannels.find((c) => c.code === paymentsCode)?.id ?? 0;

  if (!ordersChannelId) {
    const [result] = await db.insert(channels).values({
      organizationId,
      name: `SHOPLINE Orders (${storeHandle})`,
      code: ordersCode,
      channelType: "ecommerce_gateway",
      description: `SHOPLINE order data for store ${storeHandle}`,
      isActive: true,
    });
    ordersChannelId = result.insertId;
  }

  if (!paymentsChannelId) {
    const [result] = await db.insert(channels).values({
      organizationId,
      name: `SHOPLINE Payments (${storeHandle})`,
      code: paymentsCode,
      channelType: "ecommerce_gateway",
      description: `SHOPLINE payment transaction data for store ${storeHandle}`,
      isActive: true,
    });
    paymentsChannelId = result.insertId;
  }

  return { ordersChannelId, paymentsChannelId };
}

/**
 * Run the retail reconciliation engine on persisted transactions for the given window.
 */
async function runReconciliationOnPersistedData(
  db: Db,
  organizationId: number,
  ordersChannelId: number,
  paymentsChannelId: number,
  from: Date,
  to: Date,
  currency: string,
): Promise<{ matchedCount: number; exceptionCount: number }> {
  // Fetch persisted transactions for the window
  const sourceRows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.channelId, ordersChannelId),
        eq(transactions.status, "unmatched"),
        gte(transactions.transactionDate, from),
        lte(transactions.transactionDate, to),
      ),
    );

  const targetRows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.channelId, paymentsChannelId),
        eq(transactions.status, "unmatched"),
        gte(transactions.transactionDate, from),
        lte(transactions.transactionDate, to),
      ),
    );

  if (sourceRows.length === 0 && targetRows.length === 0) {
    return { matchedCount: 0, exceptionCount: 0 };
  }

  // Run the retail reconciliation engine
  const config: RetailReconciliationConfig = {
    amountTolerance: 0.005, // 0.5% tolerance
    dateWindowDays: 3,
    settlementCurrency: currency,
    chargebackDetection: true,
    fxMarkupTolerance: 0.03,
  };

  const result = runRetailReconciliation(
    sourceRows as Transaction[],
    targetRows as Transaction[],
    config,
  );

  // Persist matched pairs — update transaction status
  for (const match of result.matches) {
    await db
      .update(transactions)
      .set({ status: "matched", matchId: match.targetId })
      .where(eq(transactions.id, match.sourceId));
    await db
      .update(transactions)
      .set({ status: "matched", matchId: match.sourceId })
      .where(eq(transactions.id, match.targetId));
  }

  // Persist exceptions
  // The exceptions table requires a jobId — we use 0 as a synthetic job since
  // SHOPLINE sync runs inline (no reconciliation job). `category` is the coarse
  // core enum (for list filters/reports); the PRECISE retail category is stored
  // in `subCategory` so the exception intelligence flywheel learns on it (both
  // the intra-org agentMemory recall and the cross-org shared pool key on it).
  if (result.retailExceptions.length > 0) {
    const { mapRetailToCoreCategory } = await import("./retailIntelligence");

    const exceptionRows = result.retailExceptions.map((ex) => ({
      jobId: 0, // synthetic — no reconciliation job for inline sync
      transactionId: ex.transactionId,
      category: mapRetailToCoreCategory(ex.category),
      subCategory: ex.category, // precise retail_* key — feeds the flywheel
      severity: ex.severity,
      description: `[${ex.category}] ${ex.description}`,
      suggestedResolution: ex.suggestedResolution,
      status: "open" as const,
      currency,
    }));
    await insertExceptionsBatch(exceptionRows);
  }

  return {
    matchedCount: result.matches.length,
    exceptionCount: result.retailExceptions.length,
  };
}

function errorReport(
  opts: SyncOptions,
  error: string,
  startedAt: number,
  storeHandle = "",
): SyncReport {
  return {
    success: false,
    organizationId: opts.organizationId,
    storeHandle,
    window: {
      from: opts.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: opts.to ?? new Date(),
    },
    ordersIngested: 0,
    paymentsIngested: 0,
    payoutsIngested: 0,
    totalPersisted: 0,
    matchedCount: 0,
    exceptionCount: 0,
    durationMs: Date.now() - startedAt,
    error,
  };
}
