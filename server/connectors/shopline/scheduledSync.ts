/**
 * SHOPLINE Scheduled Sync Handlers
 *
 * Three handlers mounted at /api/scheduled/*:
 *   1. shoplineSyncCycle — 15-min polling fallback: catches each store up from
 *      its watermark, walking a long gap forward a day at a time
 *   2. shoplineDailyBatch — daily re-read of the last 24h
 *   3. shoplineWebhookReconciler — daily webhook subscription health check
 *
 * All handlers follow the existing syncAuthorized(req) pattern.
 */
import type { Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { rewindCatchUp, runSyncCycle, SHOPLINE_BACKFILL_DAYS, type SyncReport } from "./syncOrchestrator";
import { listWebhooks, registerWebhook, type ShoplineApiOptions } from "./apiClient";
import { getValidToken } from "./tokenStore";
import { replayStalledWebhookEvents, type WebhookReplaySummary } from "./webhookHandler";
import {
  SHOPLINE_BILLING_WEBHOOK_TOPICS,
  SHOPLINE_WEBHOOK_TOPICS,
} from "../../../shared/shoplineConstants";
import { ENV } from "../../_core/env";
import { loggableError } from "../../dbErrors";
import { stackFrames, errorSummary } from "../../errorText";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface StoreRow {
  id: number;
  organizationId: number;
  storeHandle: string;
  storeId: string;
  currency: string | null;
  apiVersion: string;
  /** The catch-up watermark: everything up to it has been fetched. NULL = never synced. */
  syncedThroughAt: Date | null;
}

async function getActiveStores(): Promise<StoreRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: slConnectorStores.id,
      organizationId: slConnectorStores.organizationId,
      storeHandle: slConnectorStores.storeHandle,
      storeId: slConnectorStores.storeId,
      currency: slConnectorStores.currency,
      apiVersion: slConnectorStores.apiVersion,
      syncedThroughAt: slConnectorStores.syncedThroughAt,
    })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.status, "active"));
}

/** Re-fetch this much before the watermark, so a record that landed mid-cycle
 *  isn't missed at the seam. Every step of a walk overlaps the last by it too. */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

/**
 * The most ONE catch-up step reads. It bounds the paginated SHOPLINE calls a
 * single sync cycle makes (per-store leaky bucket: burst 40, drain 4 req/s).
 *
 * It does NOT bound how far back the catch-up reaches. Until 2026-10-27 it did:
 * the poll clamped its window to the last 24 hours, and the comment here said
 * "the daily batch covers anything older". The daily batch reads the last 24
 * hours too. So everything older than a day at the end of an outage was never
 * fetched.
 */
export const CATCH_UP_STEP_MS = 24 * 60 * 60 * 1000;

/**
 * A poll takes a store's further steps only while it has run for less than
 * this.
 *
 * Every store's FIRST step always runs. That is all a poll did before, so the
 * budget only decides how much extra catching up fits into one poll.
 *
 * It keeps the response well inside the 100-second limit of the proxy in front
 * of production (CLAUDE.md §12). A poll cut off there still finishes on the
 * server, but its caller is told it failed.
 *
 * A step reads a day and polls run hours apart at worst. So even one step per
 * poll closes a gap faster than the gap grows.
 */
export const CATCH_UP_TIME_BUDGET_MS = 60 * 1000;

/**
 * How far back a catch-up step reconciles, and how much of a step's end it
 * holds back for the step after it. It is the same 24 hours the realtime sync
 * and daily batch give a pair in normal operation.
 *
 * A step fetches only its own window, so an order fetched near a step's end may
 * meet its payment only in the next step. Without this the two never shared a
 * reconciliation (Greptile, #209). The order was raised as unmatched in one
 * step and its payment in the next, and the walk still reported itself caught
 * up.
 *
 * So:
 * - every step reconciles against the day before its own window;
 * - every step but the last raises no exception for an order in its final day,
 *   and the next step judges it with its payment in view.
 */
export const CATCH_UP_RECONCILE_LOOKBACK_MS = CATCH_UP_STEP_MS;

/**
 * How a catch-up step reconciles (see CATCH_UP_RECONCILE_LOOKBACK_MS).
 *
 * Every step, the last included, reaches back a day, because it is the one
 * that judges what the step before it held back. That holds across polls too:
 * a walk cut short leaves the next poll's first step to judge them.
 *
 * Every step but the one ending at now holds its own last day's orders back.
 */
