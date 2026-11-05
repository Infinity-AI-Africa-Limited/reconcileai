#!/usr/bin/env node
/**
 * Read-only workload preflight for a deployment replacement.
 *
 * Counts the work a replacement could cut off, across every place the deployed
 * code keeps it:
 *   - unfinished reconciliation (job rows, uploads, scheduled runs, connector
 *     syncs);
 *   - waiting, active, delayed and retrying entries in every BullMQ queue,
 *     plus any queue in Redis the code does not know;
 *   - accepted work that still owes an outbox dispatch, a final hook or an
 *     acknowledgement (webhook events answered 200 but not processed, privacy
 *     jobs, deliveries, dead letters);
 *   - the drain and overlap settings visible from where it runs.
 * It samples several times and counts new intake between samples, because a
 * zero while producers are active proves nothing. No verdict it prints means
 * "safe to replace".
 *
 * BEFORE it loads a driver or opens a connection, it refuses (exit 4, a fixed
 * code, nothing connected) unless:
 *   - --expect-deployment is a full deployment id and --expect-commit a full
 *     commit SHA, and neither looks like a placeholder;
 *   - it runs inside a Railway deployment (RAILWAY_REPLICA_ID is set) whose
 *     RAILWAY_DEPLOYMENT_ID and RAILWAY_GIT_COMMIT_SHA equal those two values;
 *   - with --env-from-app, exactly one application process is running and its
 *     environment is readable. It never falls back to another process or to
 *     the operator's shell;
 *   - the database is off the loopback interface only over TLS, and Redis is
 *     reached over Railway's private network, over TLS, or on the loopback
 *     interface. A public plaintext Redis route is refused.
 * Off the loopback interface it verifies the database server's certificate AND
 * its host name, whatever the URL asks for, and confirms the connection is
 * encrypted and authorised before its first statement. It reports, as a label
 * and never the value, how the application's own URL asks for TLS.
 *
 * A global budget (--budget-seconds, default 300) bounds the run. When it runs
 * out, the script closes its own connections and reports incomplete evidence.
 * It stops, cancels and changes nothing else.
 *
 * Script class (CLAUDE.md §12): READ-ONLY. It writes nothing, so none of the
 * write controls there apply. Its own controls, each tested in
 * productionWorkloadPreflight.test.ts:
 *   - no .env loading, no application imports, no BullMQ objects (constructing
 *     a Queue writes queue metadata), no workers, no enqueues, no migrations;
 *   - every SQL statement is a constant that assertReadOnlySql accepts: a
 *     SELECT, or one of three session statements. That guard is the write
 *     control on every engine, and the report says so. The script asks the
 *     engine for no read-only mode: TiDB (production's engine) refuses one, or
 *     with tidb_enable_noop_functions accepts it and still writes (tested on
 *     TiDB 7.5), and readOnlyTransactionRatchet forbids the request. A
 *     SELECT-only database user is the way to add the engine's own control;
 *   - every Redis command passes assertReadOnlyRedis: a read-only command
 *     allow-list with key and field shapes enforced, so a job's data, options,
 *     return value and failure text are never read;
 *   - the report passes assertAggregateOnly before it is printed: numbers,
 *     booleans, nulls and fixed labels only;
 *   - errors become fixed codes; an error message can carry SQL, hosts or
 *     values, so none is ever printed.
 *
 * It is meant to be run by scripts/production-workload-preflight.sh, which
 * downloads it at a pinned commit, checks its bytes and bounds the process.
 * Directly, from the application directory (so it uses the app's own mysql2
 * and BullMQ's ioredis):
 *   node production-workload-preflight.mjs --env-from-app \
 *     --expect-deployment <deployment uuid> --expect-commit <40-hex sha>
 * Options: --samples 1..10 (default 3), --interval-seconds 1..600 (default 60),
 * --budget-seconds 30..900 (default 300; must cover the samples), and
 * --env-from-app: take the variables in ENV_KEYS from the running application
 * process instead of this shell. The values stay in this process; none is
 * printed.
 *
 * Output: one line of JSON, then a VERDICT line and a GROUPS line, or one line
 * of JSON naming a fixed error code. Exit status: see EXIT.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPORT_SCHEMA = "reconcileai_workload_preflight_v2";

/**
 * Exit statuses. A printed report exits 0 whatever its verdict: 0 means the
 * check ran, never that a replacement is safe.
 */
export const EXIT = Object.freeze({ report: 0, usage: 2, failed: 3, refused: 4, interrupted: 5 });

// ─── What is counted ──────────────────────────────────────────────────────────

/**
 * Every queue the deployed code creates (server/jobQueue.ts callers).
 * productionWorkloadPreflight.test.ts fails when a createQueue call appears
 * that this list does not account for.
 */
export const QUEUE_NAMES = Object.freeze([
  "reconciliation-runs",
  "webhook-delivery",
  "shopify-order-sync",
  "shopify-privacy",
  "shopify-manual-sync",
  "shopline-realtime-sync",
]);

/** BullMQ 5 state keys that hold runnable or in-flight entries. */
const RUNNABLE_LISTS = Object.freeze(["wait", "paused", "active"]);
const RUNNABLE_ZSETS = Object.freeze(["delayed", "prioritized", "waiting-children"]);
/** Read for context, not counted as runnable. */
const INFO_ZSETS = Object.freeze(["failed", "repeat"]);

/**
 * How many job ids per state are inspected for retry and stall counters. The
 * runnable counts are exact whatever this is; only those counters are capped.
 */
export const ID_SCAN_LIMIT = 200;
/** Unknown-queue discovery: keys examined per SCAN call, and the most calls per sample. */
export const SCAN_COUNT = 1000;
export const SCAN_ROUND_LIMIT = 500;

/** The whole run's budget, in seconds. */
export const DEFAULT_BUDGET_SECONDS = 300;
export const MIN_BUDGET_SECONDS = 30;
export const MAX_BUDGET_SECONDS = 900;
/** Time each sample is allowed on top of the sleeps, when a budget is checked up front. */
export const SAMPLE_ALLOWANCE_SECONDS = 30;
/** Per statement and per connection. The budget bounds the run; these bound one wait. */
export const QUERY_TIMEOUT_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;

/**
 * Database surfaces. `work` surfaces are process work a replacement can
 * interrupt; `parked` ones wait on a person or a legal hold and are reported
 * for context only. Every predicate names the exact non-terminal states from
 * the deployed schema.
 */
