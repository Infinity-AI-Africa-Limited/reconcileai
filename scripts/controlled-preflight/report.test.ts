import { describe, expect, it } from "vitest";
import { screenOutput } from "./report.mjs";
import { syntheticOutput, syntheticReport, type SyntheticReport } from "./synthetic-fixture";

const SCHEMA = "reconcileai_workload_preflight_v2";
const surface = (r: SyntheticReport, id = "reconciliation_jobs.unfinished") => {
  const value = r.samples[0].database.surfaces[id];
  if (value.reading !== "ok") throw new Error("Synthetic surface must be measured");
  return value;
};
const queue = (r: SyntheticReport, sample = 0) => {
  const value = r.samples[sample].redis.queues["reconciliation-runs"];
  if (value.reading !== "ok") throw new Error("Synthetic queue must be measured");
  return value;
};
type Path = Array<string | number>;
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Synthetic corruption target must be an object");
  }
  return value as Record<string, unknown>;
};
const atPath = (root: unknown, path: Path): unknown => {
  let target: unknown = root;
  for (const key of path) {
    if (Array.isArray(target)) {
      if (typeof key !== "number" || !Object.hasOwn(target, key)) throw new Error("Missing array path");
      target = (target as unknown[])[key];
    } else {
      const object = record(target);
      if (!Object.hasOwn(object, key)) throw new Error("Missing object path");
      target = object[String(key)];
    }
  }
  return target;
};
const setPath = (root: unknown, path: Path, value: unknown) => {
  const key = path.at(-1);
  if (key === undefined) throw new Error("Cannot replace synthetic root");
  const parent = atPath(root, path.slice(0, -1));
  if (Array.isArray(parent)) {
    if (typeof key !== "number") throw new Error("Expected array index");
    (parent as unknown[])[key] = value;
  } else record(parent)[String(key)] = value;
};
const refused = (stdout: string, stderr = "", code = 0) => {
  const result = screenOutput(stdout, stderr, code);
  expect(result.status).toBe("output_refused");
  expect(result.code).toBe("output_refused");
  expect(result.hold).toBe(true);
  expect(result).not.toHaveProperty("report");
  expect(result).not.toHaveProperty("stdout");
  expect(result).not.toHaveProperty("stderr");
};

