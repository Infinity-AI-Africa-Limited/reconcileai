// Preparation-only output boundary. No probe/application imports or connections.
// Schema derived from the pinned production-workload-preflight.mjs v2 and its
// fixed wrapper (3 samples, interval 60, budget 300). This is NOT deployment approval.
import { Buffer } from "node:buffer";

const SCHEMA = "reconcileai_workload_preflight_v2";
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const SURFACES = [
  ["reconciliation_jobs.unfinished", "reconciliation", "work"],
  ["reconciliation_jobs.running_stale_heartbeat", "reconciliation", "subset"],
  ["upload_batches.in_progress", "reconciliation", "work"],
  ["schedule_run_history.running", "reconciliation", "work"],
  ["wc_connector_sync_runs.running", "reconciliation", "work"],
  ["webhook_deliveries.pending", "accepted", "work"],
  ["shopify_privacy_queue_outbox.undispatched", "accepted", "work"],
  ["shopify_privacy_requests.in_progress", "accepted", "work"],
  ["shopify_privacy_requests.parked", "accepted", "parked"],
  ["shopify_privacy_data_request_jobs.in_progress", "accepted", "work"],
  ["shopify_privacy_customer_redaction_jobs.in_progress", "accepted", "work"],
  ["shopify_shop_redaction_jobs.in_progress", "accepted", "work"],
  ["shopify_privacy_artifacts.writing", "accepted", "work"],
  ["shopify_privacy_artifacts.awaiting_acknowledgement", "accepted", "parked"],
  ["shopify_webhook_events.acknowledged_unprocessed", "accepted", "work"],
  ["shopify_sync_requests.queued", "accepted", "work"],
  ["shopify_install_leases.unexpired", "accepted", "work"],
  ["shopify_connector_stores.redacting", "accepted", "work"],
  ["organizations.redacting", "accepted", "work"],
  ["sl_connector_webhook_events.acknowledged_unprocessed", "accepted", "work"],
  ["sl_connector_gdpr_requests.received", "accepted", "parked"],
  ["wc_connector_webhook_events.received", "accepted", "work"],
  ["wc_connector_dead_letters.retryable", "accepted", "work"],
  ["data_deletion_requests.open", "accepted", "work"],
];
const INTAKE = [
  "reconciliation_jobs", "upload_batches", "transactions", "schedule_run_history",
  "wc_connector_sync_runs", "webhook_deliveries", "shopify_webhook_events",
  "shopify_privacy_requests", "shopify_sync_requests", "shopify_install_leases",
  "sl_connector_webhook_events", "sl_connector_gdpr_requests", "wc_connector_webhook_events",
];
const QUEUES = [
  "reconciliation-runs", "webhook-delivery", "shopify-order-sync", "shopify-privacy",
  "shopify-manual-sync", "shopline-realtime-sync",
];
const GAPS = [
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
];
const READ_ERRORS = [
  "unreachable", "access_denied", "table_missing", "column_missing", "query_timeout",
  "write_refused", "query_failed", "auth_refused", "timeout", "read_failed",
  "guard_refused", "budget_exceeded", "tls_unavailable", "tls_hostname_refused",
  "tls_certificate_refused",
];
const CONNECTION_ERRORS = [...READ_ERRORS, "not_configured", "driver_unavailable", "tls_unverified"];
const PROCESS_KINDS = ["node_dist_index", "pnpm", "npm", "shell", "node_other", "other"];
const GROUP_VERDICTS = ["fail_unfinished_work", "unknown_incomplete_evidence", "pass_zero_observed"];
const PRODUCERS = ["producers_active", "unknown_incomplete_evidence", "no_intake_observed", "not_measured"];
const OVERALL = ["no_go_unfinished_work", "no_go_incomplete_evidence", "no_go_producers_active",
  "zero_observed_not_proof", "zero_observed_single_sample_not_proof"];