export const DB_SURFACES = Object.freeze([
  { id: "reconciliation_jobs.unfinished", group: "reconciliation", kind: "work", table: "reconciliation_jobs", where: "status IN ('pending','running') AND abandonedAt IS NULL", time: "createdAt" },
  { id: "reconciliation_jobs.running_stale_heartbeat", group: "reconciliation", kind: "subset", table: "reconciliation_jobs", where: "status = 'running' AND abandonedAt IS NULL AND COALESCE(heartbeatAt, startedAt, createdAt) < NOW() - INTERVAL 15 MINUTE", time: "createdAt" },
  { id: "upload_batches.in_progress", group: "reconciliation", kind: "work", table: "upload_batches", where: "status IN ('pending','processing')", time: "createdAt" },
  { id: "schedule_run_history.running", group: "reconciliation", kind: "work", table: "schedule_run_history", where: "status = 'running'", time: "startedAt" },
  { id: "wc_connector_sync_runs.running", group: "reconciliation", kind: "work", table: "wc_connector_sync_runs", where: "status = 'running'", time: "startedAt" },
  { id: "webhook_deliveries.pending", group: "accepted", kind: "work", table: "webhook_deliveries", where: "status = 'pending'", time: "createdAt" },
  { id: "shopify_privacy_queue_outbox.undispatched", group: "accepted", kind: "work", table: "shopify_privacy_queue_outbox", where: "status IN ('pending','dispatching','failed_retryable')", time: "createdAt" },
  { id: "shopify_privacy_requests.in_progress", group: "accepted", kind: "work", table: "shopify_privacy_requests", where: "status IN ('received','processing','awaiting_delivery','failed_retryable','blocked_dependency')", time: "receivedAt" },
  { id: "shopify_privacy_requests.parked", group: "accepted", kind: "parked", table: "shopify_privacy_requests", where: "status IN ('manual_review','blocked_legal_retention')", time: "receivedAt" },
  { id: "shopify_privacy_data_request_jobs.in_progress", group: "accepted", kind: "work", table: "shopify_privacy_data_request_jobs", where: "status IN ('received','processing','awaiting_delivery','failed_retryable','blocked_dependency')", time: "createdAt" },
  { id: "shopify_privacy_customer_redaction_jobs.in_progress", group: "accepted", kind: "work", table: "shopify_privacy_customer_redaction_jobs", where: "status IN ('received','processing','failed_retryable','blocked_dependency')", time: "createdAt" },
  { id: "shopify_shop_redaction_jobs.in_progress", group: "accepted", kind: "work", table: "shopify_shop_redaction_jobs", where: "status IN ('admitted','processing','failed_retryable','blocked_dependency','redacting')", time: "createdAt" },
  { id: "shopify_privacy_artifacts.writing", group: "accepted", kind: "work", table: "shopify_privacy_artifacts", where: "status = 'writing'", time: "createdAt" },
  { id: "shopify_privacy_artifacts.awaiting_acknowledgement", group: "accepted", kind: "parked", table: "shopify_privacy_artifacts", where: "status = 'ready' AND deliveryStatus = 'pending'", time: "createdAt" },
  { id: "shopify_webhook_events.acknowledged_unprocessed", group: "accepted", kind: "work", table: "shopify_webhook_events", where: "status = 'received'", time: "receivedAt" },
  { id: "shopify_sync_requests.queued", group: "accepted", kind: "work", table: "shopify_sync_requests", where: "status = 'queued'", time: "requestedAt" },
  { id: "shopify_install_leases.unexpired", group: "accepted", kind: "work", table: "shopify_install_leases", where: "expiresAt > NOW()", time: "createdAt" },
  { id: "shopify_connector_stores.redacting", group: "accepted", kind: "work", table: "shopify_connector_stores", where: "status = 'redacting' OR privacyRedactionState = 'customer_redacting'", time: "updatedAt" },
  { id: "organizations.redacting", group: "accepted", kind: "work", table: "organizations", where: "deletionState = 'redacting'", time: "COALESCE(redactingAt, updatedAt)" },
  // The 15-minute SHOPLINE cycle replays these while attempts stay under 3
  // (WEBHOOK_MAX_ATTEMPTS, connectors/shopline/webhookHandler.ts).
  { id: "sl_connector_webhook_events.acknowledged_unprocessed", group: "accepted", kind: "work", table: "sl_connector_webhook_events", where: "status IN ('pending','processing','failed') AND attempts < 3", time: "receivedAt" },
  // Since #221, `received` is an open shop/redact: the store is uninstalled but
  // no SHOPLINE shop erasure exists yet, and the owner is emailed until it is
  // met (gdprDeadlines.ts). No process works it, so no replacement can cut it off.
  { id: "sl_connector_gdpr_requests.received", group: "accepted", kind: "parked", table: "sl_connector_gdpr_requests", where: "status = 'received'", time: "receivedAt" },
  { id: "wc_connector_webhook_events.received", group: "accepted", kind: "work", table: "wc_connector_webhook_events", where: "status = 'received'", time: "receivedAt" },
  { id: "wc_connector_dead_letters.retryable", group: "accepted", kind: "work", table: "wc_connector_dead_letters", where: "status IN ('pending','retrying')", time: "createdAt" },
  { id: "data_deletion_requests.open", group: "accepted", kind: "work", table: "data_deletion_requests", where: "status IN ('pending','in_progress')", time: "createdAt" },
]);

/** New rows in these, of any status, between samples mean a producer is active. */
export const INTAKE_SOURCES = Object.freeze([
  { id: "reconciliation_jobs", table: "reconciliation_jobs", time: "createdAt" },
  { id: "upload_batches", table: "upload_batches", time: "createdAt" },
  { id: "transactions", table: "transactions", time: "createdAt" },
  { id: "schedule_run_history", table: "schedule_run_history", time: "startedAt" },
  { id: "wc_connector_sync_runs", table: "wc_connector_sync_runs", time: "startedAt" },
  { id: "webhook_deliveries", table: "webhook_deliveries", time: "createdAt" },
  { id: "shopify_webhook_events", table: "shopify_webhook_events", time: "receivedAt" },
  { id: "shopify_privacy_requests", table: "shopify_privacy_requests", time: "receivedAt" },
  { id: "shopify_sync_requests", table: "shopify_sync_requests", time: "requestedAt" },
  { id: "shopify_install_leases", table: "shopify_install_leases", time: "createdAt" },
  { id: "sl_connector_webhook_events", table: "sl_connector_webhook_events", time: "receivedAt" },
  { id: "sl_connector_gdpr_requests", table: "sl_connector_gdpr_requests", time: "receivedAt" },
  { id: "wc_connector_webhook_events", table: "wc_connector_webhook_events", time: "receivedAt" },
]);

/**
 * Intake is counted from this long before the first sample, so a clock
 * difference between the application (which stamps some rows itself) and the
 * database cannot hide a row. It errs towards reporting producers as active.
 */
export const INTAKE_CLOCK_MARGIN_SECONDS = 60;

/** What this preflight cannot see. Printed with every report. */
export const COVERAGE_GAPS = Object.freeze([
  "woodcore_mirror_sync_state_is_in_process_memory_only",
  "in_process_producers_leave_no_durable_marker_except_schedule_runs_and_uploads",
  "tracked_background_effects_leave_no_durable_marker",
  "http_requests_in_flight_are_not_visible",
  "replica_count_and_other_replicas_processes_are_not_visible",
  "effective_provider_draining_and_overlap_snapshot_is_not_visible",
  "pid1_signal_forwarding_is_classified_not_proven",
  "other_deployments_sharing_the_database_are_not_distinguished",
  "database_background_writers_and_open_transactions_are_not_inspected",
  "upstream_redelivery_and_catch_up_correctness_are_not_assessed",
  "external_schedulers_are_producers_whose_state_is_not_visible",
  "database_user_privileges_are_not_inspected",
]);

/** The variables the script reads. Only these are ever taken from another process. */
export const ENV_KEYS = Object.freeze([
  "DATABASE_URL",
  "REDIS_URL",
  "RAILWAY_REPLICA_ID",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_DEPLOYMENT_DRAINING_SECONDS",
  "RAILWAY_DEPLOYMENT_OVERLAP_SECONDS",
  "RECONCILEAI_DRAIN_TIMEOUT_MS",
  "RECONCILEAI_STARTUP_MODE",
  "NODE_ENV",
  "DEPLOYMENT_MODE",
  "RECONCILIATION_REQUIRE_DURABLE_QUEUE",
]);

// ─── Guards ───────────────────────────────────────────────────────────────────

export class GuardError extends Error {
  constructor(code) {
    super(code);
    this.name = "GuardError";
    this.code = code;
  }
}

/** Session statements the script issues besides its SELECTs, verbatim. */
export const SESSION_STATEMENTS = Object.freeze([
  "SET time_zone = '+00:00'",
  "START TRANSACTION WITH CONSISTENT SNAPSHOT",
  "ROLLBACK",
]);

const FORBIDDEN_SQL =
  /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|ALTER|DROP|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|DO|HANDLER|LOAD|INTO|OUTFILE|DUMPFILE|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|FLUSH|KILL|SHUTDOWN|PREPARE|EXECUTE|DEALLOCATE|SET|SHOW)\b|FOR\s+UPDATE|FOR\s+SHARE|IN\s+SHARE\s+MODE|;/i;

/** Only a constant SELECT, or one of the session statements above, passes. */
export function assertReadOnlySql(sql) {
  if (typeof sql !== "string") throw new GuardError("sql_refused");
  if (SESSION_STATEMENTS.includes(sql)) return sql;
  if (!/^SELECT\s/.test(sql) || FORBIDDEN_SQL.test(sql)) throw new GuardError("sql_refused");
  return sql;
}

