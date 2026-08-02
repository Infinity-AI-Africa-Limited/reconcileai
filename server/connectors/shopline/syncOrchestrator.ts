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
import { insertTransactions, createUploadBatch, updateUploadBatch, insertExceptionsBatch } from "../../db";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { transactions, channels } from "../../../drizzle/schema";
import { getValidToken } from "./tokenStore";
import {
  fetchOrders,
  fetchPaymentTransactions,
  fetchPayouts,
  ShoplineApiError,
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
  /**
   * Optional legs that were skipped because the store does not have them —
   * e.g. `["payments","payouts"]` for a store not on SHOPLINE Payments. The
   * sync still succeeds; this records that its coverage was partial.
   */
  degradedLegs?: string[];
}

/**
 * Run a full sync cycle for a single SHOPLINE store, recording the outcome on
 * the store row.
 *
 * The outcome write is what makes a failed sync observable: previously a
 * failure returned a report that only the caller logged, so `lastSyncAt`
 * remaining NULL could mean either "the trigger never fired" or "it fired and
 * threw" — indistinguishable without the host's log stream.
 */
export async function runSyncCycle(opts: SyncOptions): Promise<SyncReport> {
  const report = await runSyncCycleInner(opts);
  await persistSyncOutcome(opts.slStoreId, report);
  return report;
}

/**
 * Record the attempt on the store row. Never throws — callers are on the
 * webhook/cron path and a bookkeeping failure must not mask the real result.
 */
async function persistSyncOutcome(slStoreId: number, report: SyncReport): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const now = new Date();
    await db
      .update(slConnectorStores)
      .set(
        report.success
          ? { lastSyncAt: now, lastSyncAttemptAt: now, lastSyncError: null }
          : { lastSyncAttemptAt: now, lastSyncError: (report.error ?? "unknown error").slice(0, 2000) },
      )
      .where(eq(slConnectorStores.id, slStoreId));
  } catch (err) {
    console.error(`[SHOPLINE] Failed to record sync outcome for store=${slStoreId}:`, err);
  }
}

/**
 * Run one optional SHOPLINE Payments leg, tolerating a store that simply does
 * not have that product.
 *
 * Only 404 is treated as "unavailable" — that is SHOPLINE's answer for a store
 * with no Payments merchant record. Every other failure (401, 429, 5xx) still
 * throws, so a genuine outage or a broken request is never silently swallowed
 * into a green sync.
 */
export async function bestEffortLeg<T>(
  leg: "payments" | "payouts",
  storeHandle: string,
  fetcher: () => Promise<T[]>,
): Promise<{ data: T[]; unavailable: boolean }> {
  try {
    return { data: await fetcher(), unavailable: false };
  } catch (err) {
    if (err instanceof ShoplineApiError && err.status === 404) {
      console.warn(
        `[SHOPLINE] ${leg} unavailable for store=${storeHandle} (404 — store is probably not on SHOPLINE Payments); continuing with orders only`,
      );
      return { data: [], unavailable: true };
    }
    throw err;
  }
}

