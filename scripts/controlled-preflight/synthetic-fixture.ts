// SYNTHETIC ONLY: invented zero-count report. No production probe import/run.
// Shared by screening/controller tests; do not use as operational evidence.
const surfaceNames = [
  "reconciliation_jobs.unfinished", "reconciliation_jobs.running_stale_heartbeat",
  "upload_batches.in_progress", "schedule_run_history.running", "wc_connector_sync_runs.running",
  "webhook_deliveries.pending", "shopify_privacy_queue_outbox.undispatched",
  "shopify_privacy_requests.in_progress", "shopify_privacy_requests.parked",
  "shopify_privacy_data_request_jobs.in_progress", "shopify_privacy_customer_redaction_jobs.in_progress",
  "shopify_shop_redaction_jobs.in_progress", "shopify_privacy_artifacts.writing",
  "shopify_privacy_artifacts.awaiting_acknowledgement", "shopify_webhook_events.acknowledged_unprocessed",
  "shopify_sync_requests.queued", "shopify_install_leases.unexpired", "shopify_connector_stores.redacting",
  "organizations.redacting", "sl_connector_webhook_events.acknowledged_unprocessed",
  "sl_connector_gdpr_requests.received", "wc_connector_webhook_events.received",
  "wc_connector_dead_letters.retryable", "data_deletion_requests.open",
];
const intakeNames = [
  "reconciliation_jobs", "upload_batches", "transactions", "schedule_run_history", "wc_connector_sync_runs",
  "webhook_deliveries", "shopify_webhook_events", "shopify_privacy_requests", "shopify_sync_requests",
  "shopify_install_leases", "sl_connector_webhook_events", "sl_connector_gdpr_requests", "wc_connector_webhook_events",
];
const queueNames = ["reconciliation-runs", "webhook-delivery", "shopify-order-sync", "shopify-privacy", "shopify-manual-sync", "shopline-realtime-sync"];
type ReadError = "unreachable" | "access_denied" | "table_missing" | "column_missing" | "query_timeout"
  | "write_refused" | "query_failed" | "auth_refused" | "timeout" | "read_failed" | "guard_refused"
  | "budget_exceeded" | "tls_unavailable" | "tls_hostname_refused" | "tls_certificate_refused"
  | "not_configured" | "driver_unavailable" | "tls_unverified";
type UnknownReading = { reading: "unknown"; error: ReadError };
type Surface = { reading: "ok"; count: number; oldest_minutes: number | null;
  under_15_minutes: number; over_1_day: number };
type Queue = { reading: "ok"; runnable: number; wait: number; paused: number;
  active: number; delayed: number; prioritized: number; waiting_children: number; failed: number;
  repeat: number; retrying_waiting_or_delayed: number; active_on_a_retry: number;
  active_without_live_lock: number; previously_stalled: number; stalled_marked: number;
  globally_paused: boolean; id_counter: number | null; job_inspection: "complete" | "partial" };
type ProcessKind = "node_dist_index" | "pnpm" | "npm" | "shell" | "node_other" | "other";
type Recipe = { present: false } | { present: true; unreadable: true }
  | { present: true; draining_seconds_set: boolean; draining_seconds: number | null;
    overlap_seconds_set: boolean; overlap_seconds: number | null;
    start_command_kind: "pnpm_start" | "direct_node_exec" | "absent" | "other" };
type Processes = { inspected: false; reason: "proc_unreadable" }
  | { inspected: true; pid1_kind: ProcessKind; pid1_catches_sigterm: boolean | null;
    pid1_ignores_sigterm: boolean | null; app_process_count: number; app_is_pid1: boolean;
    app_catches_sigterm: boolean | null; app_launcher_chain: ProcessKind[] };
type WholeSetting = { state: "set"; value: number } | { state: "unset" | "invalid"; value: null };
type DrainSetting = { state: "default" | "set"; value: number }
  | { state: "invalid_app_refuses_to_start"; value: null };