const QUEUE_KEY = /^bull:([^:]+):(.+)$/;
const STATE_SUFFIXES = new Set([...RUNNABLE_LISTS, ...RUNNABLE_ZSETS, ...INFO_ZSETS, "stalled", "meta", "id"]);
const LIST_STATES = new Set(RUNNABLE_LISTS);
const ZSET_STATES = new Set([...RUNNABLE_ZSETS, ...INFO_ZSETS]);
const ATTEMPT_FIELDS = new Set(["atm", "attemptsMade", "stc"]);

/**
 * Read-only Redis commands, each limited to the key and field shapes it needs.
 * A job hash is readable only for its attempt and stall counters.
 */
export function assertReadOnlyRedis(command, args) {
  const refuse = () => { throw new GuardError("redis_command_refused"); };
  if (!Array.isArray(args)) refuse();
  if (command === "PING") return args.length === 0 ? true : refuse();
  if (command === "SCAN") {
    // SCAN <cursor> MATCH bull:*:meta COUNT <n>
    const [cursor, match, pattern, count, n] = args;
    if (args.length !== 5 || !/^\d+$/.test(String(cursor)) || match !== "MATCH" || pattern !== "bull:*:meta" || count !== "COUNT" || !/^\d+$/.test(String(n))) refuse();
    return true;
  }
  const key = String(args[0] ?? "");
  const parts = QUEUE_KEY.exec(key);
  if (!parts) refuse();
  const [, , rest] = parts;
  switch (command) {
    case "LLEN":
      return args.length === 1 && LIST_STATES.has(rest) ? true : refuse();
    case "ZCARD":
      return args.length === 1 && ZSET_STATES.has(rest) ? true : refuse();
    case "SCARD":
      return args.length === 1 && rest === "stalled" ? true : refuse();
    case "LRANGE":
      return args.length === 3 && LIST_STATES.has(rest) && args[1] === "0" && /^\d+$/.test(String(args[2])) ? true : refuse();
    case "ZRANGE":
      return args.length === 3 && ZSET_STATES.has(rest) && args[1] === "0" && /^\d+$/.test(String(args[2])) ? true : refuse();
    case "HEXISTS":
      return args.length === 2 && rest === "meta" && args[1] === "paused" ? true : refuse();
    case "GET":
      return args.length === 1 && rest === "id" ? true : refuse();
    case "HMGET":
      if (args.length < 2 || STATE_SUFFIXES.has(rest) || rest.endsWith(":lock")) refuse();
      return args.slice(1).every((field) => ATTEMPT_FIELDS.has(field)) ? true : refuse();
    case "EXISTS":
      return args.length === 1 && rest.endsWith(":lock") && !STATE_SUFFIXES.has(rest.slice(0, -5)) ? true : refuse();
    default:
      return refuse();
  }
}

/** Every string the report may contain, apart from its generation time. */
const FIXED_LABELS = new Set([
  REPORT_SCHEMA,
  ...COVERAGE_GAPS,
  // verdicts
  "no_go_unfinished_work", "no_go_incomplete_evidence", "no_go_producers_active",
  "zero_observed_not_proof", "zero_observed_single_sample_not_proof",
  "fail_unfinished_work", "unknown_incomplete_evidence", "pass_zero_observed",
  "producers_active", "no_intake_observed", "not_measured",
  // readings
  "ok", "partial", "complete", "unknown", "not_configured", "unreachable", "auth_refused", "access_denied",
  "table_missing", "column_missing", "query_timeout", "write_refused", "query_failed", "read_failed", "timeout",
  "driver_unavailable", "guard_refused", "session_refused", "budget_exceeded",
  "tls_certificate_refused", "tls_hostname_refused", "tls_unavailable", "tls_unverified",
  // controls and routes
  "consistent_snapshot", "per_statement", "tidb", "mysql", "statement_guard_only",
  "local_loopback", "tls_verified_identity", "tls_verified", "railway_private_network",
  // how the application's own database URL asks for TLS
  "not_requested", "verified_certificate_and_hostname", "verified_certificate_only", "unverified",
  // deployment
  "railway_runtime", "unset", "set", "invalid",
  "default", "invalid_app_refuses_to_start", "normal", "maintenance", "production", "development",
  "test", "other", "cloud", "on_premise", "pnpm_start", "direct_node_exec", "absent",
  // processes
  "node_dist_index", "pnpm", "npm", "shell", "node_other", "not_in_service_container", "proc_unreadable",
  // where the settings came from
  "own", "app_process",
  // groups
  "reconciliation", "accepted", "work", "parked", "subset",
]);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REPORT_KEY = /^[a-z0-9_.:-]{1,96}$/i;

/** Throws unless the report holds only numbers, booleans, nulls and fixed labels. */
export function assertAggregateOnly(value, depth = 0) {
  if (depth > 12) throw new GuardError("output_refused");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new GuardError("output_refused");
    return;
  }
  if (typeof value === "string") {
    if (FIXED_LABELS.has(value) || ISO_TIME.test(value)) return;
    throw new GuardError("output_refused");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertAggregateOnly(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!REPORT_KEY.test(key)) throw new GuardError("output_refused");
      assertAggregateOnly(item, depth + 1);
    }
    return;
  }
  throw new GuardError("output_refused");
}

/** Node's names for a certificate the TLS layer would not accept. */
const TLS_CERTIFICATE_CODE = /CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_/;

/** An error, as a fixed code. Never its message. */
export function errorCode(error) {
  if (error instanceof GuardError) return error.code === "budget_exceeded" ? "budget_exceeded" : "guard_refused";
  const code = String(error?.code ?? "");
  const text = String(error?.message ?? "");
  // mysql2 reports every failed TLS upgrade as HANDSHAKE_SSL_ERROR, keeping
  // Node's message: a name mismatch is told apart by it, never printed.
  if (code === "HANDSHAKE_NO_SSL_SUPPORT") return "tls_unavailable";
  if (code === "HANDSHAKE_SSL_ERROR") return /altnames|does not match certificate/i.test(text) ? "tls_hostname_refused" : "tls_certificate_refused";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "tls_hostname_refused";
  if (/^ERR_SSL_/.test(code)) return "tls_unavailable";
  // Server codes (ER_UNABLE_TO_…) are not certificate failures.
  if (!code.startsWith("ER_") && TLS_CERTIFICATE_CODE.test(code)) return "tls_certificate_refused";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "PROTOCOL_CONNECTION_LOST"].includes(code)) return "unreachable";
  if (["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR"].includes(code)) return "access_denied";
  if (code === "ER_NO_SUCH_TABLE") return "table_missing";
  if (code === "ER_BAD_FIELD_ERROR") return "column_missing";
  if (code === "ER_QUERY_TIMEOUT" || code === "ER_QUERY_INTERRUPTED" || code === "PROTOCOL_SEQUENCE_TIMEOUT") return "query_timeout";
  if (code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION") return "write_refused";
  if (/^(NOAUTH|WRONGPASS)/.test(text)) return "auth_refused";
  if (/Command timed out/i.test(text)) return "timeout";
  if (/Connection is closed|connect ETIMEDOUT|Stream isn't writeable|closed state/i.test(text)) return "unreachable";
  return code.startsWith("ER_") ? "query_failed" : "read_failed";
}

/** The exit status for a refusal or failure code. */
export function exitStatusFor(code) {
  if (code === "usage_error" || code === "budget_too_short") return EXIT.usage;
  if (/^(identity|route)_/.test(code)) return EXIT.refused;
  if (code === "interrupted") return EXIT.interrupted;
  return EXIT.failed;
}

// ─── The budget ──────────────────────────────────────────────────────────────

/** A deadline for the whole run. `tripped` once anything was cut off by it. */
export function createDeadline(ms) {
  const endsAt = Date.now() + ms;
  let tripped = false;
  return {
    remainingMs: () => Math.max(0, endsAt - Date.now()),
    expired: () => Date.now() >= endsAt,
    tripped: () => tripped,
    trip() {
      tripped = true;
    },
    assert() {
      if (Date.now() >= endsAt) {
        tripped = true;
        throw new GuardError("budget_exceeded");
      }
    },
  };
}

/** For direct calls (tests): no budget beyond each call's own timeout. */
const NO_DEADLINE = Object.freeze({
  remainingMs: () => Number.POSITIVE_INFINITY,
  expired: () => false,
  tripped: () => false,
  trip() {},
  assert() {},
});

/** A failure's code, or budget_exceeded once the budget cut the run. */
function failureCode(error, deadline) {
  return deadline.tripped() || deadline.expired() ? "budget_exceeded" : errorCode(error);
}

/** Waits for `promise`, but no longer than `ms`; never throws. */
async function settleWithin(promise, ms) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Arguments and settings ──────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    samples: 3,
    intervalSeconds: 60,
    budgetSeconds: DEFAULT_BUDGET_SECONDS,
    expectDeployment: null,
    expectCommit: null,
    envFromApp: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // A repeated option is ambiguous: which value did the operator mean?
    if (seen.has(flag)) throw new GuardError("usage_error");
    seen.add(flag);
    if (flag === "--env-from-app") {
      opts.envFromApp = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) throw new GuardError("usage_error");
    if (flag === "--samples" && /^\d{1,2}$/.test(value) && +value >= 1 && +value <= 10) opts.samples = +value;
    else if (flag === "--interval-seconds" && /^\d{1,3}$/.test(value) && +value >= 1 && +value <= 600) opts.intervalSeconds = +value;
    else if (flag === "--budget-seconds" && /^\d{1,3}$/.test(value) && +value >= MIN_BUDGET_SECONDS && +value <= MAX_BUDGET_SECONDS) opts.budgetSeconds = +value;
    // Their values are judged by checkExpectations, which refuses with an identity code.
    else if (flag === "--expect-deployment") opts.expectDeployment = value;
    else if (flag === "--expect-commit") opts.expectCommit = value;
    else throw new GuardError("usage_error");
  }
  // A budget that cannot hold the sampling it was given for would only ever
  // end in incomplete evidence.
  if (opts.budgetSeconds < (opts.samples - 1) * opts.intervalSeconds + SAMPLE_ALLOWANCE_SECONDS * opts.samples) {
    throw new GuardError("budget_too_short");
  }
  return opts;
}

