import mysql from "mysql2";
import { loggableError } from "./dbErrors";

/**
 * Every session the server opens on its own database runs in UTC.
 *
 * drizzle writes a `timestamp` column as a zone-less UTC string
 * (`2026-10-14 09:00:00.000`) and reads one back by appending `Z`. MySQL
 * interprets that string in the SESSION time zone, which defaults to the
 * server's. So the stored instants were right only because production (TiDB
 * Cloud) and CI happen to run in UTC. A customer-managed MySQL in local time —
 * an on-premise bank in Lagos or Kampala — would have shifted every write and
 * every `DEFAULT now()` read by its offset, silently. Found when a TIMESTAMP at
 * 1970-01-01 00:00:01 UTC was refused as out of range by a WAT (+01:00) server.
 *
 * The offset form, not 'UTC': a named zone needs the time-zone tables, which
 * stock MySQL images do not load.
 */
export const SESSION_TIME_ZONE = "+00:00";
export const SET_SESSION_TIME_ZONE = `SET time_zone = '${SESSION_TIME_ZONE}'`;

type SessionConnection = {
  query(sql: string, callback: (error: Error | null) => void): unknown;
  destroy(): void;
};

/**
 * Pin each new physical connection of `pool` to UTC.
 *
 * mysql2 emits `connection` before it hands a new connection to its first
 * caller, and runs a connection's commands one at a time, in order. So the SET
 * is always the first statement the connection executes, and the caller's
 * query waits behind it.
 *
 * If the SET fails, the connection is destroyed and leaves the pool. The query
 * waiting behind it is then refused and never reaches the server; without the
 * destroy it would run in the server's zone. That behaviour is mysql2's command
 * queue, not ours, so `dbSession.db.test.ts` pins it against a real server.
 * `statement` is replaceable only so that test can make the pin fail.
 */
export function pinSessionTimeZone(
  pool: { on(event: "connection", listener: (connection: SessionConnection) => void): unknown },
  statement: string = SET_SESSION_TIME_ZONE
): void {
  pool.on("connection", connection => {
    connection.query(statement, error => {
      if (!error) return;
      console.error(
        "[db] could not pin the session time zone to UTC; closing the connection rather than run in the server's zone",
        loggableError(error)
      );
      connection.destroy();
    });
  });
}

/**
 * The pool for the server's own database (DATABASE_URL). Every pool on that
 * database must come from here — `server/dbSessionGate.test.ts` fails the build
 * on one that does not. The Woodcore source database (`woodcoreDb.ts`) is not
 * ours and keeps its own zone.
 */
export function createAppPool(uri: string): mysql.Pool {
  const pool = mysql.createPool({ uri });
  pinSessionTimeZone(pool);
  return pool;
}