describe("when screenOutput receives SYNTHETIC-only output", () => {
  it("should screen aggregates and keep HOLD when three synthetic zero samples arrive", () => {
    const r = syntheticReport();
    const result = screenOutput(syntheticOutput(r), "sample 1/3 complete\nsample 2/3 complete\nsample 3/3 complete\n", 0);
    expect(result).toEqual({ status: "screened_report", code: "report", exit_code: 0, hold: true,
      report: r, verdict: "zero_observed_not_proof" });
  });
  it.each([0, 1, 2])("should screen incomplete evidence when budget stops with %i synthetic samples", (taken) => {
    const result = screenOutput(syntheticOutput(syntheticReport(taken)), "", 0);
    expect(result.status).toBe("screened_report");
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.hold).toBe(true);
  });
  it("should recompute failure before unknown evidence when synthetic work exists", () => {
    const r = syntheticReport(1);
    Object.assign(surface(r), { count: 2, oldest_minutes: 1441, over_1_day: 1, under_15_minutes: 1 });
    r.verdicts.reconciliation_unfinished = "fail_unfinished_work";
    r.verdicts.overall = "no_go_unfinished_work";
    expect(screenOutput(syntheticOutput(r), "", 0).verdict).toBe("no_go_unfinished_work");
  });
  it("should fail only its proper group when accepted synthetic work exists", () => {
    const r = syntheticReport();
    surface(r, "webhook_deliveries.pending").count = 1;
    r.verdicts.accepted_unfinished = "fail_unfinished_work";
    r.verdicts.overall = "no_go_unfinished_work";
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });
  it("should not call them interruptible work when parked or subset synthetic counts exist", () => {
    const r = syntheticReport();
    surface(r, "shopify_privacy_requests.parked").count = 1;
    surface(r, "reconciliation_jobs.running_stale_heartbeat").count = 1;
    expect(screenOutput(syntheticOutput(r), "", 0).verdict).toBe("zero_observed_not_proof");
  });
  it.each(["queue", "intake"])("should detect producers when synthetic %s intake changes", (which) => {
    const r = syntheticReport();
    if (which === "queue") queue(r, 2).id_counter = null;
    else {
      const intake = r.samples[1].database.intake.transactions;
      if (intake.reading !== "ok") throw new Error("Synthetic intake must be measured");
      intake.count = 1;
    }
    r.verdicts.producer_activity = "producers_active";
    r.verdicts.overall = "no_go_producers_active";
    expect(screenOutput(syntheticOutput(r), "", 0).verdict).toBe("no_go_producers_active");
  });
  it("should fail before incomplete evidence when partial discovery contains synthetic work", () => {
    const r = syntheticReport();
    r.samples[0].redis.unknown_queues = { reading: "partial", count: 2, runnable: 1, scan_rounds: 500, scan_complete: false };
    r.verdicts.queues_runnable = "fail_unfinished_work";
    r.verdicts.overall = "no_go_unfinished_work";
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });
  it("should preserve source verdict semantics when inspection is partial but exact counts are zero", () => {
    const r = syntheticReport();
    Object.assign(queue(r), { job_inspection: "partial", retrying_waiting_or_delayed: 800,
      active_on_a_retry: 200, active_without_live_lock: 200, previously_stalled: 1000 });
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });
  it("should accept only uniformly matched synthetic errors when database connection fails", () => {
    const r = syntheticReport();
    Object.assign(r.read_only_controls, { database_connection: "tls_unverified", engine: "unknown",
      snapshot: "per_statement", session_time_zone_utc: false });
    for (const sample of r.samples) {
      for (const map of [sample.database.surfaces, sample.database.intake]) {
        for (const key of Object.keys(map)) map[key] = { reading: "unknown", error: "tls_unverified" };
      }
    }
    Object.assign(r.verdicts, { reconciliation_unfinished: "unknown_incomplete_evidence",
      accepted_unfinished: "unknown_incomplete_evidence", producer_activity: "unknown_incomplete_evidence",
      overall: "no_go_incomplete_evidence" });
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
    Object.assign(r.samples[0].database.surfaces["organizations.redacting"], { error: "read_failed" });
    refused(syntheticOutput(r));
  });
  it.each(["not_configured", "driver_unavailable", "unreachable"] as const) (
    "should accept only matching unknown readings when Redis connection reports %s", (error) => {
      const r = syntheticReport();
      r.read_only_controls.redis_connection = error;
      if (error === "not_configured") {
        r.read_only_controls.redis_route = "not_configured";
        r.deployment.application.redis_configured = false;
      }
      for (const sample of r.samples) {
        for (const key of Object.keys(sample.redis.queues)) sample.redis.queues[key] = { reading: "unknown", error };
        sample.redis.unknown_queues = { reading: "unknown", error };
      }
      Object.assign(r.verdicts, { reconciliation_unfinished: "unknown_incomplete_evidence",
        queues_runnable: "unknown_incomplete_evidence", overall: "no_go_incomplete_evidence" });
      expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
    });
  it.each([false, true])("should accept only its exact source variant when recipe unreadable is %s", (unreadable) => {
    const r = syntheticReport();
    r.deployment.recipe = unreadable ? { present: true, unreadable: true } : { present: false };
    r.processes = { inspected: false, reason: "proc_unreadable" };
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });
  it("should accept nullable and finite numeric data when settings reach exact synthetic boundaries", () => {
    const r = syntheticReport();
    r.deployment.provider_overrides.draining_seconds = { state: "set", value: 999999999 };
    r.deployment.provider_overrides.overlap_seconds = { state: "invalid", value: null };
    r.deployment.application.drain_timeout_ms = { state: "set", value: 300000 };
    r.deployment.application.startup_mode = "invalid";
    r.deployment.application.database_tls = "not_requested";
    if (!("overlap_seconds_set" in r.deployment.recipe) || !r.processes.inspected
      || r.samples[0].redis.unknown_queues.reading === "unknown") throw new Error("Expected measured fixture");
    r.deployment.recipe.overlap_seconds_set = true;
    r.deployment.recipe.overlap_seconds = Number.MAX_SAFE_INTEGER;
    r.processes.pid1_catches_sigterm = null;
    r.processes.pid1_ignores_sigterm = null;
    r.processes.app_catches_sigterm = null;
    r.samples[0].redis.unknown_queues.count = 500001; // SCAN COUNT is only a hint.
    queue(r).failed = Number.MAX_SAFE_INTEGER;
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });

  const corruptions: Array<[string, (r: SyntheticReport) => void]> = [
    ["safe unknown root key", r => { setPath(r, ["safe_extra"], 0); }],
    ["safe unknown nested key", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "extra"], false); }],
    ["numeric unknown surface key", r => { setPath(r, ["samples", 0, "database", "surfaces", "secret:host"], 0); }],
    ["numeric unknown queue name", r => { setPath(r, ["samples", 0, "redis", "queues", "operator@example.invalid"], 0); }],
    ["numeric unknown intake key", r => { setPath(r, ["samples", 0, "database", "intake", "new_table"], 0); }],
    ["missing surface", r => { Reflect.deleteProperty(r.samples[0].database.surfaces, "organizations.redacting"); }],
    ["missing queue", r => { Reflect.deleteProperty(r.samples[0].redis.queues, "webhook-delivery"); }],
    ["safe label at wrong field", r => { setPath(r, ["processes", "pid1_kind"], "tls_verified"); }],
    ["ISO string at wrong field", r => { setPath(r, ["deployment", "application", "node_env"], r.generated_at); }],
    ["secret label", r => { setPath(r, ["read_only_controls", "engine"], "production-db.example.invalid"); }],
    ["email", r => { setPath(r, ["processes", "pid1_kind"], "operator@example.invalid"); }],
    ["credential URL", r => { setPath(r, ["deployment", "application", "database_tls"], "mysql://user:password@db.invalid/app"); }],
    ["raw job id", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "id_counter"], "private-job-id"); }],
    ["number string", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "count"], "1"); }],
    ["fraction", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "count"], 0.1); }],
    ["negative age", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "oldest_minutes"], -1); }],
    ["unsafe count", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "count"], Number.MAX_SAFE_INTEGER + 1); }],
    ["infinite count", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "count"], Infinity); }],
    ["NaN count", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "count"], NaN); }],
    ["array instead of map", r => { setPath(r, ["samples", 0, "database", "surfaces"], []); }],
    ["null object", r => { setPath(r, ["deployment", "identity"], null); }],
    ["boolean string", r => { setPath(r, ["read_only_controls", "sql_statement_guard"], "true"); }],
    ["guard disabled", r => { setPath(r, ["read_only_controls", "redis_command_guard"], false); }],
    ["payload read enabled", r => { setPath(r, ["read_only_controls", "job_payload_fields_read"], true); }],
    ["identity false", r => { setPath(r, ["deployment", "identity", "deployment_matches_expected"], false); }],
    ["effective draining claimed", r => { setPath(r, ["deployment", "effective_draining_proven"], true); }],
    ["wrong schema", r => { setPath(r, ["schema"], "reconcileai_workload_preflight_v3"); }],
    ["impossible timestamp", r => { setPath(r, ["generated_at"], "2001-02-29T12:34:56.789Z"); }],
    ["month overflow", r => { setPath(r, ["generated_at"], "2000-13-01T12:34:56.789Z"); }],
    ["offset timestamp", r => { setPath(r, ["generated_at"], "2000-02-29T12:34:56.789+00:00"); }],
    ["elapsed over hard bound", r => { setPath(r, ["sampling", "elapsed_seconds"], 371); }],
    ["sampling not fixed", r => { setPath(r, ["sampling", "samples_requested"], 10); }],
    ["interval not fixed", r => { setPath(r, ["sampling", "interval_seconds"], 1); }],
    ["budget not fixed", r => { setPath(r, ["sampling", "budget_seconds"], 900); }],
    ["scan count not fixed", r => { setPath(r, ["sampling", "queue_discovery_scan_count"], 1001); }],
    ["margin not fixed", r => { setPath(r, ["sampling", "intake_clock_margin_seconds"], 61); }],
    ["taken mismatch", r => { setPath(r, ["sampling", "samples_taken"], 2); }],
    ["out of order samples", r => { setPath(r, ["samples", 1, "sample"], 1); }],
    ["extra sample fields", r => { setPath(r, ["samples", 0, "timestamp"], r.generated_at); }],
    ["unmeasured later intake", r => { setPath(r, ["samples", 1, "database", "intake", "transactions"], { reading: "not_measured" }); }],
    ["measured first intake", r => { setPath(r, ["samples", 0, "database", "intake", "transactions"], { reading: "ok", count: 0 }); }],
    ["unknown with count", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "reading"], "unknown"); setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "error"], "read_failed"); }],
    ["ok with error", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "error"], "read_failed"); }],
    ["unused reading enum", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "reading"], "partial"); }],
    ["arbitrary safe-looking error", r => { setPath(r, ["samples", 0, "redis", "unknown_queues"], { reading: "unknown", error: "session_refused" }); }],
    ["connection-only error in successful connection", r => { setPath(r, ["samples", 0, "redis", "unknown_queues"], { reading: "unknown", error: "driver_unavailable" }); }],
    ["zero count age", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "oldest_minutes"], 1); }],
    ["bucket exceeds count", r => { setPath(r, ["samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished", "under_15_minutes"], 1); }],
    ["overlapping buckets", r => { Object.assign(surface(r), { count: 1, under_15_minutes: 1, over_1_day: 1 }); }],
    ["runnable mismatch", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "wait"], 1); }],
    ["retry cap overflow", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "retrying_waiting_or_delayed"], 801); }],
    ["active retry cap overflow", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "active_on_a_retry"], 201); }],
    ["lock cap overflow", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "active_without_live_lock"], 201); }],
    ["stall cap overflow", r => { setPath(r, ["samples", 0, "redis", "queues", "reconciliation-runs", "previously_stalled"], 1001); }],
    ["scan rounds zero", r => { setPath(r, ["samples", 0, "redis", "unknown_queues", "scan_rounds"], 0); }],
    ["scan rounds overflow", r => { setPath(r, ["samples", 0, "redis", "unknown_queues", "scan_rounds"], 501); }],
    ["scan complete conflict", r => { setPath(r, ["samples", 0, "redis", "unknown_queues", "scan_complete"], false); }],
    ["unknown names included", r => { setPath(r, ["samples", 0, "redis", "unknown_queues", "names"], ["safe"]); }],
    ["provider bound overflow", r => { setPath(r, ["deployment", "provider_overrides", "draining_seconds"], { state: "set", value: 1000000000 }); }],
    ["unset with numeric value", r => { setPath(r, ["deployment", "provider_overrides", "draining_seconds", "value"], 0); }],
    ["drain bound underflow", r => { setPath(r, ["deployment", "application", "drain_timeout_ms"], { state: "set", value: 999 }); }],
    ["drain bound overflow", r => { setPath(r, ["deployment", "application", "drain_timeout_ms"], { state: "set", value: 300001 }); }],
    ["default timeout mismatch", r => { setPath(r, ["deployment", "application", "drain_timeout_ms", "value"], 1000); }],
    ["recipe missing true variant", r => { setPath(r, ["deployment", "recipe"], { present: true }); }],
    ["recipe absent extra key", r => { setPath(r, ["deployment", "recipe"], { present: false, extra: 0 }); }],
    ["recipe unset numeric timing", r => { setPath(r, ["deployment", "recipe", "draining_seconds"], 1); }],
    ["own-shell fallback", r => { setPath(r, ["deployment", "env_source"], "own"); }],
    ["invalid application TLS", r => { setPath(r, ["deployment", "application", "database_tls"], "invalid"); }],
    ["DB configured conflict", r => { setPath(r, ["deployment", "application", "database_configured"], false); }],
    ["DB connection route conflict", r => { setPath(r, ["read_only_controls", "database_connection"], "not_configured"); }],
    ["process chain too long", r => { setPath(r, ["processes", "app_launcher_chain"], Array(13).fill("node_dist_index")); }],
    ["process chain not app first", r => { setPath(r, ["processes", "app_launcher_chain", 0], "pnpm"); }],
    ["empty app chain", r => { setPath(r, ["processes", "app_launcher_chain"], []); }],
    ["process count negative", r => { setPath(r, ["processes", "app_process_count"], -1); }],
    ["runtime impossible process reason", r => { setPath(r, ["processes"], { inspected: false, reason: "not_in_service_container" }); }],
    ["missing coverage gap", r => { r.coverage_gaps.pop(); }],
    ["duplicate coverage gap", r => { setPath(r, ["coverage_gaps", 1], r.coverage_gaps[0]); }],
    ["extra coverage gap", r => { r.coverage_gaps.push("http_requests_in_flight_are_not_visible"); }],
    ["lying group verdict", r => { setPath(r, ["verdicts", "queues_runnable"], "fail_unfinished_work"); }],
    ["lying overall verdict", r => { setPath(r, ["verdicts", "overall"], "no_go_unfinished_work"); }],
    ["lying producer verdict", r => { setPath(r, ["verdicts", "producer_activity"], "producers_active"); }],
    ["unsafe aggregate sum", r => { Object.assign(queue(r), { wait: Number.MAX_SAFE_INTEGER, active: 1, runnable: Number.MAX_SAFE_INTEGER }); }],
  ];
  it.each(corruptions)("should refuse without echo when %s corrupts SYNTHETIC output", (_, corrupt) => {
    const r = syntheticReport();
    corrupt(r);
    refused(syntheticOutput(r));
  });

  const textualCorruptions: Array<[string, (s: string) => string]> = [
    ["prepended log", s => `operator@example.invalid\n${s}`],
    ["appended log", s => `${s}mysql://user:password@db.invalid/app\n`],
    ["stdout exit line", s => `${s}exit=0\n`],
    ["duplicate report", s => s + s],
    ["truncated JSON", s => s.slice(0, 100)],
    ["truncated summaries", s => s.split("\n")[0] + "\n"],
    ["missing final newline", s => s.slice(0, -1)],
    ["extra blank line", s => s + "\n"],
    ["ANSI", s => `\x1b[31m${s}`],
    ["carriage return", s => s.replaceAll("\n", "\r\n")],
    ["NUL", s => `\0${s}`],
    ["replacement character", s => `\ufffd${s}`],
    ["lone surrogate", s => `\ud800${s}`],
    ["duplicate schema key", s => s.replace('{"schema":', '{"schema":"reconcileai_workload_preflight_v2","schema":')],
    ["escaped duplicate key", s => s.replace('{"schema":', '{"\\u0073chema":"reconcileai_workload_preflight_v2","schema":')],
    ["duplicate nested key", s => s.replace('"count":0', '"count":1,"count":0')],
    ["proto key", s => s.replace('{"schema":', '{"__proto__":0,"schema":')],
    ["constructor key", s => s.replace('{"schema":', '{"constructor":0,"schema":')],
    ["negative zero", s => s.replace('"count":0', '"count":-0')],
    ["exponent overflow", s => s.replace('"count":0', '"count":1e309')],
    ["noncanonical escaped label", s => s.replace('"tidb"', '"ti\\u0064b"')],
    ["false summary", s => s.replace("VERDICT: zero_observed_not_proof", "VERDICT: no_go_unfinished_work")],
    ["false groups", s => s.replace("GROUPS: reconciliation=pass_zero_observed", "GROUPS: reconciliation=fail_unfinished_work")],
  ];
  it.each(textualCorruptions)("should refuse when %s alters the transport string", (_, corrupt) => refused(corrupt(syntheticOutput())));
  it.each([1, 2, 3, 4, 5, 16, 124, 137])("should refuse status conflict when report subprocess exit is %i", code => refused(syntheticOutput(), "", code));
  it.each([-1, 256, NaN, Infinity, 0.5])("should refuse without trusting stdout when exit metadata is %s", code => {
    const result = screenOutput(syntheticOutput(), "", code);
    expect(result).toEqual({ status: "output_refused", code: "output_refused", exit_code: -1, hold: true });
  });
  it("should refuse before parsing when strings exceed the byte bounds", () => {
    refused("x".repeat(1024 * 1024 + 1));
    refused(syntheticOutput(), "x".repeat(16 * 1024 + 1));
  });
  it.each(["operator@example.invalid\n", "host=db.invalid\n", "sample 2/3 complete\n",
    "sample 1/3 complete\nsample 1/3 complete\n", "sample 1/4 complete\n", "exit=0\n", "\x1b[0m\n"])(
    "should refuse rather than echo it when stderr contains %j", stderr => refused(syntheticOutput(), stderr));

  const jsonFailures: Array<[string, number]> = [
    ["usage_error", 2], ["budget_too_short", 2], ["preflight_failed", 3], ["output_refused", 3], ["interrupted", 5],
    ...["deployment", "commit"].flatMap(kind => ["missing", "malformed", "placeholder"].map(reason => [`identity_expected_${kind}_${reason}`, 4] as [string, number])),
    ...["app_process_unreadable", "app_process_not_found", "app_process_ambiguous", "not_railway_runtime",
      "deployment_missing", "deployment_mismatch", "commit_missing", "commit_mismatch"].map(code => [`identity_${code}`, 4] as [string, number]),
    ...["database_url_invalid", "database_tls_setting_unsupported", "redis_url_invalid", "redis_url_options_unsupported", "redis_not_private"].map(code => [`route_${code}`, 4] as [string, number]),
    ["probe_unreadable", 16], ["probe_checksum_mismatch", 16], ["probe_load_failed", 3],
  ];
  it.each(jsonFailures)("should screen fixed JSON failure %s with its numeric exit %i", (error, code) => {
    const out = JSON.stringify({ schema: SCHEMA, error }) + "\n";
    expect(screenOutput(out, "", code)).toEqual({ status: "screened_failure", code: error, exit_code: code, hold: true });
    refused(out, "", code === 3 ? 4 : 3);
  });
  const wrapperFailures: Array<[string, number]> = [
    ["usage", 10], ...["node", "curl", "sha256sum", "mktemp", "timeout", "chmod", "rm"].map(tool => [`missing_${tool}`, 11] as [string, number]),
    ["node_too_old", 11], ["timeout_unsupported", 11], ["expected_deployment_malformed", 12],
    ["expected_commit_malformed", 12], ["app_dir_invalid", 13], ["app_dependencies_missing", 13],
    ["workdir_failed", 14], ["download_failed", 15], ["checksum_mismatch", 16], ["interrupted", 17],
    ["probe_time_limit", 124], ["probe_time_limit", 137],
  ];
  it.each(wrapperFailures)("should screen fixed wrapper failure %s with its numeric exit %i", (error, code) => {
    const err = `PREFLIGHT_WRAPPER: ${error}\n`;
    expect(screenOutput("", err, code)).toEqual({ status: "screened_failure", code: error, exit_code: code, hold: true });
    refused("", err, 0);
  });
  it("should consume but not return progress when early stop includes only permitted prior progress", () => {
    expect(screenOutput("", "sample 1/3 complete\nPREFLIGHT_WRAPPER: probe_time_limit\n", 124).status).toBe("screened_failure");
    expect(screenOutput(JSON.stringify({ schema: SCHEMA, error: "interrupted" }) + "\n", "sample 1/3 complete\n", 5).status).toBe("screened_failure");
  });
  it.each(["unknown_failure", "identity_custom_secret", "route_db.example.invalid", "query_failed", "session_refused"])(
    "should refuse when unknown top-level error %s arrives", error => refused(JSON.stringify({ schema: SCHEMA, error }) + "\n", "", 3));
  it("should refuse when fixed failures contain extra fields or raw diagnostics", () => {
    refused(JSON.stringify({ schema: SCHEMA, error: "preflight_failed", count: 0 }) + "\n", "", 3);
    refused(JSON.stringify({ schema: SCHEMA, error: "preflight_failed" }) + "\n", "password=synthetic-secret\n", 3);
    refused("", "PREFLIGHT_WRAPPER: missing_ssh\n", 11);
    refused("", "PREFLIGHT_WRAPPER: download_failed\nhost=db.invalid\n", 15);
    refused("", "sample 1/3 complete\nPREFLIGHT_WRAPPER: download_failed\n", 15);
    refused(syntheticOutput(), "PREFLIGHT_WRAPPER: probe_time_limit\n", 124);
    refused("exit=0\n", "", 0);
  });
  it("should not mutate Object prototype when prototype injection is refused", () => {
    refused('{"__proto__":{"polluted":true},"schema":"reconcileai_workload_preflight_v2","error":"preflight_failed"}\n', "", 3);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("should reject every recursive path when each SYNTHETIC object gains even a safe-valued key", () => {
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Path) => {
      if (value === null || typeof value !== "object") return;
      if (!Array.isArray(value)) paths.push(path);
      for (const [key, item] of Object.entries(Array.isArray(value) ? value as unknown[] : record(value))) {
        walk(item, [...path, Array.isArray(value) ? Number(key) : key]);
      }
    };
    walk(syntheticReport(), []);
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths) {
      const r = syntheticReport();
      setPath(r, [...path, "unexpected_but_safe"], 0);
      refused(syntheticOutput(r));
    }
  });
  it("should preserve safe integers without unsafe verdict totals when large SYNTHETIC counts are valid", () => {
    const r = syntheticReport();
    for (const id of ["reconciliation_jobs.unfinished", "upload_batches.in_progress"]) {
      r.samples[0].database.surfaces[id] = { reading: "ok", count: Number.MAX_SAFE_INTEGER,
        oldest_minutes: Number.MAX_SAFE_INTEGER, under_15_minutes: 0, over_1_day: Number.MAX_SAFE_INTEGER };
    }
    r.verdicts.reconciliation_unfinished = "fail_unfinished_work";
    r.verdicts.overall = "no_go_unfinished_work";
    expect(screenOutput(syntheticOutput(r), "", 0).status).toBe("screened_report");
  });
});
