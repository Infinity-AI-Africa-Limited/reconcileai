import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  openRuntimeReaders,
  type RuntimeAdapterOptions,
  type RuntimeAdapterTestInjection,
} from "./runtimeAdapters";
import { observeDurableStores } from "./core";
import { screenReport } from "./screen";
import { serializeReport } from "./report";
import {
  DB_SURFACES,
  INTAKE_SOURCES,
  QUEUE_IDS,
  QUEUE_STATES,
  LIMITS,
  compileDatabaseQuery,
  compileRedisRead,
  compileRedisScan,
  type DatabaseQueryId,
  type RedisReadId,
} from "./catalogue";
import {
  planDatabaseRoute,
  planRedisRoute,
  prepareRedis,
  connectRedis,
  createDeadline,
  type DatabaseProbe,
  type PreparedRedis,
  type RedisProbe,
} from "./vendor/production-workload-preflight.mjs";

// Deliberately fake sentinels. No environment credentials or app modules.
const FAKE_SECRET = "OBVIOUSLY_FAKE_SYNTHETIC_SECRET_NEVER_VALID";
const APP_DIR = resolve(import.meta.dirname, "../..");
const SIGNAL = (): AbortSignal => new AbortController().signal;
function fixture() {
  const controller = new AbortController();
  const options: RuntimeAdapterOptions = {
    databaseUrl: `mysql://synthetic:${FAKE_SECRET}@tidb.example.invalid/synthetic`,
    redisUrl: `redis://synthetic:${FAKE_SECRET}@synthetic.railway.internal:6379/0`,
    appDir: APP_DIR,
    signal: controller.signal,
  };
  const run = vi.fn(async (sql: string): Promise<unknown> => {
    if (
      ["session.utc", "session.snapshot", "session.rollback"].some(
        id => sql === compileDatabaseQuery(id as DatabaseQueryId)
      )
    )
      return { affectedRows: 0 };
    return sql.includes("oldestAgeSeconds")
      ? [{ count: "0", oldestAgeSeconds: null }]
      : [{ count: "0" }];
  });
  const abort = vi.fn((): void => {});
  const swallowedBegin = vi.fn(async (): Promise<void> => {});
  const swallowedEnd = vi.fn(async (): Promise<void> => {});
  const swallowedClose = vi.fn(async (): Promise<void> => {});
  const database: DatabaseProbe = {
    run,
    abort,
    beginSnapshot: swallowedBegin,
    endSnapshot: swallowedEnd,
    close: swallowedClose,
    controls: {
      engine: "tidb",
      session_time_zone_utc: true,
      snapshot: "per_statement",
    },
  };
  const disconnect = vi.fn((): void => {}),
    quit = vi.fn(async (): Promise<unknown> => "OK");
  const prepared: PreparedRedis = {
    client: {
      options: { host: "synthetic.railway.internal", connectTimeout: 1000 },
      disconnect,
      quit,
    },
    tls: false,
    lastError: () => undefined,
  };
  const call = vi.fn(
    async (command: string, ..._args: string[]): Promise<unknown> =>
      command === "SCAN" ? ["0", QUEUE_IDS.map(id => `bull:${id}:meta`)] : "0"
  );
  const redis: RedisProbe = {
    call,
    abort: vi.fn((): void => {}),
    close: swallowedClose,
  };
  const openDb = vi.fn<NonNullable<RuntimeAdapterTestInjection["database"]>>(
    async () => database
  );
  const prep = vi.fn<NonNullable<RuntimeAdapterTestInjection["prepareRedis"]>>(
    () => prepared
  );
  const connect = vi.fn<
    NonNullable<RuntimeAdapterTestInjection["connectRedis"]>
  >(async () => redis);
  const injection: RuntimeAdapterTestInjection = {
    database: openDb,
    prepareRedis: prep,
    connectRedis: connect,
  };
  return {
    options,
    controller,
    injection,
    database,
    prepared,
    redis,
    run,
    abort,
    disconnect,
    quit,
    call,
    openDb,
    prep,
    connect,
    swallowedBegin,
    swallowedEnd,
    swallowedClose,
  };
}
const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("when a driver fulfills after its monotonic deadline before timers run", () => {
  it.each(["database", "redis", "cleanup"] as const)(
    "should refuse the overdue %s result and permanently poison its store",
    async phase => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      try {
        if (phase === "redis") {
          f.call.mockImplementationOnce(async () => {
            now += LIMITS.redisMs + 1;
            return "0";
          });
          await expect(
            readers.redis.read("shopify-order-sync.wait", SIGNAL())
          ).rejects.toThrow("operation_timeout");
          await expect(readers.redis.scan("0", SIGNAL())).rejects.toThrow(
            "connection_unusable"
          );
          expect(f.disconnect).toHaveBeenCalledTimes(1);
        } else {
          f.run.mockImplementationOnce(async () => {
            now +=
              (phase === "cleanup" ? LIMITS.cleanupMs : LIMITS.queryMs) + 1;
            return { affectedRows: 0 };
          });
          await expect(
            phase === "cleanup"
              ? readers.database.close(SIGNAL())
              : readers.database.read("session.utc", SIGNAL())
          ).rejects.toThrow("operation_timeout");
          await expect(
            readers.database.read("session.utc", SIGNAL())
          ).rejects.toThrow("connection_unusable");
          expect(f.abort).toHaveBeenCalledTimes(1);
        }
      } finally {
        readers.database.drop();
        readers.redis.drop();
      }
    }
  );
  it("should preserve cleanup failure precedence when an overdue result cannot be dropped cleanly", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.run.mockImplementationOnce(async () => {
      now += LIMITS.queryMs + 1;
      return { affectedRows: 0 };
    });
    f.abort.mockImplementationOnce(() => {
      throw new Error(FAKE_SECRET);
    });
    await expect(
      readers.database.read("session.utc", SIGNAL())
    ).rejects.toThrow(/^cleanup_failed$/);
    await expect(
      readers.database.read("session.utc", SIGNAL())
    ).rejects.toThrow("connection_unusable");
    readers.redis.drop();
  });
});

