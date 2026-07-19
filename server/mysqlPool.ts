/**
 * Resilient mysql2 pool factory shared by every MySQL connection in the app
 * (main TiDB database, Woodcore Fineract tenant, sync writer).
 *
 * Why this exists: TiDB Cloud serverless (and most managed MySQL gateways)
 * silently drop idle connections. A default mysql2 pool keeps those dead
 * sockets in its free list, so after an idle window EVERY query fails with
 * `read ECONNRESET` / `HANDSHAKE_SSL_ERROR` until the process restarts.
 * Observed on the dev server: scheduler ticks, SFTP polling, and API queries
 * all failing identically after ~40 minutes idle.
 *
 * Two layers of defence:
 *  1. Pool config — TCP keep-alive plus an idle timeout well below the
 *     gateway's cutoff, so pooled connections are retired before the gateway
 *     kills them.
 *  2. A one-retry wrapper on `query` / `execute` / `getConnection` — if a
 *     stale socket still slips through, the connection-level error is caught
 *     once and the call is repeated on a fresh connection instead of
 *     surfacing ECONNRESET to the caller.
 */
import mysql from "mysql2/promise";

/**
 * Error codes that indicate the connection (not the statement) failed.
 * These are safe to retry once: the dominant case is a stale idle socket,
 * where the query never reached the server.
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_PACKETS_OUT_OF_ORDER",
  "HANDSHAKE_SSL_ERROR",
  "HANDSHAKE_NO_SSL_SUPPORT",
]);

export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
}

type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>;

/** Exported for unit tests. */
export function withOneRetry(fn: AnyAsyncFn, label: string): AnyAsyncFn {
  return async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const code = (err as { code?: string }).code ?? "connection error";
      console.warn(`[mysqlPool] ${label} failed with ${code}; retrying once on a fresh connection`);
      return fn(...args);
    }
  };
}

/**
 * Create a mysql2 pool with keep-alive, idle-connection retirement, and a
 * one-retry-on-connection-error wrapper. Caller options override the
 * resilience defaults, so per-pool tuning (connectionLimit, dateStrings, …)
 * still works.
 */
export function createResilientPool(options: mysql.PoolOptions): mysql.Pool {
  const pool = mysql.createPool({
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 15_000,
    // Probe the socket so half-open connections are detected early.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // Retire pooled connections after 60s idle — well below any managed
    // gateway's idle cutoff (TiDB serverless kills idle connections in
    // minutes), so the pool re-dials instead of reusing a dead socket.
    idleTimeout: 60_000,
    maxIdle: 2,
    ...options,
  });

  // The promise Pool's methods are heavily overloaded, so the patched
  // versions are attached through a narrow structural cast.
  const patched = pool as unknown as Record<string, AnyAsyncFn>;
  patched.query = withOneRetry(pool.query.bind(pool) as AnyAsyncFn, "query");
  patched.execute = withOneRetry(pool.execute.bind(pool) as AnyAsyncFn, "execute");
  // getConnection only dials — no statement has run yet, so retrying is always safe.
  patched.getConnection = withOneRetry(pool.getConnection.bind(pool) as AnyAsyncFn, "getConnection");
  return pool;
}
