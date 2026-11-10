/**
 * What the maintenance workload check counts, and the ONLY statements and
 * Redis commands it may send.
 *
 * Ported from the reviewed durable-observer catalogue (scripts/durable-observer/
 * catalogue.ts at e7dc06c, PR #225). The surfaces, their predicates and age
 * columns, the queues and their states are unchanged. What differs is the shape
 * of a run: the observer took three samples a minute apart inside one
 * five-minute process; this check takes ONE sample per request, because a
 * request must finish well inside the proxy's 100-second limit. The page runs
 * the samples.
 *
 * Aggregate and cross-tenant on purpose. It is the platform operator's view of
 * work in flight, returned as counts and ages only: no row, id, key name,
 * payload or tenant leaves this module.
 *
 * The SQL is a fixed allow-list, not an engine guarantee. Production's TiDB
 * refuses read-only transactions (see server/readOnlyTransactionRatchet.test.ts),
 * so the protection is that nothing else can be sent, and the tests prove that
 * every statement but the snapshot's own opening and ending is a SELECT.
 */
export const QUEUE_IDS = Object.freeze([
  "reconciliation-runs",
  "webhook-delivery",
  "shopify-order-sync",
  "shopify-privacy",
  "shopify-manual-sync",
  "shopline-realtime-sync",
] as const);
export const QUEUE_STATES = Object.freeze([
  "wait",
  "paused",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
  "failed",
  "repeat",
] as const);
export type QueueId = (typeof QUEUE_IDS)[number];
export type QueueState = (typeof QUEUE_STATES)[number];
export type RedisReadId = `${QueueId}.${QueueState}`;
/** Queued, running or due. Failed jobs and repeat schedules are not running. */
export const RUNNABLE_STATES: readonly QueueState[] = Object.freeze(QUEUE_STATES.slice(0, 6));

/**
 * `work` and `subset` surfaces hold unfinished work. `parked` ones wait on a
 * person, so a replacement cannot cut them off; they are reported, not counted
 * as running. Predicates and age columns are verbatim from the reviewed catalogue.
 */
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
export type SurfaceKind = (typeof surfaces)[number][1];
export const DB_SURFACES = Object.freeze(
  surfaces.map(([id, kind, table, where, time]) => Object.freeze({ id, kind, table, where, time })),
);

/** New rows here mean the app is still taking in work, so a quiet reading cannot be trusted. */
const intake = [
  ["reconciliation_jobs", "createdAt"],
  ["upload_batches", "createdAt"],
  ["transactions", "createdAt"],
  ["schedule_run_history", "startedAt"],
  ["wc_connector_sync_runs", "startedAt"],
  ["webhook_deliveries", "createdAt"],
  ["shopify_webhook_events", "receivedAt"],
  ["shopify_privacy_requests", "receivedAt"],
  ["shopify_sync_requests", "requestedAt"],
  ["shopify_install_leases", "createdAt"],
  ["sl_connector_webhook_events", "receivedAt"],
  ["sl_connector_gdpr_requests", "receivedAt"],
  ["wc_connector_webhook_events", "receivedAt"],
] as const;
export type IntakeId = (typeof intake)[number][0];
export const INTAKE_SOURCES = Object.freeze(intake.map(([id, time]) => Object.freeze({ id, table: id, time })));
/** Unchanged from the reviewed catalogue: a conservative six-minute lookback. */
export const INTAKE_LOOKBACK_SECONDS = 360;

export type SessionStatementId = "session.timezone" | "session.snapshot" | "session.rollback";
export type DatabaseStatementId = SessionStatementId | SurfaceId | `intake.${IntakeId}`;