function driverHarness(mode: "constructor" | "host" | "tls" | "path") {
  const dir = mkdtempSync(join(tmpdir(), "observer-synthetic-driver-"));
  temporary.push(dir);
  mkdirSync(join(dir, "node_modules/bullmq/node_modules/ioredis"), {
    recursive: true,
  });
  writeFileSync(join(dir, "package.json"), '{"name":"synthetic-harness"}\n');
  writeFileSync(
    join(dir, "node_modules/bullmq/index.js"),
    "module.exports = {};\n"
  );
  writeFileSync(
    join(dir, "node_modules/bullmq/node_modules/ioredis/index.js"),
    `
    module.exports = class SyntheticRedis {
      constructor(url, options) {
        if (${JSON.stringify(mode)} === "constructor") throw new Error("${FAKE_SECRET}");
        const parsed = new URL(url);
        this.options = { ...options, host: ${JSON.stringify(mode)} === "host" ? "different.invalid" : parsed.hostname };
        if (${JSON.stringify(mode)} === "tls") this.options.tls = true;
        if (${JSON.stringify(mode)} === "path") this.options.path = "/synthetic-only";
      }
      on() {}
      disconnect() { require("node:fs").writeFileSync(${JSON.stringify(join(dir, "dropped"))}, "dropped"); }
    };
  `
  );
  return dir;
}