// Top-level stop() codes, including the checked loader. Internal SQL/Redis guard
// codes cannot escape runPreflight directly through the production CLI.
const JSON_FAILURES = new Map([
  ["usage_error", 2], ["budget_too_short", 2], ["preflight_failed", 3],
  ["output_refused", 3], ["interrupted", 5],
  ["identity_expected_deployment_missing", 4], ["identity_expected_deployment_malformed", 4],
  ["identity_expected_deployment_placeholder", 4], ["identity_expected_commit_missing", 4],
  ["identity_expected_commit_malformed", 4], ["identity_expected_commit_placeholder", 4],
  ["identity_app_process_unreadable", 4], ["identity_app_process_not_found", 4],
  ["identity_app_process_ambiguous", 4], ["identity_not_railway_runtime", 4],
  ["identity_deployment_missing", 4], ["identity_deployment_mismatch", 4],
  ["identity_commit_missing", 4], ["identity_commit_mismatch", 4],
  ["route_database_url_invalid", 4], ["route_database_tls_setting_unsupported", 4],
  ["route_redis_url_invalid", 4], ["route_redis_url_options_unsupported", 4],
  ["route_redis_not_private", 4], ["probe_unreadable", 16],
  ["probe_checksum_mismatch", 16], ["probe_load_failed", 3],
]);
const WRAPPER_FAILURES = new Map([
  ["usage", [10]], ...["node", "curl", "sha256sum", "mktemp", "timeout", "chmod", "rm"].map(
    (tool) => [`missing_${tool}`, [11]]),
  ["node_too_old", [11]], ["timeout_unsupported", [11]],
  ["expected_deployment_malformed", [12]], ["expected_commit_malformed", [12]],
  ["app_dir_invalid", [13]], ["app_dependencies_missing", [13]],
  ["workdir_failed", [14]], ["download_failed", [15]], ["checksum_mismatch", [16]],
  ["interrupted", [17]], ["probe_time_limit", [124, 137]],
]);

