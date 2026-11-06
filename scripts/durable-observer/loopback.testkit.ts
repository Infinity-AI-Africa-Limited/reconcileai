/** TEST ONLY: dedicated finite harness fixtures, never a deployment adapter.
 * The harness creates NEW MySQL data and nonpersistent Redis before supplying
 * random loopback ports. No URL, dotenv, application import or worker API.
 * Exact statement allow-list only; no engine READ ONLY is requested or claimed.
 */
import { createRequire } from "node:module";
import mysql, { type Connection, type ConnectionOptions } from "mysql2";
import {
  compileDatabaseQuery, compileRedisRead, compileRedisScan, LIMITS,
  type DatabaseQueryId, type RedisReadId,
} from "./catalogue";
import type { DatabaseReader, ObserverClock, ObserverDependencies, RedisReader } from "./core";

export const FIXTURE_DATABASE = "reconcileai_test";
export interface LoopbackFixture {
  readonly host: "127.0.0.1";
  readonly database: typeof FIXTURE_DATABASE;
  readonly mysqlPort: number;
  readonly redisPort: number;
}
type FixtureInputs = {
  DURABLE_OBSERVER_TEST_MYSQL_PORT?: string;
  DURABLE_OBSERVER_TEST_REDIS_PORT?: string;
};
function port(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{4}$/.test(value)) throw new Error("loopback_fixture_refused");
  const result = Number(value);
  // Linux ephemeral range used by the dedicated harness, never default ports.
  if (result < 32768 || result > 65535) throw new Error("loopback_fixture_refused");
  return result;
}
export function requireLoopbackFixture(inputs: FixtureInputs = {
  DURABLE_OBSERVER_TEST_MYSQL_PORT: process.env.DURABLE_OBSERVER_TEST_MYSQL_PORT,
  DURABLE_OBSERVER_TEST_REDIS_PORT: process.env.DURABLE_OBSERVER_TEST_REDIS_PORT,
}): LoopbackFixture {
  const fixture: LoopbackFixture = { host: "127.0.0.1", database: FIXTURE_DATABASE,
    mysqlPort: port(inputs.DURABLE_OBSERVER_TEST_MYSQL_PORT),
    redisPort: port(inputs.DURABLE_OBSERVER_TEST_REDIS_PORT) };
  assertFixture(fixture);
  return Object.freeze(fixture);
}
function assertFixture(fixture: LoopbackFixture): void {
  if (fixture.host !== "127.0.0.1" || fixture.database !== FIXTURE_DATABASE ||
    !Number.isSafeInteger(fixture.mysqlPort) || !Number.isSafeInteger(fixture.redisPort) ||
    fixture.mysqlPort < 32768 || fixture.mysqlPort > 65535 ||
    fixture.redisPort < 32768 || fixture.redisPort > 65535 || fixture.mysqlPort === fixture.redisPort) {
    throw new Error("loopback_fixture_refused");
  }
}
function assertAuthorizedFixture(fixture: LoopbackFixture): void {
  assertFixture(fixture);
  const supplied = requireLoopbackFixture();
  if (fixture.mysqlPort !== supplied.mysqlPort || fixture.redisPort !== supplied.redisPort) {
    throw new Error("loopback_fixture_refused");
  }
}
export function fixtureMysqlOptions(fixture: LoopbackFixture): ConnectionOptions {
  assertAuthorizedFixture(fixture);
  return { host: "127.0.0.1", port: fixture.mysqlPort, database: FIXTURE_DATABASE,
    user: "root", password: "", timezone: "Z", connectTimeout: LIMITS.queryMs,
    multipleStatements: false, enableKeepAlive: false };
}