type GroupVerdict = "pass_zero_observed" | "fail_unfinished_work" | "unknown_incomplete_evidence";
export interface SyntheticReport {
  schema: "reconcileai_workload_preflight_v2";
  generated_at: string;
  sampling: { samples_requested: number; samples_taken: number; interval_seconds: number;
    budget_seconds: number; budget_exhausted: boolean; elapsed_seconds: number;
    intake_clock_margin_seconds: number; job_ids_inspected_per_state: number;
    queue_discovery_scan_count: number; queue_discovery_scan_round_limit: number };
  read_only_controls: { sql_statement_guard: true; redis_command_guard: true;
    job_payload_fields_read: false; queue_objects_constructed: false;
    identity_verified_before_connecting: true;
    database_route: "not_configured" | "local_loopback" | "tls_verified_identity";
    database_connection: "ok" | ReadError;
    redis_route: "not_configured" | "local_loopback" | "tls_verified" | "railway_private_network";
    redis_connection: "ok" | ReadError; engine: "unknown" | "tidb" | "mysql";
    session_time_zone_utc: boolean; snapshot: "consistent_snapshot" | "per_statement";
    database_write_prevention: "statement_guard_only" };
  deployment: { env_source: "app_process"; runtime: "railway_runtime";
    identity: { deployment_matches_expected: true; commit_matches_expected: true };
    recipe: Recipe; provider_overrides: { draining_seconds: WholeSetting; overlap_seconds: WholeSetting };
    application: { drain_timeout_ms: DrainSetting; startup_mode: "normal" | "maintenance" | "invalid";
      node_env: "production" | "development" | "test" | "unset" | "other";
      deployment_mode: "cloud" | "on_premise" | "unset" | "other";
      reconciliation_require_durable_queue: boolean; database_configured: boolean; redis_configured: boolean;
      database_tls: "not_configured" | "not_requested" | "unverified"
        | "verified_certificate_and_hostname" | "verified_certificate_only" };
    effective_draining_proven: false };
  processes: Processes;
  samples: Array<{ sample: number; database: {
    surfaces: Record<string, Surface | UnknownReading>;
    intake: Record<string, { reading: "not_measured" } | { reading: "ok"; count: number } | UnknownReading> };
    redis: { queues: Record<string, Queue | UnknownReading>;
      unknown_queues: { reading: "ok" | "partial"; count: number; runnable: number;
        scan_rounds: number; scan_complete: boolean } | UnknownReading } }>;
  verdicts: { reconciliation_unfinished: GroupVerdict; queues_runnable: GroupVerdict;
    accepted_unfinished: GroupVerdict;
    producer_activity: "producers_active" | "unknown_incomplete_evidence" | "no_intake_observed" | "not_measured";
    overall: "no_go_unfinished_work" | "no_go_incomplete_evidence" | "no_go_producers_active"
      | "zero_observed_not_proof" | "zero_observed_single_sample_not_proof" };
  coverage_gaps: string[];
}
export function syntheticReport(taken = 3): SyntheticReport {
  return {
    schema: "reconcileai_workload_preflight_v2",
    generated_at: "2000-02-29T12:34:56.789Z",
    sampling: { samples_requested: 3, samples_taken: taken, interval_seconds: 60, budget_seconds: 300,
      budget_exhausted: taken < 3, elapsed_seconds: taken < 3 ? 300 : 120, intake_clock_margin_seconds: 60,
      job_ids_inspected_per_state: 200, queue_discovery_scan_count: 1000, queue_discovery_scan_round_limit: 500 },
    read_only_controls: { sql_statement_guard: true, redis_command_guard: true, job_payload_fields_read: false,
      queue_objects_constructed: false, identity_verified_before_connecting: true,
      database_route: "tls_verified_identity", database_connection: "ok", redis_route: "railway_private_network",
      redis_connection: "ok", engine: "tidb", session_time_zone_utc: true, snapshot: "consistent_snapshot",
      database_write_prevention: "statement_guard_only" },
    deployment: { env_source: "app_process", runtime: "railway_runtime",
      identity: { deployment_matches_expected: true, commit_matches_expected: true },
      recipe: { present: true, draining_seconds_set: false, draining_seconds: null,
        overlap_seconds_set: false, overlap_seconds: null, start_command_kind: "pnpm_start" },
      provider_overrides: { draining_seconds: { state: "unset", value: null }, overlap_seconds: { state: "unset", value: null } },
      application: { drain_timeout_ms: { state: "default", value: 90000 }, startup_mode: "normal",
        node_env: "production", deployment_mode: "cloud", reconciliation_require_durable_queue: true,
        database_configured: true, redis_configured: true, database_tls: "verified_certificate_and_hostname" },
      effective_draining_proven: false },
    processes: { inspected: true, pid1_kind: "pnpm", pid1_catches_sigterm: false, pid1_ignores_sigterm: false,
      app_process_count: 1, app_is_pid1: false, app_catches_sigterm: true,
      app_launcher_chain: ["node_dist_index", "shell", "pnpm"] },
    samples: Array.from({ length: taken }, (_, index) => ({ sample: index + 1,
      database: { surfaces: Object.fromEntries(surfaceNames.map((id) => [id, {
        reading: "ok", count: 0, oldest_minutes: null, under_15_minutes: 0, over_1_day: 0 }])),
        intake: Object.fromEntries(intakeNames.map((id) => [id, index === 0 ? { reading: "not_measured" } : { reading: "ok", count: 0 }])) },
      redis: { queues: Object.fromEntries(queueNames.map((id) => [id, { reading: "ok", runnable: 0, wait: 0,
        paused: 0, active: 0, delayed: 0, prioritized: 0, waiting_children: 0, failed: 0, repeat: 0,
        retrying_waiting_or_delayed: 0, active_on_a_retry: 0, active_without_live_lock: 0, previously_stalled: 0,
        stalled_marked: 0, globally_paused: false, id_counter: 0, job_inspection: "complete" }])),
        unknown_queues: { reading: "ok", count: 0, runnable: 0, scan_rounds: 1, scan_complete: true } } })),
    verdicts: { reconciliation_unfinished: "pass_zero_observed", queues_runnable: "pass_zero_observed",
      accepted_unfinished: "pass_zero_observed", producer_activity: taken <= 1 ? "not_measured" : "no_intake_observed",
      overall: taken < 3 ? "no_go_incomplete_evidence" : "zero_observed_not_proof" },
    coverage_gaps: [
      "woodcore_mirror_sync_state_is_in_process_memory_only",
      "in_process_producers_leave_no_durable_marker_except_schedule_runs_and_uploads",
      "tracked_background_effects_leave_no_durable_marker", "http_requests_in_flight_are_not_visible",
      "replica_count_and_other_replicas_processes_are_not_visible",
      "effective_provider_draining_and_overlap_snapshot_is_not_visible",
      "pid1_signal_forwarding_is_classified_not_proven", "other_deployments_sharing_the_database_are_not_distinguished",
      "database_background_writers_and_open_transactions_are_not_inspected",
      "upstream_redelivery_and_catch_up_correctness_are_not_assessed",
      "external_schedulers_are_producers_whose_state_is_not_visible", "database_user_privileges_are_not_inspected" ],
  };
}
export function syntheticOutput(report = syntheticReport()): string {
  const v = report.verdicts;
  return `${JSON.stringify(report)}\nVERDICT: ${v.overall}\nGROUPS: reconciliation=${v.reconciliation_unfinished} queues=${v.queues_runnable} accepted=${v.accepted_unfinished} producers=${v.producer_activity}\n`;
}
