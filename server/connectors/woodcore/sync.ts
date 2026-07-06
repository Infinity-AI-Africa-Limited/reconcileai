/**
 * Batch sync engine — the daily fallback to webhooks, and the gap-filler.
 *
 * Window strategy: each run pulls [lastSuccessfulWindowTo − 1 day overlap, now].
 * The overlap catches late postings and value-dated entries; dedupe on
 * externalRef makes the overlap free. First-ever run defaults to 7 days back
 * (a longer backfill is an explicit `trigger: "backfill"` with custom dates).
 *
 * Volume: 500K txns/month ≈ 17K/day. At pageSize 500 that's ~34 pages per
 * entity per day — minutes of work, well inside an in-process job.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  wcConnectorSyncRuns,
  type WcConnectorConfig,
} from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { getCbsProfile } from "../cbs/registry";
import { WoodcoreClient } from "./client";
import { getConfigRow, toConnection } from "./config";
import { enqueueDeadLetter } from "./dlq";
import {
  createIngestBatch,
  ensureCbsChannel,
  finalizeIngestBatch,
  ingestCanonicalTransactions,
} from "./ingest";
import { applyMapping } from "./mapping";
import type { CanonicalTransaction, WcClientDeps, WcEntity } from "./types";
import { getActiveOverrideRules } from "./webhooks";

export type SyncScope = "savings" | "loans" | "gl" | "all";
export type SyncTrigger = "scheduled" | "manual" | "webhook_gap" | "backfill";

const ENTITY_BY_SCOPE: Record<Exclude<SyncScope, "all">, WcEntity> = {
  savings: "savings_transaction",
  loans: "loan_transaction",
  gl: "journal_entry",
};

const OVERLAP_MS = 24 * 60 * 60 * 1000; // 1 day
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** In-process guard: one running sync per config. */
const runningConfigs = new Set<number>();

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10); // yyyy-MM-dd
}

export interface SyncRunSummary {
  runId: number;
  status: "completed" | "partial" | "failed";
  fetched: number;
  inserted: number;
  duplicates: number;
  failed: number;
  windowFrom: Date;
  windowTo: Date;
  error?: string;
}

export async function getLastSuccessfulWindowTo(configId: number): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(wcConnectorSyncRuns)
    .where(
      and(
        eq(wcConnectorSyncRuns.configId, configId),
        eq(wcConnectorSyncRuns.status, "completed"),
      ),
    )
    .orderBy(desc(wcConnectorSyncRuns.windowTo))
    .limit(1);
  return rows[0]?.windowTo ?? null;
}

/**
 * Run one batch sync for a connector config. Failures of individual records go
 * to the DLQ and the run completes as "partial"; only infrastructure-level
 * failures (auth, DB down) fail the whole run.
 */
