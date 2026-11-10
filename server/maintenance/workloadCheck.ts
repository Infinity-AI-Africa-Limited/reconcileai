import {
  DB_SURFACES,
  INTAKE_SOURCES,
  LIMITS,
  NOT_COLLECTED,
  QUEUE_IDS,
  QUEUE_STATES,
  RUNNABLE_STATES,
  type DatabaseStatementId,
  type IntakeId,
  type QueueId,
  type QueueState,
  type RedisReadId,
  type SurfaceId,
  type SurfaceKind,
} from "./workloadCatalogue";

/**
 * One reading of the work the platform has in flight, for a person deciding
 * whether maintenance can start. It reads, it never decides: every report keeps
 * `hold: true`, and the best verdict it can give is "nothing observed in the
 * areas checked", which is not permission to deploy, back up or change
 * anything.
 *
 * Ported from the reviewed durable observer (scripts/durable-observer/core.ts at
 * e7dc06c, PR #225) for a single sample. The rules are the observer's:
 *   - unfinished work is a positive count on a work surface (parked ones wait on
 *     a person) or in a runnable queue state (failed jobs and repeat schedules
 *     are not running);
 *   - anything not read, cut short or refused makes the evidence incomplete,
 *     and a value that was not read is null, never zero;
 *   - unfinished work outranks incomplete evidence.
 *
 * Every operation has a deadline, and the whole reading has a budget. A
 * connection whose operation failed or timed out is destroyed rather than
 * returned to its pool, so an abandoned query or an open snapshot cannot leak
 * into the application's own work.
 */
export const ERROR_CODES = Object.freeze([
  "database_unavailable",
  "database_session_failed",
  "database_snapshot_failed",
  "database_read_failed",
  "database_cleanup_failed",
  "redis_not_configured",
  "redis_unavailable",
  "redis_read_failed",
  "redis_discovery_incomplete",
  "invalid_database_result",
  "invalid_redis_result",
  "operation_timeout",
  "run_budget_exhausted",
  "cleanup_failed",
  "intake_observed",
  "unknown_queue_observed",
] as const);
export type WorkloadErrorCode = (typeof ERROR_CODES)[number];
export type WorkloadVerdict = "no_go_unfinished_work" | "no_go_incomplete_evidence" | "zero_observed_not_proof";

/** One connection borrowed from the app's pool. Only catalogue statements reach it. */
export interface WorkloadDatabaseConnection {
  /** Run one catalogue statement. Resolves with the first row, or undefined. */
  run(id: DatabaseStatementId, signal: AbortSignal): Promise<unknown>;
  /** Return the connection to its pool. Only ever after a clean ROLLBACK. */
  release(): void;
  /** Destroy the connection so it never returns to the pool. */
  drop(): void;
}
/** One dedicated Redis connection. Only catalogue reads and metadata SCANs reach it. */
export interface WorkloadRedisConnection {
  read(id: RedisReadId, signal: AbortSignal): Promise<unknown>;
  /** One SCAN step over queue metadata keys: resolves with [cursor, keys]. */
  scan(cursor: string, signal: AbortSignal): Promise<unknown>;
  close(signal: AbortSignal): Promise<void>;
  drop(): void;
}
/** What this replica knows about itself. Railway's attribution, not attestation. */
export interface WorkloadReplica {
  lifecycle: "running" | "draining" | "drained" | "incomplete";
  /** Operations this replica's lifecycle tracks right now, this check's own request included. */
  trackedOperations: number;
  uptimeSeconds: number;
  commit: string | null;
  deploymentId: string | null;
  replicaId: string | null;
}
export interface WorkloadCheckDependencies {
  /** Resolves null when the app has no database configured. */
  openDatabase(signal: AbortSignal): Promise<WorkloadDatabaseConnection | null>;
  /** Resolves null when REDIS_URL is unset: queued work then lives only in process memory. */
  openRedis(signal: AbortSignal): Promise<WorkloadRedisConnection | null>;
  /** Monotonic milliseconds, for deadlines and the elapsed time. */
  monotonicMs(): number;
  /** The wall clock, for the report's timestamp only. */
  wallClock(): Date;
  replica(): WorkloadReplica;
}

export interface WorkloadSurfaceReading {
  id: SurfaceId;
  kind: SurfaceKind;
  count: number | null;
  oldestAgeSeconds: number | null;
}
export interface WorkloadCheckReport {
  schema: "reconcileai_workload_check_v1";
  /** Never permission: a person decides, and maintenance gates stay where they are. */
  hold: true;
  /** An allow-list of statements, not an engine privilege or a read-only transaction. */
  databaseControl: "statement_guard_only";
  verdict: WorkloadVerdict;
  checkedAt: string;
  elapsedMs: number;
  database: {
    snapshot: "consistent_snapshot" | "unavailable";
    cleanup: "ok" | "failed";
    surfaces: WorkloadSurfaceReading[];
    intake: { id: IntakeId; count: number | null }[];
  };
  redis: {
    backend: "redis" | "not_configured" | "unavailable";
    queues: { id: QueueId; states: Record<QueueState, number | null> }[];
    discovery: "complete" | "incomplete";
    unknownQueues: number | null;
  };
  replica: WorkloadReplica;
  notCollected: typeof NOT_COLLECTED;
  errors: WorkloadErrorCode[];
}

