/**
 * How the maintenance check's readings are presented: plain words for its fixed
 * codes, and what a run of readings does and does not show.
 *
 * Pure functions; the page renders what these return. Nothing here turns a
 * reading into permission: the strongest thing it says is that nothing was
 * observed in the areas checked.
 */
export type WorkloadVerdict = "no_go_unfinished_work" | "no_go_incomplete_evidence" | "zero_observed_not_proof";
export type Tone = "critical" | "warning" | "neutral";

export interface VerdictPresentation {
  title: string;
  tone: Tone;
  message: string;
}

const VERDICTS: Record<WorkloadVerdict, VerdictPresentation> = {
  no_go_unfinished_work: {
    title: "Work in progress",
    tone: "critical",
    message: "Work is in flight in the areas checked. Do not start maintenance.",
  },
  no_go_incomplete_evidence: {
    title: "Incomplete reading",
    tone: "warning",
    message: "Part of the reading failed or was cut short, or new work arrived. This is not a quiet result.",
  },
  zero_observed_not_proof: {
    title: "Nothing observed",
    tone: "neutral",
    message:
      "Nothing was in flight in the areas checked when this reading was taken. This is not permission to deploy, back up or change anything.",
  },
};

export function presentVerdict(verdict: WorkloadVerdict): VerdictPresentation {
  return VERDICTS[verdict];
}

const ERRORS: Record<string, string> = {
  database_unavailable: "The database could not be reached.",
  database_busy: "An earlier check is still waiting for a database connection, so this one did not queue another.",
  database_session_failed: "The database session was not in UTC, so ages could not be trusted.",
  database_snapshot_failed: "A consistent database snapshot could not be opened.",
  database_read_failed: "A database count failed.",
  database_cleanup_failed: "The database snapshot could not be ended cleanly; its connection was closed instead.",
  redis_not_configured: "This app has no Redis, so queued work lives only in its memory and cannot be read.",
  redis_unavailable: "Redis could not be reached.",
  redis_read_failed: "A queue count failed.",
  redis_discovery_incomplete: "The search for unknown queues did not finish.",
  invalid_database_result: "A database count came back in an unexpected form.",
  invalid_redis_result: "A queue reading came back in an unexpected form.",
  operation_timeout: "A read took too long and was stopped.",
  run_budget_exhausted: "The reading ran out of time.",
  cleanup_failed: "A connection could not be closed cleanly.",
  intake_observed: "New work arrived in the last six minutes.",
  unknown_queue_observed: "Redis holds a queue this check does not know.",
};

export function describeError(code: string): string {
  return ERRORS[code] ?? "An unrecognised problem was reported.";
}

const NOT_COLLECTED: Record<string, string> = {
  other_replicas_in_memory_work_is_not_visible: "Work held in other servers' memory.",
  http_requests_in_flight_are_counted_only_for_this_replica: "Requests on other servers (this server's are counted).",
  woodcore_mirror_sync_state_is_in_process_memory_only: "The Woodcore mirror sync, which keeps its state in memory.",
  in_process_producers_leave_no_durable_marker_except_schedule_runs_and_uploads:
    "Work started in memory that leaves no record, apart from scheduled runs and uploads.",
  external_schedulers_are_producers_whose_state_is_not_visible: "Outside schedulers that start work, such as GitHub Actions.",
  other_deployments_sharing_the_database_are_not_distinguished: "Other deployments that share this database.",
  database_background_writers_and_open_transactions_are_not_inspected: "Database-side writers and open transactions.",
  database_user_privileges_are_not_inspected: "What the database account is allowed to do.",
  upstream_redelivery_and_catch_up_correctness_are_not_assessed: "Whether providers will resend anything missed.",
  job_payloads_ids_retries_stalls_and_locks_are_not_collected: "Job contents, ids, retries, stalls and locks.",
  redis_reads_are_not_one_atomic_snapshot: "Queue counts are read one after another, not at a single instant.",
  intake_uses_a_conservative_fixed_six_minute_lookback: "New work is counted over a fixed six-minute window.",
  the_build_commit_is_railway_attribution_not_binary_attestation:
    "The build commit is what Railway reports, not proof of the code running.",
};

export function describeNotCollected(code: string): string {
  return NOT_COLLECTED[code] ?? code.replace(/_/g, " ");
}

