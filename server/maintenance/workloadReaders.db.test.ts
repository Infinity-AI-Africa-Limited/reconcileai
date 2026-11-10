/**
 * The workload check's database adapter against a REAL MySQL when the server
 * stops answering, and when the pool cannot answer. CI's database only, gated
 * like the other *.db.test.ts files.
 *
 * A relay between the pool and the server can be frozen: it then forwards
 * nothing in either direction and never closes its side, which is how a
 * stalled peer looks from this process.
 */
import net from "node:net";
import type { PoolConnection } from "mysql2";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDatabaseTarget } from "../dbTarget";
import { createAppPool } from "../dbSession";
import { DB_SURFACES } from "./workloadCatalogue";
import { openPoolDatabase, type BorrowedConnection, type ConnectionSource } from "./workloadReaders";

const url = process.env.DATABASE_URL;
const localDatabase = Boolean(url) && classifyDatabaseTarget(url).local;

type Socket = net.Socket;
const socketOf = (connection: PoolConnection | BorrowedConnection): Socket =>
  (connection as unknown as { stream: Socket }).stream;

function relay(target: URL) {
  const sockets: Socket[] = [];
  let frozen = false;
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect(Number(target.port || 3306), target.hostname);
    sockets.push(client, upstream);
    for (const socket of [client, upstream]) socket.on("error", () => {});
    client.on("data", chunk => {
      if (!frozen) upstream.write(chunk);
    });
    upstream.on("data", chunk => {
      if (!frozen) client.write(chunk);
    });
  });
  return {
    listen: () =>
      new Promise<string>(resolve =>
        server.listen(0, "127.0.0.1", () => {
          const relayed = new URL(target.href);
          relayed.hostname = "127.0.0.1";
          relayed.port = String((server.address() as net.AddressInfo).port);
          resolve(relayed.href);
        }),
      ),
    freeze: () => {
      frozen = true;
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function take(pool: ReturnType<typeof createAppPool>): Promise<PoolConnection> {
  return new Promise((resolve, reject) => pool.getConnection((error, connection) => (error ? reject(error) : resolve(connection))));
}
const end = (pool: ReturnType<typeof createAppPool>) => new Promise<void>(resolve => pool.end(() => resolve()));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.runIf(localDatabase)("when the database stops answering mid-reading", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  async function relayedPool() {
    const stall = relay(new URL(url ?? ""));
    const pool = createAppPool(await stall.listen());
    cleanups.push(() => stall.close(), () => end(pool));
    return { stall, pool };
  }

  it("should close its own socket at the deadline, though the server never replies", async () => {
    const { stall, pool } = await relayedPool();
    const handed: PoolConnection[] = [];
    const source: ConnectionSource = {
      getConnection: callback =>
        pool.getConnection((error, connection) => {
          if (connection) handed.push(connection);
          callback(error, connection);
        }),
    };
    const reader = await openPoolDatabase(source, new AbortController().signal);
    if (reader === "busy") throw new Error("unexpected busy");
    await expect(reader.run("session.timezone", new AbortController().signal)).resolves.toMatchObject({ tz: "+00:00" });

    stall.freeze();
    const deadline = AbortSignal.timeout(300);
    await expect(reader.run(DB_SURFACES[0].id, deadline)).rejects.toThrow("aborted");
    const socket = socketOf(handed[0]);
    expect(socket.destroyed).toBe(true);
    // Closing our socket is all this proves. Whether the server stopped the
    // statement is not observable here; MAX_EXECUTION_TIME bounds it there.
  });

  it("should need the forced close: mysql2's destroy alone leaves the socket open on a stalled peer", async () => {
    const { stall, pool } = await relayedPool();
    const connection = await take(pool);
    stall.freeze();
    connection.destroy();
    await pause(300);
    // If this starts failing, mysql2 now closes the socket itself; the forced
    // close in workloadReaders.ts is then belt and braces, not the fix.
    expect(socketOf(connection).destroyed).toBe(false);
    socketOf(connection).destroy();
  });

  it("should get a fresh connection after retiring one", async () => {
    const pool = createAppPool(url ?? "");
    cleanups.push(() => end(pool));
    const first = await openPoolDatabase(pool, new AbortController().signal);
    if (first === "busy") throw new Error("unexpected busy");
    first.drop();
    const second = await openPoolDatabase(pool, new AbortController().signal);
    if (second === "busy") throw new Error("unexpected busy");
    await expect(second.run("session.timezone", new AbortController().signal)).resolves.toMatchObject({ tz: "+00:00" });
    second.release();
  });
});

describe.runIf(localDatabase)("when the pool has no connection to give", () => {
  it("should keep one request waiting at most, and hand the late connection back", async () => {
    const limited = new URL(url ?? "");
    limited.searchParams.set("connectionLimit", "1");
    const pool = createAppPool(limited.href);
    let requests = 0;
    const source: ConnectionSource = {
      getConnection: callback => {
        requests++;
        pool.getConnection(callback);
      },
    };
    const holder = await take(pool);
    try {
      await expect(openPoolDatabase(source, AbortSignal.timeout(200))).rejects.toThrow("aborted");
      await expect(openPoolDatabase(source, new AbortController().signal)).resolves.toBe("busy");
      expect(requests).toBe(1);
    } finally {
      holder.release();
    }
    // The pool hands the freed connection to the abandoned request, which gives it straight back.
    await pause(100);
    const reader = await openPoolDatabase(source, new AbortController().signal);
    if (reader === "busy") throw new Error("still busy after the pool answered");
    expect(requests).toBe(2);
    await expect(reader.run("session.timezone", new AbortController().signal)).resolves.toMatchObject({ tz: "+00:00" });
    reader.release();
    await end(pool);
  });
});