// ─── Identity: checked before anything is loaded or connected ───────────────

const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Published example identifiers, and constants that name no deployment or commit. */
const KNOWN_PLACEHOLDERS = new Set([
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426655440000",
  "550e8400-e29b-41d4-a716-446655440000",
  "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
]);

/**
 * Whether a well-formed identifier is a stand-in rather than a real one. Real
 * deployment ids and commit SHAs are random: one with under six distinct
 * digits, a repeating pattern or a counting run of eight is typed by a person
 * (0000…, deadbeef…, 1234567890abcdef…). The chance of a real one being
 * refused is below one in a million.
 */
export function isPlaceholderIdentifier(value) {
  if (KNOWN_PLACEHOLDERS.has(value)) return true;
  const hex = value.replace(/-/g, "");
  if (new Set(hex).size < 6) return true;
  for (let period = 1; period <= hex.length / 2; period += 1) {
    let repeats = true;
    for (let i = period; i < hex.length && repeats; i += 1) repeats = hex[i] === hex[i - period];
    if (repeats) return true;
  }
  let up = 1;
  let down = 1;
  for (let i = 1; i < hex.length; i += 1) {
    const step = Number.parseInt(hex[i], 16) - Number.parseInt(hex[i - 1], 16);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= 8 || down >= 8) return true;
  }
  return false;
}

/** The expected identity must be given, complete and real, or nothing runs. */
export function checkExpectations(opts) {
  const check = (value, shape, name) => {
    if (value === null || value === "") throw new GuardError(`identity_expected_${name}_missing`);
    if (!shape.test(value)) throw new GuardError(`identity_expected_${name}_malformed`);
    if (isPlaceholderIdentifier(value)) throw new GuardError(`identity_expected_${name}_placeholder`);
  };
  check(opts.expectDeployment, DEPLOYMENT_ID, "deployment");
  check(opts.expectCommit, COMMIT_SHA, "commit");
}

/**
 * The variables to use: this process's own, or, with --env-from-app, the one
 * running application's. Anything short of exactly one readable application
 * process is refused; there is no fallback.
 */
export function selectEnvironment(opts, ownEnv, procRoot = "/proc") {
  if (!opts.envFromApp) return { source: "own", env: ownEnv };
  const app = readAppEnvironment(procRoot);
  if (app.source !== "app_process") throw new GuardError(`identity_${app.source}`);
  // The application's values are authoritative, including its unset ones.
  const env = Object.fromEntries(Object.entries(ownEnv).filter(([key]) => !ENV_KEYS.includes(key)));
  return { source: "app_process", env: Object.assign(env, app.env) };
}

/** The deployment the variables belong to must be the one the operator named. */
export function verifyIdentity(env, opts) {
  if (!env.RAILWAY_REPLICA_ID) throw new GuardError("identity_not_railway_runtime");
  if (!env.RAILWAY_DEPLOYMENT_ID) throw new GuardError("identity_deployment_missing");
  if (env.RAILWAY_DEPLOYMENT_ID.toLowerCase() !== opts.expectDeployment) throw new GuardError("identity_deployment_mismatch");
  if (!env.RAILWAY_GIT_COMMIT_SHA) throw new GuardError("identity_commit_missing");
  if (env.RAILWAY_GIT_COMMIT_SHA.toLowerCase() !== opts.expectCommit) throw new GuardError("identity_commit_mismatch");
}

// ─── Routes: judged before anything is connected ─────────────────────────────

/** A loopback IP literal. A name, even "localhost", is not: names are verified over TLS. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "");
  if (net.isIPv4(host)) return host.startsWith("127.");
  return host === "::1";
}

/** How the application's own DATABASE_URL asks mysql2 for TLS: a label, never the setting. */
export function applicationDatabaseTls(ssl) {
  if (!ssl) return "not_requested";
  if (typeof ssl !== "object" || Array.isArray(ssl)) return "invalid";
  if (ssl.rejectUnauthorized === false) return "unverified";
  return ssl.verifyIdentity === true ? "verified_certificate_and_hostname" : "verified_certificate_only";
}

/**
 * The database connection, from DATABASE_URL parsed exactly as mysql2 parses a
 * URI. Off the loopback interface it ALWAYS verifies the server's certificate
 * and host name: mysql2 checks the name only when verifyIdentity is set, and a
 * URL may switch certificate checks off. Other URL options are not used.
 */
