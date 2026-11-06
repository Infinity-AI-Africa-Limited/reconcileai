import {
  DB_SURFACES, INTAKE_SOURCES, QUEUE_IDS, QUEUE_STATES, LIMITS,
  type DatabaseQueryId, type RedisReadId, type QueueState,
} from "./catalogue";
import { NOT_COLLECTED, type ObserverErrorCode, type ObserverReport, type ObserverSample } from "./contracts";
export { NOT_COLLECTED, ERROR_CODES } from "./contracts";
export type { ObserverErrorCode, ObserverReport, ObserverSample, ObserverVerdict } from "./contracts";

/** Caller supplies ONE dedicated, already-owned connection per store. No pools,
 * reconnects, offline queues, app Queue/Worker objects or arbitrary SQL/keys.
 * Adapters must honour abort by cancelling outstanding work, and synchronously
 * drop their owned socket. A rejected/timed-out operation poisons that store.
 * Low-level adapters must compile IDs through the fixed catalogue and cap SCAN
 * responses BEFORE retaining them; COUNT is a hint, not a response-size bound.
 */
interface OwnedConnection {
  close(signal: AbortSignal): Promise<void>;
  drop(): void;
}
export interface DatabaseReader extends OwnedConnection {
  /** Aggregate SELECTs return ONE {count, oldestAgeSeconds?} object; session IDs return no data. */
  read(id: DatabaseQueryId, signal: AbortSignal): Promise<unknown>;
}
export interface RedisReader extends OwnedConnection {
  read(id: RedisReadId, signal: AbortSignal): Promise<unknown>;
  /** Return [decimalCursor, metadataKeys]; only compileRedisScan may form the command. */
  scan(cursor: string, signal: AbortSignal): Promise<unknown>;
}
export interface ObserverClock {
  /** Monotonic integer milliseconds, not a wall-clock identity. */
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export interface ObserverDependencies { database: DatabaseReader; redis: RedisReader; clock: ObserverClock }

function integer(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : null;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function emptySample(): ObserverSample {
  return {
    database: { snapshot: "unavailable", cleanup: "ok",
      surfaces: DB_SURFACES.map(s => ({ id: s.id, count: null, oldestAgeSeconds: null })),
      intake: INTAKE_SOURCES.map(s => ({ id: s.id, count: null })) },
    redis: { queues: QUEUE_IDS.map(id => ({ id,
      states: Object.fromEntries(QUEUE_STATES.map(s => [s, null])) as Record<QueueState, number | null> })),
      discovery: "incomplete", unknownQueues: null }, elapsedMs: 0,
  };
}

/** Preparation-only entry point. Never declares drain, shutdown or replacement safety. */
export async function observeDurableStores(deps: ObserverDependencies): Promise<ObserverReport> {
  const errors = new Set<ObserverErrorCode>();
  const samples: ObserverSample[] = [];
  let databaseUsable = true, redisUsable = true, expired = false;
  let databaseCommands = 0, redisCommands = 0;
  let started = 0, lastTime = 0;
  const runAbort = new AbortController();
  function drop(connection: OwnedConnection): void {
    try { connection.drop(); } catch { errors.add("cleanup_failed"); }
  }
  function poison(connection: OwnedConnection): void {
    if (connection === deps.database) databaseUsable = false;
    if (connection === deps.redis) redisUsable = false;
    drop(connection);
  }
  function elapsed(): number {
    const now = deps.clock.now();
    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < lastTime) throw new Error("clock_invalid");
    lastTime = now;
    return Math.min(LIMITS.runMs, now - started);
  }
  const budgetTimer = setTimeout(() => {
    expired = true;
    errors.add("run_budget_exhausted");
    runAbort.abort();
    poison(deps.database); poison(deps.redis);
  }, LIMITS.runMs);
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, milliseconds: number,
    failure: ObserverErrorCode, connection?: OwnedConnection, cleanup = false): Promise<{ value: T } | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = (): void => {};
    try {
      if (!cleanup && (expired || elapsed() >= LIMITS.runMs)) {
        expired = true; errors.add("run_budget_exhausted");
        if (connection) poison(connection);
        return null;
      }
      const cancellation = new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new Error("operation_cancelled")); };
        if (!cleanup) runAbort.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          errors.add("operation_timeout"); onAbort();
        }, milliseconds);
      });
      // Assimilate synchronous throws and observe late rejections. Abort ends
      // the wait AND drops this connection, not merely a Promise.race timeout.
      return { value: await Promise.race([Promise.resolve().then(() => operation(controller.signal)), cancellation]) };
    } catch {
      errors.add(failure);
      if (connection) poison(connection);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      runAbort.signal.removeEventListener("abort", onAbort);
    }
  }
  async function db(id: DatabaseQueryId, code: ObserverErrorCode): Promise<{ value: unknown } | null> {
    if (!databaseUsable) return null;
    if (++databaseCommands > LIMITS.databaseCommands) {
      errors.add("run_budget_exhausted"); poison(deps.database); return null;
    }
    return bounded(signal => deps.database.read(id, signal), LIMITS.queryMs, code, deps.database);
  }
  async function redis(operation: (signal: AbortSignal) => Promise<unknown>): Promise<{ value: unknown } | null> {
    if (!redisUsable) return null;
    if (++redisCommands > LIMITS.redisCommands) {
      errors.add("run_budget_exhausted"); poison(deps.redis); return null;
    }
    return bounded(operation, LIMITS.redisMs, "redis_read_failed", deps.redis);
  }
  async function databaseSample(sample: ObserverSample, index: number): Promise<void> {
    if (!databaseUsable) return;
    if (!(await db("session.snapshot", "database_snapshot_failed"))) return;
    sample.database.snapshot = "consistent_snapshot";
    try {
      for (const s of sample.database.surfaces) {
        const result = await db(s.id, "database_read_failed");
        if (!result) break;
        s.count = integer(field(result.value, "count"));
        const age = field(result.value, "oldestAgeSeconds");
        s.oldestAgeSeconds = integer(age);
        if (s.count === null || (s.count > 0 && s.oldestAgeSeconds === null) ||
          (s.count === 0 && age !== null)) errors.add("invalid_database_result");
        if (s.count === null || s.count === 0) s.oldestAgeSeconds = null;
      }
      if (index > 0) for (const s of sample.database.intake) {
        const result = await db(`intake.${s.id}`, "database_read_failed");
        if (!result) break;
        s.count = integer(field(result.value, "count"));
        if (s.count === null) errors.add("invalid_database_result");
        else if (s.count > 0) errors.add("intake_observed");
      }
    } catch {
      errors.add("invalid_database_result"); poison(deps.database);
    } finally {
      if (!databaseUsable || !(await db("session.rollback", "database_cleanup_failed"))) {
        sample.database.cleanup = "failed"; errors.add("database_cleanup_failed");
      }
    }
  }
  async function redisSample(sample: ObserverSample): Promise<void> {
    if (!redisUsable) return;
    for (const q of sample.redis.queues) for (const state of QUEUE_STATES) {
      const result = await redis(signal => deps.redis.read(`${q.id}.${state}`, signal));
      if (!result) break;
      q.states[state] = integer(result.value);
      if (q.states[state] === null) errors.add("invalid_redis_result");
    }
    const unknown = new Set<string>(); // INTERNAL ONLY: names never reach the report.
    let cursor = "0", complete = false;
    try {
      for (let round = 0; round < LIMITS.scanRounds && redisUsable; round++) {
        const result = await redis(signal => deps.redis.scan(cursor, signal));
        if (!result) break;
        const value: unknown = result.value;
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" ||
          !/^(0|[1-9][0-9]{0,19})$/.test(value[0]) || !Array.isArray(value[1]) ||
          value[1].length > LIMITS.scanKeysPerRead) break;
        let bytes = 0, valid = true;
        for (const key of value[1] as unknown[]) {
          if (typeof key !== "string" || key.length > LIMITS.keyLength ||
            (bytes += key.length * 2) > LIMITS.scanBytesPerRead) { valid = false; break; }
          const match = /^bull:([A-Za-z0-9_-]+):meta$/.exec(key);
          if (!match) { valid = false; break; }
          if (!QUEUE_IDS.some(id => id === match[1])) unknown.add(match[1]);
          if (unknown.size >= LIMITS.unknownQueues) { valid = false; break; }
        }
        if (unknown.size > 0) errors.add("unknown_queue_observed");
        if (!valid) break;
        cursor = value[0];
        if (cursor === "0") { complete = true; break; }
      }
    } catch { errors.add("invalid_redis_result"); poison(deps.redis); }
    sample.redis.discovery = complete ? "complete" : "incomplete";
    sample.redis.unknownQueues = complete || unknown.size > 0 ? unknown.size : null;
    if (!complete) errors.add("redis_discovery_incomplete");
  }
  try {
    started = deps.clock.now(); lastTime = started;
    if (typeof started !== "number" || !Number.isSafeInteger(started) || started < 0) throw new Error("clock_invalid");
    await db("session.utc", "database_session_failed");
    for (let index = 0; index < LIMITS.samples; index++) {
      if (index > 0) {
        const before = elapsed();
        if (!(await bounded(signal => deps.clock.wait(LIMITS.intervalMs, signal),
          LIMITS.intervalMs + LIMITS.queryMs, "clock_invalid"))) break;
        if (elapsed() - before < LIMITS.intervalMs) throw new Error("clock_invalid");
      }
      if (expired || elapsed() >= LIMITS.runMs) { errors.add("run_budget_exhausted"); break; }
      const sample = emptySample(); sample.elapsedMs = elapsed(); samples.push(sample);
      await databaseSample(sample, index);
      await redisSample(sample);
      sample.elapsedMs = elapsed();
    }
  } catch { errors.add("clock_invalid"); }
  finally {
    clearTimeout(budgetTimer);
    for (const connection of [deps.database, deps.redis]) {
      if (connection === deps.database ? !databaseUsable : !redisUsable) { drop(connection); continue; }
      const closed = await bounded(signal => connection.close(signal), LIMITS.cleanupMs, "cleanup_failed", connection, true);
      if (!closed && connection === deps.database && samples.length > 0) samples[samples.length - 1].database.cleanup = "failed";
      drop(connection);
    }
  }
  // Deliberately stricter than the original: parked, failed and repeat entries
  // also block this preparation report. No sums of overlapping populations.
  const unfinished = samples.some(sample => sample.database.surfaces.some(s => s.count !== null && s.count > 0) ||
    sample.redis.queues.some(q => QUEUE_STATES.some(s => (q.states[s] ?? 0) > 0)));
  const incomplete = errors.size > 0 || samples.length !== LIMITS.samples || samples.some((sample, index) =>
    sample.database.snapshot !== "consistent_snapshot" || sample.database.cleanup !== "ok" ||
    sample.database.surfaces.some(s => s.count === null) || (index > 0 && sample.database.intake.some(s => s.count === null)) ||
    sample.redis.discovery !== "complete" || sample.redis.unknownQueues !== 0 ||
    sample.redis.queues.some(q => QUEUE_STATES.some(s => q.states[s] === null)));
  return { schema: "reconcileai_durable_observer_v1", execution: "synthetic_only", hold: true,
    databaseControl: "statement_guard_only", verdict: unfinished ? "no_go_unfinished_work" : incomplete ? "no_go_incomplete_evidence" : "zero_observed_not_proof",
    samples, notCollected: NOT_COLLECTED, errors: [...errors] };
}

export const runObserver = observeDurableStores;
