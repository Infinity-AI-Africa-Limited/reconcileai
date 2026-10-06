/**
 * The scheduled order sync: the backstop behind Shopify's webhooks.
 *
 * Shopify does not guarantee delivery, and an order webhook is admitted only
 * onto the durable queue. With no Redis the queue refuses, the webhook is
 * answered 503, and until this loop nothing ever synced that order. So this is
 * not a nicety: without Redis it is the only automatic order sync there is.
 *
 * Every tick syncs the stores that have not synced successfully within the
 * interval, a bounded number per tick, one store at a time — the ones whose
 * turn came LEAST recently. Each attempt is recorded on the store's sync cursor
 * before it runs, so a store that keeps failing goes to the back of the line
 * like any other instead of holding its place: ordered by last success, a
 * batch's worth of never-synced or broken stores would be picked every tick
 * and the healthy stores behind them never reached.
 * The sync itself is incremental from the store's watermark, takes the store's
 * row lock, and refuses a store fenced for redaction, so a tick that overlaps a
 * webhook-triggered sync, or runs on several instances at once, serialises on
 * the lock and finds nothing left to do — wasteful at worst, never wrong.
 */
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { organizations } from "../../../drizzle/schema";
import { shopifyConnectorStores, shopifySyncCursors } from "../../../drizzle/shopify_schema";
import { ENV } from "../../_core/env";
import { getDb, type DbExecutor } from "../../db";
import { loggableError } from "../../dbErrors";
import { singleFlight } from "../../singleFlight";
import { runShopifyOrderSyncToNow } from "./syncOrchestrator";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS = 15 * 60_000;

/**
 * Stores synced per tick. Least-recently-attempted first, so with more eligible
 * stores than this every store is still reached, once per ceil(stores / batch)
 * ticks, however many of them keep failing.
 */
export const SHOPIFY_ORDER_BACKSTOP_BATCH = 25;

/**
 * Time one tick may spend catching stores up, shared among the stores it
 * picked. Stores are synced one at a time, so a store with a long backlog — a
 * large shop's 60-day first read, or one Shopify is throttling — would
 * otherwise hold every store behind it. Each store is given the time left
 * divided by the stores left: a lone store may use the whole tick, a full batch
 * gets an equal share each, and time a store leaves unused passes to the next.
 * Two-thirds of the interval, leaving headroom for the cycle each store may
 * finish past its share. A store still behind resumes on its next turn, from
 * its committed watermark.
 */
export const SHOPIFY_ORDER_BACKSTOP_TICK_BUDGET_MS = (SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS * 2) / 3;

export interface ShopifyOrderBackstopReport {
  scanned: number;
  synced: number;
  failed: number;
}

export interface ShopifyOrderBackstopDeps {
  db?: Db;
  now?: () => Date;
  sync?: (
    params: { storeId: number; organizationId: number; trigger: "backstop" },
    options: { budgetMs: number },
  ) => Promise<unknown>;
  batchSize?: number;
  intervalMs?: number;
  tickBudgetMs?: number;
}