async function runSyncCycleInner(opts: SyncOptions): Promise<SyncReport> {
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
    //
    // Orders are mandatory — they are the merchant's own sales data and every
    // store has them. A failure here is a real failure.
    const orders = await fetchAllOrders(apiOpts, fromIso, toIso);

    // Payments and payouts come from the SHOPLINE **Payments** product
    // (`/payments/store/*`), which a store only has if it is onboarded onto
    // SHOPLINE Payments. Stores using an external gateway — and every blank
    // dev store — answer 404 `Resource not found: merchant`.
    //
    // These legs are therefore BEST-EFFORT. Previously a 404 here aborted the
    // whole cycle before the upload batch was even created, so orders were
    // never persisted and `lastSyncAt` never advanced: any merchant not on
    // SHOPLINE Payments got a permanently empty dashboard. Degrade instead,
    // and report it, so order-level reconciliation still runs.
    const payments = await bestEffortLeg("payments", storeHandle, () =>
      fetchAllPayments(apiOpts, fromIso, toIso),
    );
    const payouts = await bestEffortLeg("payouts", storeHandle, () =>
      fetchAllPayouts(apiOpts, fromIso, toIso),
    );
    const degraded = [
      ...(payments.unavailable ? ["payments"] : []),
      ...(payouts.unavailable ? ["payouts"] : []),
    ];

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
      totalRows: orders.length + payments.data.length + payouts.data.length,
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
    const paymentRows = payments.data.map((p) => normalisePaymentTransaction(p, ctx));
    const payoutRows = payouts.data.map((p) => normalisePayout(p, ctx));

    const allRows = [...orderRows, ...paymentRows, ...payoutRows];
    if (allRows.length > 0) {
      await insertTransactions(allRows);
    }

    // Close the batch out. Without this it sat at "processing" forever, so the
    // upload history showed every SHOPLINE sync as permanently in-flight.
    await updateUploadBatch(batchId, {
      status: "completed",
      validRows: allRows.length,
      invalidRows: 0,
      completedAt: new Date(),
    });

    // ── Step 5: Run reconciliation ──────────────────────────────────────────
    //
    // Reconciliation needs BOTH legs. When the payments feed is unavailable
    // (store not on SHOPLINE Payments — see bestEffortLeg above), the target
    // side is empty, and the engine's only guard is
    // `sourceRows.length === 0 && targetRows.length === 0` — an AND — so it
    // would happily match every order against nothing and raise one
    // high-severity "No matching transaction found" exception per order.
    //
    // That claim is also simply untrue: the payment was never *fetched*, so we
    // cannot say it was not *found*. For a merchant on an external gateway
    // that is an alert storm across their entire order book. Ingest the orders
    // so the merchant still sees their sales data, and skip the match.
    let matchedCount = 0;
    let exceptionCount = 0;
    const reconciliationSkipped = payments.unavailable;

    if (reconciliationSkipped) {
      console.info(
        `[SHOPLINE] Reconciliation skipped for store=${storeHandle} — payments feed unavailable; ingested ${allRows.length} row(s) only`,
      );
    } else if (!opts.ingestOnly && allRows.length > 0) {
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

    // Step 6 (lastSyncAt) is handled by persistSyncOutcome in the runSyncCycle
    // wrapper, so success and failure are recorded through one path.
    return {
      success: true,
      organizationId: opts.organizationId,
      storeHandle,
      window: { from, to },
      ordersIngested: orders.length,
      paymentsIngested: payments.data.length,
      payoutsIngested: payouts.data.length,
      totalPersisted: allRows.length,
      matchedCount,
      exceptionCount,
      durationMs: Date.now() - startedAt,
      ...(degraded.length > 0 ? { degradedLegs: degraded } : {}),
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

// ─── Historical backfill (first install) ────────────────────────────────────

/** How far back the first-install backfill reaches. */
export const SHOPLINE_BACKFILL_DAYS = 90;

/**
 * Pull the merchant's recent history on first install so the dashboard has
 * real reconciliation results within minutes instead of staying empty until
 * the first scheduled sync.
 *
 * Windowing matters: SHOPLINE caps payout queries at a 3-month range and
 * payment-transaction queries at 6 months, and per-store rate limits apply.
 * The backfill therefore runs in sequential 30-day slices (oldest first) so
 * every slice is comfortably inside those caps, and a failure in one slice
 * doesn't lose the others.
 *
 * Designed to be fire-and-forget from the OAuth callback: it never throws,
 * and returns a per-slice summary for logging.
 */
export async function runHistoricalBackfill(opts: {
  organizationId: number;
  slStoreId: number;
  days?: number;
  triggeredBy?: number;
}): Promise<{ slices: number; ordersIngested: number; exceptionCount: number; errors: string[] }> {
  const days = opts.days ?? SHOPLINE_BACKFILL_DAYS;
  const sliceDays = 30;
  const now = new Date();
  const errors: string[] = [];
  let ordersIngested = 0;
  let exceptionCount = 0;
  let slices = 0;

  for (let offset = days; offset > 0; offset -= sliceDays) {
    const from = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() - Math.max(offset - sliceDays, 0) * 24 * 60 * 60 * 1000);
    slices++;
    try {
      const report = await runSyncCycle({
        organizationId: opts.organizationId,
        slStoreId: opts.slStoreId,
        from,
        to,
        triggeredBy: opts.triggeredBy ?? 0,
      });
      if (report.error) {
        errors.push(`${from.toISOString().slice(0, 10)}: ${report.error}`);
      } else {
        ordersIngested += report.ordersIngested;
        exceptionCount += report.exceptionCount;
      }
    } catch (err) {
      errors.push(`${from.toISOString().slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.info(
    `[SHOPLINE Backfill] store=${opts.slStoreId} ${days}d in ${slices} slices — ${ordersIngested} orders, ${exceptionCount} exceptions, ${errors.length} slice error(s)`,
  );
  return { slices, ordersIngested, exceptionCount, errors };
}