export function planDatabaseRoute(raw) {
  if (!raw) return { route: "not_configured", application_tls: "not_configured" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError("route_database_url_invalid");
  }
  let ssl;
  const sslText = url.searchParams.get("ssl");
  if (sslText !== null) {
    try {
      ssl = JSON.parse(sslText);
    } catch {
      ssl = sslText;
    }
  }
  const applicationTls = applicationDatabaseTls(ssl);
  // The application itself cannot connect with such a setting (mysql2 throws).
  if (applicationTls === "invalid") throw new GuardError("route_database_tls_setting_unsupported");
  let target;
  try {
    target = {
      host: decodeURIComponent(url.hostname),
      port: Number.parseInt(url.port, 10) || 3306,
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    throw new GuardError("route_database_url_invalid");
  }
  if (!target.host) throw new GuardError("route_database_url_invalid");
  const loopback = isLoopbackHost(target.host);
  const asked = ssl && typeof ssl === "object" ? ssl : undefined;
  return {
    route: loopback ? "local_loopback" : "tls_verified_identity",
    application_tls: applicationTls,
    connection: {
      ...target,
      ssl: loopback ? (asked ? { ...asked } : undefined) : { ...asked, rejectUnauthorized: true, verifyIdentity: true },
    },
  };
}

const PRIVATE_NETWORK_SUFFIX = ".railway.internal";

function normalisedHost(host) {
  return String(host ?? "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/**
 * Where REDIS_URL leads. Allowed: Railway's private network, TLS (verified by
 * Node's defaults), or the loopback interface. A public plaintext route, such
 * as a TCP proxy, is refused. Only `family` may appear among the URL's
 * options: ioredis copies every option into its own settings.
 */
export function planRedisRoute(raw) {
  const text = raw?.trim();
  if (!text) return { route: "not_configured" };
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new GuardError("route_redis_url_invalid");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new GuardError("route_redis_url_invalid");
  for (const key of url.searchParams.keys()) {
    if (key !== "family") throw new GuardError("route_redis_url_options_unsupported");
  }
  const host = normalisedHost(url.hostname);
  if (!host) throw new GuardError("route_redis_url_invalid");
  const tls = url.protocol === "rediss:";
  let route;
  if (tls) route = "tls_verified";
  else if (isLoopbackHost(host)) route = "local_loopback";
  else if (host.endsWith(PRIVATE_NETWORK_SUFFIX) && host.length > PRIVATE_NETWORK_SUFFIX.length) route = "railway_private_network";
  else throw new GuardError("route_redis_not_private");
  return { route, url: text, host, tls };
}

export function readWholeNumber(raw) {
  if (raw === undefined || raw === "") return { state: "unset", value: null };
  if (!/^\d{1,9}$/.test(raw)) return { state: "invalid", value: null };
  return { state: "set", value: Number(raw) };
}

/** Mirrors server/maintenance/config.ts readDrainTimeout without importing it. */
export function readDrainTimeoutSetting(raw) {
  if (raw === undefined) return { state: "default", value: 90_000 };
  if (!/^\d+$/.test(raw)) return { state: "invalid_app_refuses_to_start", value: null };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) return { state: "invalid_app_refuses_to_start", value: null };
  return { state: "set", value: parsed };
}

/** Mirrors readStartupMode: unset or exactly "normal" is normal; anything else but "maintenance" stops startup. */
export function readStartupModeSetting(raw) {
  if (raw === undefined || raw === "normal") return "normal";
  return raw === "maintenance" ? "maintenance" : "invalid";
}

function oneOf(raw, allowed, unsetLabel = "unset") {
  if (raw === undefined || raw === "") return unsetLabel;
  return allowed.includes(raw) ? raw : "other";
}

export function classifyStartCommand(command) {
  if (typeof command !== "string") return "absent";
  if (/^\s*pnpm\s+start\s*$/.test(command)) return "pnpm_start";
  if (/\bexec\s+node\s+dist\/index\.js\b/.test(command)) return "direct_node_exec";
  return "other";
}

export function inspectRecipe(appDir) {
  const file = path.join(appDir, "railway.json");
  if (!existsSync(file)) return { present: false };
  try {
    const deploy = JSON.parse(readFileSync(file, "utf8"))?.deploy ?? {};
    const timing = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    return {
      present: true,
      draining_seconds_set: deploy.drainingSeconds !== undefined,
      draining_seconds: timing(deploy.drainingSeconds),
      overlap_seconds_set: deploy.overlapSeconds !== undefined,
      overlap_seconds: timing(deploy.overlapSeconds),
      start_command_kind: classifyStartCommand(deploy.startCommand),
    };
  } catch {
    return { present: true, unreadable: true };
  }
}

/** The deployment's settings. Called only once verifyIdentity has passed. */
export function inspectDeployment(env, appDir, databasePlan) {
  return {
    runtime: "railway_runtime",
    // Both were required to match before anything was connected.
    identity: { deployment_matches_expected: true, commit_matches_expected: true },
    recipe: inspectRecipe(appDir),
    provider_overrides: {
      draining_seconds: readWholeNumber(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS),
      overlap_seconds: readWholeNumber(env.RAILWAY_DEPLOYMENT_OVERLAP_SECONDS),
    },
    application: {
      drain_timeout_ms: readDrainTimeoutSetting(env.RECONCILEAI_DRAIN_TIMEOUT_MS),
      startup_mode: readStartupModeSetting(env.RECONCILEAI_STARTUP_MODE),
      node_env: oneOf(env.NODE_ENV, ["production", "development", "test"]),
      deployment_mode: oneOf((env.DEPLOYMENT_MODE ?? "cloud").toLowerCase(), ["cloud", "on_premise"]),
      reconciliation_require_durable_queue: /^(1|true)$/i.test(env.RECONCILIATION_REQUIRE_DURABLE_QUEUE ?? ""),
      database_configured: Boolean(env.DATABASE_URL),
      redis_configured: Boolean(env.REDIS_URL?.trim()),
      // How the application's own connection asks for TLS. The preflight's own
      // connection verifies certificate and host name regardless.
      database_tls: databasePlan.application_tls,
    },
    // The provider's stored draining/overlap for the RUNNING deployment is not
    // visible from inside it; only the owner's dashboard shows it.
    effective_draining_proven: false,
  };
}

// ─── Processes (only inside the service container) ───────────────────────────

/** Whether a /proc status text marks SIGTERM (signal 15, mask bit 14) in a field. */
export function signalMaskHas(statusText, field, signal = 15) {
  const match = new RegExp(`^${field}:\\s*([0-9a-fA-F]+)\\s*$`, "m").exec(statusText ?? "");
  if (!match) return null;
  return ((BigInt(`0x${match[1]}`) >> BigInt(signal - 1)) & 1n) === 1n;
}

/** A fixed class for a process's argv. Nothing from argv is ever printed. */
export function classifyCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "other";
  const names = argv.map((arg) => path.basename(String(arg)));
  if (argv.some((arg) => /(^|\/)dist\/index\.js$/.test(String(arg))) && !names.some((n) => /^pnpm/.test(n))) return "node_dist_index";
  if (names.some((n) => /^pnpm(\.c?js)?$/.test(n))) return "pnpm";
  if (names.some((n) => /^npm(-cli\.js)?$/.test(n))) return "npm";
  if (["bash", "sh", "dash"].includes(names[0])) return "shell";
  if (names[0] === "node") return "node_other";
  return "other";
}

function readArgv(procRoot, pid) {
  return readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean);
}

/** Process ids running the built application (node dist/index.js), never this one. */
function findAppPids(procRoot) {
  const pids = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || +entry === process.pid) continue;
    try {
      if (classifyCommand(readArgv(procRoot, entry)) === "node_dist_index") pids.push(+entry);
    } catch {
      // The process exited while being read.
    }
  }
  return pids;
}

/**
 * The application's own values for ENV_KEYS, read from its process's
 * environment. Every other variable is ignored, and no value is printed. The
 * source says why when there is no single readable application process.
 */
export function readAppEnvironment(procRoot = "/proc") {
  let pids;
  try {
    pids = findAppPids(procRoot);
  } catch {
    return { source: "app_process_unreadable", env: {} };
  }
  if (pids.length === 0) return { source: "app_process_not_found", env: {} };
  if (pids.length > 1) return { source: "app_process_ambiguous", env: {} };
  try {
    const env = {};
    for (const entry of readFileSync(path.join(procRoot, String(pids[0]), "environ"), "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0 && ENV_KEYS.includes(entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return { source: "app_process", env };
  } catch {
    return { source: "app_process_unreadable", env: {} };
  }
}

/** The kinds of process from `pid` up to PID 1: the chain a stop signal must cross. */
export function launcherChain(procRoot, pid) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < 12 && current >= 1; depth += 1) {
    chain.push(classifyCommand(readArgv(procRoot, current)));
    if (current === 1) break;
    const status = readFileSync(path.join(procRoot, String(current), "status"), "utf8");
    const parent = /^PPid:\s*(\d+)\s*$/m.exec(status);
    current = parent ? Number(parent[1]) : 0;
  }
  return chain;
}