const SURFACES: Record<string, string> = {
  "reconciliation_jobs.unfinished": "Reconciliation runs pending or running",
  "reconciliation_jobs.running_stale_heartbeat": "Running reconciliations with no heartbeat for 15 minutes",
  "upload_batches.in_progress": "File uploads being processed",
  "schedule_run_history.running": "Scheduled tasks running",
  "wc_connector_sync_runs.running": "Core-banking connector syncs running",
  "webhook_deliveries.pending": "Outbound webhooks waiting to be delivered",
  "shopify_privacy_queue_outbox.undispatched": "Shopify privacy jobs not yet queued",
  "shopify_privacy_requests.in_progress": "Shopify privacy requests in progress",
  "shopify_privacy_requests.parked": "Shopify privacy requests waiting on a person",
  "shopify_privacy_data_request_jobs.in_progress": "Shopify customer data requests in progress",
  "shopify_privacy_customer_redaction_jobs.in_progress": "Shopify customer erasures in progress",
  "shopify_shop_redaction_jobs.in_progress": "Shopify shop erasures in progress",
  "shopify_privacy_artifacts.writing": "Shopify privacy files being written",
  "shopify_privacy_artifacts.awaiting_acknowledgement": "Shopify privacy files waiting for acknowledgement",
  "shopify_webhook_events.acknowledged_unprocessed": "Shopify webhooks received but not processed",
  "shopify_sync_requests.queued": "Shopify syncs queued",
  "shopify_install_leases.unexpired": "Shopify installs in progress",
  "shopify_connector_stores.redacting": "Shopify stores being erased",
  "organizations.redacting": "Organisations being erased",
  "sl_connector_webhook_events.acknowledged_unprocessed": "SHOPLINE webhooks received but not processed",
  "sl_connector_gdpr_requests.received": "SHOPLINE privacy requests waiting on a person",
  "wc_connector_webhook_events.received": "Core-banking webhooks received but not processed",
  "wc_connector_dead_letters.retryable": "Core-banking deliveries waiting to be retried",
  "data_deletion_requests.open": "Data deletion requests open",
};

export function describeSurface(id: string): string {
  return SURFACES[id] ?? id;
}

/** Unknown is never shown as zero. */
export function formatCount(count: number | null): string {
  return count === null ? "Unknown" : count.toLocaleString("en-GB");
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

export interface Reading {
  checkedAt: string;
  verdict: WorkloadVerdict;
}

export const READINGS_NEEDED = 3;
export const MIN_SPACING_MS = 60_000;

export type ReadingsStatus =
  | { kind: "none" }
  | { kind: "work_in_progress" }
  | { kind: "incomplete" }
  | { kind: "need_more"; remaining: number }
  | { kind: "too_close"; waitMs: number }
  | { kind: "quiet"; spanMs: number };

/**
 * What the latest readings show together. One reading is one moment, so the
 * strongest result needs three in a row that observed nothing, each at least a
 * minute after the one before. Even that is only "nothing observed".
 */
export function assessReadings(readings: readonly Reading[], now: number): ReadingsStatus {
  if (readings.length === 0) return { kind: "none" };
  const latest = readings.slice(-READINGS_NEEDED);
  if (latest.some(r => r.verdict === "no_go_unfinished_work")) return { kind: "work_in_progress" };
  if (latest.some(r => r.verdict === "no_go_incomplete_evidence")) return { kind: "incomplete" };
  // Every reading counted here observed nothing; earlier ones are irrelevant.
  if (latest.length < READINGS_NEEDED) return { kind: "need_more", remaining: READINGS_NEEDED - latest.length };
  const times = latest.map(r => Date.parse(r.checkedAt));
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (!(gap >= MIN_SPACING_MS)) {
      const last = times[times.length - 1];
      return { kind: "too_close", waitMs: Math.max(0, last + MIN_SPACING_MS - now) };
    }
  }
  return { kind: "quiet", spanMs: times[times.length - 1] - times[0] };
}

export function describeReadings(status: ReadingsStatus): string {
  switch (status.kind) {
    case "none":
      return "No readings yet. Press Run check.";
    case "work_in_progress":
      return "Work was in flight in one of the latest readings.";
    case "incomplete":
      return "One of the latest readings was incomplete, so they cannot show a quiet system.";
    case "need_more":
      return `Take ${status.remaining} more ${status.remaining === 1 ? "reading" : "readings"}, each at least a minute after the last.`;
    case "too_close":
      return "Readings must be at least a minute apart. Take another reading when the minute has passed.";
    case "quiet":
      return `Three readings over ${Math.round(status.spanMs / 60_000)} minutes observed nothing in the areas checked. This is still not permission to change production.`;
  }
}