export function stepReconcileOptions(
  window: { from: Date; to: Date },
  now: Date,
): { reconcileFrom: Date; holdOrdersFrom?: Date } {
  const reconcileFrom = new Date(window.from.getTime() - CATCH_UP_RECONCILE_LOOKBACK_MS);
  if (window.to.getTime() >= now.getTime()) return { reconcileFrom };
  return { reconcileFrom, holdOrdersFrom: new Date(window.to.getTime() - CATCH_UP_RECONCILE_LOOKBACK_MS) };
}

/**
 * The next window the poll reads for a store: from its watermark, less the
 * seam overlap, forward by at most one step, ending no later than now. The poll
 * calls it again with the advanced watermark until a step ends at now.
 *
 * A store that has never synced reads the last step's worth; history before
 * install is the install backfill's job (`runHistoricalBackfill`).
 *
 * This replaced a fixed "last 15 minutes", which could not do the poll's one
 * job: a webhook sync lost and a poll one minute late left the record outside
 * every later window.
 */
export function catchUpStep(syncedThroughAt: Date | null, now: Date): { from: Date; to: Date } {
  if (!syncedThroughAt) return { from: new Date(now.getTime() - CATCH_UP_STEP_MS), to: now };
  // A watermark ahead of this clock (another instance's skew) reads as current.
  const start = Math.min(syncedThroughAt.getTime(), now.getTime()) - WATERMARK_OVERLAP_MS;
  return { from: new Date(start), to: new Date(Math.min(start + CATCH_UP_STEP_MS, now.getTime())) };
}

interface StoreCatchUp {
  /** The whole walk as one report: first step's start to last step's end, counts summed. */
  report: SyncReport;
  steps: number;
  /** The walk reached now. False when a step failed or the poll's budget ran out. */
  caughtUp: boolean;
}

/**
 * Walk one store forward from its watermark to `now`, a step at a time.
 *
 * Each step is a full sync cycle, and its outcome (including the advanced
 * watermark) is written to the store row by `runSyncCycle` before the next step
 * starts. So a walk cut short by a failure or by the budget resumes on the next
 * poll from the last step that succeeded.
 *
 * Consecutive steps overlap by the seam, exactly as consecutive polls always
 * have. A pair split across a step boundary is therefore treated no differently
 * from one split across two polls.
 */
async function catchUpStore(store: StoreRow, now: Date, pollStartedAt: number): Promise<StoreCatchUp> {
  let watermark = store.syncedThroughAt;
  const steps: SyncReport[] = [];
  for (;;) {
    const window = catchUpStep(watermark, now);
    const stepStartedAt = Date.now();
    let step: SyncReport;
    try {
      step = await runSyncCycle({
        organizationId: store.organizationId,
        slStoreId: store.id,
        from: window.from,
        to: window.to,
        triggeredBy: 0, // system
        ...stepReconcileOptions(window, now),
      });
    } catch (err) {
      step = {
        success: false,
        organizationId: store.organizationId,
        storeHandle: store.storeHandle,
        window,
        ordersIngested: 0,
        paymentsIngested: 0,
        payoutsIngested: 0,
        totalPersisted: 0,
        matchedCount: 0,
        exceptionCount: 0,
        // This step's own time: the walk's total is the sum of its steps.
        durationMs: Date.now() - stepStartedAt,
        error: errorSummary(err),
      };
    }
    steps.push(step);
    if (!step.success) break;
    watermark = window.to;
    if (window.to.getTime() >= now.getTime()) break;
    if (Date.now() - pollStartedAt >= CATCH_UP_TIME_BUDGET_MS) break;
  }

  const last = steps[steps.length - 1];
  const sum = (pick: (r: SyncReport) => number) => steps.reduce((total, r) => total + pick(r), 0);
  const degradedLegs = [...new Set(steps.flatMap((r) => r.degradedLegs ?? []))];
  return {
    report: {
      success: last.success,
      organizationId: store.organizationId,
      storeHandle: store.storeHandle,
      window: { from: steps[0].window.from, to: last.window.to },
      ordersIngested: sum((r) => r.ordersIngested),
      paymentsIngested: sum((r) => r.paymentsIngested),
      payoutsIngested: sum((r) => r.payoutsIngested),
      totalPersisted: sum((r) => r.totalPersisted),
      matchedCount: sum((r) => r.matchedCount),
      exceptionCount: sum((r) => r.exceptionCount),
      durationMs: sum((r) => r.durationMs),
      undatedRowsSkipped: sum((r) => r.undatedRowsSkipped ?? 0),
      ...(degradedLegs.length > 0 ? { degradedLegs } : {}),
      ...(last.error ? { error: last.error } : {}),
    },
    steps: steps.length,
    caughtUp: last.success && last.window.to.getTime() >= now.getTime(),
  };
}