/** Minimal structural type avoids a new direct dependency or BullMQ imports. */
export interface FixtureRedisClient {
  connect(): Promise<void>;
  call(command: string, ...args: string[]): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  on(event: "error", listener: () => void): unknown;
}
interface FixtureRedisOptions {
  host: "127.0.0.1"; port: number; lazyConnect: true;
  maxRetriesPerRequest: 0; enableOfflineQueue: false;
  retryStrategy: () => null; reconnectOnError: () => false;
  enableReadyCheck: false; disableClientInfo: true;
  autoResubscribe: false; autoResendUnfulfilledCommands: false;
  connectTimeout: number; commandTimeout: number;
}
export function createFixtureRedisClient(fixture: LoopbackFixture): FixtureRedisClient {
  assertAuthorizedFixture(fixture);
  const require = createRequire(import.meta.url);
  // Resolve the installed transitive dependency, do not load BullMQ itself.
  const bullmqRequire = createRequire(require.resolve("bullmq/package.json"));
  const Redis = bullmqRequire("ioredis") as new (options: FixtureRedisOptions) => FixtureRedisClient;
  const client = new Redis({ host: "127.0.0.1", port: fixture.redisPort,
    lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    retryStrategy: () => null, reconnectOnError: () => false,
    enableReadyCheck: false, disableClientInfo: true,
    autoResubscribe: false, autoResendUnfulfilledCommands: false,
    connectTimeout: LIMITS.redisMs, commandTimeout: LIMITS.redisMs });
  // Driver error objects are never logged or returned; failures are fixed codes.
  client.on("error", () => {});
  return client;
}
async function bounded<T>(signal: AbortSignal, milliseconds: number, drop: () => void,
  operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = (): void => {};
  try {
    if (signal.aborted) throw new Error("fixture_operation_failed");
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { drop(); reject(new Error("fixture_operation_failed")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, milliseconds);
    });
    return await Promise.race([Promise.resolve().then(operation), cancelled]);
  } catch {
    drop();
    throw new Error("fixture_operation_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
function query(connection: Connection, sql: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error, rows) => { if (error) reject(error); else resolve(rows); });
  });
}
export function fixtureClock(): ObserverClock {
  let elapsed = 0;
  // Logical test intervals only; actual command deadlines remain wall-clock timers.
  return { now: () => elapsed, wait: async (milliseconds, signal) => {
    if (signal.aborted) throw new Error("fixture_operation_failed");
    elapsed += milliseconds;
  } };
}
/** Constructor ownership is guarded too; a second-client failure cannot leak the first. */
export function allocateFixturePair<D extends { destroy(): void }, R extends { disconnect(reconnect?: boolean): void }>(
  databaseFactory: () => D, redisFactory: () => R,
): { database: D; redis: R } {
  let database: D | undefined;
  let redis: R | undefined;
  try {
    database = databaseFactory();
    redis = redisFactory();
    return { database, redis };
  } catch {
    try { database?.destroy(); } catch { /* Never release constructor/cleanup diagnostics. */ }
    try { redis?.disconnect(false); } catch { /* Fixed error below. */ }
    throw new Error("fixture_connection_failed");
  }
}
export async function createLoopbackReaders(fixture: LoopbackFixture = requireLoopbackFixture()): Promise<ObserverDependencies> {
  assertAuthorizedFixture(fixture); // Validate before either driver can open a socket.
  const { database: connection, redis: client } = allocateFixturePair(
    () => mysql.createConnection(fixtureMysqlOptions(fixture)), () => createFixtureRedisClient(fixture),
  );
  let databaseDropped = false, redisDropped = false, utc = false, snapshot = false;
  const dropDatabase = (): void => { databaseDropped = true; connection.destroy(); };
  const dropRedis = (): void => { redisDropped = true; client.disconnect(false); };
  try {
    connection.on("error", () => {});
    const signal = new AbortController().signal;
    await bounded(signal, LIMITS.queryMs, dropDatabase, () => new Promise<void>((resolve, reject) => {
      connection.connect(error => { if (error) reject(error); else resolve(); });
    }));
    await bounded(signal, LIMITS.redisMs, dropRedis, () => client.connect());
  } catch {
    try { dropDatabase(); } catch { /* Attempt both owned clients; fixed error only. */ }
    try { dropRedis(); } catch { /* Fixed error only. */ }
    throw new Error("fixture_connection_failed");
  }
  const database: DatabaseReader = {
    async read(id: DatabaseQueryId, signal: AbortSignal): Promise<unknown> {
      const sql = compileDatabaseQuery(id); // Only finite IDs form SQL.
      if (databaseDropped || (id !== "session.utc" && !utc) ||
        (!id.startsWith("session.") && !snapshot)) {
        throw new Error("fixture_read_refused");
      }
      return bounded(signal, LIMITS.queryMs, dropDatabase, async () => {
        const rows = await query(connection, sql);
        if (id === "session.utc") utc = true;
        if (id === "session.snapshot") snapshot = true;
        if (id === "session.rollback") snapshot = false;
        if (id.startsWith("session.")) return undefined;
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error("fixture_result_refused");
        return rows[0] as unknown;
      });
    },
    async close(signal: AbortSignal): Promise<void> {
      if (databaseDropped) return;
      await bounded(signal, LIMITS.cleanupMs, dropDatabase, () => new Promise<void>((resolve, reject) => {
        connection.end(error => { if (error) reject(error); else resolve(); });
      }));
      databaseDropped = true;
    },
    drop: dropDatabase,
  };
  const redis: RedisReader = {
    async read(id: RedisReadId, signal: AbortSignal): Promise<unknown> {
      const command = compileRedisRead(id);
      if (redisDropped) throw new Error("fixture_read_refused");
      return bounded(signal, LIMITS.redisMs, dropRedis, () => client.call(command.command, ...command.args));
    },
    async scan(cursor: string, signal: AbortSignal): Promise<unknown> {
      const command = compileRedisScan(cursor);
      if (redisDropped) throw new Error("fixture_read_refused");
      return bounded(signal, LIMITS.redisMs, dropRedis, async () => {
        const result = await client.call(command.command, ...command.args);
        if (!Array.isArray(result) || result.length !== 2 || typeof result[0] !== "string" ||
          !/^(0|[1-9][0-9]{0,19})$/.test(result[0]) || !Array.isArray(result[1]) ||
          result[1].length > LIMITS.scanKeysPerRead) throw new Error("fixture_result_refused");
        let bytes = 0;
        for (const key of result[1] as unknown[]) {
          if (typeof key !== "string" || key.length > LIMITS.keyLength ||
            (bytes += key.length * 2) > LIMITS.scanBytesPerRead) throw new Error("fixture_result_refused");
        }
        return result;
      });
    },
    async close(signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("fixture_operation_failed");
      dropRedis(); // No QUIT or other noncatalogue Redis command.
    },
    drop: dropRedis,
  };
  return { database, redis, clock: fixtureClock() };
}