export function inspectProcesses(env, procRoot = "/proc") {
  if (!env.RAILWAY_REPLICA_ID) return { inspected: false, reason: "not_in_service_container" };
  try {
    const pid1Argv = readArgv(procRoot, 1);
    const pid1Status = readFileSync(path.join(procRoot, "1", "status"), "utf8");
    const appPids = findAppPids(procRoot);
    let appCatchesSigterm = null;
    let chain = [];
    if (appPids.length > 0) {
      appCatchesSigterm = signalMaskHas(readFileSync(path.join(procRoot, String(appPids[0]), "status"), "utf8"), "SigCgt");
      chain = launcherChain(procRoot, appPids[0]);
    }
    return {
      inspected: true,
      pid1_kind: classifyCommand(pid1Argv),
      pid1_catches_sigterm: signalMaskHas(pid1Status, "SigCgt"),
      pid1_ignores_sigterm: signalMaskHas(pid1Status, "SigIgn"),
      app_process_count: appPids.length,
      app_is_pid1: appPids.includes(1),
      app_catches_sigterm: appCatchesSigterm,
      // From the app up to PID 1, e.g. node_dist_index, shell, pnpm.
      app_launcher_chain: chain,
    };
  } catch {
    return { inspected: false, reason: "proc_unreadable" };
  }
}

// ─── Database ────────────────────────────────────────────────────────────────

/**
 * Count, oldest age, and two age buckets. A crash leaves rows in unfinished
 * states for good (production defers stuck-job recovery), so the buckets let a
 * reader tell such leftovers from live work. The verdict still counts both.
 */
export function surfaceSql(surface) {
  const t = surface.time;
  return assertReadOnlySql(
    `SELECT /*+ MAX_EXECUTION_TIME(10000) */ COUNT(*) AS n, TIMESTAMPDIFF(MINUTE, MIN(${t}), NOW()) AS oldest_minutes, SUM(${t} >= NOW() - INTERVAL 15 MINUTE) AS under_15_minutes, SUM(${t} < NOW() - INTERVAL 1 DAY) AS over_1_day FROM ${surface.table} WHERE ${surface.where}`,
  );
}

export function intakeSql(source) {
  return assertReadOnlySql(
    `SELECT /*+ MAX_EXECUTION_TIME(10000) */ COUNT(*) AS n FROM ${source.table} WHERE ${source.time} >= NOW() - INTERVAL ? SECOND`,
  );
}

/** Every statement the script can send to the database, for the guard tests. */
export function allSqlStatements() {
  return [
    ...SESSION_STATEMENTS,
    "SELECT VERSION() AS v",
    ...DB_SURFACES.map(surfaceSql),
    ...INTAKE_SOURCES.map(intakeSql),
  ];
}

function appRequire(appDir) {
  return createRequire(path.join(appDir, "package.json"));
}

/** Connects as `plan` (planDatabaseRoute) says. Failures come back as `{ error }` with a fixed code. */
export async function openDatabase(plan, appDir, deadline = NO_DEADLINE) {
  if (plan.route === "not_configured") return { error: "not_configured" };
  let mysql;
  try {
    mysql = appRequire(appDir)("mysql2/promise");
  } catch {
    return { error: "driver_unavailable" };
  }
  let connection;
  try {
    deadline.assert();
    connection = await mysql.createConnection({
      ...plan.connection,
      multipleStatements: false,
      connectTimeout: Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline.remainingMs())),
    });
  } catch (error) {
    return { error: failureCode(error, deadline) };
  }
  // A connection lost between samples would otherwise crash the process and
  // print its message. The next statement fails instead, as a fixed code.
  connection.on("error", () => {});
  if (plan.route === "tls_verified_identity") {
    // Proof, not trust in options: the socket the statements will use is
    // encrypted, and its certificate chain was accepted.
    const stream = connection.connection?.stream;
    if (stream?.encrypted !== true || stream.authorized !== true) {
      connection.destroy();
      return { error: "tls_unverified" };
    }
  }
  const run = async (sql, params) => {
    const statement = assertReadOnlySql(sql);
    deadline.assert();
    const timeout = Math.max(1, Math.min(QUERY_TIMEOUT_MS, deadline.remainingMs()));
    try {
      const [rows] = await connection.query({ sql: statement, timeout }, params ?? []);
      return rows;
    } catch (error) {
      // A statement that timed out keeps the connection busy: drop it.
      if (error?.code === "PROTOCOL_SEQUENCE_TIMEOUT") connection.destroy();
      throw error;
    }
  };
  const controls = { engine: "unknown", session_time_zone_utc: false, snapshot: "per_statement" };
  try {
    const [{ v }] = await run("SELECT VERSION() AS v");
    controls.engine = /tidb/i.test(String(v)) ? "tidb" : "mysql";
  } catch {
    // Reported as unknown.
  }
  try {
    await run("SET time_zone = '+00:00'");
    controls.session_time_zone_utc = true;
  } catch {
    // Reported as false; ages may then be off by the session's offset.
  }
  return {
    controls,
    // One snapshot per sample, so its counts describe one moment. Rolled back
    // after; it never holds a write.
    async beginSnapshot() {
      try {
        await run("START TRANSACTION WITH CONSISTENT SNAPSHOT");
        controls.snapshot = "consistent_snapshot";
      } catch {
        controls.snapshot = "per_statement";
      }
    },
    async endSnapshot() {
      try {
        await run("ROLLBACK");
      } catch {
        // Nothing was written; a failed ROLLBACK changes nothing.
      }
    },
    run,
    /** The budget ran out: drop the connection, so anything waiting on it fails now. */
    abort() {
      connection.destroy();
    },
    async close() {
      await settleWithin(connection.end(), CLOSE_GRACE_MS);
      connection.destroy();
    },
  };
}

async function sampleDatabase(db, windowSeconds, deadline) {
  const surfaces = {};
  const intake = {};
  if (db.error) {
    for (const s of DB_SURFACES) surfaces[s.id] = { reading: "unknown", error: db.error };
    for (const i of INTAKE_SOURCES) intake[i.id] = { reading: "unknown", error: db.error };
    return { surfaces, intake };
  }
  await db.beginSnapshot();
  try {
    for (const s of DB_SURFACES) {
      try {
        const [row] = await db.run(surfaceSql(s));
        surfaces[s.id] = {
          reading: "ok",
          count: Number(row.n),
          oldest_minutes: row.oldest_minutes === null ? null : Math.max(0, Number(row.oldest_minutes)),
          under_15_minutes: Number(row.under_15_minutes ?? 0),
          over_1_day: Number(row.over_1_day ?? 0),
        };
      } catch (error) {
        surfaces[s.id] = { reading: "unknown", error: failureCode(error, deadline) };
      }
    }
    for (const i of INTAKE_SOURCES) {
      if (windowSeconds === null) {
        intake[i.id] = { reading: "not_measured" };
        continue;
      }
      try {
        const [row] = await db.run(intakeSql(i), [windowSeconds]);
        intake[i.id] = { reading: "ok", count: Number(row.n) };
      } catch (error) {
        intake[i.id] = { reading: "unknown", error: failureCode(error, deadline) };
      }
    }
  } finally {
    await db.endSnapshot();
  }
  return { surfaces, intake };
}

// ─── Redis ───────────────────────────────────────────────────────────────────

/**
 * Builds the client without connecting, then checks ioredis reads the URL as
 * planRedisRoute did: the same host, TLS or not, and no socket path. A
 * difference is refused before any connection exists.
 */
export function prepareRedis(plan, appDir) {
  if (plan.route === "not_configured") return { error: "not_configured" };
  let IORedis;
  try {
    const require = appRequire(appDir);
    const fromBullmq = createRequire(require.resolve("bullmq"));
    const loaded = fromBullmq("ioredis");
    IORedis = loaded.default ?? loaded.Redis ?? loaded;
  } catch {
    return { error: "driver_unavailable" };
  }
  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: () => null,
    // ioredis otherwise sends CLIENT SETINFO on connect. The session then
    // carries only AUTH (when the URL has credentials), SELECT (when it names
    // a database), the guarded reads, and QUIT.
    disableClientInfo: true,
  };
  // Node's defaults verify the chain and the host name; this only makes sure
  // nothing switches the chain check off.
  if (plan.tls) options.tls = { rejectUnauthorized: true };
  let client;
  try {
    client = new IORedis(plan.url, options);
  } catch {
    return { error: "driver_unavailable" };
  }
  // Surfaced through the failing command as a fixed code. A failed TLS
  // handshake reaches only this event (connect() then reports a closed
  // connection), so the last one is kept to name the refusal.
  let lastError;
  client.on("error", (error) => {
    lastError = error;
  });
  const parsed = client.options;
  if (normalisedHost(parsed.host) !== plan.host || Boolean(parsed.tls) !== plan.tls || parsed.path) {
    client.disconnect();
    throw new GuardError("route_redis_url_invalid");
  }
  return { client, tls: plan.tls, lastError: () => lastError };
}

