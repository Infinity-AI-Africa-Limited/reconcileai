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
 * Run it from the application directory, so it uses the app's own mysql2 and
 * BullMQ's ioredis, with the service's DATABASE_URL and REDIS_URL:
 *   node production-workload-preflight.mjs --expect-deployment <id> --expect-commit <sha>
 * Options: --samples 1..10 (default 3), --interval-seconds 1..600 (default 60),
 * --env-from-app: take the variables in ENV_KEYS from the running application
 * process instead of this shell, for an operator shell that does not inherit
 * them. The values stay in this process; none is printed.
 *
 * Output: one line of JSON, then a VERDICT line and a GROUPS line.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPORT_SCHEMA = "reconcileai_workload_preflight_v1";

// ─── What is counted ──────────────────────────────────────────────────────────

/** Every queue the deployed code creates (server/jobQueue.ts callers). */
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

/** How many job ids per state are inspected for retry and stall counters. */
export const ID_SCAN_LIMIT = 1000;

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
  "ok", "unknown", "not_configured", "unreachable", "auth_refused", "access_denied", "table_missing",
  "column_missing", "query_timeout", "write_refused", "query_failed", "read_failed", "timeout",
  "driver_unavailable", "guard_refused", "session_refused",
  // controls
  "consistent_snapshot", "per_statement", "tidb", "mysql", "statement_guard_only",
  // deployment
  "railway_runtime", "railway_variables_without_runtime", "not_railway", "unset", "set", "invalid",
  "default", "invalid_app_refuses_to_start", "normal", "maintenance", "production", "development",
  "test", "other", "cloud", "on_premise", "pnpm_start", "direct_node_exec", "absent",
  // processes
  "node_dist_index", "pnpm", "npm", "shell", "node_other", "not_in_service_container", "proc_unreadable",
  // where the settings came from
  "own", "app_process", "pid1", "app_process_unreadable",
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

/** An error, as a fixed code. Never its message. */
export function errorCode(error) {
  if (error instanceof GuardError) return "guard_refused";
  const code = String(error?.code ?? "");
  const text = String(error?.message ?? "");
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "PROTOCOL_CONNECTION_LOST"].includes(code)) return "unreachable";
  if (["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR"].includes(code)) return "access_denied";
  if (code === "ER_NO_SUCH_TABLE") return "table_missing";
  if (code === "ER_BAD_FIELD_ERROR") return "column_missing";
  if (code === "ER_QUERY_TIMEOUT" || code === "ER_QUERY_INTERRUPTED") return "query_timeout";
  if (code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION") return "write_refused";
  if (/^(NOAUTH|WRONGPASS)/.test(text)) return "auth_refused";
  if (/Command timed out/i.test(text)) return "timeout";
  if (/Connection is closed|connect ETIMEDOUT|Stream isn't writeable|closed state/i.test(text)) return "unreachable";
  return code.startsWith("ER_") ? "query_failed" : "read_failed";
}

// ─── Arguments and settings ──────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { samples: 3, intervalSeconds: 60, expectDeployment: null, expectCommit: null, envFromApp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--env-from-app") {
      opts.envFromApp = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) throw new GuardError("usage_error");
    if (flag === "--samples" && /^\d{1,2}$/.test(value) && +value >= 1 && +value <= 10) opts.samples = +value;
    else if (flag === "--interval-seconds" && /^\d{1,3}$/.test(value) && +value >= 1 && +value <= 600) opts.intervalSeconds = +value;
    else if (flag === "--expect-deployment" && /^[a-z0-9-]{6,64}$/.test(value)) opts.expectDeployment = value;
    else if (flag === "--expect-commit" && /^[0-9a-f]{7,40}$/.test(value)) opts.expectCommit = value;
    else throw new GuardError("usage_error");
  }
  return opts;
}

/** A non-negative integer setting: unset, set (with its value) or invalid. */
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