describe("when the authoritative public preflight is vendored", () => {
  it("should preserve the pinned bytes and record the full commit", () => {
    const root = resolve(import.meta.dirname, "vendor");
    const provenance = JSON.parse(
      readFileSync(join(root, "provenance.json"), "utf8")
    ) as { commit: string; sha256: string; sourcePath: string };
    expect(provenance.commit).toBe("b3b323f759dbe205653847af3ad424ce0e93c95f");
    expect(provenance.sourcePath).toBe(
      "scripts/production-workload-preflight.mjs"
    );
    expect(
      createHash("sha256")
        .update(readFileSync(join(root, "production-workload-preflight.mjs")))
        .digest("hex")
    ).toBe(provenance.sha256);
    expect(provenance.sha256).toBe(
      "9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab"
    );
  });
});
describe("when normal injected stores answer only fixed aggregate reads", () => {
  it("should reuse real route plans and run the unchanged synthetic-only core", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    let now = 0;
    const report = await observeDurableStores({
      ...readers,
      clock: {
        now: () => now,
        wait: async ms => {
          now += ms;
        },
      },
    });
    expect(report).toMatchObject({
      execution: "synthetic_only",
      hold: true,
      databaseControl: "statement_guard_only",
      verdict: "zero_observed_not_proof",
      errors: [],
    });
    expect(screenReport(serializeReport(report))).not.toContain(FAKE_SECRET);
    expect(f.openDb).toHaveBeenCalledTimes(1);
    expect(f.prep).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    const dbPlan = f.openDb.mock.calls[0][0];
    expect({
      ...dbPlan,
      connection: { ...dbPlan.connection, stream: undefined },
    }).toEqual({
      ...planDatabaseRoute(f.options.databaseUrl),
      connection: {
        ...planDatabaseRoute(f.options.databaseUrl).connection,
        stream: undefined,
      },
    });
    expect(f.prep.mock.calls[0][0]).toEqual(planRedisRoute(f.options.redisUrl));
    expect(dbPlan.connection?.ssl).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
    const fixedDb = new Set<string>(
      [
        "session.utc",
        "session.snapshot",
        "session.rollback",
        ...DB_SURFACES.map(s => s.id),
        ...INTAKE_SOURCES.map(s => `intake.${s.id}`),
      ].map(id => compileDatabaseQuery(id as DatabaseQueryId))
    );
    expect(f.run.mock.calls.every(([sql]) => fixedDb.has(sql))).toBe(true);
    expect(
      f.run.mock.calls.filter(
        ([sql]) => sql === "START TRANSACTION WITH CONSISTENT SNAPSHOT"
      )
    ).toHaveLength(3);
    expect(f.run.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(
      4
    );
    expect(
      f.call.mock.calls.every(([cmd]) =>
        ["LLEN", "ZCARD", "SCAN"].includes(cmd)
      )
    ).toBe(true);
    expect(f.swallowedBegin).not.toHaveBeenCalled();
    expect(f.swallowedEnd).not.toHaveBeenCalled();
    expect(f.swallowedClose).not.toHaveBeenCalled();
    expect(f.quit).toHaveBeenCalledTimes(1);
    expect(Object.keys(readers.database)).toEqual(["read", "close", "drop"]);
    expect(Object.keys(readers.redis)).toEqual([
      "read",
      "scan",
      "close",
      "drop",
    ]);
  });
  it("should dispatch every known Redis state and scan exactly as the catalogue compiles it", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    for (const q of QUEUE_IDS)
      for (const state of QUEUE_STATES) {
        const id: RedisReadId = `${q}.${state}`;
        await readers.redis.read(id, SIGNAL());
        const command = compileRedisRead(id);
        expect(f.call.mock.calls.at(-1)).toEqual([
          command.command,
          ...command.args,
        ]);
      }
    await readers.redis.scan("42", SIGNAL());
    const scan = compileRedisScan("42");
    expect(f.call.mock.calls.at(-1)).toEqual([scan.command, ...scan.args]);
    readers.database.drop();
    readers.redis.drop();
  });
  it("should accept exactly one positive aggregate row and bounded unknown metadata", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.run.mockResolvedValue([{ count: "7", oldestAgeSeconds: "9" }]);
    expect(await readers.database.read(DB_SURFACES[0].id, SIGNAL())).toEqual({
      count: 7,
      oldestAgeSeconds: 9,
    });
    f.run.mockResolvedValue([{ count: "2" }]);
    expect(
      await readers.database.read("intake.transactions", SIGNAL())
    ).toEqual({ count: 2 });
    f.call.mockResolvedValue(["0", ["bull:synthetic_unknown:meta"]]);
    expect(await readers.redis.scan("0", SIGNAL())).toEqual([
      "0",
      ["bull:synthetic_unknown:meta"],
    ]);
    readers.database.drop();
    readers.redis.drop();
  });
  it("should force verified DB TLS even when URL asks for ssl false", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(
      {
        ...f.options,
        databaseUrl: "mysql://tidb.example.invalid/synthetic?ssl=false",
      },
      f.injection
    );
    expect(f.openDb.mock.calls[0][0].connection?.ssl).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
    readers.database.drop();
    readers.redis.drop();
  });
});
describe("when a runtime route is not approved", () => {
  const dbBad = [
    "",
    "not-a-url",
    "postgres://host.invalid/db",
    "mysql://127.0.0.1/db",
    "mysql://[::1]/db",
    "mysql://localhost/db",
    "mysql://localhost./db",
    "mysql://a.localhost/db",
    "mysql://127.1/db",
    "mysql://2130706433/db",
    "mysql://0x7f.1/db",
    "mysql://db.local/db",
    "mysql://host.invalid/db?ssl=true",
  ];
  it.each(dbBad)(
    "should refuse database route %s before preparing or connecting",
    async databaseUrl => {
      const f = fixture();
      await expect(
        openRuntimeReaders({ ...f.options, databaseUrl }, f.injection)
      ).rejects.toThrow("route_refused");
      expect(f.openDb).not.toHaveBeenCalled();
      expect(f.prep).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    }
  );
  const redisBad = [
    "",
    "not-a-url",
    "http://host.invalid",
    "redis://public.example.invalid",
    "redis://127.0.0.1",
    "rediss://127.0.0.1",
    "redis://[::1]",
    "rediss://localhost",
    "redis://synthetic.railway.internal?tls=false",
    "rediss://host.invalid?retryStrategy=false",
  ];
  it.each(redisBad)(
    "should refuse Redis route %s before preparing or connecting",
    async redisUrl => {
      const f = fixture();
      await expect(
        openRuntimeReaders({ ...f.options, redisUrl }, f.injection)
      ).rejects.toThrow("route_refused");
      expect(f.openDb).not.toHaveBeenCalled();
      expect(f.prep).not.toHaveBeenCalled();
    }
  );
  it("should make zero real socket connections for rejected loopback routes with real openers", async () => {
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = net.createServer(socket => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("synthetic_listener_failed");
    try {
      const f = fixture();
      for (const options of [
        {
          ...f.options,
          databaseUrl: `mysql://127.0.0.1:${address.port}/synthetic`,
        },
        { ...f.options, redisUrl: `redis://127.0.0.1:${address.port}` },
        { ...f.options, redisUrl: `rediss://127.0.0.1:${address.port}` },
      ]) {
        await expect(openRuntimeReaders(options)).rejects.toThrow(
          "route_refused"
        );
      }
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      expect(connections).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("should accept loopback only with the complete explicit isolated injection", async () => {
    const f = fixture();
    const options = {
      ...f.options,
      databaseUrl: "mysql://127.0.0.1/synthetic",
      redisUrl: "redis://127.0.0.1",
    };
    await expect(
      openRuntimeReaders(options, { isolatedLoopback: true })
    ).rejects.toThrow("route_refused");
    const readers = await openRuntimeReaders(options, {
      ...f.injection,
      isolatedLoopback: true,
    });
    readers.database.drop();
    readers.redis.drop();
  });
});
describe("when setup aborts or only partly acquires connections", () => {
  it("should reject an already aborted signal without invoking any opener", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
      "setup_aborted"
    );
    expect(f.prep).not.toHaveBeenCalled();
  });
  it("should synchronously drop an in-flight real DB socket and lazy Redis then dispose a late opener", async () => {
    const f = fixture();
    const socket = new net.Socket();
    let release: (value: DatabaseProbe) => void = () => {};
    let entered: () => void = () => {};
    const ready = new Promise<void>(resolve => {
      entered = resolve;
    });
    f.openDb.mockImplementation(async plan => {
      plan.connection?.stream?.();
      entered();
      return new Promise<DatabaseProbe>(resolve => {
        release = resolve;
      });
    });
    const opening = openRuntimeReaders(f.options, {
      ...f.injection,
      databaseSocket: () => socket,
    });
    const rejected = expect(opening).rejects.toThrow("setup_aborted");
    await ready;
    f.controller.abort();
    expect(socket.destroyed).toBe(true);
    expect(f.disconnect).toHaveBeenCalled();
    await rejected;
    release(f.database);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("should cancel the actual imported DB opener during an isolated real-socket handshake", async () => {
    const f = fixture();
    const accepted = new Set<Socket>();
    let sawConnection: () => void = () => {};
    const ready = new Promise<void>(resolve => {
      sawConnection = resolve;
    });
    const server = net.createServer(socket => {
      accepted.add(socket);
      socket.on("close", () => accepted.delete(socket));
      sawConnection();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("synthetic_listener_failed");
    let ownedSocket: Socket | undefined;
    try {
      // Explicitly map only transport to an isolated listener: imported opener
      // and TLS host/options remain real, with no external DNS or connect.
      const opening = openRuntimeReaders(f.options, {
        prepareRedis: f.prep,
        connectRedis: f.connect,
        databaseSocket: () => {
          ownedSocket = net.createConnection({
            host: "127.0.0.1",
            port: address.port,
          });
          return ownedSocket;
        },
      });
      const rejected = expect(opening).rejects.toThrow(/^setup_aborted$/);
      await ready;
      f.controller.abort();
      expect(ownedSocket?.destroyed).toBe(true);
      expect(f.disconnect).toHaveBeenCalled();
      await rejected;
      expect(f.openDb).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      ownedSocket?.destroy();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("should drop both stores during pending Redis connect and observe a late rejection", async () => {
    const f = fixture();
    let entered: () => void = () => {},
      rejectLate: (reason: Error) => void = () => {};
    const ready = new Promise<void>(resolve => {
      entered = resolve;
    });
    f.connect.mockImplementation(async () => {
      entered();
      return new Promise<RedisProbe>((_, reject) => {
        rejectLate = reject;
      });
    });
    const opening = openRuntimeReaders(f.options, f.injection);
    const rejected = expect(opening).rejects.toThrow("setup_aborted");
    await ready;
    f.controller.abort();
    expect(f.abort).toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalled();
    await rejected;
    rejectLate(new Error(FAKE_SECRET));
    await Promise.resolve();
  });
  it("should drop prepared Redis when DB setup returns a fixed failure", async () => {
    const f = fixture();
    f.openDb.mockResolvedValue({ error: "tls_unverified" });
    await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
      "setup_failed"
    );
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("should reject a swallowed failed initial UTC or version probe and drop the DB", async () => {
    for (const controls of [
      {
        engine: "tidb",
        session_time_zone_utc: false,
        snapshot: "per_statement",
      },
      {
        engine: "unknown",
        session_time_zone_utc: true,
        snapshot: "per_statement",
      },
    ]) {
      const f = fixture();
      f.database.controls = controls;
      await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
        "setup_failed"
      );
      expect(f.abort).toHaveBeenCalled();
      expect(f.disconnect).toHaveBeenCalled();
    }
  });
  it("should clean up both stores on connect failure without leaking callback diagnostics", async () => {
    const f = fixture();
    f.connect.mockRejectedValue(
      new Error(`mysql://synthetic:${FAKE_SECRET}@synthetic.invalid`)
    );
    await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
      /^setup_failed$/
    );
    expect(f.abort).toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalled();
  });
  it("should bound a hanging DB setup and retain a fixed setup error", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.openDb.mockImplementation(
      async () => new Promise<DatabaseProbe>(() => {})
    );
    const opening = openRuntimeReaders(f.options, f.injection);
    const rejected = expect(opening).rejects.toThrow("setup_failed");
    await vi.advanceTimersByTimeAsync(LIMITS.queryMs);
    await rejected;
    expect(f.disconnect).toHaveBeenCalled();
  });
  it("should expose cleanup failure after attempting every partial cleanup", async () => {
    const f = fixture();
    f.disconnect.mockImplementation(() => {
      throw new Error(FAKE_SECRET);
    });
    f.connect.mockResolvedValue({ error: "tls_unverified" });
    await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
      /^cleanup_failed$/
    );
    expect(f.abort).toHaveBeenCalled();
  });
});
describe("when the imported Redis constructor and connector enforce transport settings", () => {
  it.each(["constructor", "host", "tls", "path"] as const)(
    "should reject %s without opening DB or connecting Redis",
    async mode => {
      const f = fixture();
      const appDir = driverHarness(mode);
      await expect(
        openRuntimeReaders(
          { ...f.options, appDir },
          { database: f.openDb, connectRedis: f.connect }
        )
      ).rejects.toThrow(/^setup_failed$/);
      expect(f.openDb).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
      if (mode !== "constructor")
        expect(readFileSync(join(appDir, "dropped"), "utf8")).toBe("dropped");
    }
  );
  it("should reuse real lazy preparation without opening a socket", () => {
    const socket = vi.spyOn(net, "createConnection");
    const prepared = prepareRedis(
      planRedisRoute("rediss://synthetic.example.invalid:6379/0"),
      APP_DIR
    );
    if ("error" in prepared) throw new Error("synthetic_driver_unavailable");
    try {
      expect(prepared.tls).toBe(true);
      expect(prepared.client.options.tls).toMatchObject({
        rejectUnauthorized: true,
      });
      expect(socket).not.toHaveBeenCalled();
    } finally {
      prepared.client.disconnect();
    }
  });
  it.each([
    { encrypted: false, authorized: true },
    { encrypted: true, authorized: false },
    {},
  ])(
    "should reject unverified TLS %j before PING using imported connectRedis",
    async stream => {
      const f = fixture();
      const call = vi.fn(async (): Promise<unknown> => "PONG");
      const client = {
        ...f.prepared.client,
        stream,
        connect: vi.fn(async (): Promise<void> => {}),
        call,
      };
      const result = await connectRedis(
        { ...f.prepared, tls: true, client },
        createDeadline(1000)
      );
      expect(result).toEqual({ error: "tls_unverified" });
      expect(call).not.toHaveBeenCalled();
      expect(f.disconnect).toHaveBeenCalledTimes(1);
    }
  );
  it("should drop and return fixed errors on imported PING failure", async () => {
    const f = fixture();
    const client = {
      ...f.prepared.client,
      connect: async (): Promise<void> => {},
      call: async (): Promise<unknown> => {
        throw new Error(FAKE_SECRET);
      },
    };
    expect(
      await connectRedis({ ...f.prepared, client }, createDeadline(1000))
    ).toEqual({ error: "read_failed" });
    expect(f.disconnect).toHaveBeenCalled();
  });
  it("should reject a prepared TLS false mismatch and drop it before DB", async () => {
    const f = fixture();
    f.prepared.tls = true;
    await expect(openRuntimeReaders(f.options, f.injection)).rejects.toThrow(
      "setup_failed"
    );
    expect(f.disconnect).toHaveBeenCalled();
    expect(f.openDb).not.toHaveBeenCalled();
  });
});
describe("when pending commands abort or reject", () => {
  it("should synchronously drop a pending query and forbid all later reads", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    const controller = new AbortController();
    let rejectLate: (reason: Error) => void = () => {};
    f.run.mockImplementation(
      async () =>
        new Promise<unknown>((_, reject) => {
          rejectLate = reject;
        })
    );
    const pending = readers.database.read(DB_SURFACES[0].id, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/^operation_aborted$/);
    await Promise.resolve();
    controller.abort();
    expect(f.abort).toHaveBeenCalledTimes(1);
    await rejected;
    rejectLate(new Error(FAKE_SECRET));
    await Promise.resolve();
    await expect(
      readers.database.read("session.rollback", SIGNAL())
    ).rejects.toThrow("connection_unusable");
    expect(f.run).toHaveBeenCalledTimes(1);
    readers.redis.drop();
  });
  it("should reject pending work immediately when its reader is explicitly dropped", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.call.mockImplementation(async () => new Promise<unknown>(() => {}));
    const pending = readers.redis.scan("0", SIGNAL());
    const rejected = expect(pending).rejects.toThrow(/^operation_aborted$/);
    await Promise.resolve();
    readers.redis.drop();
    expect(f.disconnect).toHaveBeenCalled();
    await rejected;
    readers.database.drop();
  });
  it("should drop timed-out Redis commands without retry or offline work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.call.mockImplementation(async () => new Promise<unknown>(() => {}));
    const pending = readers.redis.read("shopify-privacy.wait", SIGNAL());
    const rejected = expect(pending).rejects.toThrow("operation_timeout");
    await vi.advanceTimersByTimeAsync(LIMITS.redisMs);
    await rejected;
    await expect(readers.redis.scan("0", SIGNAL())).rejects.toThrow(
      "connection_unusable"
    );
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalled();
    readers.database.drop();
  });
  it("should poison DB on driver rejection and never expose secret-shaped diagnostics", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.run.mockRejectedValue(new Error(`SELECT ${FAKE_SECRET}`));
    await expect(
      readers.database.read(DB_SURFACES[0].id, SIGNAL())
    ).rejects.toThrow(/^database_read_failed$/);
    await expect(
      readers.database.read(DB_SURFACES[1].id, SIGNAL())
    ).rejects.toThrow(/^connection_unusable$/);
    expect(f.run).toHaveBeenCalledTimes(1);
    readers.redis.drop();
  });
  it("should reject concurrent use instead of queueing or reconnecting", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    let release: (value: unknown) => void = () => {};
    f.run.mockImplementation(
      async () =>
        new Promise<unknown>(resolve => {
          release = resolve;
        })
    );
    const controller = new AbortController();
    const first = readers.database.read(DB_SURFACES[0].id, controller.signal);
    const rejected = expect(first).rejects.toThrow("operation_aborted");
    await Promise.resolve();
    await expect(
      readers.database.read("session.utc", SIGNAL())
    ).rejects.toThrow("connection_unusable");
    await rejected;
    release([{ count: 0, oldestAgeSeconds: null }]);
    readers.redis.drop();
  });
});
describe("when returned rows or decoded Redis metadata do not meet the closed bounds", () => {
  const badRows: { label: string; rows: unknown }[] = [
    { label: "zero rows", rows: [] },
    {
      label: "two rows",
      rows: [
        { count: 0, oldestAgeSeconds: null },
        { count: 0, oldestAgeSeconds: null },
      ],
    },
    {
      label: "secret-shaped count",
      rows: [{ count: FAKE_SECRET, oldestAgeSeconds: null }],
    },
    {
      label: "extra field",
      rows: [{ count: 0, oldestAgeSeconds: null, password: FAKE_SECRET }],
    },
    {
      label: "missing positive age",
      rows: [{ count: 1, oldestAgeSeconds: null }],
    },
    { label: "non-null zero age", rows: [{ count: 0, oldestAgeSeconds: 1 }] },
    { label: "negative zero", rows: [{ count: -0, oldestAgeSeconds: null }] },
  ];
  it.each(badRows)(
    "should reject $label and drop the store",
    async ({ rows }) => {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      f.run.mockResolvedValue(rows);
      await expect(
        readers.database.read(DB_SURFACES[0].id, SIGNAL())
      ).rejects.toThrow(/^database_read_failed$/);
      expect(f.abort).toHaveBeenCalled();
      readers.redis.drop();
    }
  );
  it("should refuse getter-backed aggregates without invoking the getter", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    const getter = vi.fn(() => FAKE_SECRET);
    f.run.mockResolvedValue([
      Object.defineProperty({ oldestAgeSeconds: null }, "count", {
        enumerable: true,
        get: getter,
      }),
    ]);
    await expect(
      readers.database.read(DB_SURFACES[0].id, SIGNAL())
    ).rejects.toThrow("database_read_failed");
    expect(getter).not.toHaveBeenCalled();
    readers.redis.drop();
  });
  it.each(["01", -1, -0, false, NaN, Infinity, FAKE_SECRET])(
    "should reject invalid Redis counts %s",
    async count => {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      f.call.mockResolvedValue(count);
      await expect(
        readers.redis.read("shopify-privacy.wait", SIGNAL())
      ).rejects.toThrow(/^redis_read_failed$/);
      expect(f.disconnect).toHaveBeenCalled();
      readers.database.drop();
    }
  );
  const badScans: { label: string; response: unknown }[] = [
    {
      label: "key count ceiling",
      response: [
        "0",
        new Array(LIMITS.scanKeysPerRead + 1).fill("bull:synthetic:meta"),
      ],
    },
    {
      label: "malformed key",
      response: ["0", ["bull:synthetic:meta:" + FAKE_SECRET]],
    },
    { label: "noncanonical cursor", response: ["00", []] },
    {
      label: "individual length ceiling",
      response: ["0", ["bull:" + "s".repeat(LIMITS.keyLength) + ":meta"]],
    },
    {
      label: "aggregate byte ceiling",
      response: ["0", new Array(150).fill("bull:" + "s".repeat(240) + ":meta")],
    },
  ];
  it.each(badScans)(
    "should screen $label immediately after decoding",
    async ({ response }) => {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      f.call.mockResolvedValue(response);
      await expect(readers.redis.scan("0", SIGNAL())).rejects.toThrow(
        /^redis_read_failed$/
      );
      expect(f.disconnect).toHaveBeenCalled();
      readers.database.drop();
    }
  );
  it("should reject oversized scans before inspecting a single decoded key", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    const keys = new Array<unknown>(LIMITS.scanKeysPerRead + 1);
    const getter = vi.fn(() => FAKE_SECRET);
    Object.defineProperty(keys, "0", { get: getter });
    f.call.mockResolvedValue(["0", keys]);
    await expect(readers.redis.scan("0", SIGNAL())).rejects.toThrow(
      /^redis_read_failed$/
    );
    expect(getter).not.toHaveBeenCalled();
    readers.database.drop();
  });
  it("should reject session commands with returned rows or nonzero affected rows", async () => {
    for (const rows of [[{ count: 0 }], { affectedRows: 1 }]) {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      f.run.mockResolvedValue(rows);
      await expect(
        readers.database.read("session.utc", SIGNAL())
      ).rejects.toThrow(/^database_read_failed$/);
      readers.redis.drop();
    }
  });
  it("should refuse arbitrary SQL ids, unknown keys, and arbitrary scan arguments before driver calls", async () => {
    for (const operation of ["db", "redis", "scan"] as const) {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      const rejected =
        operation === "db"
          ? readers.database.read(
              `SELECT ${FAKE_SECRET}` as DatabaseQueryId,
              SIGNAL()
            )
          : operation === "redis"
            ? readers.redis.read("unknown.payload" as RedisReadId, SIGNAL())
            : readers.redis.scan("0 MATCH *", SIGNAL());
      await expect(rejected).rejects.toThrow(
        operation === "db" ? "database_read_failed" : "redis_read_failed"
      );
      expect(f.run).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      readers.database.drop();
      readers.redis.drop();
    }
  });
});
describe("when snapshot, rollback, or cleanup fails", () => {
  it.each(["session.snapshot", "session.rollback"] as const)(
    "should propagate guarded %s failure into unchanged core evidence",
    async id => {
      const f = fixture();
      const readers = await openRuntimeReaders(f.options, f.injection);
      const original = f.run.getMockImplementation();
      f.run.mockImplementation(async sql => {
        if (sql === compileDatabaseQuery(id)) throw new Error(FAKE_SECRET);
        return original?.(sql);
      });
      let now = 0;
      const report = await observeDurableStores({
        ...readers,
        clock: {
          now: () => now,
          wait: async ms => {
            now += ms;
          },
        },
      });
      expect(report.verdict).toBe("no_go_incomplete_evidence");
      expect(report.errors).toContain(
        id === "session.snapshot"
          ? "database_snapshot_failed"
          : "database_cleanup_failed"
      );
      expect(JSON.stringify(report)).not.toContain(FAKE_SECRET);
      expect(f.swallowedBegin).not.toHaveBeenCalled();
      expect(f.swallowedEnd).not.toHaveBeenCalled();
    }
  );
  it("should propagate close rollback failure instead of using the swallowing probe close", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.run.mockRejectedValue(new Error(FAKE_SECRET));
    await expect(readers.database.close(SIGNAL())).rejects.toThrow(
      /^cleanup_failed$/
    );
    expect(f.abort).toHaveBeenCalled();
    expect(f.swallowedClose).not.toHaveBeenCalled();
    readers.redis.drop();
  });
  it("should propagate QUIT rejection and drop Redis", async () => {
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.quit.mockRejectedValue(new Error(FAKE_SECRET));
    await expect(readers.redis.close(SIGNAL())).rejects.toThrow(
      /^cleanup_failed$/
    );
    expect(f.disconnect).toHaveBeenCalled();
    readers.database.drop();
  });
  it("should bound a hanging close then synchronously drop Redis", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const readers = await openRuntimeReaders(f.options, f.injection);
    f.quit.mockImplementation(async () => new Promise<unknown>(() => {}));
    const closing = readers.redis.close(SIGNAL());
    const rejected = expect(closing).rejects.toThrow("operation_timeout");
    await vi.advanceTimersByTimeAsync(LIMITS.cleanupMs);
    await rejected;
    expect(f.disconnect).toHaveBeenCalled();
    readers.database.drop();
  });
});