export async function connectRedis(prepared, deadline = NO_DEADLINE) {
  if (prepared.error) return { error: prepared.error };
  const { client } = prepared;
  try {
    deadline.assert();
    client.options.connectTimeout = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline.remainingMs()));
    await client.connect();
  } catch (error) {
    client.disconnect();
    return { error: failureCode(prepared.lastError?.() ?? error, deadline) };
  }
  if (prepared.tls && (client.stream?.encrypted !== true || client.stream.authorized !== true)) {
    client.disconnect();
    return { error: "tls_unverified" };
  }
  const call = async (command, ...args) => {
    const strings = args.map(String);
    assertReadOnlyRedis(command, strings);
    deadline.assert();
    return client.call(command, ...strings);
  };
  try {
    await call("PING");
  } catch (error) {
    client.disconnect();
    return { error: failureCode(error, deadline) };
  }
  return {
    call,
    abort() {
      client.disconnect();
    },
    async close() {
      await settleWithin(client.quit(), CLOSE_GRACE_MS);
      client.disconnect();
    },
  };
}

/** Plans, prepares and connects in one step, for direct calls. */
export async function openRedis(raw, appDir, deadline = NO_DEADLINE) {
  return connectRedis(prepareRedis(planRedisRoute(raw), appDir), deadline);
}

function toCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * One known queue. Its state counts are exact; the job inspection that follows
 * (retries, stalls, lost locks) is capped at ID_SCAN_LIMIT ids per state, and
 * is labelled partial when capped or cut short.
 */
export async function readQueue(redis, name) {
  const base = `bull:${name}`;
  const states = {};
  for (const state of RUNNABLE_LISTS) states[state] = toCount(await redis.call("LLEN", `${base}:${state}`));
  for (const state of [...RUNNABLE_ZSETS, ...INFO_ZSETS]) states[state] = toCount(await redis.call("ZCARD", `${base}:${state}`));
  const stalledMarked = toCount(await redis.call("SCARD", `${base}:stalled`));
  const globallyPaused = toCount(await redis.call("HEXISTS", `${base}:meta`, "paused")) === 1;
  const idCounter = await redis.call("GET", `${base}:id`);

  let retrying = 0;
  let activeRetrying = 0;
  let previouslyStalled = 0;
  let activeWithoutLock = 0;
  let inspection = "complete";
  const seen = new Set();
  const inspect = async (state, kind) => {
    const ids = kind === "list"
      ? await redis.call("LRANGE", `${base}:${state}`, "0", String(ID_SCAN_LIMIT - 1))
      : await redis.call("ZRANGE", `${base}:${state}`, "0", String(ID_SCAN_LIMIT - 1));
    if (states[state] > ID_SCAN_LIMIT) inspection = "partial";
    for (const id of ids ?? []) {
      const jobKey = `${base}:${id}`;
      if (seen.has(`${state}|${id}`)) continue;
      seen.add(`${state}|${id}`);
      const [atm, legacyAttempts, stc] = await redis.call("HMGET", jobKey, "atm", "attemptsMade", "stc");
      const attempts = toCount(atm ?? legacyAttempts ?? 0);
      if (toCount(stc ?? 0) > 0) previouslyStalled += 1;
      if (state === "active") {
        if (attempts > 0) activeRetrying += 1;
        if (toCount(await redis.call("EXISTS", `${jobKey}:lock`)) === 0) activeWithoutLock += 1;
      } else if (attempts > 0) {
        retrying += 1;
      }
    }
  };
  try {
    for (const state of ["wait", "paused", "active"]) await inspect(state, "list");
    for (const state of ["delayed", "prioritized"]) await inspect(state, "zset");
  } catch {
    // The counts above stand; only the counters below are incomplete.
    inspection = "partial";
  }

  const runnable = [...RUNNABLE_LISTS, ...RUNNABLE_ZSETS].reduce((sum, state) => sum + states[state], 0);
  return {
    reading: "ok",
    runnable,
    ...Object.fromEntries(Object.entries(states).map(([state, n]) => [state.replace("-", "_"), n])),
    retrying_waiting_or_delayed: retrying,
    active_on_a_retry: activeRetrying,
    active_without_live_lock: activeWithoutLock,
    previously_stalled: previouslyStalled,
    stalled_marked: stalledMarked,
    globally_paused: globallyPaused,
    id_counter: idCounter === null ? null : toCount(idCounter),
    job_inspection: inspection,
  };
}

/**
 * Queues in Redis the code does not know. `ok` only when the key scan reached
 * its end and every queue found was counted; otherwise `partial`, with what was
 * seen. Work seen in a partial reading still counts.
 */
export async function readUnknownQueues(redis) {
  const names = new Set();
  let cursor = "0";
  let rounds = 0;
  let interrupted = false;
  try {
    do {
      const [next, keys] = await redis.call("SCAN", cursor, "MATCH", "bull:*:meta", "COUNT", String(SCAN_COUNT));
      for (const key of keys ?? []) {
        const name = String(key).slice("bull:".length, -":meta".length);
        if (!QUEUE_NAMES.includes(name) && !name.includes(":")) names.add(name);
      }
      cursor = String(next);
      rounds += 1;
    } while (cursor !== "0" && rounds < SCAN_ROUND_LIMIT);
  } catch (error) {
    // Without one completed round there is nothing to report.
    if (rounds === 0) throw error;
    interrupted = true;
  }
  let runnable = 0;
  let counted = 0;
  try {
    for (const name of names) {
      for (const state of RUNNABLE_LISTS) runnable += toCount(await redis.call("LLEN", `bull:${name}:${state}`));
      for (const state of RUNNABLE_ZSETS) runnable += toCount(await redis.call("ZCARD", `bull:${name}:${state}`));
      counted += 1;
    }
  } catch {
    interrupted = true;
  }
  const scanComplete = !interrupted && cursor === "0";
  return {
    reading: scanComplete && counted === names.size ? "ok" : "partial",
    count: names.size,
    runnable,
    scan_rounds: rounds,
    scan_complete: scanComplete,
  };
}