function prefixMatch(actual, expected) {
  if (!actual) return { present: false, matches_expected: null };
  return { present: true, matches_expected: expected ? actual.startsWith(expected) : null };
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

export function inspectDeployment(env, opts, appDir) {
  const runtime = env.RAILWAY_REPLICA_ID
    ? "railway_runtime"
    : env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID
      ? "railway_variables_without_runtime"
      : "not_railway";
  return {
    runtime,
    deployment_id: prefixMatch(env.RAILWAY_DEPLOYMENT_ID, opts.expectDeployment),
    commit: prefixMatch(env.RAILWAY_GIT_COMMIT_SHA, opts.expectCommit),
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
 * The application's own values for ENV_KEYS, read from its process (or PID
 * 1's) environment. Every other variable is ignored, and no value is printed.
 */
export function readAppEnvironment(procRoot = "/proc") {
  let candidates = [];
  try {
    candidates = [...findAppPids(procRoot).slice(0, 1).map((pid) => [pid, "app_process"]), [1, "pid1"]];
  } catch {
    candidates = [[1, "pid1"]];
  }
  for (const [pid, source] of candidates) {
    try {
      const env = {};
      for (const entry of readFileSync(path.join(procRoot, String(pid), "environ"), "utf8").split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0 && ENV_KEYS.includes(entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      return { source, env };
    } catch {
      // Try the next process.
    }
  }
  return { source: "app_process_unreadable", env: {} };
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

export async function openDatabase(url, appDir) {
  if (!url) return { error: "not_configured" };
  let mysql;
  try {
    mysql = appRequire(appDir)("mysql2/promise");
  } catch {
    return { error: "driver_unavailable" };
  }
  let connection;
  try {
    connection = await mysql.createConnection({ uri: url, multipleStatements: false, connectTimeout: 10_000 });
  } catch (error) {
    return { error: errorCode(error) };
  }
  // A connection lost between samples would otherwise crash the process and
  // print its message. The next statement fails instead, as a fixed code.
  connection.on("error", () => {});
  const run = async (sql, params) => {
    const [rows] = await connection.query(assertReadOnlySql(sql), params ?? []);
    return rows;
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
    async close() {
      try {
        await connection.end();
      } catch {
        connection.destroy();
      }
    },
  };
}

async function sampleDatabase(db, windowSeconds) {
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
        surfaces[s.id] = { reading: "unknown", error: errorCode(error) };
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
        intake[i.id] = { reading: "unknown", error: errorCode(error) };
      }
    }
  } finally {
    await db.endSnapshot();
  }
  return { surfaces, intake };
}

// ─── Redis ───────────────────────────────────────────────────────────────────

export async function openRedis(url, appDir) {
  if (!url?.trim()) return { error: "not_configured" };
  let IORedis;
  try {
    const require = appRequire(appDir);
    const fromBullmq = createRequire(require.resolve("bullmq"));
    const loaded = fromBullmq("ioredis");
    IORedis = loaded.default ?? loaded.Redis ?? loaded;
  } catch {
    return { error: "driver_unavailable" };
  }
  const client = new IORedis(url.trim(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    retryStrategy: () => null,
  });
  client.on("error", () => {
    // Surfaced through the failing command as a fixed code.
  });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    return { error: errorCode(error) };
  }
  const call = async (command, ...args) => {
    assertReadOnlyRedis(command, args.map(String));
    return client.call(command, ...args.map(String));
  };
  try {
    await call("PING");
  } catch (error) {
    client.disconnect();
    return { error: errorCode(error) };
  }
  return {
    call,
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

function toCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

async function readQueue(redis, name) {
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
  let truncated = false;
  const seen = new Set();
  const inspect = async (state, kind) => {
    const ids = kind === "list"
      ? await redis.call("LRANGE", `${base}:${state}`, "0", String(ID_SCAN_LIMIT - 1))
      : await redis.call("ZRANGE", `${base}:${state}`, "0", String(ID_SCAN_LIMIT - 1));
    if (states[state] > ID_SCAN_LIMIT) truncated = true;
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
  for (const state of ["wait", "paused", "active"]) await inspect(state, "list");
  for (const state of ["delayed", "prioritized"]) await inspect(state, "zset");

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
    inspection_truncated: truncated,
  };
}

async function readUnknownQueues(redis) {
  const unknown = new Set();
  let cursor = "0";
  let rounds = 0;
  do {
    const [next, keys] = await redis.call("SCAN", cursor, "MATCH", "bull:*:meta", "COUNT", "500");
    for (const key of keys ?? []) {
      const name = String(key).slice("bull:".length, -":meta".length);
      if (!QUEUE_NAMES.includes(name) && !name.includes(":")) unknown.add(name);
    }
    cursor = String(next);
    rounds += 1;
  } while (cursor !== "0" && rounds < 200);
  let runnable = 0;
  for (const name of unknown) {
    for (const state of RUNNABLE_LISTS) runnable += toCount(await redis.call("LLEN", `bull:${name}:${state}`));
    for (const state of RUNNABLE_ZSETS) runnable += toCount(await redis.call("ZCARD", `bull:${name}:${state}`));
  }
  return { reading: "ok", count: unknown.size, runnable, scan_complete: cursor === "0" };
}

async function sampleRedis(redis) {
  const queues = {};
  if (redis.error) {
    for (const name of QUEUE_NAMES) queues[name] = { reading: "unknown", error: redis.error };
    return { queues, unknown_queues: { reading: "unknown", error: redis.error } };
  }
  for (const name of QUEUE_NAMES) {
    try {
      queues[name] = await readQueue(redis, name);
    } catch (error) {
      queues[name] = { reading: "unknown", error: errorCode(error) };
    }
  }
  let unknownQueues;
  try {
    unknownQueues = await readUnknownQueues(redis);
  } catch (error) {
    unknownQueues = { reading: "unknown", error: errorCode(error) };
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

export function judge(samples) {
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
    if (unknown?.reading === "ok") reading.total += unknown.runnable;
    else reading.missing = true;
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
  else if (groups.includes("unknown_incomplete_evidence") || producers === "unknown_incomplete_evidence") overall = "no_go_incomplete_evidence";
  else if (producers === "producers_active") overall = "no_go_producers_active";
  else if (producers === "not_measured") overall = "zero_observed_single_sample_not_proof";
  else overall = "zero_observed_not_proof";
  return { reconciliation_unfinished: reconciliation, queues_runnable: queues, accepted_unfinished: accepted, producer_activity: producers, overall };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPreflight({ argv, env: ownEnv, appDir, procRoot = "/proc", log = () => {} }) {
  const opts = parseArgs(argv);
  let env = ownEnv;
  let envSource = "own";
  if (opts.envFromApp) {
    const app = readAppEnvironment(procRoot);
    envSource = app.source;
    if (app.source !== "app_process_unreadable") {
      // The application's values are authoritative, including its unset ones.
      env = Object.fromEntries(Object.entries(ownEnv).filter(([key]) => !ENV_KEYS.includes(key)));
      Object.assign(env, app.env);
    }
  }
  const generatedAt = new Date().toISOString();
  const db = await openDatabase(env.DATABASE_URL, appDir);
  const redis = await openRedis(env.REDIS_URL, appDir);
  const samples = [];
  const firstSampleAt = Date.now();
  try {
    for (let k = 1; k <= opts.samples; k += 1) {
      if (k > 1) await sleep(opts.intervalSeconds * 1000);
      const windowSeconds = k === 1 ? null : Math.ceil((Date.now() - firstSampleAt) / 1000) + INTAKE_CLOCK_MARGIN_SECONDS;
      samples.push({
        sample: k,
        database: await sampleDatabase(db, windowSeconds),
        redis: await sampleRedis(redis),
      });
      log(`sample ${k}/${opts.samples} complete`);
    }
  } finally {
    await db.close?.();
    await redis.close?.();
  }
  const report = {
    schema: REPORT_SCHEMA,
    generated_at: generatedAt,
    sampling: { samples: opts.samples, interval_seconds: opts.intervalSeconds, intake_clock_margin_seconds: INTAKE_CLOCK_MARGIN_SECONDS },
    read_only_controls: {
      sql_statement_guard: true,
      redis_command_guard: true,
      job_payload_fields_read: false,
      queue_objects_constructed: false,
      database_connection: db.error ?? "ok",
      redis_connection: redis.error ?? "ok",
      engine: db.controls?.engine ?? "unknown",
      session_time_zone_utc: db.controls?.session_time_zone_utc ?? false,
      snapshot: db.controls?.snapshot ?? "per_statement",
      // On every engine. Only a SELECT-only database user would add the engine's own.
      database_write_prevention: "statement_guard_only",
    },
    deployment: { env_source: envSource, ...inspectDeployment(env, opts, appDir) },
    processes: inspectProcesses(env, procRoot),
    samples,
    verdicts: judge(samples),
    coverage_gaps: [...COVERAGE_GAPS],
  };
  assertAggregateOnly(report);
  return report;
}

async function main() {
  // Nothing reaches the terminal but the report or a fixed code: an exception
  // from any callback would otherwise print its message and stack.
  const fail = () => {
    process.stdout.write(`${JSON.stringify({ schema: REPORT_SCHEMA, error: "preflight_failed" })}\n`);
    process.exit(3);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  let report;
  try {
    report = await runPreflight({
      argv: process.argv.slice(2),
      env: process.env,
      appDir: process.cwd(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    const code = error instanceof GuardError ? error.code : "preflight_failed";
    process.stdout.write(`${JSON.stringify({ schema: REPORT_SCHEMA, error: code })}\n`);
    process.exitCode = code === "usage_error" ? 2 : 3;
    return;
  }
  const v = report.verdicts;
  process.stdout.write(
    `${JSON.stringify(report)}\nVERDICT: ${v.overall}\n` +
      `GROUPS: reconciliation=${v.reconciliation_unfinished} queues=${v.queues_runnable} accepted=${v.accepted_unfinished} producers=${v.producer_activity}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