export async function runBatchSync(
  configId: number,
  opts: {
    trigger: SyncTrigger;
    scope?: SyncScope;
    windowFrom?: Date;
    windowTo?: Date;
    clientDeps?: WcClientDeps;
  },
): Promise<SyncRunSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const cfg = await getConfigRow(configId);
  if (!cfg) throw new Error(`Connector config ${configId} not found`);
  if (!cfg.isEnabled) throw new Error(`Connector config ${configId} is disabled`);

  if (runningConfigs.has(configId)) {
    throw new Error(`A sync is already running for connector ${configId}`);
  }

  // Tenant concurrency quota: syncs count against the org's reconciliation
  // slots so one tenant's backfill can't monopolise the process.
  const { acquireReconciliationSlot } = await import("../../_core/rateLimit");
  const releaseSlot = await acquireReconciliationSlot(cfg.organizationId);
  if (!releaseSlot) {
    throw new Error(
      `Organization ${cfg.organizationId} is at its concurrent reconciliation quota — try again shortly`,
    );
  }
  runningConfigs.add(configId);

  const scope = opts.scope ?? "all";
  let runId: number;
  let windowFrom: Date;
  let windowTo: Date;
  try {
    const now = new Date();
    const lastTo = await getLastSuccessfulWindowTo(configId);
    windowFrom =
      opts.windowFrom ??
      (lastTo ? new Date(lastTo.getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS));
    windowTo = opts.windowTo ?? now;

    // Create the run row up front so the dashboard shows it as running.
    const insertRes = await db.insert(wcConnectorSyncRuns).values({
      configId,
      organizationId: cfg.organizationId,
      trigger: opts.trigger,
      scope,
      windowFrom,
      windowTo,
      status: "running",
    });
    runId = Number((insertRes as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  } catch (err) {
    // Failed before the run started — free the guards, or the tenant's slot leaks.
    runningConfigs.delete(configId);
    releaseSlot();
    throw err;
  }

  const startedMs = Date.now();
  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let failed = 0;
  let fatalError: string | undefined;

  try {
    const conn = await toConnection(cfg);
    const profile = getCbsProfile(cfg.cbsType);
    const client = new WoodcoreClient(conn, opts.clientDeps);
    const channelId = await ensureCbsChannel(cfg.organizationId, cfg.cbsType);

    const entities: WcEntity[] =
      scope === "all"
        ? ["savings_transaction", "loan_transaction", "journal_entry"]
        : [ENTITY_BY_SCOPE[scope]];

    for (const entity of entities) {
      const overrides = await getActiveOverrideRules(configId, entity);
      const batchId = await createIngestBatch({
        organizationId: cfg.organizationId,
        channelId,
        label: `sync#${runId}:${entity}:${fmtDate(windowFrom)}..${fmtDate(windowTo)}`,
      });
      let entityFetched = 0;
      let entityInserted = 0;
      let entityFailed = 0;

      const onPage = async (items: unknown[]): Promise<void> => {
        entityFetched += items.length;
        fetched += items.length;
        const mappedOk: CanonicalTransaction[] = [];
        for (const item of items) {
          const mapped = applyMapping(entity, item, overrides, profile.apiMappings[entity]);
          if (mapped.ok && mapped.value) {
            mappedOk.push(mapped.value);
          } else {
            entityFailed++;
            failed++;
            await enqueueDeadLetter({
              configId,
              organizationId: cfg.organizationId,
              source: "batch_sync",
              refType: entity,
              refId: String((item as Record<string, unknown>)?.id ?? "unknown"),
              payload: item,
              error: `mapping failed: ${mapped.errors.join("; ")}`,
            });
          }
        }
        if (mappedOk.length > 0) {
          const r = await ingestCanonicalTransactions(mappedOk, {
            organizationId: cfg.organizationId,
            channelId,
            batchId,
          });
          inserted += r.inserted;
          entityInserted += r.inserted;
          duplicates += r.duplicates;
        }
        // Keep the run row live for the dashboard.
        await db
          .update(wcConnectorSyncRuns)
          .set({ fetched, inserted, duplicates, failed })
          .where(eq(wcConnectorSyncRuns.id, runId));
      };

      try {
        if (entity === "savings_transaction") {
          await client.fetchSavingsTransactions(fmtDate(windowFrom), fmtDate(windowTo), onPage);
        } else if (entity === "loan_transaction") {
          await client.fetchLoanTransactions(fmtDate(windowFrom), fmtDate(windowTo), onPage);
        } else {
          await client.fetchJournalEntries(fmtDate(windowFrom), fmtDate(windowTo), onPage);
        }
        await finalizeIngestBatch(
          batchId,
          { total: entityFetched, valid: entityInserted, invalid: entityFailed },
          true,
        );
      } catch (err) {
        // Endpoint-level failure for this entity: DLQ an api_call marker so the
        // retry tick re-pulls this window, and continue with the other entities.
        const msg = err instanceof Error ? err.message : String(err);
        failed++;
        await finalizeIngestBatch(
          batchId,
          { total: entityFetched, valid: entityInserted, invalid: entityFailed },
          false,
          msg,
        );
        await enqueueDeadLetter({
          configId,
          organizationId: cfg.organizationId,
          source: "api_call",
          refType: entity,
          refId: `${fmtDate(windowFrom)}..${fmtDate(windowTo)}`,
          payload: { entity, windowFrom: windowFrom.toISOString(), windowTo: windowTo.toISOString() },
          error: msg,
        });
      }
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    runningConfigs.delete(configId);
    releaseSlot();
  }

  const status: "completed" | "partial" | "failed" = fatalError
    ? "failed"
    : failed > 0
      ? "partial"
      : "completed";

  await db
    .update(wcConnectorSyncRuns)
    .set({
      status,
      fetched,
      inserted,
      duplicates,
      failed,
      error: fatalError ?? null,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
    })
    .where(eq(wcConnectorSyncRuns.id, runId));

  return { runId, status, fetched, inserted, duplicates, failed, windowFrom, windowTo, error: fatalError };
}

/**
 * Retry handler for api_call dead letters: re-pull the failed entity/window.
 */
export async function retryApiCallDeadLetter(letter: {
  configId: number;
  refType: string | null;
  payload: unknown;
}): Promise<void> {
  const p = letter.payload as { windowFrom?: string; windowTo?: string } | null;
  const from = p?.windowFrom ? new Date(p.windowFrom) : undefined;
  const to = p?.windowTo ? new Date(p.windowTo) : undefined;
  const scope: SyncScope =
    letter.refType === "savings_transaction" ? "savings"
    : letter.refType === "loan_transaction" ? "loans"
    : letter.refType === "journal_entry" ? "gl"
    : "all";
  const summary = await runBatchSync(letter.configId, {
    trigger: "webhook_gap",
    scope,
    windowFrom: from,
    windowTo: to,
  });
  if (summary.status === "failed") {
    throw new Error(summary.error ?? "retry sync failed");
  }
}

/**
 * The daily scheduler tick (called from /api/scheduled/woodcoreConnectorSync).
 * Runs the batch sync for every enabled config whose batchSyncHourUtc has
 * arrived and which hasn't completed a scheduled run today.
 */
export async function runDueScheduledSyncs(
  configs: WcConnectorConfig[],
  nowUtc: Date = new Date(),
): Promise<Array<{ configId: number; ran: boolean; reason?: string; summary?: SyncRunSummary }>> {
  const db = await getDb();
  if (!db) return configs.map((c) => ({ configId: c.id, ran: false, reason: "db unavailable" }));

  const results: Array<{ configId: number; ran: boolean; reason?: string; summary?: SyncRunSummary }> = [];
  for (const cfg of configs) {
    if (!cfg.batchSyncEnabled) {
      results.push({ configId: cfg.id, ran: false, reason: "batch sync disabled" });
      continue;
    }
    if (nowUtc.getUTCHours() < cfg.batchSyncHourUtc) {
      results.push({ configId: cfg.id, ran: false, reason: "not due yet" });
      continue;
    }
    // Already ran a scheduled sync today?
    const startOfDay = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
    const recent = await db
      .select()
      .from(wcConnectorSyncRuns)
      .where(and(eq(wcConnectorSyncRuns.configId, cfg.id), eq(wcConnectorSyncRuns.trigger, "scheduled")))
      .orderBy(desc(wcConnectorSyncRuns.startedAt))
      .limit(1);
    if (recent[0] && recent[0].startedAt >= startOfDay) {
      results.push({ configId: cfg.id, ran: false, reason: "already ran today" });
      continue;
    }
    try {
      const summary = await runBatchSync(cfg.id, { trigger: "scheduled" });
      results.push({ configId: cfg.id, ran: true, summary });
    } catch (err) {
      results.push({
        configId: cfg.id,
        ran: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