async function sampleRedis(redis, deadline) {
  const queues = {};
  if (redis.error) {
    for (const name of QUEUE_NAMES) queues[name] = { reading: "unknown", error: redis.error };
    return { queues, unknown_queues: { reading: "unknown", error: redis.error } };
  }
  for (const name of QUEUE_NAMES) {
    try {
      queues[name] = await readQueue(redis, name);
    } catch (error) {
      queues[name] = { reading: "unknown", error: failureCode(error, deadline) };
    }
  }
  let unknownQueues;
  try {
    unknownQueues = await readUnknownQueues(redis);
  } catch (error) {
    unknownQueues = { reading: "unknown", error: failureCode(error, deadline) };
  }
  return { queues, unknown_queues: unknownQueues };
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

/**
 * A group's verdict over its readings, each { total, missing }. Work seen in
 * any reading fails the group even if other readings are missing: a reading we
 * could not take never cancels one we did.
 */
function groupVerdict(readings) {
  if (readings.some((r) => r.total > 0)) return "fail_unfinished_work";
  if (readings.some((r) => r.missing)) return "unknown_incomplete_evidence";
  return "pass_zero_observed";
}

/**
 * `incomplete`: the run took fewer samples than it was asked for (the budget
 * ran out). Missing evidence then, unless work was seen.
 */
export function judge(samples, { incomplete = false } = {}) {
  const dbTotals = (group, sample) => {
    const reading = { total: 0, missing: false };
    for (const s of DB_SURFACES.filter((x) => x.group === group && x.kind === "work")) {
      const r = sample.database.surfaces[s.id];
      if (r?.reading === "ok") reading.total += r.count;
      else reading.missing = true;
    }
    return reading;
  };
  const queueTotal = (sample, names) => {
    const reading = { total: 0, missing: false };
    for (const name of names) {
      const r = sample.redis.queues[name];
      if (r?.reading === "ok") reading.total += r.runnable;
      else reading.missing = true;
    }
    return reading;
  };
  const reconciliation = groupVerdict(samples.flatMap((s) => [dbTotals("reconciliation", s), queueTotal(s, ["reconciliation-runs"])]));
  const accepted = groupVerdict(samples.map((s) => dbTotals("accepted", s)));
  const queues = groupVerdict(samples.map((s) => {
    const reading = queueTotal(s, QUEUE_NAMES);
    const unknown = s.redis.unknown_queues;
    // A partial discovery's work is real work; its gaps are missing evidence.
    if (unknown?.reading === "ok" || unknown?.reading === "partial") reading.total += toCount(unknown.runnable);
    if (unknown?.reading !== "ok") reading.missing = true;
    return reading;
  }));

  let producers = "not_measured";
  if (samples.length > 1) {
    let activity = false;
    let unknownIntake = false;
    for (const sample of samples.slice(1)) {
      for (const reading of Object.values(sample.database.intake)) {
        if (reading.reading === "ok" && reading.count > 0) activity = true;
        if (reading.reading === "unknown") unknownIntake = true;
      }
    }
    const first = samples[0].redis.queues;
    const last = samples[samples.length - 1].redis.queues;
    for (const name of QUEUE_NAMES) {
      if (first[name]?.reading === "ok" && last[name]?.reading === "ok" && first[name].id_counter !== last[name].id_counter) activity = true;
    }
    producers = activity ? "producers_active" : unknownIntake ? "unknown_incomplete_evidence" : "no_intake_observed";
  }

  const groups = [reconciliation, accepted, queues];
  let overall;
  if (groups.includes("fail_unfinished_work")) overall = "no_go_unfinished_work";
  else if (incomplete || samples.length === 0 || groups.includes("unknown_incomplete_evidence") || producers === "unknown_incomplete_evidence") overall = "no_go_incomplete_evidence";
  else if (producers === "producers_active") overall = "no_go_producers_active";
  else if (producers === "not_measured") overall = "zero_observed_single_sample_not_proof";
  else overall = "zero_observed_not_proof";
  return { reconciliation_unfinished: reconciliation, queues_runnable: queues, accepted_unfinished: accepted, producer_activity: producers, overall };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole check. `open` replaces the connection openers (tests count their
 * calls); `limits.budgetMs` replaces the budget (tests). The CLI sets neither.
 */
export async function runPreflight({ argv, env: ownEnv, appDir, procRoot = "/proc", log = () => {}, open = {}, limits = {} }) {
  const startedAt = Date.now();
  const opts = parseArgs(argv);

  // Nothing below is loaded or connected until the target is identified.
  checkExpectations(opts);
  const { source: envSource, env } = selectEnvironment(opts, ownEnv, procRoot);
  verifyIdentity(env, opts);
  const databasePlan = planDatabaseRoute(env.DATABASE_URL);
  const redisPlan = planRedisRoute(env.REDIS_URL);

  const openers = { database: openDatabase, prepareRedis, connectRedis, ...open };
  const budgetMs = limits.budgetMs ?? opts.budgetSeconds * 1000;
  const deadline = createDeadline(budgetMs);
  const generatedAt = new Date().toISOString();
  // Built without connecting, so a URL ioredis reads differently is refused
  // while nothing is connected.
  const preparedRedis = openers.prepareRedis(redisPlan, appDir);
  const db = await openers.database(databasePlan, appDir, deadline);
  const redis = await openers.connectRedis(preparedRedis, deadline);
  // When the budget runs out, drop the probe's own connections, so whatever is
  // waiting on them fails now and the report says the evidence is incomplete.
  const stop = setTimeout(() => {
    deadline.trip();
    db.abort?.();
    redis.abort?.();
  }, deadline.remainingMs());

  const samples = [];
  let stoppedEarly = false;
  const firstSampleAt = Date.now();
  try {
    for (let k = 1; k <= opts.samples; k += 1) {
      if (k > 1) {
        if (deadline.remainingMs() <= opts.intervalSeconds * 1000) {
          stoppedEarly = true;
          break;
        }
        await sleep(opts.intervalSeconds * 1000);
      }
      if (deadline.expired()) {
        stoppedEarly = true;
        break;
      }
      const windowSeconds = k === 1 ? null : Math.ceil((Date.now() - firstSampleAt) / 1000) + INTAKE_CLOCK_MARGIN_SECONDS;
      samples.push({
        sample: k,
        database: await sampleDatabase(db, windowSeconds, deadline),
        redis: await sampleRedis(redis, deadline),
      });
      log(`sample ${k}/${opts.samples} complete`);
    }
  } finally {
    clearTimeout(stop);
    await db.close?.();
    await redis.close?.();
  }
  const report = {
    schema: REPORT_SCHEMA,
    generated_at: generatedAt,
    sampling: {
      samples_requested: opts.samples,
      samples_taken: samples.length,
      interval_seconds: opts.intervalSeconds,
      budget_seconds: Math.ceil(budgetMs / 1000),
      budget_exhausted: stoppedEarly || deadline.tripped(),
      elapsed_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      intake_clock_margin_seconds: INTAKE_CLOCK_MARGIN_SECONDS,
      job_ids_inspected_per_state: ID_SCAN_LIMIT,
      queue_discovery_scan_count: SCAN_COUNT,
      queue_discovery_scan_round_limit: SCAN_ROUND_LIMIT,
    },
    read_only_controls: {
      sql_statement_guard: true,
      redis_command_guard: true,
      job_payload_fields_read: false,
      queue_objects_constructed: false,
      identity_verified_before_connecting: true,
      database_route: databasePlan.route,
      database_connection: db.error ?? "ok",
      redis_route: redisPlan.route,
      redis_connection: redis.error ?? "ok",
      engine: db.controls?.engine ?? "unknown",
      session_time_zone_utc: db.controls?.session_time_zone_utc ?? false,
      snapshot: db.controls?.snapshot ?? "per_statement",
      // On every engine. Only a SELECT-only database user would add the engine's own.
      database_write_prevention: "statement_guard_only",
    },
    deployment: { env_source: envSource, ...inspectDeployment(env, appDir, databasePlan) },
    processes: inspectProcesses(env, procRoot),
    samples,
    verdicts: judge(samples, { incomplete: samples.length < opts.samples }),
    coverage_gaps: [...COVERAGE_GAPS],
  };
  assertAggregateOnly(report);
  return report;
}

/**
 * The command. Prints the report and its two summary lines, or one fixed error
 * code, and exits with EXIT's status. `argv` is the options alone.
 */
export async function main(argv = process.argv.slice(2)) {
  // Nothing reaches the terminal but the report or a fixed code: an exception
  // from any callback would otherwise print its message and stack.
  const stop = (code) => {
    process.stdout.write(`${JSON.stringify({ schema: REPORT_SCHEMA, error: code })}\n`);
    process.exit(exitStatusFor(code));
  };
  process.on("uncaughtException", () => stop("preflight_failed"));
  process.on("unhandledRejection", () => stop("preflight_failed"));
  // Interrupted: the operating system closes the probe's own connections.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop("interrupted"));
  let report;
  try {
    report = await runPreflight({
      argv,
      env: process.env,
      appDir: process.cwd(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    stop(error instanceof GuardError ? error.code : "preflight_failed");
    return;
  }
  const v = report.verdicts;
  process.stdout.write(
    `${JSON.stringify(report)}\nVERDICT: ${v.overall}\n` +
      `GROUPS: reconciliation=${v.reconciliation_unfinished} queues=${v.queues_runnable} accepted=${v.accepted_unfinished} producers=${v.producer_activity}\n`,
  );
  process.exit(EXIT.report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
