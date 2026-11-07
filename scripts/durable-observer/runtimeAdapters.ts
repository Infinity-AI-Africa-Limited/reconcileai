/** Internal callable preparation only. No environment lookup, CLI or app startup.
 * Route parsing, DB TLS and Redis construction/connect remain the pinned probe's.
 * See vendor/PROVENANCE.md for the narrower observer guards and cleanup choices.
 */
import net, { type Socket } from "node:net";
import { types } from "node:util";
import {
  planDatabaseRoute,
  planRedisRoute,
  openDatabase,
  prepareRedis,
  connectRedis,
  createDeadline,
  type DatabaseProbe,
  type PreparedRedis,
} from "./vendor/production-workload-preflight.mjs";
import {
  compileDatabaseQuery,
  compileRedisRead,
  compileRedisScan,
  LIMITS,
  type DatabaseQueryId,
  type RedisReadId,
} from "./catalogue";
import type { DatabaseReader, RedisReader } from "./core";

export interface RuntimeAdapterOptions {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly appDir: string;
  readonly signal: AbortSignal;
}
/** Trusted, explicitly injected synthetic harness only, never URL/env options.
 * Loopback requires all three injected openers; the real route planners are
 * always called, and cannot be replaced by this injection.
 */
export interface RuntimeAdapterTestInjection {
  readonly database?: typeof openDatabase;
  readonly prepareRedis?: typeof prepareRedis;
  readonly connectRedis?: typeof connectRedis;
  readonly databaseSocket?: (host: string, port: number) => Socket;
  readonly isolatedLoopback?: true;
}
export interface RuntimeReaders {
  readonly database: DatabaseReader;
  readonly redis: RedisReader;
}
type FixedError =
  | "route_refused"
  | "setup_aborted"
  | "setup_failed"
  | "database_session_failed"
  | "database_read_failed"
  | "redis_read_failed"
  | "invalid_database_result"
  | "invalid_redis_result"
  | "operation_aborted"
  | "operation_timeout"
  | "connection_unusable"
  | "cleanup_failed";
const fail = (code: FixedError): never => {
  throw new Error(code);
};

/** One owned store, no retry. Abort synchronously drops even setup-in-flight. */
class OwnedStore {
  private dead = false;
  private busy = false;
  private dropFailed = false;
  private onDrop: ((code: FixedError) => void) | undefined;
  private readonly drops: (() => void)[] = [];
  addDrop(action: () => void): void {
    if (this.dead) {
      try {
        action();
      } catch {
        this.dropFailed = true;
        fail("cleanup_failed");
      }
    } else this.drops.push(action);
  }
  drop = (code: FixedError = "operation_aborted"): void => {
    if (this.dead) {
      if (this.dropFailed) fail("cleanup_failed");
      return;
    }
    this.dead = true;
    let failed = false;
    for (const action of this.drops.splice(0)) {
      try {
        action();
      } catch {
        failed = true;
      }
    }
    this.dropFailed = failed;
    this.onDrop?.(failed ? "cleanup_failed" : code);
    if (failed) fail("cleanup_failed");
  };
  async run<T>(
    signal: AbortSignal,
    ms: number,
    failure: FixedError,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.dead) return fail("connection_unusable");
    if (this.busy) {
      this.drop();
      return fail("connection_unusable");
    }
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = (): void => {};
    const deadline = performance.now() + ms;
    try {
      const cancellation = new Promise<never>((_, reject) => {
        this.onDrop = code => reject(new Error(code));
        cancel = () => {
          let code: FixedError =
            failure === "setup_failed" ? "setup_aborted" : "operation_aborted";
          try {
            this.drop(code);
          } catch {
            code = "cleanup_failed";
          }
          reject(new Error(code));
        };
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          try {
            this.drop("operation_timeout");
            reject(new Error("operation_timeout"));
          } catch {
            reject(new Error("cleanup_failed"));
          }
        }, ms);
        if (signal.aborted) cancel();
      });
      // Attach rejection handlers even if a driver completes after cancellation.
      const work = Promise.resolve()
        .then(() => {
          if (this.dead || signal.aborted)
            return fail(
              failure === "setup_failed" ? "setup_aborted" : "operation_aborted"
            );
          return operation();
        })
        .catch(() => {
          try {
            this.drop(failure);
          } catch {
            return fail("cleanup_failed");
          }
          return fail(failure);
        });
      const value = await Promise.race([work, cancellation]);
      // Response decoding or a delayed event loop can complete the promise
      // before an overdue timer fires. Acceptance is bounded independently.
      if (performance.now() >= deadline) {
        try {
          this.drop("operation_timeout");
        } catch {
          return fail("cleanup_failed");
        }
        return fail("operation_timeout");
      }
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      this.busy = false;
      this.onDrop = undefined;
    }
  }
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? (descriptor.value as unknown)
    : undefined;
}
function unsigned(
  value: unknown,
  code: "invalid_database_result" | "invalid_redis_result"
): number {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value))
    value = Number(value);
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
    ? value
    : fail(code);
}
function dbResult(id: DatabaseQueryId, rows: unknown): unknown {
  if (id.startsWith("session.")) {
    if (
      !rows ||
      typeof rows !== "object" ||
      Array.isArray(rows) ||
      types.isProxy(rows) ||
      ownValue(rows, "affectedRows") !== 0
    )
      return fail("invalid_database_result");
    return undefined;
  }
  if (!Array.isArray(rows) || types.isProxy(rows) || rows.length !== 1)
    return fail("invalid_database_result");
  const row: unknown = ownValue(rows, "0");
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    types.isProxy(row)
  )
    return fail("invalid_database_result");
  const expected = id.startsWith("intake.")
    ? ["count"]
    : ["count", "oldestAgeSeconds"];
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== expected.length ||
    keys.some(key => typeof key !== "string" || !expected.includes(key))
  )
    return fail("invalid_database_result");
  const count = unsigned(ownValue(row, "count"), "invalid_database_result");
  if (expected.length === 1) return { count };
  const rawAge = ownValue(row, "oldestAgeSeconds");
  const age =
    rawAge === null ? null : unsigned(rawAge, "invalid_database_result");
  if ((count === 0 && age !== null) || (count > 0 && age === null))
    return fail("invalid_database_result");
  return { count, oldestAgeSeconds: age };
}
function scanResult(value: unknown): [string, string[]] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length !== 2)
    return fail("invalid_redis_result");
  const cursor = ownValue(value, "0"),
    keys = ownValue(value, "1");
  if (
    typeof cursor !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(cursor) ||
    !Array.isArray(keys) ||
    types.isProxy(keys) ||
    keys.length > LIMITS.scanKeysPerRead
  )
    return fail("invalid_redis_result");
  let bytes = 0;
  const screened: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = ownValue(keys, String(i));
    if (
      typeof key !== "string" ||
      key.length > LIMITS.keyLength ||
      (bytes += key.length * 2) > LIMITS.scanBytesPerRead ||
      !/^bull:[A-Za-z0-9_-]+:meta$/.test(key)
    )
      return fail("invalid_redis_result");
    screened.push(key);
  }
  return [cursor, screened];
}

