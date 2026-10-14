/**
 * The UTC pin on each new connection, against a scripted pool. That a real
 * server then runs those sessions in UTC — whatever its own default — is
 * proven in dbSession.db.test.ts.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppPool, pinSessionTimeZone, SET_SESSION_TIME_ZONE } from "./dbSession";

function scriptedConnection(pinError: Error | null = null) {
  const statements: string[] = [];
  const connection = {
    destroyed: false,
    query(sql: string, callback: (error: Error | null) => void) {
      statements.push(sql);
      callback(sql === SET_SESSION_TIME_ZONE ? pinError : null);
    },
    destroy() {
      connection.destroyed = true;
    },
  };
  return { connection, statements };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("when the server opens a new database connection", () => {
  it("should make the UTC pin that connection's first statement", () => {
    const pool = new EventEmitter();
    pinSessionTimeZone(pool);
    const { connection, statements } = scriptedConnection();

    pool.emit("connection", connection);

    expect(statements).toEqual(["SET time_zone = '+00:00'"]);
    expect(connection.destroyed).toBe(false);
  });

  it("should pin every new connection, not only the first", () => {
    const pool = new EventEmitter();
    pinSessionTimeZone(pool);
    const first = scriptedConnection();
    const second = scriptedConnection();

    pool.emit("connection", first.connection);
    pool.emit("connection", second.connection);

    expect(first.statements).toEqual([SET_SESSION_TIME_ZONE]);
    expect(second.statements).toEqual([SET_SESSION_TIME_ZONE]);
  });

  it("should close a connection whose pin fails, rather than let it run in the server's zone", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = new EventEmitter();
    pinSessionTimeZone(pool);
    // Shaped as mysql2 raises it: code, errno and the server's own text.
    const driverError = Object.assign(new Error("Unknown or incorrect time zone: '+00:00' near 'WHERE secret = 1'"), {
      code: "ER_UNKNOWN_TIME_ZONE",
      errno: 1298,
      sqlMessage: "Unknown or incorrect time zone: '+00:00' near 'WHERE secret = 1'",
    });
    const { connection } = scriptedConnection(driverError);

    pool.emit("connection", connection);

    expect(connection.destroyed).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    // Logged by code, never by the driver's text (rule: error text never leaves raw).
    expect(JSON.stringify(logged.mock.calls)).not.toContain("WHERE secret");
  });
});

describe("when the app's pool is created", () => {
  it("should come with the pin attached", async () => {
    // Nothing connects until a query runs, so an unreachable address is fine here.
    const pool = createAppPool("mysql://user:password@127.0.0.1:9/never");
    expect(pool.listenerCount("connection")).toBe(1);
    await new Promise<void>(resolve => pool.end(() => resolve()));
  });
});
