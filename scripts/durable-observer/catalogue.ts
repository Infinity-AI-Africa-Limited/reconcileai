/** Preparation only: catalogue from the pinned public preflight.
 * Source base: 4efaac2a1e4d35f9aaa448b2daba4652e7e58dee (not target identity).
 * No app imports, drivers, configuration, resource creation or target identity.
 * SQL is a finite statement allow-list, NOT an engine read-only guarantee.
 */
export const SOURCE_PIN = "4efaac2a1e4d35f9aaa448b2daba4652e7e58dee";
export const QUEUE_IDS = Object.freeze([
  "reconciliation-runs", "webhook-delivery", "shopify-order-sync",
  "shopify-privacy", "shopify-manual-sync", "shopline-realtime-sync",
] as const);
export const QUEUE_STATES = Object.freeze([
  "wait", "paused", "active", "delayed", "prioritized", "waiting-children", "failed", "repeat",
] as const);
export type QueueId = (typeof QUEUE_IDS)[number];
export type QueueState = (typeof QUEUE_STATES)[number];
export type RedisReadId = `${QueueId}.${QueueState}`;
export const RUNNABLE_STATES: readonly QueueState[] = Object.freeze(QUEUE_STATES.slice(0, 6));

// Predicates and age columns are verbatim from the pinned public preflight.
const surfaces = [
  ["reconciliation_jobs.unfinished", "work", "reconciliation_jobs", "status IN ('pending','running') AND abandonedAt IS NULL", "createdAt"],
  ["reconciliation_jobs.running_stale_heartbeat", "subset", "reconciliation_jobs", "status = 'running' AND abandonedAt IS NULL AND COALESCE(heartbeatAt, startedAt, createdAt) < NOW() - INTERVAL 15 MINUTE", "createdAt"],
  ["upload_batches.in_progress", "work", "upload_batches", "status IN ('pending','processing')", "createdAt"],
  ["schedule_run_history.running", "work", "schedule_run_history", "status = 'running'", "startedAt"],
  ["wc_connector_sync_runs.running", "work", "wc_connector_sync_runs", "status = 'running'", "startedAt"],
  ["webhook_deliveries.pending", "work", "webhook_deliveries", "status = 'pending'", "createdAt"],
  ["shopify_privacy_queue_outbox.undispatched", "work", "shopify_privacy_queue_outbox", "status IN ('pending','dispatching','failed_retryable')", "createdAt"],
  ["shopify_privacy_requests.in_progress", "work", "shopify_privacy_requests", "status IN ('received','processing','awaiting_delivery','failed_retryable','blocked_dependency')", "receivedAt"],
  ["shopify_privacy_requests.parked", "parked", "shopify_privacy_requests", "status IN ('manual_review','blocked_legal_retention')", "receivedAt"],
  ["shopify_privacy_data_request_jobs.in_progress", "work", "shopify_privacy_data_request_jobs", "status IN ('received','processing','awaiting_delivery','failed_retryable','blocked_dependency')", "createdAt"],
  ["shopify_privacy_customer_redaction_jobs.in_progress", "work", "shopify_privacy_customer_redaction_jobs", "status IN ('received','processing','failed_retryable','blocked_dependency')", "createdAt"],
  ["shopify_shop_redaction_jobs.in_progress", "work", "shopify_shop_redaction_jobs", "status IN ('admitted','processing','failed_retryable','blocked_dependency','redacting')", "createdAt"],
  ["shopify_privacy_artifacts.writing", "work", "shopify_privacy_artifacts", "status = 'writing'", "createdAt"],
  ["shopify_privacy_artifacts.awaiting_acknowledgement", "parked", "shopify_privacy_artifacts", "status = 'ready' AND deliveryStatus = 'pending'", "createdAt"],
  ["shopify_webhook_events.acknowledged_unprocessed", "work", "shopify_webhook_events", "status = 'received'", "receivedAt"],
  ["shopify_sync_requests.queued", "work", "shopify_sync_requests", "status = 'queued'", "requestedAt"],
  ["shopify_install_leases.unexpired", "work", "shopify_install_leases", "expiresAt > NOW()", "createdAt"],
  ["shopify_connector_stores.redacting", "work", "shopify_connector_stores", "status = 'redacting' OR privacyRedactionState = 'customer_redacting'", "updatedAt"],
  ["organizations.redacting", "work", "organizations", "deletionState = 'redacting'", "COALESCE(redactingAt, updatedAt)"],
  ["sl_connector_webhook_events.acknowledged_unprocessed", "work", "sl_connector_webhook_events", "status IN ('pending','processing','failed') AND attempts < 3", "receivedAt"],
  ["sl_connector_gdpr_requests.received", "parked", "sl_connector_gdpr_requests", "status = 'received'", "receivedAt"],
  ["wc_connector_webhook_events.received", "work", "wc_connector_webhook_events", "status = 'received'", "receivedAt"],
  ["wc_connector_dead_letters.retryable", "work", "wc_connector_dead_letters", "status IN ('pending','retrying')", "createdAt"],
  ["data_deletion_requests.open", "work", "data_deletion_requests", "status IN ('pending','in_progress')", "createdAt"],
] as const;
export type SurfaceId = (typeof surfaces)[number][0];
export const DB_SURFACES = Object.freeze(surfaces.map(([id, kind, table, where, time]) => Object.freeze({ id, kind, table, where, time })));
const intake = [
  ["reconciliation_jobs", "createdAt"], ["upload_batches", "createdAt"],
  ["transactions", "createdAt"], ["schedule_run_history", "startedAt"],
  ["wc_connector_sync_runs", "startedAt"], ["webhook_deliveries", "createdAt"],
  ["shopify_webhook_events", "receivedAt"], ["shopify_privacy_requests", "receivedAt"],
  ["shopify_sync_requests", "requestedAt"], ["shopify_install_leases", "createdAt"],
  ["sl_connector_webhook_events", "receivedAt"], ["sl_connector_gdpr_requests", "receivedAt"],
  ["wc_connector_webhook_events", "receivedAt"],
] as const;
export type IntakeId = (typeof intake)[number][0];
export const INTAKE_SOURCES = Object.freeze(intake.map(([id, time]) => Object.freeze({ id, table: id, time })));
export type DatabaseQueryId = "session.utc" | "session.snapshot" | "session.rollback" | SurfaceId | `intake.${IntakeId}`;
const queries = new Map<DatabaseQueryId, string>([
  ["session.utc", "SET time_zone = '+00:00'"],
  ["session.snapshot", "START TRANSACTION WITH CONSISTENT SNAPSHOT"],
  ["session.rollback", "ROLLBACK"],
]);
for (const s of DB_SURFACES) queries.set(s.id, `SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count, GREATEST(0, TIMESTAMPDIFF(SECOND, MIN(${s.time}), NOW())) AS oldestAgeSeconds FROM ${s.table} WHERE ${s.where}`);
// Whole-run ceiling (300s) + pinned clock margin (60s); conservative superset,
// not an exact between-sample delta. First sample intentionally does not query intake.
for (const s of INTAKE_SOURCES) queries.set(`intake.${s.id}`, `SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count FROM ${s.table} WHERE ${s.time} >= NOW() - INTERVAL 360 SECOND`);
export function compileDatabaseQuery(id: DatabaseQueryId): string {
  const sql = queries.get(id);
  if (!sql) throw new Error("query_refused");
  return sql;
}
export interface RedisCommand { readonly command: "LLEN" | "ZCARD" | "SCAN"; readonly args: readonly string[] }
const reads = new Map<RedisReadId, RedisCommand>();
for (const q of QUEUE_IDS) for (const s of QUEUE_STATES) reads.set(`${q}.${s}`, Object.freeze({
  command: ["wait", "paused", "active"].includes(s) ? "LLEN" : "ZCARD",
  args: Object.freeze([`bull:${q}:${s}`]),
}));
export function compileRedisRead(id: RedisReadId): RedisCommand {
  const command = reads.get(id);
  if (!command) throw new Error("redis_read_refused");
  return command;
}
// Discovery must be able to finish on the keyspace the app itself retains:
// every BullMQ queue keeps up to 1,000 completed and 5,000 failed jobs
// (server/jobQueue.ts), about 36,000 job keys across the six queues. SCAN walks
// the WHOLE keyspace whatever MATCH says, so 10 rounds of COUNT 100 (about 1,000
// keys) could never finish there: measured 359 calls at 36,000 keys. COUNT 1000
// finishes 36,000 keys in 37 calls and 96,000 in 96, so 100 rounds is the bound.
// Replies hold only MATCHing meta keys, so a larger COUNT does not enlarge them.
// redisCommands: per sample 48 state reads + 100 SCAN rounds, three samples.
export const LIMITS = Object.freeze({
  samples: 3, intervalMs: 60_000, runMs: 300_000, queryMs: 1_500,
  redisMs: 1_000, cleanupMs: 500, databaseCommands: 120, redisCommands: 450,
  scanCount: 1000, scanRounds: 100, scanKeysPerRead: 256,
  scanBytesPerRead: 32_768, keyLength: 256, unknownQueues: 128,
});
export function compileRedisScan(cursor: string): RedisCommand {
  if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(cursor)) throw new Error("redis_scan_refused");
  return Object.freeze({ command: "SCAN", args: Object.freeze([cursor, "MATCH", "bull:*:meta", "COUNT", String(LIMITS.scanCount)]) });
}