function requireValue(ok) {
  if (!ok) throw new Error("output_refused");
}
function objectKeys(value, keys) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const own = Object.keys(value);
  requireValue(own.length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function integer(value, min = 0, max = MAX_INT) {
  requireValue(Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max);
}
function bool(value) { requireValue(typeof value === "boolean"); }
function nullableBool(value) { if (value !== null) bool(value); }
function label(value, allowed) { requireValue(typeof value === "string" && allowed.includes(value)); }
function literal(value, expected) { requireValue(value === expected); }
function nullableInteger(value, min = 0, max = MAX_INT) {
  if (value !== null) integer(value, min, max);
}
function exactArray(value, expected) {
  requireValue(Array.isArray(value) && value.length === expected.length);
  value.forEach((item, i) => literal(item, expected[i]));
}
function unknown(value) {
  objectKeys(value, ["reading", "error"]);
  literal(value.reading, "unknown");
  label(value.error, CONNECTION_ERRORS);
}
function surface(value) {
  if (value?.reading === "unknown") return unknown(value);
  objectKeys(value, ["reading", "count", "oldest_minutes", "under_15_minutes", "over_1_day"]);
  literal(value.reading, "ok");
  integer(value.count);
  nullableInteger(value.oldest_minutes);
  integer(value.under_15_minutes, 0, value.count);
  integer(value.over_1_day, 0, value.count);
  requireValue(value.under_15_minutes <= value.count - value.over_1_day);
  if (value.count === 0) literal(value.oldest_minutes, null);
}
function intake(value, first) {
  if (value?.reading === "unknown") return unknown(value);
  if (first) {
    objectKeys(value, ["reading"]);
    literal(value.reading, "not_measured");
  } else {
    objectKeys(value, ["reading", "count"]);
    literal(value.reading, "ok");
    integer(value.count);
  }
}
function queue(value) {
  if (value?.reading === "unknown") return unknown(value);
  const states = ["wait", "paused", "active", "delayed", "prioritized", "waiting_children", "failed", "repeat"];
  objectKeys(value, ["reading", "runnable", ...states, "retrying_waiting_or_delayed",
    "active_on_a_retry", "active_without_live_lock", "previously_stalled", "stalled_marked",
    "globally_paused", "id_counter", "job_inspection"]);
  literal(value.reading, "ok");
  states.forEach((key) => integer(value[key]));
  integer(value.runnable);
  const total = states.slice(0, 6).reduce((sum, key) => sum + value[key], 0);
  integer(total);
  literal(value.runnable, total);
  integer(value.retrying_waiting_or_delayed, 0, 800);
  integer(value.active_on_a_retry, 0, 200);
  integer(value.active_without_live_lock, 0, 200);
  integer(value.previously_stalled, 0, 1000);
  integer(value.stalled_marked);
  bool(value.globally_paused);
  nullableInteger(value.id_counter);
  label(value.job_inspection, ["complete", "partial"]);
  // Redis reads are not atomic: do NOT compare inspection counters to earlier
  // state counts, or claim partial inspection makes exact state counts unknown.
}
function unknownQueues(value) {
  if (value?.reading === "unknown") return unknown(value);
  objectKeys(value, ["reading", "count", "runnable", "scan_rounds", "scan_complete"]);
  label(value.reading, ["ok", "partial"]);
  integer(value.count);
  integer(value.runnable);
  integer(value.scan_rounds, 1, 500);
  bool(value.scan_complete);
  literal(value.scan_complete, value.reading === "ok");
  // SCAN COUNT is a hint, not a bound on the number of discovered queue names.
}
function wholeSetting(value) {
  objectKeys(value, ["state", "value"]);
  label(value.state, ["unset", "invalid", "set"]);
  if (value.state === "set") integer(value.value, 0, 999999999);
  else literal(value.value, null);
}
function drainSetting(value) {
  objectKeys(value, ["state", "value"]);
  label(value.state, ["default", "set", "invalid_app_refuses_to_start"]);
  if (value.state === "default") literal(value.value, 90000);
  else if (value.state === "set") integer(value.value, 1000, 300000);
  else literal(value.value, null);
}
function recipe(value) {
  if (value?.present === false) {
    objectKeys(value, ["present"]);
  } else if (value?.unreadable === true) {
    objectKeys(value, ["present", "unreadable"]);
    literal(value.present, true);
  } else {
    objectKeys(value, ["present", "draining_seconds_set", "draining_seconds",
      "overlap_seconds_set", "overlap_seconds", "start_command_kind"]);
    literal(value.present, true);
    for (const stem of ["draining_seconds", "overlap_seconds"]) {
      bool(value[`${stem}_set`]);
      nullableInteger(value[stem]);
      if (!value[`${stem}_set`]) literal(value[stem], null);
    }
    label(value.start_command_kind, ["pnpm_start", "direct_node_exec", "absent", "other"]);
  }
}
function deployment(value, controls) {
  objectKeys(value, ["env_source", "runtime", "identity", "recipe", "provider_overrides", "application", "effective_draining_proven"]);
  literal(value.env_source, "app_process"); // Fixed wrapper always passes --env-from-app.
  literal(value.runtime, "railway_runtime");
  objectKeys(value.identity, ["deployment_matches_expected", "commit_matches_expected"]);
  literal(value.identity.deployment_matches_expected, true);
  literal(value.identity.commit_matches_expected, true);
  recipe(value.recipe);
  objectKeys(value.provider_overrides, ["draining_seconds", "overlap_seconds"]);
  wholeSetting(value.provider_overrides.draining_seconds);
  wholeSetting(value.provider_overrides.overlap_seconds);
  const app = value.application;
  objectKeys(app, ["drain_timeout_ms", "startup_mode", "node_env", "deployment_mode",
    "reconciliation_require_durable_queue", "database_configured", "redis_configured", "database_tls"]);
  drainSetting(app.drain_timeout_ms);
  label(app.startup_mode, ["normal", "maintenance", "invalid"]);
  label(app.node_env, ["production", "development", "test", "unset", "other"]);
  label(app.deployment_mode, ["cloud", "on_premise", "unset", "other"]);
  bool(app.reconciliation_require_durable_queue);
  bool(app.database_configured);
  bool(app.redis_configured);
  label(app.database_tls, ["not_configured", "not_requested", "unverified",
    "verified_certificate_and_hostname", "verified_certificate_only"]);
  literal(app.database_configured, controls.database_route !== "not_configured");
  literal(app.redis_configured, controls.redis_route !== "not_configured");
  literal(app.database_tls === "not_configured", !app.database_configured);
  literal(value.effective_draining_proven, false);
}
function processes(value) {
  if (value?.inspected === false) {
    objectKeys(value, ["inspected", "reason"]);
    literal(value.reason, "proc_unreadable"); // Identity already required Railway runtime.
    return;
  }
  objectKeys(value, ["inspected", "pid1_kind", "pid1_catches_sigterm", "pid1_ignores_sigterm",
    "app_process_count", "app_is_pid1", "app_catches_sigterm", "app_launcher_chain"]);
  literal(value.inspected, true);
  label(value.pid1_kind, PROCESS_KINDS);
  nullableBool(value.pid1_catches_sigterm);
  nullableBool(value.pid1_ignores_sigterm);
  integer(value.app_process_count);
  bool(value.app_is_pid1);
  nullableBool(value.app_catches_sigterm);
  requireValue(Array.isArray(value.app_launcher_chain) && value.app_launcher_chain.length <= 12);
  value.app_launcher_chain.forEach((item) => label(item, PROCESS_KINDS));
  if (value.app_process_count === 0) {
    literal(value.app_is_pid1, false);
    literal(value.app_catches_sigterm, null);
    literal(value.app_launcher_chain.length, 0);
  } else {
    requireValue(value.app_launcher_chain.length >= 1);
    literal(value.app_launcher_chain[0], "node_dist_index");
  }
  if (value.app_is_pid1) literal(value.pid1_kind, "node_dist_index");
}
function controls(value) {
  objectKeys(value, ["sql_statement_guard", "redis_command_guard", "job_payload_fields_read",
    "queue_objects_constructed", "identity_verified_before_connecting", "database_route",
    "database_connection", "redis_route", "redis_connection", "engine", "session_time_zone_utc",
    "snapshot", "database_write_prevention"]);
  for (const key of ["sql_statement_guard", "redis_command_guard", "identity_verified_before_connecting"]) literal(value[key], true);
  for (const key of ["job_payload_fields_read", "queue_objects_constructed"]) literal(value[key], false);
  label(value.database_route, ["not_configured", "local_loopback", "tls_verified_identity"]);
  label(value.redis_route, ["not_configured", "local_loopback", "tls_verified", "railway_private_network"]);
  label(value.database_connection, ["ok", ...CONNECTION_ERRORS]);
  label(value.redis_connection, ["ok", ...CONNECTION_ERRORS]);
  for (const stem of ["database", "redis"]) {
    literal(value[`${stem}_route`] === "not_configured", value[`${stem}_connection`] === "not_configured");
  }
  label(value.engine, ["unknown", "tidb", "mysql"]);
  bool(value.session_time_zone_utc);
  label(value.snapshot, ["per_statement", "consistent_snapshot"]);
  literal(value.database_write_prevention, "statement_guard_only");
  if (value.database_connection !== "ok") {
    literal(value.engine, "unknown");
    literal(value.session_time_zone_utc, false);
    literal(value.snapshot, "per_statement");
  }
}
function connectionReadings(readings, connection) {
  if (connection === "ok") {
    for (const value of readings) if (value.reading === "unknown") label(value.error, READ_ERRORS);
  } else {
    for (const value of readings) {
      unknown(value);
      literal(value.error, connection);
    }
  }
}
function groupVerdict(readings) {
  if (readings.some((r) => r.positive)) return "fail_unfinished_work";
  if (readings.some((r) => r.missing)) return "unknown_incomplete_evidence";
  return "pass_zero_observed";
}
function judge(samples, requested) {
  // Only positivity is needed: no unsafe addition of otherwise valid large counts.
  const db = (group, s) => {
    const values = SURFACES.filter(([, g, k]) => g === group && k === "work").map(([id]) => s.database.surfaces[id]);
    return { positive: values.some((r) => r.reading === "ok" && r.count > 0), missing: values.some((r) => r.reading !== "ok") };
  };
  const queues = (s, names) => {
    const values = names.map((name) => s.redis.queues[name]);
    return { positive: values.some((r) => r.reading === "ok" && r.runnable > 0), missing: values.some((r) => r.reading !== "ok") };
  };
  const reconciliation = groupVerdict(samples.flatMap((s) => [db("reconciliation", s), queues(s, ["reconciliation-runs"])]));
  const accepted = groupVerdict(samples.map((s) => db("accepted", s)));
  const runnable = groupVerdict(samples.map((s) => {
    const q = queues(s, QUEUES);
    const u = s.redis.unknown_queues;
    return { positive: q.positive || (["ok", "partial"].includes(u.reading) && u.runnable > 0), missing: q.missing || u.reading !== "ok" };
  }));
  let producers = "not_measured";
  if (samples.length > 1) {
    const readings = samples.slice(1).flatMap((s) => Object.values(s.database.intake));
    const first = samples[0].redis.queues;
    const last = samples.at(-1).redis.queues;
    const activity = readings.some((r) => r.reading === "ok" && r.count > 0) || QUEUES.some((name) =>
      first[name].reading === "ok" && last[name].reading === "ok" && first[name].id_counter !== last[name].id_counter);
    producers = activity ? "producers_active" : readings.some((r) => r.reading === "unknown") ? "unknown_incomplete_evidence" : "no_intake_observed";
  }
  const groups = [reconciliation, accepted, runnable];
  const overall = groups.includes("fail_unfinished_work") ? "no_go_unfinished_work"
    : samples.length < requested || samples.length === 0 || groups.includes("unknown_incomplete_evidence") || producers === "unknown_incomplete_evidence" ? "no_go_incomplete_evidence"
    : producers === "producers_active" ? "no_go_producers_active"
    : producers === "not_measured" ? "zero_observed_single_sample_not_proof" : "zero_observed_not_proof";
  return { reconciliation_unfinished: reconciliation, queues_runnable: runnable,
    accepted_unfinished: accepted, producer_activity: producers, overall };
}
function report(value) {
  objectKeys(value, ["schema", "generated_at", "sampling", "read_only_controls", "deployment", "processes", "samples", "verdicts", "coverage_gaps"]);
  literal(value.schema, SCHEMA);
  requireValue(typeof value.generated_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generated_at));
  const time = new Date(value.generated_at);
  requireValue(Number.isFinite(time.getTime()) && time.toISOString() === value.generated_at);
  const sampling = value.sampling;
  objectKeys(sampling, ["samples_requested", "samples_taken", "interval_seconds", "budget_seconds",
    "budget_exhausted", "elapsed_seconds", "intake_clock_margin_seconds", "job_ids_inspected_per_state",
    "queue_discovery_scan_count", "queue_discovery_scan_round_limit"]);
  literal(sampling.samples_requested, 3);
  integer(sampling.samples_taken, 0, 3);
  literal(sampling.interval_seconds, 60);
  literal(sampling.budget_seconds, 300);
  bool(sampling.budget_exhausted);
  // Fixed wrapper terminates at 360s and kills after another 10s.
  integer(sampling.elapsed_seconds, 0, 370);
  literal(sampling.intake_clock_margin_seconds, 60);
  literal(sampling.job_ids_inspected_per_state, 200);
  literal(sampling.queue_discovery_scan_count, 1000);
  literal(sampling.queue_discovery_scan_round_limit, 500);
  controls(value.read_only_controls);
  deployment(value.deployment, value.read_only_controls);
  processes(value.processes);
  requireValue(Array.isArray(value.samples) && value.samples.length === sampling.samples_taken);
  if (sampling.samples_taken < 3) literal(sampling.budget_exhausted, true);
  value.samples.forEach((sample, i) => {
    objectKeys(sample, ["sample", "database", "redis"]);
    literal(sample.sample, i + 1);
    objectKeys(sample.database, ["surfaces", "intake"]);
    objectKeys(sample.database.surfaces, SURFACES.map(([id]) => id));
    SURFACES.forEach(([id]) => surface(sample.database.surfaces[id]));
    objectKeys(sample.database.intake, INTAKE);
    INTAKE.forEach((id) => intake(sample.database.intake[id], i === 0));
    objectKeys(sample.redis, ["queues", "unknown_queues"]);
    objectKeys(sample.redis.queues, QUEUES);
    QUEUES.forEach((id) => queue(sample.redis.queues[id]));
    unknownQueues(sample.redis.unknown_queues);
    connectionReadings([...Object.values(sample.database.surfaces), ...Object.values(sample.database.intake)], value.read_only_controls.database_connection);
    connectionReadings([...Object.values(sample.redis.queues), sample.redis.unknown_queues], value.read_only_controls.redis_connection);
  });
  objectKeys(value.verdicts, ["reconciliation_unfinished", "queues_runnable", "accepted_unfinished", "producer_activity", "overall"]);
  for (const key of ["reconciliation_unfinished", "queues_runnable", "accepted_unfinished"]) label(value.verdicts[key], GROUP_VERDICTS);
  label(value.verdicts.producer_activity, PRODUCERS);
  label(value.verdicts.overall, OVERALL);
  const expected = judge(value.samples, sampling.samples_requested);
  for (const key of Object.keys(expected)) literal(value.verdicts[key], expected[key]);
  exactArray(value.coverage_gaps, GAPS);
}
function lines(value) {
  // The pinned writer uses LF only, no blank lines, and ASCII only. Reject U+FFFD,
  // non-ASCII/lone-surrogate strings and terminal control bytes. A string API
  // cannot detect bytes a caller silently discarded: adapters must decode fatally.
  requireValue(/^[\x20-\x7e\n]*$/.test(value));
  if (value === "") return [];
  requireValue(value.endsWith("\n"));
  return value.slice(0, -1).split("\n");
}
function parseCanonical(line) {
  const value = JSON.parse(line);
  // Pinned JSON.stringify is compact/canonical. Round-trip equality rejects
  // duplicate keys (including escaped aliases), -0, exponent/overflow tricks,
  // extraneous whitespace, and alternate encodings before anything is returned.
  requireValue(JSON.stringify(value) === line);
  return value;
}
function progress(linesSeen, taken) {
  requireValue(linesSeen.length <= 3);
  linesSeen.forEach((line, i) => literal(line, `sample ${i + 1}/3 complete`));
  if (taken !== undefined) requireValue(linesSeen.length === 0 || linesSeen.length === taken);
}