/** Tighten, do not replace the reused route planners. Runtime hosts are DNS
 * names, never IP literals/numeric aliases or localhost. TLS loopback is also
 * refused. Only a complete explicitly isolated injected harness can relax it.
 */
function runtimeHost(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const normal = host
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    net.isIP(normal) ||
    normal === "localhost" ||
    normal.endsWith(".localhost") ||
    normal.endsWith(".local")
  )
    return false;
  // WHATWG's HTTP parser canonicalises numeric aliases such as 127.1 / 0x7f.1.
  try {
    if (net.isIP(new URL(`http://${normal}`).hostname.replace(/^\[|\]$/g, "")))
      return false;
  } catch {
    return false;
  }
  return (
    normal.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normal
    )
  );
}

export async function openRuntimeReaders(
  options: RuntimeAdapterOptions,
  injected: RuntimeAdapterTestInjection = {}
): Promise<RuntimeReaders> {
  const dbOwner = new OwnedStore(),
    redisOwner = new OwnedStore();
  let db: DatabaseProbe | undefined, prepared: PreparedRedis | undefined;
  let routesAccepted = false;
  let abortCleanupFailed = false;
  const abortSetup = (): void => {
    for (const owner of [dbOwner, redisOwner]) {
      try {
        owner.drop();
      } catch {
        abortCleanupFailed = true;
      }
    }
  };
  options.signal.addEventListener("abort", abortSetup, { once: true });
  try {
    if (options.signal.aborted) return fail("setup_aborted");
    const dbPlan = planDatabaseRoute(options.databaseUrl),
      redisPlan = planRedisRoute(options.redisUrl);
    const isolated =
      injected.isolatedLoopback === true &&
      injected.database !== undefined &&
      injected.prepareRedis !== undefined &&
      injected.connectRedis !== undefined;
    if (
      new URL(options.databaseUrl).protocol !== "mysql:" ||
      !dbPlan.connection ||
      redisPlan.route === "not_configured"
    )
      return fail("route_refused");
    if (
      !isolated &&
      (dbPlan.route !== "tls_verified_identity" ||
        !runtimeHost(dbPlan.connection.host) ||
        !runtimeHost(redisPlan.host))
    )
      return fail("route_refused");
    if (
      !isolated &&
      (dbPlan.connection.ssl?.rejectUnauthorized !== true ||
        dbPlan.connection.ssl.verifyIdentity !== true ||
        !["railway_private_network", "tls_verified"].includes(redisPlan.route))
    )
      return fail("route_refused");
    routesAccepted = true;
    const deadline = createDeadline(LIMITS.runMs);
    // Prepare lazy Redis BEFORE opening DB, retaining its client for every
    // failure path. The imported constructor checks parsed host/TLS/path.
    const candidate = (injected.prepareRedis ?? prepareRedis)(
      redisPlan,
      options.appDir
    );
    if ("error" in candidate) return fail("setup_failed");
    prepared = candidate;
    redisOwner.addDrop(() => candidate.client.disconnect());
    if (
      candidate.tls !== redisPlan.tls ||
      Boolean(candidate.client.options.tls) !== candidate.tls ||
      (candidate.tls &&
        ownValue(candidate.client.options.tls, "rejectUnauthorized") !== true)
    )
      return fail("setup_failed");
    // The probe's DB opener does not expose a handle until after handshake and
    // its initial SELECT VERSION / UTC probe. mysql2's supported stream factory
    // gives us ownership DURING that wait; the same imported TLS handshake is
    // still used, with the original host and verifyIdentity:true options.
    const target = dbPlan.connection;
    let socketCreated = false;
    const ownedPlan = {
      ...dbPlan,
      connection: {
        ...target,
        stream: (): Socket => {
          if (socketCreated || options.signal.aborted)
            return fail("setup_failed");
          socketCreated = true;
          const socket = (
            injected.databaseSocket ??
            ((host, port) => net.createConnection({ host, port }))
          )(target.host, target.port);
          dbOwner.addDrop(() => {
            socket.destroy();
          });
          return socket;
        },
      },
    };
    db = await dbOwner.run(
      options.signal,
      LIMITS.queryMs,
      "setup_failed",
      async () => {
        const probe = await (injected.database ?? openDatabase)(
          ownedPlan,
          options.appDir,
          deadline
        );
        if ("error" in probe) return fail("setup_failed");
        dbOwner.addDrop(() => probe.abort()); // Also immediately aborts a late opener.
        if (
          probe.controls.session_time_zone_utc !== true ||
          !["tidb", "mysql"].includes(probe.controls.engine)
        )
          return fail("database_session_failed");
        return probe;
      }
    );
    const redis = await redisOwner.run(
      options.signal,
      LIMITS.redisMs,
      "setup_failed",
      async () => {
        const probe = await (injected.connectRedis ?? connectRedis)(
          candidate,
          deadline
        );
        if ("error" in probe) return fail("setup_failed");
        redisOwner.addDrop(() => probe.abort());
        // Own the prepared client already; never export this broader command API.
        if (options.signal.aborted) return fail("setup_aborted");
        return probe;
      }
    );
    const database = db;
    const client = prepared.client;
    return Object.freeze({
      database: Object.freeze({
        read: (id: DatabaseQueryId, signal: AbortSignal): Promise<unknown> =>
          dbOwner.run(
            signal,
            LIMITS.queryMs,
            "database_read_failed",
            async () => {
              return dbResult(id, await database.run(compileDatabaseQuery(id)));
            }
          ),
        // Probe close() swallows end failures. Instead, fixed guarded rollback
        // must succeed, then synchronously drop; no unobservable end() wait.
        close: async (signal: AbortSignal): Promise<void> => {
          await dbOwner.run(
            signal,
            LIMITS.cleanupMs,
            "cleanup_failed",
            async () => {
              dbResult(
                "session.rollback",
                await database.run(compileDatabaseQuery("session.rollback"))
              );
            }
          );
          dbOwner.drop();
        },
        drop: (): void => dbOwner.drop(),
      }),
      redis: Object.freeze({
        read: (id: RedisReadId, signal: AbortSignal): Promise<unknown> =>
          redisOwner.run(
            signal,
            LIMITS.redisMs,
            "redis_read_failed",
            async () => {
              const fixed = compileRedisRead(id);
              return unsigned(
                await redis.call(fixed.command, ...fixed.args),
                "invalid_redis_result"
              );
            }
          ),
        scan: (cursor: string, signal: AbortSignal): Promise<unknown> =>
          redisOwner.run(
            signal,
            LIMITS.redisMs,
            "redis_read_failed",
            async () => {
              const fixed = compileRedisScan(cursor);
              return scanResult(await redis.call(fixed.command, ...fixed.args));
            }
          ),
        // Bypass probe close()'s settleWithin swallowing, await QUIT directly.
        close: async (signal: AbortSignal): Promise<void> => {
          await redisOwner.run(
            signal,
            LIMITS.cleanupMs,
            "cleanup_failed",
            async () => {
              if ((await client.quit()) !== "OK") return fail("cleanup_failed");
            }
          );
          redisOwner.drop();
        },
        drop: (): void => redisOwner.drop(),
      }),
    });
  } catch (error) {
    let cleanupFailed = false;
    for (const owner of [dbOwner, redisOwner]) {
      try {
        owner.drop();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed || abortCleanupFailed) return fail("cleanup_failed");
    // Never stringify a driver/callback error, message, host or URL.
    if (options.signal.aborted) return fail("setup_aborted");
    return fail(routesAccepted ? "setup_failed" : "route_refused");
  } finally {
    options.signal.removeEventListener("abort", abortSetup);
  }
}