// ─── 1. Incremental Sync (15-min polling fallback) ───────────────────────────

/** `YYYY-MM-DDTHH:MM[:SS[.mmm]]Z` — UTC only, so no offset can be misread. */
const CATCH_UP_FROM_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;

/**
 * Read an operator's `catchUpFrom` instruction: re-read every active store
 * from this instant (see `rewindCatchUp`).
 *
 * It is refused, never clamped, when it is malformed, in the future, or further
 * back than the install backfill reaches (`SHOPLINE_BACKFILL_DAYS`). Clamping
 * would re-read a different period than the one the operator asked for, and
 * report it as done.
 */
export function parseCatchUpFrom(
  raw: unknown,
  now: Date,
): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true, value: null };
  const fields = typeof raw === "string" ? CATCH_UP_FROM_PATTERN.exec(raw) : null;
  if (!fields) {
    return { ok: false, error: "catchUpFrom must be a UTC timestamp such as 2026-10-26T02:00:00Z" };
  }
  // `new Date` does not refuse an impossible date; it rolls it over. 2026-09-31
  // becomes 1 October and 24:00 becomes the next day, so the operator would be
  // told it worked for a date they never asked for. Every field must survive the
  // round trip.
  const value = new Date(raw as string);
  const [, year, month, day, hour, minute, second] = fields.map(Number);
  const real =
    !Number.isNaN(value.getTime()) &&
    value.getUTCFullYear() === year &&
    value.getUTCMonth() + 1 === month &&
    value.getUTCDate() === day &&
    value.getUTCHours() === hour &&
    value.getUTCMinutes() === minute &&
    (fields[6] === undefined || value.getUTCSeconds() === second);
  if (!real) return { ok: false, error: "catchUpFrom is not a real date" };
  if (value.getTime() >= now.getTime()) return { ok: false, error: "catchUpFrom must be in the past" };
  const earliest = now.getTime() - SHOPLINE_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  if (value.getTime() < earliest) {
    return { ok: false, error: `catchUpFrom must be within the last ${SHOPLINE_BACKFILL_DAYS} days` };
  }
  return { ok: true, value };
}

