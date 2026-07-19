/**
 * SHOPLINE Scheduled Sync Handlers
 *
 * Three handlers mounted at /api/scheduled/*:
 *   1. shoplineSyncCycle — 15-min polling fallback (incremental)
 *   2. shoplineDailyBatch — daily full 24h reconciliation
 *   3. shoplineWebhookReconciler — daily webhook subscription health check
 *
 * All handlers follow the existing syncAuthorized(req) pattern.
 */
import type { Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { slConnectorStores } from "../../../drizzle/connector_schema";
import { runSyncCycle, type SyncReport } from "./syncOrchestrator";
import { listWebhooks, registerWebhook, type ShoplineApiOptions } from "./apiClient";
import { getValidToken } from "./tokenStore";
import { SHOPLINE_WEBHOOK_TOPICS } from "../../../shared/shoplineConstants";
import { ENV } from "../../_core/env";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface StoreRow {
  id: number;
  organizationId: number;
  storeHandle: string;
  storeId: string;
  currency: string | null;
  apiVersion: string;
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
    })
    .from(slConnectorStores)
    .where(eq(slConnectorStores.status, "active"));
}

async function updateLastSyncAt(storeId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(slConnectorStores)
    .set({ lastSyncAt: new Date() })
    .where(eq(slConnectorStores.id, storeId));
}

// ─── 1. Incremental Sync (15-min polling fallback) ───────────────────────────

export async function handleShoplineSyncCycle(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const stores = await getActiveStores();
    if (stores.length === 0) {
      res.json({ ok: true, skipped: "no_active_stores", durationMs: Date.now() - startedAt });
      return;
    }

    const reports: SyncReport[] = [];
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    const now = new Date();

    for (const store of stores) {
      try {
        const report = await runSyncCycle({
          organizationId: store.organizationId,
          slStoreId: store.id,
          from: fifteenMinAgo,
          to: now,
          triggeredBy: 0, // system
        });
        reports.push(report);
        if (report.success) {
          await updateLastSyncAt(store.id);
        }
      } catch (err) {
        reports.push({
          success: false,
          organizationId: store.organizationId,
          storeHandle: store.storeHandle,
          window: { from: fifteenMinAgo, to: now },
          ordersIngested: 0,
          paymentsIngested: 0,
          payoutsIngested: 0,
          totalPersisted: 0,
          matchedCount: 0,
          exceptionCount: 0,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successCount = reports.filter((r) => r.success).length;
    const failCount = reports.filter((r) => !r.success).length;

    res.json({
      ok: true,
      storesProcessed: stores.length,
      successCount,
      failCount,
      totalOrders: reports.reduce((sum, r) => sum + r.ordersIngested, 0),
      totalPayments: reports.reduce((sum, r) => sum + r.paymentsIngested, 0),
      totalPayouts: reports.reduce((sum, r) => sum + r.payoutsIngested, 0),
      totalExceptions: reports.reduce((sum, r) => sum + r.exceptionCount, 0),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[shoplineSyncCycle] fatal error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── 2. Daily Batch Sync (full 24h window) ──────────────────────────────────

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
        reports.push(report);
        if (report.success) {
          await updateLastSyncAt(store.id);
        }
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
          error: err instanceof Error ? err.message : String(err),
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
      durationMs: Date.now() - startedAt,
      reports: reports.map((r) => ({
        store: r.storeHandle,
        success: r.success,
        matched: r.matchedCount,
        exceptions: r.exceptionCount,
        error: r.error,
      })),
    });
  } catch (err) {
    console.error("[shoplineDailyBatch] fatal error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
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
        const requiredTopics = SHOPLINE_WEBHOOK_TOPICS;
        const missing = requiredTopics.filter((t) => !existingTopics.has(t));
        result.missingTopics = missing;

        // Re-register missing webhooks
        for (const topic of missing) {
          try {
            await registerWebhook(apiOpts, topic, webhookCallbackUrl);
            result.registeredCount++;
          } catch (regErr) {
            result.errors.push(
              `Failed to register ${topic}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
            );
          }
        }
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
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
    console.error("[shoplineWebhookReconciler] fatal error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
