import { getDb } from "../db";
import { applicationLifecycle } from "./lifecycle";
import { compileRedisRead, compileStatement, LIMITS, SCAN_MATCH } from "./workloadCatalogue";
import type {
  WorkloadCheckDependencies,
  WorkloadDatabaseConnection,
  WorkloadRedisConnection,
  WorkloadReplica,
} from "./workloadCheck";

/**
 * The real connections behind the maintenance workload check.
 *
 * Database: ONE connection borrowed from the app's own pool (so the same
 * database, TLS settings and UTC session pin as the app), used for one
 * consistent snapshot and handed back only after a clean ROLLBACK. Only
 * catalogue statements are compiled; there is no other way in.
 *   - At most ONE request for a connection is outstanding per process. mysql2
 *     cannot withdraw a request from its pool queue, so one abandoned by a
 *     timeout stays queued until the pool answers; while it does, a new check
 *     is refused as `busy` instead of queuing another. A connection that
 *     arrives after its request was abandoned was never used: it goes back.
 *   - A connection whose statement failed or was cancelled is RETIRED: taken
 *     out of the pool AND its socket destroyed. mysql2 3.15's destroy() only
 *     half-closes (stream.end()), which a stalled peer can hold open. Closing
 *     the socket ends this process's side; it is not proof the server stopped
 *     the statement. MAX_EXECUTION_TIME(1000) bounds that on the server.
 *
 * Redis: a dedicated connection to the app's own REDIS_URL, made with BullMQ's
 * connection class but never a BullMQ Queue, because constructing a Queue
 * writes the queue's metadata key. Connecting sends AUTH and SELECT when the
 * URL carries them, then INFO; closing sends QUIT. No client-info tag, no
 * retries, no offline queue, no reconnects. Commands are the catalogue's LLEN
 * and ZCARD reads and SCAN over queue metadata keys.
 *
 * Nothing here logs. Failures become the caller's fixed codes, so no host, key
 * or connection string can reach a log or a page.
 */

/** Reject when `signal` aborts. The race still observes `work`'s late settlement. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return Promise.race([work, aborted]);
}

/** The parts of a mysql2 pool connection the reader uses. */
export interface BorrowedConnection {
  query(options: { sql: string; timeout: number }, callback: (error: Error | null, rows: unknown) => void): unknown;
  release(): void;
  destroy(): void;
  /** The connection's socket (a TLS socket once TLS has started). */
  stream?: { destroy(): void };
}
/** The part of a mysql2 pool the reader uses. */
export interface ConnectionSource {
  getConnection(callback: (error: Error | null, connection?: BorrowedConnection) => void): void;
}

let outstanding = false;

/** Out of the pool, and the socket closed now rather than whenever the peer answers. */
function retire(connection: BorrowedConnection): void {
  try {
    connection.destroy();
  } finally {
    connection.stream?.destroy();
  }
}

function borrow(source: ConnectionSource, signal: AbortSignal): Promise<BorrowedConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    outstanding = true;
    signal.addEventListener("abort", onAbort, { once: true });
    source.getConnection((error, connection) => {
      outstanding = false;
      signal.removeEventListener("abort", onAbort);
      if (settled) {
        // Abandoned before the pool answered: it was never used, so give it back.
        connection?.release();
        return;
      }
      settled = true;
      if (error || !connection) reject(new Error("unavailable"));
      else resolve(connection);
    });
  });
}

/**
 * Borrow one connection from `source` for one reading. Resolves "busy" while an
 * earlier request is still waiting in the pool, without adding another.
 */
export async function openPoolDatabase(
  source: ConnectionSource,
  signal: AbortSignal,
): Promise<WorkloadDatabaseConnection | "busy"> {
  if (outstanding) return "busy";
  const connection = await borrow(source, signal);
  return {
    run: (id, operationSignal) =>
      new Promise((resolve, reject) => {
        const sql = compileStatement(id);
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          // A cancelled statement may still be running: retire the connection.
          retire(connection);
          reject(new Error("aborted"));
        };
        if (operationSignal.aborted) {
          onAbort();
          return;
        }
        operationSignal.addEventListener("abort", onAbort, { once: true });
        connection.query({ sql, timeout: LIMITS.queryMs }, (error, rows) => {
          operationSignal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          if (error) reject(new Error("statement_failed"));
          else resolve(Array.isArray(rows) ? rows[0] : undefined);
        });
      }),
    release: () => connection.release(),
    drop: () => retire(connection),
  };
}

export async function openAppDatabase(signal: AbortSignal): Promise<WorkloadDatabaseConnection | "busy" | null> {
  const db = await getDb();
  if (!db) return null;
  return openPoolDatabase(db.$client, signal);
}

export async function openAppRedis(signal: AbortSignal): Promise<WorkloadRedisConnection | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  const { RedisConnection } = await import("bullmq");
  const connection = new RedisConnection(
    {
      url,
      connectTimeout: LIMITS.connectMs,
      commandTimeout: LIMITS.redisMs,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      disableClientInfo: true,
    },
    { shared: false, blocking: false, skipVersionCheck: true },
  );
  // Without a listener an 'error' event throws. The caller reports a fixed code.
  connection.on("error", () => {});
  let client: Awaited<typeof connection.client>;
  try {
    client = await abortable(connection.client, signal);
  } catch (error) {
    // Never leave it connecting in the background.
    await connection.close(true);
    throw error;
  }
  return {
    read: (id, operationSignal) => {
      const read = compileRedisRead(id);
      return abortable(read.command === "LLEN" ? client.llen(read.key) : client.zcard(read.key), operationSignal);
    },
    scan: (cursor, operationSignal) => {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(cursor)) return Promise.reject(new Error("scan_refused"));
      return abortable(client.scan(cursor, { MATCH: SCAN_MATCH, COUNT: LIMITS.scanCount }), operationSignal);
    },
    close: closeSignal => abortable(connection.close(), closeSignal),
    drop: () => client.disconnect(),
  };
}

const COMMIT = /^[0-9a-f]{40}$/;
const RAILWAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A value of the expected shape, or null: never an arbitrary environment string. */
function shaped(value: string | undefined, pattern: RegExp): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && pattern.test(trimmed) ? trimmed : null;
}

export function appReplica(env: NodeJS.ProcessEnv = process.env): WorkloadReplica {
  const lifecycle = applicationLifecycle.snapshot();
  return {
    lifecycle: lifecycle.state,
    trackedOperations: lifecycle.active,
    uptimeSeconds: Math.floor(process.uptime()),
    commit: shaped(env.RAILWAY_GIT_COMMIT_SHA, COMMIT),
    deploymentId: shaped(env.RAILWAY_DEPLOYMENT_ID, RAILWAY_ID),
    replicaId: shaped(env.RAILWAY_REPLICA_ID, RAILWAY_ID),
  };
}

export function appWorkloadDependencies(): WorkloadCheckDependencies {
  return {
    openDatabase: openAppDatabase,
    openRedis: openAppRedis,
    monotonicMs: () => performance.now(),
    wallClock: () => new Date(),
    replica: () => appReplica(),
  };
}