export async function handleShoplineSyncCycle(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  // Refused before anything runs, so a typo is an error the operator sees rather
  // than a poll that quietly did something else.
  const catchUpFrom = parseCatchUpFrom(req.query?.catchUpFrom, new Date());
  if (!catchUpFrom.ok) {
    res.status(400).json({ error: catchUpFrom.error });
    return;
  }
  try {
    // Drain any webhook the receiver admitted but never finished, BEFORE the
    // polling pass. The receiver stores a delivery then acknowledges, so a
    // process restart between the two leaves the row `pending` and a throw
    // leaves it `failed` — and SHOPLINE will not redeliver after a 2xx, so this
    // is the only thing that comes back for them.
    //
    // Deliberately inside the existing 15-minute cycle rather than on its own
    // schedule: a recovery path gated on someone remembering to configure a
    // cron is a recovery path that is not there.
    let replay: WebhookReplaySummary | null = null;
    const replayDb = await getDb();
    if (replayDb) {
      try {
        replay = await replayStalledWebhookEvents(replayDb);
        if (replay.examined > 0) {
          console.log(
            `[shoplineSyncCycle] webhook replay: examined=${replay.examined} processed=${replay.processed} failed=${replay.failed} dlq=${replay.movedToDlq}`,
          );
        }
      } catch (err) {
        // Recovery failing must not take the polling pass down with it.
        console.error("[shoplineSyncCycle] webhook replay failed:", loggableError(err));
      }
    }

    // An operator pointing the poll back at an earlier instant. This is the
    // recovery for a gap that older code wrote past (rewindCatchUp). Done here,
    // before the stores are read, so this very poll starts walking from there.
    let rewind: { to: string; storesRewound: number } | null = null;
    if (catchUpFrom.value) {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable — catchUpFrom was not applied");
      const storesRewound = await rewindCatchUp(db, catchUpFrom.value);
      rewind = { to: catchUpFrom.value.toISOString(), storesRewound };
      console.warn(
        `[shoplineSyncCycle] catch-up rewound to ${rewind.to} for ${storesRewound} store(s) on an operator's instruction`,
      );
    }

    const stores = await getActiveStores();
    if (stores.length === 0) {
      res.json({ ok: true, skipped: "no_active_stores", webhookReplay: replay, catchUpRewind: rewind, durationMs: Date.now() - startedAt });
      return;
    }

    const now = new Date();
    const walks: StoreCatchUp[] = [];
    for (const store of stores) {
      // Each store catches up from its own watermark.
      walks.push(await catchUpStore(store, now, startedAt));
    }
    const reports = walks.map((w) => w.report);

    const successCount = reports.filter((r) => r.success).length;
    const failCount = reports.filter((r) => !r.success).length;

    for (const walk of walks) {
      const r = walk.report;
      if (!r.success) {
        console.error(`[shoplineSyncCycle] store=${r.storeHandle} FAILED after ${walk.steps} step(s): ${r.error ?? "unknown error"}`);
      } else if (walk.steps > 1 || !walk.caughtUp) {
        // A walk longer than one step means the store had fallen behind, which
        // is worth seeing even when every step succeeded.
        console.info(
          `[shoplineSyncCycle] store=${r.storeHandle} read ${walk.steps} step(s) ` +
            `${r.window.from.toISOString()}..${r.window.to.toISOString()} caughtUp=${walk.caughtUp}`,
        );
      }
    }

    res.json({
      ok: true,
      storesProcessed: stores.length,
      successCount,
      failCount,
      caughtUpCount: walks.filter((w) => w.caughtUp).length,
      webhookReplay: replay,
      catchUpRewind: rewind,
      totalOrders: reports.reduce((sum, r) => sum + r.ordersIngested, 0),
      totalPayments: reports.reduce((sum, r) => sum + r.paymentsIngested, 0),
      totalPayouts: reports.reduce((sum, r) => sum + r.payoutsIngested, 0),
      totalExceptions: reports.reduce((sum, r) => sum + r.exceptionCount, 0),
      // Rows dropped for an unreadable transaction date. An operator running
      // this by hand must see a partial sync as partial.
      totalUndatedSkipped: reports.reduce((sum, r) => sum + (r.undatedRowsSkipped ?? 0), 0),
      durationMs: Date.now() - startedAt,
      // Per-store detail so an operator running this by hand sees WHICH store
      // failed and why, without needing the log stream or a DB query.
      reports: walks.map(({ report: r, steps, caughtUp }) => ({
        store: r.storeHandle,
        success: r.success,
        window: { from: r.window.from.toISOString(), to: r.window.to.toISOString() },
        // How many day-long steps this poll took, and whether they reached now.
        // A store still behind after a successful walk resumes next poll.
        steps,
        caughtUp,
        orders: r.ordersIngested,
        payments: r.paymentsIngested,
        payouts: r.payoutsIngested,
        matched: r.matchedCount,
        exceptions: r.exceptionCount,
        undatedSkipped: r.undatedRowsSkipped ?? 0,
        error: r.error ?? null,
        durationMs: r.durationMs,
      })),
    });
  } catch (err) {
    console.error("[shoplineSyncCycle] fatal error:", { ...loggableError(err), frames: stackFrames(err) });
    res.status(500).json({
      error: errorSummary(err),
      frames: stackFrames(err),
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── 2. Daily Batch Sync (full 24h window) ──────────────────────────────────

/**
 * Re-read the last 24 hours for every store. This picks up records SHOPLINE
 * changed after the poll first read them.
 *
 * It is NOT the catch-up for an outage. It reads the same day the poll does,
 * and nothing older. Behind a gap it also leaves the watermark where it is
 * (`recordSyncOutcome`), so it can no longer hide the gap from the poll that
 * walks it.
 */
export async function handleShoplineDailyBatch(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const stores = await getActiveStores();
    if (stores.length === 0) {
      res.json({ ok: true, skipped: "no_active_stores", durationMs: Date.now() - startedAt });
      return;
    }

    const reports: SyncReport[] = [];
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();

    for (const store of stores) {
      try {
        const report = await runSyncCycle({
          organizationId: store.organizationId,
          slStoreId: store.id,
          from: twentyFourHoursAgo,
          to: now,
          triggeredBy: 0,
        });
        // runSyncCycle records the outcome on the store row itself.
        reports.push(report);
      } catch (err) {
        reports.push({
          success: false,
          organizationId: store.organizationId,
          storeHandle: store.storeHandle,
          window: { from: twentyFourHoursAgo, to: now },
          ordersIngested: 0,
          paymentsIngested: 0,
          payoutsIngested: 0,
          totalPersisted: 0,
          matchedCount: 0,
          exceptionCount: 0,
          durationMs: Date.now() - startedAt,
          error: errorSummary(err),
        });
      }
    }

    const successCount = reports.filter((r) => r.success).length;
    const failCount = reports.filter((r) => !r.success).length;
    const totalReconciled = reports.reduce((sum, r) => sum + r.matchedCount, 0);
    const totalExceptions = reports.reduce((sum, r) => sum + r.exceptionCount, 0);

    // Log summary for owner notification
    console.log(
      `[shoplineDailyBatch] Completed: ${successCount}/${stores.length} stores OK, ` +
        `${totalReconciled} matched, ${totalExceptions} exceptions, ${Date.now() - startedAt}ms`,
    );

    res.json({
      ok: true,
      storesProcessed: stores.length,
      successCount,
      failCount,
      totalOrders: reports.reduce((sum, r) => sum + r.ordersIngested, 0),
      totalPayments: reports.reduce((sum, r) => sum + r.paymentsIngested, 0),
      totalPayouts: reports.reduce((sum, r) => sum + r.payoutsIngested, 0),
      totalReconciled,
      totalExceptions,
      totalUndatedSkipped: reports.reduce((sum, r) => sum + (r.undatedRowsSkipped ?? 0), 0),
      durationMs: Date.now() - startedAt,
      reports: reports.map((r) => ({
        store: r.storeHandle,
        success: r.success,
        matched: r.matchedCount,
        exceptions: r.exceptionCount,
        undatedSkipped: r.undatedRowsSkipped ?? 0,
        error: r.error,
      })),
    });
  } catch (err) {
    console.error("[shoplineDailyBatch] fatal error:", { ...loggableError(err), frames: stackFrames(err) });
    res.status(500).json({
      error: errorSummary(err),
      frames: stackFrames(err),
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── 3. Webhook Subscription Reconciler ─────────────────────────────────────

interface WebhookReconcileResult {
  storeHandle: string;
  existingCount: number;
  missingTopics: string[];
  registeredCount: number;
  errors: string[];
}

export async function handleShoplineWebhookReconciler(
  req: Request,
  res: Response,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    if (!db) {
      res.status(500).json({ error: "DB unavailable" });
      return;
    }

    const stores = await getActiveStores();
    if (stores.length === 0) {
      res.json({ ok: true, skipped: "no_active_stores", durationMs: Date.now() - startedAt });
      return;
    }

    const callbackBase = ENV.appUrl || req.headers.origin || "";
    const webhookCallbackUrl = `${callbackBase}/api/webhooks/shopline`;

    const results: WebhookReconcileResult[] = [];

    for (const store of stores) {
      const result: WebhookReconcileResult = {
        storeHandle: store.storeHandle,
        existingCount: 0,
        missingTopics: [],
        registeredCount: 0,
        errors: [],
      };

      try {
        // Get a valid token for this store
        const accessToken = await getValidToken(
          db,
          store.id,
          store.organizationId,
          store.storeHandle,
        );
        if (!accessToken) {
          result.errors.push("No valid token — cannot check webhooks");
          results.push(result);
          continue;
        }

        const apiOpts: ShoplineApiOptions = {
          storeHandle: store.storeHandle,
          accessToken,
        };

        // List existing webhooks
        const existing = await listWebhooks(apiOpts);
        result.existingCount = existing.length;

        // Determine which required topics are missing
        const existingTopics = new Set(existing.map((w) => w.topic));
        // Reconcile both operational settlement events and native app-plan
        // lifecycle events. Missing billing topics would leave subscription
        // access stale even when order reconciliation webhooks remain healthy.
        const requiredTopics = [...SHOPLINE_WEBHOOK_TOPICS, ...SHOPLINE_BILLING_WEBHOOK_TOPICS];
        const missing = requiredTopics.filter((t) => !existingTopics.has(t));
        result.missingTopics = missing;

        // Re-register missing webhooks
        for (const topic of missing) {
          try {
            await registerWebhook(apiOpts, topic, webhookCallbackUrl);
            result.registeredCount++;
          } catch (regErr) {
            result.errors.push(
              `Failed to register ${topic}: ${errorSummary(regErr)}`,
            );
          }
        }
      } catch (err) {
        result.errors.push(errorSummary(err));
      }

      results.push(result);
    }

    const totalMissing = results.reduce((sum, r) => sum + r.missingTopics.length, 0);
    const totalRegistered = results.reduce((sum, r) => sum + r.registeredCount, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    if (totalErrors > 0) {
      console.warn(
        `[shoplineWebhookReconciler] ${totalErrors} errors across ${stores.length} stores`,
      );
    }

    res.json({
      ok: true,
      storesChecked: stores.length,
      totalMissing,
      totalRegistered,
      totalErrors,
      durationMs: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    console.error("[shoplineWebhookReconciler] fatal error:", { ...loggableError(err), frames: stackFrames(err) });
    res.status(500).json({
      error: errorSummary(err),
      frames: stackFrames(err),
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
