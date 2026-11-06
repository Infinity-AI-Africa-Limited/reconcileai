import type { IntakeId, QueueId, QueueState, SurfaceId } from "./catalogue";

export const NOT_COLLECTED = Object.freeze([
  "woodcore_mirror_sync_state_is_in_process_memory_only",
  "in_process_producers_leave_no_durable_marker_except_schedule_runs_and_uploads",
  "tracked_background_effects_leave_no_durable_marker",
  "http_requests_in_flight_are_not_visible",
  "replica_count_and_other_replicas_processes_are_not_visible",
  "effective_provider_draining_and_overlap_snapshot_is_not_visible",
  "pid1_signal_forwarding_is_not_proven",
  "other_deployments_sharing_the_database_are_not_distinguished",
  "database_background_writers_and_open_transactions_are_not_inspected",
  "upstream_redelivery_and_catch_up_correctness_are_not_assessed",
  "external_schedulers_are_producers_whose_state_is_not_visible",
  "database_user_privileges_are_not_inspected",
  "runtime_drivers_and_target_identity_are_not_implemented",
  "job_payloads_ids_retries_stalls_and_locks_are_not_collected",
  "redis_samples_are_not_atomic_snapshots",
  "intake_uses_conservative_fixed_360_second_lookback",
] as const);

export const ERROR_CODES = Object.freeze([
  "database_session_failed", "database_snapshot_failed", "database_read_failed",
  "database_cleanup_failed", "redis_read_failed", "redis_discovery_incomplete",
  "invalid_database_result", "invalid_redis_result", "operation_timeout",
  "run_budget_exhausted", "cleanup_failed", "clock_invalid",
  "intake_observed", "unknown_queue_observed",
] as const);
export type ObserverErrorCode = (typeof ERROR_CODES)[number];
export type ObserverVerdict = "zero_observed_not_proof" | "no_go_unfinished_work" | "no_go_incomplete_evidence";
export interface ObserverSample {
  database: {
    snapshot: "consistent_snapshot" | "unavailable";
    cleanup: "ok" | "failed";
    surfaces: { id: SurfaceId; count: number | null; oldestAgeSeconds: number | null }[];
    intake: { id: IntakeId; count: number | null }[];
  };
  redis: {
    queues: { id: QueueId; states: Record<QueueState, number | null> }[];
    discovery: "complete" | "incomplete";
    unknownQueues: number | null;
  };
  elapsedMs: number;
}
export interface ObserverReport {
  schema: "reconcileai_durable_observer_v1";
  execution: "synthetic_only";
  hold: true;
  verdict: ObserverVerdict;
  /** An allow-list is not an engine privilege or read-only transaction proof. */
  databaseControl: "statement_guard_only";
  samples: ObserverSample[];
  notCollected: typeof NOT_COLLECTED;
  errors: ObserverErrorCode[];
}