const BLOCKING_SURFACES: ReadonlySet<string> = new Set(DB_SURFACES.filter(s => s.kind !== "parked").map(s => s.id));
const SESSION_TIME_ZONE = "+00:00";

function integer(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : null;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function emptyReport(checkedAt: string, replica: WorkloadReplica): WorkloadCheckReport {
  return {
    schema: "reconcileai_workload_check_v1",
    hold: true,
    databaseControl: "statement_guard_only",
    verdict: "no_go_incomplete_evidence",
    checkedAt,
    elapsedMs: 0,
    database: {
      snapshot: "unavailable",
      cleanup: "ok",
      surfaces: DB_SURFACES.map(s => ({ id: s.id, kind: s.kind, count: null, oldestAgeSeconds: null })),
      intake: INTAKE_SOURCES.map(s => ({ id: s.id, count: null })),
    },
    redis: {
      backend: "unavailable",
      queues: QUEUE_IDS.map(id => ({
        id,
        states: Object.fromEntries(QUEUE_STATES.map(s => [s, null])) as Record<QueueState, number | null>,
      })),
      discovery: "incomplete",
      unknownQueues: null,
    },
    replica,
    notCollected: NOT_COLLECTED,
    errors: [],
  };
}

/** Take one reading. Never throws: every failure becomes a fixed code and a null. */
export async function runWorkloadCheck(deps: WorkloadCheckDependencies): Promise<WorkloadCheckReport> {
  const started = deps.monotonicMs();
  const report = emptyReport(deps.wallClock().toISOString(), deps.replica());
  const errors = new Set<WorkloadErrorCode>();
  const run = new AbortController();
  const budget = setTimeout(() => {
    errors.add("run_budget_exhausted");
    run.abort();
  }, LIMITS.runMs);

  /**
   * Run one operation under its own deadline and the run's budget. On failure
   * `abandon` destroys whatever the operation was using; the operation's own
   * late settlement is still observed by the race, so it cannot go unhandled.
   */
  async function bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    milliseconds: number,
    failure: WorkloadErrorCode,
    abandon: () => void,
  ): Promise<{ value: T } | null> {
    if (run.signal.aborted) {
      abandon();
      return null;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopListening = (): void => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        const cancel = (): void => {
          controller.abort();
          reject(new Error("operation_cancelled"));
        };
        run.signal.addEventListener("abort", cancel, { once: true });
        stopListening = () => run.signal.removeEventListener("abort", cancel);
        timer = setTimeout(() => {
          errors.add("operation_timeout");
          cancel();
        }, milliseconds);
      });
      return { value: await Promise.race([Promise.resolve().then(() => operation(controller.signal)), cancelled]) };
    } catch {
      errors.add(failure);
      abandon();
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stopListening();
    }
  }

  try {
    await readDatabase();
    await readRedis();
  } finally {
    clearTimeout(budget);
  }

  async function readDatabase(): Promise<void> {
    const opened = await bounded(signal => deps.openDatabase(signal), LIMITS.connectMs, "database_unavailable", () => {});
    if (!opened) return;
    if (!opened.value) {
      errors.add("database_unavailable");
      return;
    }
    const connection = opened.value;
    let usable = true;
    let statements = 0;
    const drop = (): void => {
      if (!usable) return;
      usable = false;
      try {
        connection.drop();
      } catch {
        errors.add("cleanup_failed");
      }
    };
    const statement = async (id: DatabaseStatementId, failure: WorkloadErrorCode) => {
      if (!usable) return null;
      if (++statements > LIMITS.databaseStatements) {
        errors.add("run_budget_exhausted");
        drop();
        return null;
      }
      return bounded(signal => connection.run(id, signal), LIMITS.queryMs, failure, drop);
    };

    const zone = await statement("session.timezone", "database_session_failed");
    if (zone && field(zone.value, "tz") !== SESSION_TIME_ZONE) {
      // Ages compare stored instants with NOW(); in another zone they would be wrong.
      errors.add("database_session_failed");
      drop();
    }
    if (usable && (await statement("session.snapshot", "database_snapshot_failed"))) {
      report.database.snapshot = "consistent_snapshot";
      for (const s of report.database.surfaces) {
        const result = await statement(s.id, "database_read_failed");
        if (!result) break;
        s.count = integer(field(result.value, "count"));
        const age = field(result.value, "oldestAgeSeconds");
        s.oldestAgeSeconds = integer(age);
        if (s.count === null || (s.count > 0 && s.oldestAgeSeconds === null) || (s.count === 0 && age !== null))
          errors.add("invalid_database_result");
        if (s.count === null || s.count === 0) s.oldestAgeSeconds = null;
      }
      for (const s of report.database.intake) {
        const result = await statement(`intake.${s.id}`, "database_read_failed");
        if (!result) break;
        s.count = integer(field(result.value, "count"));
        if (s.count === null) errors.add("invalid_database_result");
        else if (s.count > 0) errors.add("intake_observed");
      }
      // Always end the snapshot. A connection that cannot is destroyed, never pooled.
      if (!(await statement("session.rollback", "database_cleanup_failed"))) {
        report.database.cleanup = "failed";
        errors.add("database_cleanup_failed");
        drop();
      }
    }
    if (usable) {
      usable = false;
      try {
        connection.release();
      } catch {
        errors.add("cleanup_failed");
      }
    }
  }

  async function readRedis(): Promise<void> {
    let connection: WorkloadRedisConnection | null = null;
    let usable = false;
    let commands = 0;
    const drop = (): void => {
      if (!usable || !connection) return;
      usable = false;
      try {
        connection.drop();
      } catch {
        errors.add("cleanup_failed");
      }
    };
    const command = async (operation: (redis: WorkloadRedisConnection, signal: AbortSignal) => Promise<unknown>) => {
      const redis = connection;
      if (!usable || !redis) return null;
      if (++commands > LIMITS.redisCommands) {
        errors.add("run_budget_exhausted");
        drop();
        return null;
      }
      return bounded(signal => operation(redis, signal), LIMITS.redisMs, "redis_read_failed", drop);
    };

    const opened = await bounded(signal => deps.openRedis(signal), LIMITS.connectMs, "redis_unavailable", () => {});
    if (!opened) return;
    if (!opened.value) {
      report.redis.backend = "not_configured";
      errors.add("redis_not_configured");
      return;
    }
    connection = opened.value;
    usable = true;
    report.redis.backend = "redis";

    for (const q of report.redis.queues)
      for (const state of QUEUE_STATES) {
        const result = await command((redis, signal) => redis.read(`${q.id}.${state}`, signal));
        if (!result) break;
        q.states[state] = integer(result.value);
        if (q.states[state] === null) errors.add("invalid_redis_result");
      }

    const unknown = new Set<string>(); // Internal only: no queue name reaches the report.
    let cursor = "0";
    let complete = false;
    for (let round = 0; round < LIMITS.scanRounds && usable; round++) {
      const result = await command((redis, signal) => redis.scan(cursor, signal));
      if (!result) break;
      const value: unknown = result.value;
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value[0]) ||
        !Array.isArray(value[1]) ||
        value[1].length > LIMITS.scanKeysPerRead
      ) {
        errors.add("invalid_redis_result");
        break;
      }
      let valid = true;
      for (const key of value[1] as unknown[]) {
        const match = typeof key === "string" && key.length <= LIMITS.keyLength ? /^bull:([A-Za-z0-9_-]+):meta$/.exec(key) : null;
        if (!match) {
          errors.add("invalid_redis_result");
          valid = false;
          break;
        }
        if (!QUEUE_IDS.some(id => id === match[1])) unknown.add(match[1]);
        if (unknown.size >= LIMITS.unknownQueues) {
          valid = false;
          break;
        }
      }
      if (!valid) break;
      cursor = value[0];
      if (cursor === "0") {
        complete = true;
        break;
      }
    }
    if (unknown.size > 0) errors.add("unknown_queue_observed");
    report.redis.discovery = complete ? "complete" : "incomplete";
    report.redis.unknownQueues = complete || unknown.size > 0 ? unknown.size : null;
    if (!complete) errors.add("redis_discovery_incomplete");

    if (usable) {
      // QUIT, then drop the socket whatever QUIT did.
      const redis = connection;
      await bounded(signal => redis.close(signal), LIMITS.cleanupMs, "cleanup_failed", () => {});
      drop();
    }
  }

  report.elapsedMs = Math.max(0, Math.round(deps.monotonicMs() - started));
  report.errors = ERROR_CODES.filter(code => errors.has(code));
  const unfinished =
    report.database.surfaces.some(s => BLOCKING_SURFACES.has(s.id) && s.count !== null && s.count > 0) ||
    report.redis.queues.some(q => RUNNABLE_STATES.some(s => (q.states[s] ?? 0) > 0));
  const incomplete =
    report.errors.length > 0 ||
    report.database.snapshot !== "consistent_snapshot" ||
    report.database.cleanup !== "ok" ||
    report.database.surfaces.some(s => s.count === null) ||
    report.database.intake.some(s => s.count === null) ||
    report.redis.backend !== "redis" ||
    report.redis.discovery !== "complete" ||
    report.redis.unknownQueues !== 0 ||
    report.redis.queues.some(q => QUEUE_STATES.some(s => q.states[s] === null));
  report.verdict = unfinished ? "no_go_unfinished_work" : incomplete ? "no_go_incomplete_evidence" : "zero_observed_not_proof";
  return report;
}
