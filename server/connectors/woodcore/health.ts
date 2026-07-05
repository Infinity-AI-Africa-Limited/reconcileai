/**
 * Connector health: the single payload behind the IT-admin dashboard.
 *
 * Status rules:
 *   down     — last connectivity test failed, or the 3 most recent sync runs all failed
 *   degraded — DLQ has pending/exhausted items, webhook failure rate (24h) > 5%,
 *              auth is running on a fallback mode, or the last sync was partial
 *   ok       — everything above is clean
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  wcConnectorDeadLetters,
  wcConnectorSyncRuns,
  wcConnectorWebhookEvents,
  wcConnectorConfigs,
  type WcConnectorConfig,
} from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { WoodcoreClient } from "./client";
import { toConnection } from "./config";
import type { WcClientDeps } from "./types";

export type ConnectorStatus = "ok" | "degraded" | "down" | "unknown";

export interface ConnectorHealth {
  status: ConnectorStatus;
  reasons: string[];
  connectivity: { ok: boolean; latencyMs: number | null; checkedAt: string; error?: string };
  authMode: string;
  authDegraded: boolean;
  lastSync: {
    runId: number;
    status: string;
    trigger: string;
    finishedAt: string | null;
    fetched: number;
    inserted: number;
    failed: number;
  } | null;
  webhooks24h: { received: number; processed: number; failed: number; duplicates: number };
  dlq: { pending: number; retrying: number; exhausted: number };
  volume30d: { inserted: number };
}

export async function testConnection(
  cfg: WcConnectorConfig,
  deps: WcClientDeps = {},
): Promise<{ ok: boolean; latencyMs: number; authModeUsed: string; authDegraded: boolean; error?: string }> {
  const conn = toConnection(cfg);
  const client = new WoodcoreClient(conn, deps);
  const ping = await client.ping();
  return {
    ok: ping.ok,
    latencyMs: ping.latencyMs,
    authModeUsed: client.lastAuth?.modeUsed ?? conn.authMode,
    authDegraded: client.lastAuth?.degraded ?? false,
    error: ping.error,
  };
}

export async function getConnectorHealth(
  cfg: WcConnectorConfig,
  opts: { runConnectivityProbe?: boolean; clientDeps?: WcClientDeps } = {},
): Promise<ConnectorHealth> {
  const db = await getDb();
  const reasons: string[] = [];

  // 1) Connectivity — live probe (dashboard refresh) or last stored result.
  let connectivity: ConnectorHealth["connectivity"];
  let authDegraded = false;
  let authModeUsed: string = cfg.authMode;
  if (opts.runConnectivityProbe) {
    const probe = await testConnection(cfg, opts.clientDeps);
    connectivity = {
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      checkedAt: new Date().toISOString(),
      error: probe.error,
    };
    authDegraded = probe.authDegraded;
    authModeUsed = probe.authModeUsed;
    if (db) {
      await db
        .update(wcConnectorConfigs)
        .set({
          lastHealthStatus: probe.ok ? (authDegraded ? "degraded" : "ok") : "down",
          lastHealthCheckAt: new Date(),
          lastHealthDetail: probe.error ?? (authDegraded ? "auth fallback in use" : null),
        })
        .where(eq(wcConnectorConfigs.id, cfg.id));
    }
  } else {
    connectivity = {
      ok: cfg.lastHealthStatus === "ok" || cfg.lastHealthStatus === "degraded",
      latencyMs: null,
      checkedAt: cfg.lastHealthCheckAt?.toISOString() ?? "never",
      error: cfg.lastHealthDetail ?? undefined,
    };
  }

  if (!db) {
    return {
      status: "unknown",
      reasons: ["database unavailable"],
      connectivity,
      authMode: authModeUsed,
      authDegraded,
      lastSync: null,
      webhooks24h: { received: 0, processed: 0, failed: 0, duplicates: 0 },
      dlq: { pending: 0, retrying: 0, exhausted: 0 },
      volume30d: { inserted: 0 },
    };
  }

  // 2) Recent sync runs
  const recentRuns = await db
    .select()
    .from(wcConnectorSyncRuns)
    .where(eq(wcConnectorSyncRuns.configId, cfg.id))
    .orderBy(desc(wcConnectorSyncRuns.startedAt))
    .limit(3);
  const last = recentRuns[0] ?? null;

  // 3) Webhook stats, last 24h
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const whRows = await db
    .select({
      status: wcConnectorWebhookEvents.status,
      n: sql<number>`COUNT(*)`,
    })
    .from(wcConnectorWebhookEvents)
    .where(and(eq(wcConnectorWebhookEvents.configId, cfg.id), gte(wcConnectorWebhookEvents.receivedAt, dayAgo)))
    .groupBy(wcConnectorWebhookEvents.status);
  const wh = { received: 0, processed: 0, failed: 0, duplicates: 0 };
  for (const r of whRows) {
    const n = Number(r.n);
    wh.received += n;
    if (r.status === "processed") wh.processed += n;
    else if (r.status === "failed" || r.status === "quarantined") wh.failed += n;
    else if (r.status === "duplicate") wh.duplicates += n;
  }

  // 4) DLQ depth
  const dlqRows = await db
    .select({ status: wcConnectorDeadLetters.status, n: sql<number>`COUNT(*)` })
    .from(wcConnectorDeadLetters)
    .where(eq(wcConnectorDeadLetters.configId, cfg.id))
    .groupBy(wcConnectorDeadLetters.status);
  const dlq = { pending: 0, retrying: 0, exhausted: 0 };
  for (const r of dlqRows) {
    if (r.status === "pending") dlq.pending = Number(r.n);
    else if (r.status === "retrying") dlq.retrying = Number(r.n);
    else if (r.status === "exhausted") dlq.exhausted = Number(r.n);
  }

  // 5) 30-day ingested volume (the 500K/month capacity headline number)
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const volRows = await db
    .select({ total: sql<number>`COALESCE(SUM(${wcConnectorSyncRuns.inserted}), 0)` })
    .from(wcConnectorSyncRuns)
    .where(and(eq(wcConnectorSyncRuns.configId, cfg.id), gte(wcConnectorSyncRuns.startedAt, monthAgo)));
  const volume30d = { inserted: Number(volRows[0]?.total ?? 0) + wh.processed };

  // ── Status determination ──
  let status: ConnectorStatus = "ok";
  if (!connectivity.ok && connectivity.checkedAt !== "never") {
    status = "down";
    reasons.push(`connectivity check failed${connectivity.error ? `: ${connectivity.error}` : ""}`);
  }
  const failedRuns = recentRuns.filter((r) => r.status === "failed").length;
  if (recentRuns.length >= 3 && failedRuns === 3) {
    status = "down";
    reasons.push("last 3 sync runs all failed");
  }
  if (status !== "down") {
    if (authDegraded) {
      status = "degraded";
      reasons.push(`auth degraded — running on fallback (${authModeUsed})`);
    }
    if (dlq.pending + dlq.retrying + dlq.exhausted > 0) {
      status = "degraded";
      reasons.push(`${dlq.pending + dlq.retrying} items awaiting retry, ${dlq.exhausted} exhausted`);
    }
    if (wh.received > 0 && wh.failed / wh.received > 0.05) {
      status = "degraded";
      reasons.push(`webhook failure rate ${(100 * (wh.failed / wh.received)).toFixed(1)}% (24h)`);
    }
    if (last?.status === "partial") {
      status = "degraded";
      reasons.push("most recent sync completed with per-record failures");
    }
    if (last?.status === "failed") {
      status = "degraded";
      reasons.push("most recent sync failed");
    }
  }
  if (connectivity.checkedAt === "never" && !last) {
    status = "unknown";
    reasons.push("connector has never been tested or run");
  }

  return {
    status,
    reasons,
    connectivity,
    authMode: authModeUsed,
    authDegraded,
    lastSync: last
      ? {
          runId: last.id,
          status: last.status,
          trigger: last.trigger,
          finishedAt: last.finishedAt?.toISOString() ?? null,
          fetched: last.fetched,
          inserted: last.inserted,
          failed: last.failed,
        }
      : null,
    webhooks24h: wh,
    dlq,
    volume30d,
  };
}