const statements = new Map<DatabaseStatementId, string>([
  // The app's pool pins every session to UTC (server/dbSession.ts). The ages
  // below compare stored instants with NOW(), so the check reads the pin back
  // rather than assume it.
  ["session.timezone", "SELECT @@session.time_zone AS tz"],
  ["session.snapshot", "START TRANSACTION WITH CONSISTENT SNAPSHOT"],
  ["session.rollback", "ROLLBACK"],
]);
for (const s of DB_SURFACES)
  statements.set(
    s.id,
    `SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count, GREATEST(0, TIMESTAMPDIFF(SECOND, MIN(${s.time}), NOW())) AS oldestAgeSeconds FROM ${s.table} WHERE ${s.where}`,
  );
for (const s of INTAKE_SOURCES)
  statements.set(
    `intake.${s.id}`,
    `SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count FROM ${s.table} WHERE ${s.time} >= NOW() - INTERVAL ${INTAKE_LOOKBACK_SECONDS} SECOND`,
  );

/** The statement for a catalogue id. Anything else is refused. */
export function compileStatement(id: DatabaseStatementId): string {
  const sql = statements.get(id);
  if (!sql) throw new Error("statement_refused");
  return sql;
}
/** Every statement the check can send, for the tests that prove what they are. */
export function allStatements(): ReadonlyArray<readonly [DatabaseStatementId, string]> {
  return [...statements.entries()];
}

export interface RedisRead {
  readonly command: "LLEN" | "ZCARD";
  readonly key: string;
}
const reads = new Map<RedisReadId, RedisRead>();
for (const q of QUEUE_IDS)
  for (const s of QUEUE_STATES)
    reads.set(
      `${q}.${s}`,
      Object.freeze({ command: s === "wait" || s === "paused" || s === "active" ? "LLEN" : "ZCARD", key: `bull:${q}:${s}` }),
    );

/** The single-key read for a catalogue id. Anything else is refused. */
export function compileRedisRead(id: RedisReadId): RedisRead {
  const read = reads.get(id);
  if (!read) throw new Error("redis_read_refused");
  return read;
}

/** SCAN only ever matches queue metadata keys; its replies are names, never values. */
export const SCAN_MATCH = "bull:*:meta";

/**
 * Bounds for ONE sample.
 *
 * Discovery must be able to finish on the keyspace the app itself keeps: every
 * BullMQ queue retains up to 1,000 completed and 5,000 failed jobs
 * (server/jobQueue.ts), about 36,000 job keys across the six queues. SCAN walks
 * the whole keyspace whatever MATCH says; COUNT 1000 finishes 36,000 keys in
 * about 37 calls and 96,000 in 96, so 100 rounds is the bound (measured for the
 * reviewed observer). The run budget keeps a request inside the proxy's limit.
 */
export const LIMITS = Object.freeze({
  runMs: 45_000,
  connectMs: 3_000,
  queryMs: 1_500,
  redisMs: 1_000,
  cleanupMs: 1_000,
  databaseStatements: 3 + DB_SURFACES.length + INTAKE_SOURCES.length,
  redisCommands: QUEUE_IDS.length * QUEUE_STATES.length + 100,
  scanCount: 1000,
  scanRounds: 100,
  scanKeysPerRead: 256,
  keyLength: 256,
  unknownQueues: 128,
});

/** What a reading of this kind cannot show, stated with every report. */
export const NOT_COLLECTED = Object.freeze([
  "other_replicas_in_memory_work_is_not_visible",
  "http_requests_in_flight_are_counted_only_for_this_replica",
  "woodcore_mirror_sync_state_is_in_process_memory_only",
  "in_process_producers_leave_no_durable_marker_except_schedule_runs_and_uploads",
  "external_schedulers_are_producers_whose_state_is_not_visible",
  "other_deployments_sharing_the_database_are_not_distinguished",
  "database_background_writers_and_open_transactions_are_not_inspected",
  "database_user_privileges_are_not_inspected",
  "upstream_redelivery_and_catch_up_correctness_are_not_assessed",
  "job_payloads_ids_retries_stalls_and_locks_are_not_collected",
  "redis_reads_are_not_one_atomic_snapshot",
  "intake_uses_a_conservative_fixed_six_minute_lookback",
  "the_build_commit_is_railway_attribution_not_binary_attestation",
] as const);