/** Return screened data only. Never expose an exception, raw stdout or stderr. */
export function screenOutput(stdout, stderr, exitCode) {
  const validExit = Number.isSafeInteger(exitCode) && !Object.is(exitCode, -0) && exitCode >= 0 && exitCode <= 255;
  const refused = { status: "output_refused", code: "output_refused", exit_code: validExit ? exitCode : -1, hold: true };
  try {
    requireValue(validExit && typeof stdout === "string" && typeof stderr === "string");
    requireValue(Buffer.byteLength(stdout, "utf8") <= MAX_STDOUT && Buffer.byteLength(stderr, "utf8") <= MAX_STDERR);
    const out = lines(stdout);
    const err = lines(stderr);
    if (out.length === 0 && err.length >= 1 && err.at(-1).startsWith("PREFLIGHT_WRAPPER: ")) {
      const code = err.at(-1).slice("PREFLIGHT_WRAPPER: ".length);
      requireValue(WRAPPER_FAILURES.get(code)?.includes(exitCode));
      const prior = err.slice(0, -1);
      if (["interrupted", "probe_time_limit"].includes(code)) progress(prior);
      else literal(prior.length, 0);
      return { status: "screened_failure", code, exit_code: exitCode, hold: true };
    }
    requireValue(out.length === 1 || out.length === 3);
    const value = parseCanonical(out[0]);
    if (out.length === 1) {
      objectKeys(value, ["schema", "error"]);
      literal(value.schema, SCHEMA);
      requireValue(typeof value.error === "string" && JSON_FAILURES.has(value.error));
      literal(exitCode, JSON_FAILURES.get(value.error));
      if (["preflight_failed", "output_refused", "interrupted"].includes(value.error)) progress(err);
      else literal(err.length, 0);
      return { status: "screened_failure", code: value.error, exit_code: exitCode, hold: true };
    }
    literal(exitCode, 0);
    report(value);
    progress(err, value.sampling.samples_taken);
    const v = value.verdicts;
    literal(out[1], `VERDICT: ${v.overall}`);
    literal(out[2], `GROUPS: reconciliation=${v.reconciliation_unfinished} queues=${v.queues_runnable} accepted=${v.accepted_unfinished} producers=${v.producer_activity}`);
    return { status: "screened_report", code: "report", exit_code: exitCode, hold: true, report: value, verdict: v.overall };
  } catch {
    return refused;
  }
}