/** One tick. Never throws: a failure is logged by its code and the next tick tries again. */
export async function runShopifyOrderBackstop(deps: ShopifyOrderBackstopDeps = {}): Promise<ShopifyOrderBackstopReport> {
  const report: ShopifyOrderBackstopReport = { scanned: 0, synced: 0, failed: 0 };
  let stores: Array<{ storeId: number; organizationId: number }>;
  let db: Db | null;
  try {
    db = deps.db ?? (await getDb());
    if (!db) throw new Error("Database unavailable");
    const now = (deps.now ?? (() => new Date()))();
    const staleBefore = new Date(now.getTime() - (deps.intervalMs ?? SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS));
    stores = await db
      .select({ storeId: shopifyConnectorStores.id, organizationId: shopifyConnectorStores.organizationId })
      .from(shopifyConnectorStores)
      .innerJoin(organizations, eq(organizations.id, shopifyConnectorStores.organizationId))
      .leftJoin(
        shopifySyncCursors,
        and(
          eq(shopifySyncCursors.storeId, shopifyConnectorStores.id),
          eq(shopifySyncCursors.organizationId, shopifyConnectorStores.organizationId),
          eq(shopifySyncCursors.resource, "orders"),
        ),
      )
      .where(
        and(
          // Exactly the stores a sync would accept: active, and neither the
          // tenant nor the store fenced for redaction.
          eq(shopifyConnectorStores.status, "active"),
          eq(shopifyConnectorStores.privacyRedactionState, "active"),
          eq(organizations.deletionState, "active"),
          // Not synced successfully within the interval, by any trigger.
          or(isNull(shopifySyncCursors.lastSuccessfulAt), lte(shopifySyncCursors.lastSuccessfulAt, staleBefore)),
        ),
      )
      // Whose turn came least recently. `updatedAt` moves on every attempt (see
      // recordShopifyBackstopAttempt) and on every cursor write; a store with no cursor yet
      // sorts first, as MySQL puts NULL first ascending.
      .orderBy(asc(shopifySyncCursors.updatedAt), asc(shopifyConnectorStores.id))
      .limit(deps.batchSize ?? SHOPIFY_ORDER_BACKSTOP_BATCH);
  } catch (error) {
    console.error("[shopify-backstop] order sync backstop unavailable", {
      code: "shopify_backstop_unavailable",
      ...loggableError(error),
    });
    return report;
  }

  // To NOW, not one cycle: a cycle reads at most one 7-day window, so a newly
  // installed store (60 days to read) or one behind after an outage would
  // advance a week per tick — about nine ticks, over two hours at 15 minutes,
  // before its recent orders appear. Without Redis this loop is the only
  // automatic sync, so that delay was the merchant's whole first experience.
  // Within a share of the tick's time, so one store's backlog cannot starve the rest.
  const sync = deps.sync ?? runShopifyOrderSyncToNow;
  const clock = deps.now ?? (() => new Date());
  const tickEndsAt = clock().getTime() + (deps.tickBudgetMs ?? SHOPIFY_ORDER_BACKSTOP_TICK_BUDGET_MS);
  for (const [index, store] of stores.entries()) {
    report.scanned += 1;
    try {
      await recordShopifyBackstopAttempt(db, store);
      // The time left, shared among the stores left.
      const budgetMs = Math.max(0, Math.floor((tickEndsAt - clock().getTime()) / (stores.length - index)));
      await sync({ storeId: store.storeId, organizationId: store.organizationId, trigger: "backstop" }, { budgetMs });
      report.synced += 1;
    } catch (error) {
      // One store's failure never stops the rest; the sync has already recorded
      // its error code on the store's cursor for the merchant dashboard.
      report.failed += 1;
      console.error("[shopify-backstop] store order sync failed", {
        code: "shopify_backstop_store_failed",
        storeId: store.storeId,
        organizationId: store.organizationId,
        ...loggableError(error),
      });
    }
  }
  if (report.scanned > 0) {
    console.log("[shopify-backstop] order sync backstop ran", { code: "shopify_backstop_completed", ...report });
  }
  return report;
}

/**
 * Mark the store's turn as taken, before its sync runs. Written on the database
 * clock, like the column's own ON UPDATE, so the ordering compares like with
 * like. Explicit because ON UPDATE fires only when a value changes, and a store
 * failing the same way every time changes nothing. Creates the cursor for a
 * store that has none; a cursor with no watermark syncs exactly as no cursor,
 * and the next success sets it (advancedOrderWatermark never keeps a NULL).
 */
export async function recordShopifyBackstopAttempt(
  db: DbExecutor | null,
  store: { storeId: number; organizationId: number },
): Promise<void> {
  if (!db) throw new Error("Database unavailable");
  await db
    .insert(shopifySyncCursors)
    .values({ storeId: store.storeId, organizationId: store.organizationId, resource: "orders" })
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`CURRENT_TIMESTAMP` } });
}

let backstopTimer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the backstop once per process. Returns whether it is running.
 *
 * Not started without Shopify app credentials: no store can have been installed,
 * and every sync would fail refreshing its token. The first tick waits a jittered
 * minute or two, so a deploy is not met by a burst of syncs and several
 * instances do not tick in step.
 */
export function startShopifyOrderBackstopLoop(
  options: { intervalMs?: number; firstDelayMs?: number; run?: () => Promise<unknown> } = {},
): boolean {
  if (backstopTimer || firstRun) return true;
  if (!ENV.shopifyClientId || !ENV.shopifyClientSecret) {
    console.log("[shopify-backstop] not started: Shopify app credentials are not configured", {
      code: "shopify_backstop_disabled",
    });
    return false;
  }
  const intervalMs = options.intervalMs ?? SHOPIFY_ORDER_BACKSTOP_INTERVAL_MS;
  const tick = singleFlight(async () => {
    await (options.run ?? (() => runShopifyOrderBackstop({ intervalMs })))();
  });
  firstRun = setTimeout(() => {
    firstRun = null;
    void tick();
    backstopTimer = setInterval(() => void tick(), intervalMs);
    backstopTimer.unref?.();
  }, options.firstDelayMs ?? 60_000 + Math.floor(Math.random() * 60_000));
  firstRun.unref?.();
  return true;
}

/** Test-only: stop the loop so a suite can start it again. */
export function stopShopifyOrderBackstopLoop(): void {
  if (firstRun) clearTimeout(firstRun);
  if (backstopTimer) clearInterval(backstopTimer);
  firstRun = null;
  backstopTimer = null;
}
