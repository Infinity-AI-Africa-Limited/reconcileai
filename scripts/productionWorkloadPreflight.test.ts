/**
 * production-workload-preflight.mjs is the read-only check run before a
 * deployment is replaced.
 *
 * What matters is how the script behaves when an operator runs it. So these
 * tests run the REAL script as a subprocess, and import its guards, to show:
 *   - it loads no driver and opens no connection until the deployment it runs
 *     in is proven to be the one the operator named;
 *   - off the loopback interface it reaches the database only over TLS with a
 *     verified certificate AND host name, and Redis only over a private or TLS
 *     route;
 *   - it never writes, to the database or to Redis;
 *   - it prints only numbers, booleans and fixed labels, even when a
 *     connection fails with a password in the URL;
 *   - its counts are right for every surface, against the REAL schema;
 *   - its verdicts never say "safe", say "producers active" when work arrives
 *     between samples, and say "incomplete" when a queue scan or the budget
 *     was cut short, unless work was seen.
 *
 * Database cases build disposable databases of their own on the local MySQL
 * fixture. Their tables are copied from the migrated test database with CREATE
 * TABLE LIKE, so a misspelt column fails here, not in production. Redis cases
 * run only on a disposable loopback fixture named by RECONCILEAI_TEST_REDIS_URL,
 * in database indexes no other test uses. TLS cases run everywhere: they use
 * small fake servers and certificates made for the run with openssl.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import {
  DB_SURFACES,
  EXIT,
  ID_SCAN_LIMIT,
  INTAKE_SOURCES,
  QUEUE_NAMES,
  REPORT_SCHEMA,
  SCAN_ROUND_LIMIT,
  allSqlStatements,
  applicationDatabaseTls,
  assertAggregateOnly,
  assertReadOnlyRedis,
  assertReadOnlySql,
  checkExpectations,
  classifyCommand,
  classifyStartCommand,
  errorCode,
  exitStatusFor,
  inspectProcesses,
  isLoopbackHost,
  isPlaceholderIdentifier,
  judge,
  openDatabase,
  parseArgs,
  planDatabaseRoute,
  planRedisRoute,
  readAppEnvironment,
  readDrainTimeoutSetting,
  readQueue,
  readStartupModeSetting,
  readUnknownQueues,
  readWholeNumber,
  runPreflight,
  signalMaskHas,
  surfaceSql,
  type Openers,
  type OpenedDatabase,
  type RedisReader,
  type Sample,
} from "./production-workload-preflight.mjs";
import { classifyDatabaseTarget } from "../server/dbTarget";

const SCRIPT = path.resolve(__dirname, "production-workload-preflight.mjs");
const REPO = path.resolve(__dirname, "..");

/** How long one run of the script may take before it is killed. */
const RUN_TIMEOUT_MS = 30_000;
/** A case's ceiling outlasts its runs, so a hung run still returns its output. */
const ceilingFor = (runs: number) => runs * RUN_TIMEOUT_MS + 15_000;

// ─── The deployment the runs claim to be ─────────────────────────────────────

/** A random identifier of the given shape that the placeholder check accepts. */
function realLooking(make: () => string): string {
  for (;;) {
    const value = make();
    if (!isPlaceholderIdentifier(value)) return value;
  }
}

const IDENTITY = {
  deployment: realLooking(() => randomUUID()),
  commit: realLooking(() => randomBytes(20).toString("hex")),
};
const OTHER_DEPLOYMENT = realLooking(() => randomUUID());
const OTHER_COMMIT = realLooking(() => randomBytes(20).toString("hex"));

/** The options naming IDENTITY. */
const identityArgs = (): string[] => ["--expect-deployment", IDENTITY.deployment, "--expect-commit", IDENTITY.commit];
/** The variables a Railway deployment with IDENTITY carries. */
const identityVars = (): Record<string, string> => ({
  RAILWAY_REPLICA_ID: "synthetic-replica",
  RAILWAY_DEPLOYMENT_ID: IDENTITY.deployment,
  RAILWAY_GIT_COMMIT_SHA: IDENTITY.commit,
});

// ─── Running the real script ─────────────────────────────────────────────────

type ScriptRun = { code: number | null; killed: boolean; stdout: string; stderr: string; report: unknown; verdict: string | undefined };

/**
 * Run the script with ONLY the variables given, never the test runner's own
 * DATABASE_URL or REDIS_URL. `onStderr` lets a test act between samples; `cwd`
 * is the application directory the script loads its drivers from.
 */
function runScript(
  args: string[],
  vars: Record<string, string>,
  onStderr?: (line: string) => Promise<void> | void,
  nodeOptions: string[] = [],
  cwd: string = REPO,
): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeOptions, SCRIPT, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...vars },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (onStderr) for (const line of text.split("\n").filter(Boolean)) void onStderr(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.split("\n");
      let report: unknown;
      try {
        report = JSON.parse(lines[0]);
      } catch {
        report = undefined;
      }
      const verdict = lines.find((line) => line.startsWith("VERDICT: "))?.slice("VERDICT: ".length);
      resolve({ code, killed, stdout, stderr, report, verdict });
    });
  });
}

/** A nested field of an untyped report, or undefined. */
function field(value: unknown, ...keys: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** A loopback TCP server that counts the connections made to it. */
async function countingServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, connections: () => connections, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ─── Always on: guards and parsers ───────────────────────────────────────────

describe("when the SQL guard reads a statement", () => {
  it("should accept every statement the script can send", () => {
    for (const sql of allSqlStatements()) expect(() => assertReadOnlySql(sql), sql).not.toThrow();
  });

  it.each([
    "INSERT INTO upload_batches (status) VALUES ('pending')",
    "UPDATE reconciliation_jobs SET status = 'failed'",
    "DELETE FROM webhook_deliveries",
    "REPLACE INTO organizations SET id = 1",
    "SELECT COUNT(*) FROM reconciliation_jobs FOR UPDATE",
    "SELECT COUNT(*) FROM reconciliation_jobs LOCK IN SHARE MODE",
    "SELECT COUNT(*) FROM reconciliation_jobs FOR SHARE",
    "SELECT * FROM users INTO OUTFILE '/tmp/x'",
    "SELECT 1; DROP TABLE users",
    "SELECT SLEEP(10)",
    "SELECT GET_LOCK('x', 1)",
    "select count(*) from users",
    "SET GLOBAL read_only = 0",
    "SET SESSION TRANSACTION READ WRITE",
    // Asked for by an earlier version; TiDB refuses or ignores it (see the script's header).
    "SET SESSION TRANSACTION READ ONLY",
    "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
    "SHOW PROCESSLIST",
    "CALL anything()",
    "TRUNCATE TABLE transactions",
  ])("should refuse %s", (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow("sql_refused");
  });
});

describe("when the Redis guard reads a command", () => {
  const accepted: [string, string[]][] = [
    ["PING", []],
    ["LLEN", ["bull:webhook-delivery:wait"]],
    ["LLEN", ["bull:webhook-delivery:active"]],
    ["ZCARD", ["bull:webhook-delivery:delayed"]],
    ["ZCARD", ["bull:webhook-delivery:waiting-children"]],
    ["SCARD", ["bull:webhook-delivery:stalled"]],
    ["HEXISTS", ["bull:webhook-delivery:meta", "paused"]],
    ["GET", ["bull:webhook-delivery:id"]],
    ["LRANGE", ["bull:webhook-delivery:active", "0", "199"]],
    ["ZRANGE", ["bull:webhook-delivery:delayed", "0", "199"]],
    ["HMGET", ["bull:webhook-delivery:42", "atm", "attemptsMade", "stc"]],
    ["HMGET", ["bull:shopify-order-sync:shop:1:webhook:2", "atm", "attemptsMade", "stc"]],
    ["EXISTS", ["bull:webhook-delivery:42:lock"]],
    ["SCAN", ["0", "MATCH", "bull:*:meta", "COUNT", "1000"]],
  ];
  const refused: [string, string[]][] = [
    ["SET", ["bull:webhook-delivery:id", "1"]],
    ["DEL", ["bull:webhook-delivery:wait"]],
    ["EVAL", ["return 1", "0"]],
    ["EVALSHA", ["abc", "0"]],
    ["HGETALL", ["bull:webhook-delivery:42"]],
    ["HGET", ["bull:webhook-delivery:42", "data"]],
    ["HMGET", ["bull:webhook-delivery:42", "data"]],
    ["HMGET", ["bull:webhook-delivery:42", "atm", "opts"]],
    ["HMGET", ["bull:webhook-delivery:42", "atm", "returnvalue"]],
    ["HMGET", ["bull:webhook-delivery:42", "failedReason"]],
    ["HMGET", ["bull:webhook-delivery:meta", "atm"]],
    ["XREVRANGE", ["bull:webhook-delivery:events", "+", "-", "COUNT", "1"]],
    ["XRANGE", ["bull:webhook-delivery:events", "-", "+"]],
    ["KEYS", ["*"]],
    ["SCAN", ["0", "MATCH", "*", "COUNT", "500"]],
    ["CONFIG", ["GET", "requirepass"]],
    ["FLUSHDB", []],
    ["LLEN", ["bull:webhook-delivery:42"]],
    ["GET", ["bull:webhook-delivery:42"]],
    ["LRANGE", ["bull:webhook-delivery:wait", "5", "10"]],
    ["EXISTS", ["bull:webhook-delivery:meta"]],
    ["HEXISTS", ["bull:webhook-delivery:42", "data"]],
    ["ZCARD", ["bull:webhook-delivery"]],
    ["LLEN", ["session:abc"]],
    ["MULTI", []],
  ];

  it.each(accepted)("should accept %s %j", (command, args) => {
    expect(assertReadOnlyRedis(command, args)).toBe(true);
  });

  it.each(refused)("should refuse %s %j", (command, args) => {
    expect(() => assertReadOnlyRedis(command, args)).toThrow("redis_command_refused");
  });
});

describe("when the output guard reads a report", () => {
  it("should accept numbers, booleans, nulls, fixed labels and the generation time", () => {
    expect(() =>
      assertAggregateOnly({
        schema: REPORT_SCHEMA,
        generated_at: "2026-11-04T10:00:00.000Z",
        counts: { a: 0, b: 12 },
        flag: true,
        none: null,
        reading: "partial",
        route: "railway_private_network",
        gaps: ["http_requests_in_flight_are_not_visible"],
      }),
    ).not.toThrow();
  });

  it.each([
    ["a connection URL", { url: "mysql://user:pass@host:3306/db" }],
    ["a hex token", { token: "9f86d081884c7d659a2feaa0c55ad015" }],
    ["a free-text error", { error: "Access denied for user 'app'@'10.0.0.7'" }],
    ["a negative number", { n: -1 }],
    ["a fraction", { n: 1.5 }],
    ["a host name", { host: "redis.railway.internal" }],
    ["a deployment id", { id: IDENTITY.deployment }],
    ["a nested secret", { a: { b: [{ c: "s3cr3t" }] } }],
    ["a key with spaces", { "a key": 1 }],
  ])("should refuse %s", (_label, value) => {
    expect(() => assertAggregateOnly(value)).toThrow("output_refused");
  });
});

describe("when an error is turned into a fixed code", () => {
  it("should tell certificate, host name and TLS-support failures apart, from codes and never from printed text", () => {
    expect(errorCode({ code: "HANDSHAKE_SSL_ERROR", message: "Hostname/IP does not match certificate's altnames: Host: a. is not in the cert's altnames" })).toBe("tls_hostname_refused");
    expect(errorCode({ code: "HANDSHAKE_SSL_ERROR", message: "self-signed certificate in certificate chain" })).toBe("tls_certificate_refused");
    expect(errorCode({ code: "HANDSHAKE_NO_SSL_SUPPORT" })).toBe("tls_unavailable");
    expect(errorCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls_hostname_refused");
    expect(errorCode({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe("tls_certificate_refused");
    expect(errorCode({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe("tls_certificate_refused");
    expect(errorCode({ code: "ERR_SSL_WRONG_VERSION_NUMBER" })).toBe("tls_unavailable");
    expect(errorCode({ code: "PROTOCOL_SEQUENCE_TIMEOUT" })).toBe("query_timeout");
    // A server error is not a certificate failure, whatever its name says.
    expect(errorCode({ code: "ER_UNABLE_TO_CREATE_SOMETHING" })).toBe("query_failed");
  });

  it("should map every refusal to its exit status", () => {
    expect(exitStatusFor("usage_error")).toBe(EXIT.usage);
    expect(exitStatusFor("budget_too_short")).toBe(EXIT.usage);
    expect(exitStatusFor("identity_commit_mismatch")).toBe(EXIT.refused);
    expect(exitStatusFor("route_redis_not_private")).toBe(EXIT.refused);
    expect(exitStatusFor("interrupted")).toBe(EXIT.interrupted);
    expect(exitStatusFor("output_refused")).toBe(EXIT.failed);
    expect(exitStatusFor("preflight_failed")).toBe(EXIT.failed);
  });
});

describe("when the settings readers parse a variable", () => {
  it("should read the drain timeout exactly as the application does", () => {
    expect(readDrainTimeoutSetting(undefined)).toEqual({ state: "default", value: 90_000 });
    expect(readDrainTimeoutSetting("120000")).toEqual({ state: "set", value: 120_000 });
    expect(readDrainTimeoutSetting("999")).toEqual({ state: "invalid_app_refuses_to_start", value: null });
    expect(readDrainTimeoutSetting("300001")).toEqual({ state: "invalid_app_refuses_to_start", value: null });
    expect(readDrainTimeoutSetting("90s")).toEqual({ state: "invalid_app_refuses_to_start", value: null });
    expect(readDrainTimeoutSetting("")).toEqual({ state: "invalid_app_refuses_to_start", value: null });
  });

  it("should agree with the application's own readers on every case", async () => {
    const { readDrainTimeout, readStartupMode } = await import("../server/maintenance/config");
    for (const raw of [undefined, "", "0", "999", "1000", "90000", "300000", "300001", "90s", " 1000", "1e4"]) {
      let app: number | "throws";
      try {
        app = readDrainTimeout(raw);
      } catch {
        app = "throws";
      }
      expect(readDrainTimeoutSetting(raw).value ?? "throws", String(raw)).toBe(app);
    }
    for (const raw of [undefined, "", "normal", "maintenance", "Maintenance", "normal "]) {
      let app: string;
      try {
        app = readStartupMode(raw);
      } catch {
        app = "invalid";
      }
      expect(readStartupModeSetting(raw), String(raw)).toBe(app);
    }
  });

  it("should read a provider timing override as unset, a whole number or invalid", () => {
    expect(readWholeNumber(undefined)).toEqual({ state: "unset", value: null });
    expect(readWholeNumber("120")).toEqual({ state: "set", value: 120 });
    expect(readWholeNumber("-5")).toEqual({ state: "invalid", value: null });
    expect(readWholeNumber("2m")).toEqual({ state: "invalid", value: null });
  });

  it("should classify the start command without printing it", () => {
    expect(classifyStartCommand("pnpm start")).toBe("pnpm_start");
    expect(classifyStartCommand("NODE_ENV=production exec node dist/index.js")).toBe("direct_node_exec");
    expect(classifyStartCommand("node server.js")).toBe("other");
    expect(classifyStartCommand(undefined)).toBe("absent");
  });
});

describe("when the run's options are read", () => {
  it("should accept the defaults and a budget that holds the sampling", () => {
    expect(parseArgs([])).toMatchObject({ samples: 3, intervalSeconds: 60, budgetSeconds: 300, envFromApp: false });
    expect(parseArgs(["--samples", "1", "--budget-seconds", "30"])).toMatchObject({ samples: 1, budgetSeconds: 30 });
  });

  it.each([
    [["--samples", "0"]],
    [["--interval-seconds", "9999"]],
    [["--budget-seconds", "29"]],
    [["--budget-seconds", "901"]],
    [["--unknown", "1"]],
    [["--samples"]],
    [["--samples", "1", "--samples", "2"]],
    [["--env-from-app", "--env-from-app"]],
    [["--expect-commit", IDENTITY.commit, "--expect-commit", OTHER_COMMIT]],
  ])("should refuse %j as a usage error", (argv) => {
    expect(() => parseArgs(argv)).toThrow("usage_error");
  });

  it("should refuse a budget too short for the sampling it was given", () => {
    // Two 60-second sleeps and 30 seconds per sample need 210 seconds.
    expect(() => parseArgs(["--budget-seconds", "209"])).toThrow("budget_too_short");
    expect(parseArgs(["--budget-seconds", "210"]).budgetSeconds).toBe(210);
  });
});

// Above PID_MAX_LIMIT (2^22), so no real process, the test runner included,
// can share a fake process's id.
const SHELL_PID = 4_194_400;
const APP_PID = 4_194_401;

/**
 * A fake /proc holding the chain `pnpm start` produces: pnpm as PID 1, then a
 * shell, then the app (or each of `apps`). `environ` gives a process an
 * environment file.
 */
function fakeProcTree(environ: Partial<Record<number, Record<string, string>>> = {}, apps: number[] = [APP_PID]): string {
  const procRoot = mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  const fake = (pid: number, argv: string[], ppid: number, sigCgt: string) => {
    mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
    writeFileSync(path.join(procRoot, String(pid), "cmdline"), `${argv.join("\0")}\0`);
    writeFileSync(path.join(procRoot, String(pid), "status"), `Name:\tx\nPPid:\t${ppid}\nSigIgn:\t0000000000000000\nSigCgt:\t${sigCgt}\n`);
    const vars = environ[pid];
    if (vars) writeFileSync(path.join(procRoot, String(pid), "environ"), Object.entries(vars).map(([k, v]) => `${k}=${v}\0`).join(""));
  };
  fake(1, ["node", "/usr/local/bin/pnpm", "start"], 0, "0000000000004000");
  fake(SHELL_PID, ["/bin/sh", "-c", "NODE_ENV=production node dist/index.js"], 1, "0000000000000000");
  for (const pid of apps) fake(pid, ["node", "dist/index.js"], SHELL_PID, "0000000180004a02");
  return procRoot;
}

/** Fake /proc trees made by a describe block, removed after it. */
function procTrees() {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  return (environ: Partial<Record<number, Record<string, string>>> = {}, apps: number[] = [APP_PID]) => {
    const root = fakeProcTree(environ, apps);
    roots.push(root);
    return root;
  };
}

describe("when the processes are read inside the service container", () => {
  const tree = procTrees();

  it("should report the launcher chain and which process catches SIGTERM, as fixed classes only", () => {
    expect(inspectProcesses({ RAILWAY_REPLICA_ID: "replica" }, tree())).toEqual({
      inspected: true,
      pid1_kind: "pnpm",
      pid1_catches_sigterm: true,
      pid1_ignores_sigterm: false,
      app_process_count: 1,
      app_is_pid1: false,
      app_catches_sigterm: true,
      app_launcher_chain: ["node_dist_index", "shell", "pnpm"],
    });
  });

  it("should not read processes outside the service container", () => {
    expect(inspectProcesses({}, tree())).toEqual({ inspected: false, reason: "not_in_service_container" });
  });

  it("should read signal 15 from bit 14 of a mask, and classify commands", () => {
    expect(signalMaskHas("SigCgt:\t0000000000004000\n", "SigCgt")).toBe(true);
    expect(signalMaskHas("SigCgt:\t0000000000002000\n", "SigCgt")).toBe(false);
    expect(signalMaskHas("nothing", "SigCgt")).toBeNull();
    expect(classifyCommand(["node", "dist/index.js"])).toBe("node_dist_index");
    expect(classifyCommand(["/usr/local/bin/node", "/app/dist/index.js"])).toBe("node_dist_index");
    expect(classifyCommand(["bash", "-c", "pnpm start"])).toBe("shell");
  });
});

/** Connection openers that count their calls and connect nothing. */
function countedOpeners(database?: () => Promise<Partial<OpenedDatabase>>) {
  const calls = { database: 0, prepareRedis: 0, connectRedis: 0 };
  const open: Openers = {
    database: async () => {
      calls.database += 1;
      return database ? database() : { error: "not_configured" };
    },
    prepareRedis: () => {
      calls.prepareRedis += 1;
      return { error: "not_configured" };
    },
    connectRedis: async () => {
      calls.connectRedis += 1;
      return { error: "not_configured" };
    },
  };
  return { calls, open };
}

describe("when the settings are taken from the running application", () => {
  const appEnv = {
    DATABASE_URL: "mysql://sentinel_user:Sentinel-Pass-789@127.0.0.1:1/sentinel_db",
    RECONCILEAI_DRAIN_TIMEOUT_MS: "120000",
    JWT_SECRET: "Sentinel-Secret-Not-Read",
    ...identityVars(),
  };
  const tree = procTrees();

  it("should accept the flag anywhere among the options", () => {
    expect(parseArgs(["--env-from-app", "--samples", "1"])).toMatchObject({ envFromApp: true, samples: 1 });
    expect(parseArgs(["--samples", "2", "--env-from-app"])).toMatchObject({ envFromApp: true, samples: 2 });
    expect(parseArgs([])).toMatchObject({ envFromApp: false });
    expect(() => parseArgs(["--env-from-app", "yes"])).toThrow("usage_error");
  });

  it("should read only the variables the script uses, from the one app process", () => {
    expect(readAppEnvironment(tree({ [APP_PID]: appEnv, 1: { DATABASE_URL: "mysql://pid1" } }))).toEqual({
      source: "app_process",
      env: {
        DATABASE_URL: appEnv.DATABASE_URL,
        RECONCILEAI_DRAIN_TIMEOUT_MS: "120000",
        RAILWAY_REPLICA_ID: identityVars().RAILWAY_REPLICA_ID,
        RAILWAY_DEPLOYMENT_ID: IDENTITY.deployment,
        RAILWAY_GIT_COMMIT_SHA: IDENTITY.commit,
      },
    });
  });

  it("should say why there is no single readable app process, and never fall back to PID 1", () => {
    // PID 1 (the launcher) holds the variables too; it is not the application.
    expect(readAppEnvironment(tree({ 1: { REDIS_URL: "redis://pid1" } }))).toEqual({ source: "app_process_unreadable", env: {} });
    expect(readAppEnvironment(tree({ 1: appEnv }, []))).toEqual({ source: "app_process_not_found", env: {} });
    expect(readAppEnvironment(tree({ [APP_PID]: appEnv, [APP_PID + 1]: appEnv }, [APP_PID, APP_PID + 1]))).toEqual({ source: "app_process_ambiguous", env: {} });
  });

  it("should use the app's values, including the ones it leaves unset, and print none of them", async () => {
    const report = await runPreflight({
      argv: [...identityArgs(), "--samples", "1", "--env-from-app"],
      // The operator's shell: a stale override, and no database at all.
      env: { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30", PATH: process.env.PATH },
      appDir: REPO,
      procRoot: tree({ [APP_PID]: appEnv }),
    });
    expect(field(report, "deployment", "env_source")).toBe("app_process");
    expect(field(report, "read_only_controls", "database_route")).toBe("local_loopback");
    expect(field(report, "read_only_controls", "database_connection")).toBe("unreachable");
    expect(field(report, "deployment", "application", "drain_timeout_ms")).toEqual({ state: "set", value: 120_000 });
    expect(field(report, "deployment", "provider_overrides", "draining_seconds")).toEqual({ state: "unset", value: null });
    expect(field(report, "processes", "inspected")).toBe(true);
    const printed = JSON.stringify(report);
    for (const secret of ["Sentinel", "sentinel", "127.0.0.1", IDENTITY.deployment, IDENTITY.commit]) expect(printed).not.toContain(secret);
  }, ceilingFor(1));

  it.each([
    ["no app process", (): string => tree({ 1: appEnv }, [])],
    ["two app processes", (): string => tree({ [APP_PID]: appEnv, [APP_PID + 1]: appEnv }, [APP_PID, APP_PID + 1])],
    ["an app process whose environment cannot be read", (): string => tree({ 1: appEnv })],
  ])("should refuse with %s, though the operator's shell holds a matching identity", async (_label, procRoot) => {
    const { calls, open } = countedOpeners();
    await expect(
      runPreflight({
        argv: [...identityArgs(), "--samples", "1", "--env-from-app"],
        env: { ...identityVars(), DATABASE_URL: appEnv.DATABASE_URL },
        appDir: REPO,
        procRoot: procRoot(),
        open,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^identity_app_process_(not_found|ambiguous|unreadable)$/) });
    expect(calls).toEqual({ database: 0, prepareRedis: 0, connectRedis: 0 });
  });
});

// ─── Always on: the identity fence ───────────────────────────────────────────

describe("when the deployment the run targets is not proven", () => {
  const tree = procTrees();
  const vars = () => ({ ...identityVars(), DATABASE_URL: "mysql://u:p@127.0.0.1:1/x", REDIS_URL: "redis://127.0.0.1:1" });
  const without = (key: string) => {
    const env: Record<string, string> = vars();
    delete env[key];
    return env;
  };
  const expected = (deployment: string | null, commit: string | null) => [
    ...(deployment === null ? [] : ["--expect-deployment", deployment]),
    ...(commit === null ? [] : ["--expect-commit", commit]),
  ];

  const cases: [string, string[], Record<string, string>, string][] = [
    ["no expected deployment", expected(null, IDENTITY.commit), vars(), "identity_expected_deployment_missing"],
    ["no expected commit", expected(IDENTITY.deployment, null), vars(), "identity_expected_commit_missing"],
    ["a deployment id prefix", expected(IDENTITY.deployment.slice(0, 8), IDENTITY.commit), vars(), "identity_expected_deployment_malformed"],
    ["a short commit", expected(IDENTITY.deployment, IDENTITY.commit.slice(0, 12)), vars(), "identity_expected_commit_malformed"],
    ["an uppercase commit", expected(IDENTITY.deployment, IDENTITY.commit.toUpperCase()), vars(), "identity_expected_commit_malformed"],
    ["template text", expected("<deployment-id>", IDENTITY.commit), vars(), "identity_expected_deployment_malformed"],
    ["the nil id", expected("00000000-0000-0000-0000-000000000000", IDENTITY.commit), vars(), "identity_expected_deployment_placeholder"],
    ["a published example id", expected("123e4567-e89b-12d3-a456-426614174000", IDENTITY.commit), vars(), "identity_expected_deployment_placeholder"],
    ["a counting commit", expected(IDENTITY.deployment, "1234567890abcdef1234567890abcdef12345678"), vars(), "identity_expected_commit_placeholder"],
    ["a repeated commit", expected(IDENTITY.deployment, "deadbeef".repeat(5)), vars(), "identity_expected_commit_placeholder"],
    ["no Railway runtime", identityArgs(), without("RAILWAY_REPLICA_ID"), "identity_not_railway_runtime"],
    ["no deployment id in the environment", identityArgs(), without("RAILWAY_DEPLOYMENT_ID"), "identity_deployment_missing"],
    ["another deployment", identityArgs(), { ...vars(), RAILWAY_DEPLOYMENT_ID: OTHER_DEPLOYMENT }, "identity_deployment_mismatch"],
    ["no commit in the environment", identityArgs(), without("RAILWAY_GIT_COMMIT_SHA"), "identity_commit_missing"],
    ["another commit", identityArgs(), { ...vars(), RAILWAY_GIT_COMMIT_SHA: OTHER_COMMIT }, "identity_commit_mismatch"],
    // The old check matched a prefix: a commit sharing all but its last digit passed.
    [
      "a commit differing only in its last digit",
      identityArgs(),
      { ...vars(), RAILWAY_GIT_COMMIT_SHA: `${IDENTITY.commit.slice(0, 39)}${IDENTITY.commit.endsWith("0") ? "1" : "0"}` },
      "identity_commit_mismatch",
    ],
  ];

  it.each(cases)("should refuse %s with a fixed code, opening nothing", async (_label, argv, env, code) => {
    const { calls, open } = countedOpeners();
    await expect(runPreflight({ argv: [...argv, "--samples", "1"], env, appDir: REPO, procRoot: tree(), open })).rejects.toMatchObject({ code });
    expect(calls).toEqual({ database: 0, prepareRedis: 0, connectRedis: 0 });
  });

  it("should open both connections once the identity matches, and say it was checked first", async () => {
    const { calls, open } = countedOpeners();
    const report = await runPreflight({ argv: [...identityArgs(), "--samples", "1"], env: vars(), appDir: REPO, procRoot: tree(), open });
    expect(calls).toEqual({ database: 1, prepareRedis: 1, connectRedis: 1 });
    expect(field(report, "read_only_controls", "identity_verified_before_connecting")).toBe(true);
    expect(field(report, "deployment", "identity")).toEqual({ deployment_matches_expected: true, commit_matches_expected: true });
    expect(field(report, "deployment", "runtime")).toBe("railway_runtime");
  });

  it("should judge a deployment id without regard to letter case, and a placeholder by its shape", () => {
    const opts = parseArgs(identityArgs());
    expect(() => checkExpectations(opts)).not.toThrow();
    expect(isPlaceholderIdentifier("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
    expect(isPlaceholderIdentifier("abcabcab-cabc-abca-bcab-cabcabcabcab")).toBe(true);
    expect(isPlaceholderIdentifier("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isPlaceholderIdentifier(IDENTITY.deployment)).toBe(false);
  });

  it("should exit 4 with a fixed code and connect nowhere, as a command", async () => {
    const server = await countingServer();
    try {
      const target = { DATABASE_URL: `mysql://u:p@127.0.0.1:${server.port}/x`, REDIS_URL: `redis://127.0.0.1:${server.port}` };
      const runs: [string[], Record<string, string>, RegExp][] = [
        [expected(null, null), { ...identityVars(), ...target }, /^identity_expected_deployment_missing$/],
        [expected("replace-with-deployment-id", IDENTITY.commit), { ...identityVars(), ...target }, /^identity_expected_deployment_malformed$/],
        [identityArgs(), { ...identityVars(), RAILWAY_DEPLOYMENT_ID: OTHER_DEPLOYMENT, ...target }, /^identity_deployment_mismatch$/],
        [identityArgs(), { ...target }, /^identity_not_railway_runtime$/],
        // This machine runs no Railway application, so the app process is not
        // found (or, if some process matched, it is not this deployment).
        [[...identityArgs(), "--env-from-app"], { ...identityVars(), ...target }, /^identity_/],
      ];
      for (const [args, env, code] of runs) {
        const result = await runScript([...args, "--samples", "1"], env);
        expect(result.code, args.join(" ")).toBe(EXIT.refused);
        const printed = JSON.parse(result.stdout) as { schema: string; error: string };
        expect(printed.schema).toBe(REPORT_SCHEMA);
        expect(printed.error).toMatch(code);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
      }
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  }, ceilingFor(5));

  it("should refuse bad arguments before opening any connection", async () => {
    const server = await countingServer();
    try {
      for (const args of [["--samples", "0"], ["--interval-seconds", "9999"], ["--unknown", "1"], ["--samples"], ["--budget-seconds", "60"]]) {
        const result = await runScript([...identityArgs(), ...args], {
          ...identityVars(),
          DATABASE_URL: `mysql://u:p@127.0.0.1:${server.port}/x`,
          REDIS_URL: `redis://127.0.0.1:${server.port}`,
        });
        expect(result.code, args.join(" ")).toBe(EXIT.usage);
        expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: args[0] === "--budget-seconds" ? "budget_too_short" : "usage_error" });
      }
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  }, ceilingFor(5));
});

/**
 * An application directory whose mysql2, bullmq and ioredis are stubs that
 * record being loaded, so a test can see whether a driver was loaded at all.
 */
function stubAppDir(): { dir: string; loaded: () => string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stub-app-"));
  const log = path.join(dir, "loaded.log");
  const record = (name: string) => `require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});`;
  const pkg = (name: string, files: Record<string, string>) => {
    const root = path.join(dir, "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "0.0.0-stub", main: "index.js" }));
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(root, file), text);
  };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stub-app", private: true }));
  pkg("mysql2", {
    "index.js": record("mysql2"),
    "promise.js": `${record("mysql2/promise")}\nexports.createConnection = async () => { throw Object.assign(new Error("stub"), { code: "ECONNREFUSED" }); };`,
  });
  pkg("bullmq", { "index.js": `${record("bullmq")}\nmodule.exports = {};` });
  pkg("ioredis", { "index.js": `${record("ioredis")}\nmodule.exports = class Redis { constructor() { throw new Error("stub"); } };` });
  return { dir, loaded: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

describe("when the identity fails, drivers are not even loaded", () => {
  const apps: string[] = [];
  afterAll(() => {
    for (const dir of apps) rmSync(dir, { recursive: true, force: true });
  });

  it("should load mysql2, bullmq and ioredis only after the identity has matched", async () => {
    const refused = stubAppDir();
    const allowed = stubAppDir();
    apps.push(refused.dir, allowed.dir);
    const target = { DATABASE_URL: "mysql://u:p@127.0.0.1:1/x", REDIS_URL: "redis://127.0.0.1:1" };

    const mismatch = await runScript([...identityArgs(), "--samples", "1"], { ...identityVars(), RAILWAY_GIT_COMMIT_SHA: OTHER_COMMIT, ...target }, undefined, [], refused.dir);
    expect(mismatch.code).toBe(EXIT.refused);
    expect(refused.loaded()).toEqual([]);

    // The control: the same stubs ARE loaded once the identity matches, so the
    // empty list above is not an artefact of the stubs.
    const matched = await runScript([...identityArgs(), "--samples", "1"], { ...identityVars(), DATABASE_URL: target.DATABASE_URL }, undefined, [], allowed.dir);
    expect(matched.code, matched.stdout).toBe(EXIT.report);
    expect(allowed.loaded()).toEqual(["mysql2/promise"]);
    expect(field(matched.report, "read_only_controls", "database_connection")).toBe("unreachable");
  }, ceilingFor(2));
});

// ─── Always on: routes ───────────────────────────────────────────────────────

describe("when the connection routes are judged", () => {
  const ssl = (setting: unknown) => `?ssl=${encodeURIComponent(JSON.stringify(setting))}`;

  it("should verify certificate and host name off the loopback interface, whatever the URL asks", () => {
    const cases: [string, string][] = [
      ["", "not_requested"],
      [ssl({ rejectUnauthorized: true }), "verified_certificate_only"],
      [ssl({ minVersion: "TLSv1.2" }), "verified_certificate_only"],
      [ssl({ rejectUnauthorized: true, verifyIdentity: true }), "verified_certificate_and_hostname"],
      [ssl({ rejectUnauthorized: false }), "unverified"],
    ];
    for (const [query, applicationTls] of cases) {
      const plan = planDatabaseRoute(`mysql://u:p@db.example.test:4000/app${query}`);
      expect(plan.route, query).toBe("tls_verified_identity");
      expect(plan.application_tls, query).toBe(applicationTls);
      expect(plan.connection?.ssl, query).toMatchObject({ rejectUnauthorized: true, verifyIdentity: true });
    }
    // The URL's own TLS settings (a CA, a minimum version) are kept.
    expect(planDatabaseRoute(`mysql://u:p@db.example.test/app${ssl({ ca: "PEM", minVersion: "TLSv1.2" })}`).connection?.ssl).toEqual({
      ca: "PEM",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
  });

  it("should take only loopback addresses as local, never a name", () => {
    expect(planDatabaseRoute("mysql://u:p@127.0.0.1:3306/x")).toMatchObject({ route: "local_loopback", connection: { ssl: undefined } });
    expect(planDatabaseRoute("mysql://u:p@[::1]:3306/x").route).toBe("local_loopback");
    expect(planDatabaseRoute("mysql://u:p@localhost:3306/x").route).toBe("tls_verified_identity");
    expect(isLoopbackHost("127.255.0.9")).toBe(true);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("localhost")).toBe(false);
  });

  it("should use no URL option but the connection itself and its TLS settings", () => {
    const plan = planDatabaseRoute(`mysql://u%40x:p%3Ay@db.example.test:4000/app?multipleStatements=true&connectTimeout=999999&ssl=${encodeURIComponent("{}")}`);
    expect(Object.keys(plan.connection ?? {}).sort()).toEqual(["database", "host", "password", "port", "ssl", "user"]);
    expect(plan.connection).toMatchObject({ host: "db.example.test", port: 4000, database: "app", user: "u@x", password: "p:y" });
  });

  it("should refuse a database URL the application itself could not use", () => {
    for (const query of [ssl(true), `?ssl=${encodeURIComponent("Amazon RDS")}`, ssl([])]) {
      expect(() => planDatabaseRoute(`mysql://u:p@db.example.test/app${query}`), query).toThrow("route_database_tls_setting_unsupported");
    }
    expect(() => planDatabaseRoute("not a url")).toThrow("route_database_url_invalid");
    expect(planDatabaseRoute(undefined).route).toBe("not_configured");
    expect(applicationDatabaseTls(undefined)).toBe("not_requested");
  });

  it("should allow Redis only over the private network, TLS, or the loopback interface", () => {
    expect(planRedisRoute("redis://default:pw@redis.railway.internal:6379")).toMatchObject({ route: "railway_private_network", tls: false });
    expect(planRedisRoute("redis://default:pw@Redis.Railway.Internal.:6379?family=0").route).toBe("railway_private_network");
    expect(planRedisRoute("rediss://default:pw@cache.example.test:6380")).toMatchObject({ route: "tls_verified", tls: true });
    expect(planRedisRoute("redis://127.0.0.1:6380/9").route).toBe("local_loopback");
    expect(planRedisRoute("  ").route).toBe("not_configured");
    const refusals: [string, string][] = [
      ["redis://default:pw@monorail.proxy.rlwy.net:12345", "route_redis_not_private"],
      ["redis://localhost:6379", "route_redis_not_private"],
      ["redis://railway.internal:6379", "route_redis_not_private"],
      ["redis://redis.railway.internal.example.com:6379", "route_redis_not_private"],
      ["redis://redis.railway.internal:6379?tls=x", "route_redis_url_options_unsupported"],
      ["redis://redis.railway.internal:6379?family=0&rejectUnauthorized=false", "route_redis_url_options_unsupported"],
      ["http://redis.railway.internal:6379", "route_redis_url_invalid"],
      ["not a url", "route_redis_url_invalid"],
    ];
    for (const [url, code] of refusals) {
      let caught: unknown;
      try {
        planRedisRoute(url);
      } catch (error) {
        caught = error;
      }
      expect(caught, url).toMatchObject({ code });
      // A refusal carries its code and nothing of the URL.
      expect((caught as Error).message, url).toBe(code);
    }
  });

  it("should refuse an unsafe route as a command, before connecting anywhere", async () => {
    const server = await countingServer();
    try {
      const result = await runScript([...identityArgs(), "--samples", "1"], {
        ...identityVars(),
        DATABASE_URL: `mysql://u:p@127.0.0.1:${server.port}/x`,
        REDIS_URL: "redis://default:Sentinel-Pass@monorail.proxy.rlwy.net:12345",
      });
      expect(result.code).toBe(EXIT.refused);
      expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "route_redis_not_private" });
      expect(result.stdout + result.stderr).not.toContain("Sentinel");
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  }, ceilingFor(1));
});

// ─── Always on: the budget ───────────────────────────────────────────────────

/** A database stand-in that answers `answers` statements, then hangs until aborted. */
function hangingDatabase(answers: number) {
  const state = { aborted: false, closed: false, statements: 0 };
  const waiting: ((error: Error) => void)[] = [];
  const lost = () => Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });
  const db: Partial<OpenedDatabase> = {
    controls: { engine: "mysql", session_time_zone_utc: true, snapshot: "consistent_snapshot" },
    async beginSnapshot() {},
    async endSnapshot() {},
    run(sql: string) {
      assertReadOnlySql(sql);
      state.statements += 1;
      if (state.aborted) return Promise.reject(lost());
      if (state.statements <= answers) return Promise.resolve([{ n: 1, oldest_minutes: 5, under_15_minutes: 1, over_1_day: 0 }]);
      return new Promise<Record<string, unknown>[]>((_resolve, reject) => waiting.push(reject));
    },
    abort() {
      state.aborted = true;
      for (const reject of waiting.splice(0)) reject(lost());
    },
    async close() {
      state.closed = true;
    },
  };
  return { db, state };
}

describe("when the run's budget runs out", () => {
  const tree = procTrees();

  it("should close its own connections and report incomplete evidence", async () => {
    const { db, state } = hangingDatabase(0);
    const { open } = countedOpeners(async () => db);
    const started = Date.now();
    const report = await runPreflight({
      argv: [...identityArgs(), "--samples", "3", "--interval-seconds", "1"],
      env: identityVars(),
      appDir: REPO,
      procRoot: tree(),
      open,
      limits: { budgetMs: 1500 },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state).toMatchObject({ aborted: true, closed: true });
    expect(field(report, "sampling")).toMatchObject({ samples_requested: 3, samples_taken: 1, budget_exhausted: true });
    expect(field(report, "samples", 0, "database", "surfaces", "upload_batches.in_progress")).toEqual({ reading: "unknown", error: "budget_exceeded" });
    expect(field(report, "verdicts", "overall")).toBe("no_go_incomplete_evidence");
  });

  it("should still report work it saw before the budget ran out", async () => {
    // The first statement counts unfinished reconciliation jobs, and finds one.
    const { db } = hangingDatabase(1);
    const { open } = countedOpeners(async () => db);
    const report = await runPreflight({
      argv: [...identityArgs(), "--samples", "3", "--interval-seconds", "1"],
      env: identityVars(),
      appDir: REPO,
      procRoot: tree(),
      open,
      limits: { budgetMs: 1500 },
    });
    expect(field(report, "samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished")).toMatchObject({ reading: "ok", count: 1 });
    expect(field(report, "verdicts", "overall")).toBe("no_go_unfinished_work");
  });
});

// ─── Always on: verdicts ─────────────────────────────────────────────────────

describe("when the verdicts are judged", () => {
  /** One sample: uploads in progress, runnable deliveries, transactions taken in, and the unknown-queue scan. */
  const sample = (
    upload: number | null,
    delivery: number | null,
    intake: number | null,
    idCounter = 5,
    unknownQueues: { reading: string; runnable?: number } = { reading: "ok", runnable: 0 },
  ): Sample => ({
    database: {
      surfaces: Object.fromEntries(
        DB_SURFACES.map((s) => [s.id, upload === null ? { reading: "unknown" } : { reading: "ok", count: s.id === "upload_batches.in_progress" ? upload : 0 }]),
      ),
      intake: Object.fromEntries(
        INTAKE_SOURCES.map((i) => [i.id, intake === null ? { reading: "not_measured" } : { reading: "ok", count: i.id === "transactions" ? intake : 0 }]),
      ),
    },
    redis: {
      queues: Object.fromEntries(
        QUEUE_NAMES.map((q) => [q, delivery === null ? { reading: "unknown" } : { reading: "ok", runnable: q === "webhook-delivery" ? delivery : 0, id_counter: idCounter }]),
      ),
      unknown_queues: unknownQueues,
    },
  });

  it("should keep each surface in the group and kind decided for it", () => {
    // Moving a surface to "parked" removes it from the verdict. That is a
    // decision about what may be cut off, so it must be made here, on purpose.
    expect(Object.fromEntries(DB_SURFACES.map((s) => [s.id, `${s.group}/${s.kind}`]))).toEqual({
      "reconciliation_jobs.unfinished": "reconciliation/work",
      "reconciliation_jobs.running_stale_heartbeat": "reconciliation/subset",
      "upload_batches.in_progress": "reconciliation/work",
      "schedule_run_history.running": "reconciliation/work",
      "wc_connector_sync_runs.running": "reconciliation/work",
      "webhook_deliveries.pending": "accepted/work",
      "shopify_privacy_queue_outbox.undispatched": "accepted/work",
      "shopify_privacy_requests.in_progress": "accepted/work",
      "shopify_privacy_requests.parked": "accepted/parked",
      "shopify_privacy_data_request_jobs.in_progress": "accepted/work",
      "shopify_privacy_customer_redaction_jobs.in_progress": "accepted/work",
      "shopify_shop_redaction_jobs.in_progress": "accepted/work",
      "shopify_privacy_artifacts.writing": "accepted/work",
      "shopify_privacy_artifacts.awaiting_acknowledgement": "accepted/parked",
      "shopify_webhook_events.acknowledged_unprocessed": "accepted/work",
      "shopify_sync_requests.queued": "accepted/work",
      "shopify_install_leases.unexpired": "accepted/work",
      "shopify_connector_stores.redacting": "accepted/work",
      "organizations.redacting": "accepted/work",
      "sl_connector_webhook_events.acknowledged_unprocessed": "accepted/work",
      "sl_connector_gdpr_requests.received": "accepted/parked",
      "wc_connector_webhook_events.received": "accepted/work",
      "wc_connector_dead_letters.retryable": "accepted/work",
      "data_deletion_requests.open": "accepted/work",
    });
  });

  it("should never say anything stronger than 'zero observed, not proof'", () => {
    expect(judge([sample(0, 0, null), sample(0, 0, 0)]).overall).toBe("zero_observed_not_proof");
    expect(judge([sample(0, 0, null)]).overall).toBe("zero_observed_single_sample_not_proof");
  });

  it("should put unfinished work first, then missing evidence, then live producers", () => {
    expect(judge([sample(0, 2, null)]).queues_runnable).toBe("fail_unfinished_work");
    expect(judge([sample(0, null, null), sample(0, 0, 3)]).overall).toBe("no_go_incomplete_evidence");
    expect(judge([sample(0, 0, null), sample(0, 0, 3)]).overall).toBe("no_go_producers_active");
    expect(judge([sample(0, 0, null, 5), sample(0, 0, 0, 6)]).overall).toBe("no_go_producers_active");
  });

  it("should report observed work even when another reading is missing", () => {
    const verdicts = judge([sample(1, 0, null), sample(0, null, 0)]);
    expect(verdicts.reconciliation_unfinished).toBe("fail_unfinished_work");
    expect(verdicts.overall).toBe("no_go_unfinished_work");
  });

  it("should treat a missing intake reading as missing evidence, not as quiet", () => {
    const quiet = sample(0, 0, 0);
    quiet.database.intake.transactions = { reading: "unknown" };
    expect(judge([sample(0, 0, null), quiet]).overall).toBe("no_go_incomplete_evidence");
  });

  describe("when the unknown-queue scan stopped before its end", () => {
    const partial = (runnable: number) => ({ reading: "partial", runnable });

    it("should report incomplete evidence when nothing was seen", () => {
      const verdicts = judge([sample(0, 0, null, 5, partial(0)), sample(0, 0, 0, 5, partial(0))]);
      expect(verdicts.queues_runnable).toBe("unknown_incomplete_evidence");
      expect(verdicts.overall).toBe("no_go_incomplete_evidence");
    });

    it("should count work it did see in an unknown queue", () => {
      expect(judge([sample(0, 0, null, 5, partial(2))])).toMatchObject({ queues_runnable: "fail_unfinished_work", overall: "no_go_unfinished_work" });
    });

    it("should keep the no-go for known unfinished work", () => {
      const verdicts = judge([sample(1, 3, null, 5, partial(0)), sample(1, 3, 0, 5, partial(0))]);
      expect(verdicts).toMatchObject({ reconciliation_unfinished: "fail_unfinished_work", queues_runnable: "fail_unfinished_work", overall: "no_go_unfinished_work" });
    });
  });

  it("should report incomplete evidence when fewer samples were taken than asked, unless work was seen", () => {
    expect(judge([sample(0, 0, null)], { incomplete: true }).overall).toBe("no_go_incomplete_evidence");
    expect(judge([sample(2, 0, null)], { incomplete: true }).overall).toBe("no_go_unfinished_work");
    expect(judge([]).overall).toBe("no_go_incomplete_evidence");
  });
});

// ─── Always on: the queue readers, against a stand-in Redis ─────────────────

/**
 * A stand-in Redis: every command passes the real guard, then `answer` replies.
 * Records what was asked.
 */
function fakeRedis(answer: (command: string, args: string[]) => unknown): RedisReader & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async call(command: string, ...args: (string | number)[]) {
      const strings = args.map(String);
      assertReadOnlyRedis(command, strings);
      commands.push(command);
      const reply = answer(command, strings);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe("when Redis is searched for queues the code does not know", () => {
  it("should say ok only when the key scan reached its end", async () => {
    const redis = fakeRedis((command, args) => {
      if (command === "SCAN") return args[0] === "0" ? ["7", ["bull:legacy-queue:meta", "bull:webhook-delivery:meta"]] : ["0", []];
      return command === "LLEN" && args[0] === "bull:legacy-queue:wait" ? 4 : 0;
    });
    expect(await readUnknownQueues(redis)).toEqual({ reading: "ok", count: 1, runnable: 4, scan_rounds: 2, scan_complete: true });
  });

  it("should say partial, with what it saw, when the scan stops at its round limit", async () => {
    let round = 0;
    const redis = fakeRedis((command) => {
      if (command === "SCAN") {
        round += 1;
        // A cursor that never returns to 0: more keys than the limit allows.
        return [String(round + 1), round === 1 ? ["bull:legacy-queue:meta"] : []];
      }
      return command === "ZCARD" ? 1 : 0;
    });
    const reading = await readUnknownQueues(redis);
    expect(reading).toEqual({ reading: "partial", count: 1, runnable: 3, scan_rounds: SCAN_ROUND_LIMIT, scan_complete: false });
    expect(redis.commands.filter((c) => c === "SCAN")).toHaveLength(SCAN_ROUND_LIMIT);
  });

  it("should say partial when the connection fails part-way, and fail outright before any round", async () => {
    let round = 0;
    const midway = fakeRedis((command) => {
      if (command !== "SCAN") return 0;
      round += 1;
      return round === 1 ? ["9", ["bull:legacy-queue:meta"]] : new Error("Connection is closed.");
    });
    expect(await readUnknownQueues(midway)).toMatchObject({ reading: "partial", count: 1, scan_complete: false });
    const never = fakeRedis(() => new Error("Connection is closed."));
    await expect(readUnknownQueues(never)).rejects.toThrow("Connection is closed.");
  });
});

describe("when a known queue's jobs are inspected", () => {
  it("should keep exact counts and label the inspection partial when capped or cut short", async () => {
    const capped = fakeRedis((command, args) => {
      if (command === "LLEN") return args[0].endsWith(":wait") ? ID_SCAN_LIMIT + 5 : 0;
      if (command === "LRANGE") return args[0].endsWith(":wait") ? Array.from({ length: ID_SCAN_LIMIT }, (_, i) => String(i)) : [];
      if (command === "HMGET") return [null, null, null];
      if (command === "GET") return "900";
      return command === "ZRANGE" ? [] : 0;
    });
    const reading = await readQueue(capped, "webhook-delivery");
    expect(reading).toMatchObject({ reading: "ok", runnable: ID_SCAN_LIMIT + 5, wait: ID_SCAN_LIMIT + 5, job_inspection: "partial", id_counter: 900 });
    expect(capped.commands.filter((c) => c === "HMGET")).toHaveLength(ID_SCAN_LIMIT);

    const cut = fakeRedis((command, args) => {
      if (command === "LLEN") return args[0].endsWith(":active") ? 2 : 0;
      if (command === "LRANGE") return args[0].endsWith(":active") ? ["1", "2"] : [];
      if (command === "HMGET") return new Error("Connection is closed.");
      return command === "ZRANGE" ? [] : command === "GET" ? null : 0;
    });
    expect(await readQueue(cut, "reconciliation-runs")).toMatchObject({ reading: "ok", runnable: 2, active: 2, job_inspection: "partial" });
  });
});

describe("when a report would carry a value outside the fixed vocabulary", () => {
  const tree = procTrees();

  it("should refuse to return it", async () => {
    // A clock past year 9999 stamps the report with a time outside the fixed
    // format: a value the output guard must refuse rather than print.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("+010000-01-01T00:00:00.000Z"));
    try {
      const { open } = countedOpeners();
      await expect(runPreflight({ argv: [...identityArgs(), "--samples", "1"], env: identityVars(), appDir: REPO, procRoot: tree(), open })).rejects.toMatchObject({
        code: "output_refused",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Always on: what the deployed code holds ────────────────────────────────

/**
 * The newest migration the preflight's surfaces were reconciled against. When
 * a migration lands after it, this fails until someone checks the new tables
 * and states for process work a replacement could cut off, updates
 * DB_SURFACES if needed, and moves this forward.
 */
const COVERAGE_RECONCILED_THROUGH_MIGRATION = "0119_shopline_billing_charges";

/** Every createQueue call in the deployed code, by file, and the queues it names. */
const QUEUE_CALL_SITES: Record<string, string[]> = {
  "server/reconciliationQueue.ts": ["reconciliation-runs"],
  "server/webhookDelivery.ts": ["webhook-delivery"],
  "server/connectors/shopify/syncQueue.ts": ["shopify-manual-sync", "shopify-order-sync"],
  "server/connectors/shopify/privacyQueue.ts": ["shopify-privacy"],
  "server/connectors/shopline/realtimeSync.ts": ["shopline-realtime-sync"],
};

describe("when the deployed code is compared with what the preflight counts", () => {
  it("should know every queue the code creates", () => {
    const sites: Record<string, number> = {};
    for (const entry of readdirSync(path.join(REPO, "server"), { recursive: true })) {
      const file = `server/${String(entry).split(path.sep).join("/")}`;
      if (!file.endsWith(".ts") || /\.(test|testkit|d)\.ts$/.test(file) || /\.fixture\./.test(file)) continue;
      const text = readFileSync(path.join(REPO, file), "utf8");
      const calls = text.match(/(?<!function\s+)\bcreateQueue\s*(?:<[^<>()]*>)?\s*\(/g);
      if (calls) sites[file] = calls.length;
    }
    expect(sites).toEqual(Object.fromEntries(Object.entries(QUEUE_CALL_SITES).map(([file, names]) => [file, names.length])));
    const named = new Set<string>();
    for (const [file, names] of Object.entries(QUEUE_CALL_SITES)) {
      const text = readFileSync(path.join(REPO, file), "utf8");
      for (const name of names) {
        expect(text, `${file} names ${name}`).toContain(`"${name}"`);
        named.add(name);
      }
    }
    expect([...named].sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it("should have been reconciled against the newest migration", () => {
    const journal = JSON.parse(readFileSync(path.join(REPO, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.at(-1)?.tag).toBe(COVERAGE_RECONCILED_THROUGH_MIGRATION);
  });
});

// ─── Always on: the real script, without a database or Redis ────────────────

describe("when the script runs without a database or Redis", () => {
  it("should report incomplete evidence, and nothing but aggregate labels", async () => {
    const result = await runScript([...identityArgs(), "--samples", "1"], identityVars());
    expect(result.code, result.stdout).toBe(EXIT.report);
    // One line of JSON, then the verdict and the group verdicts.
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(result.stdout).toMatch(/\nGROUPS: reconciliation=\w+ queues=\w+ accepted=\w+ producers=\w+\n$/);
    expect(field(result.report, "deployment", "env_source")).toBe("own");
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(() => assertAggregateOnly(result.report)).not.toThrow();
    expect(field(result.report, "read_only_controls")).toMatchObject({
      queue_objects_constructed: false,
      identity_verified_before_connecting: true,
      database_route: "not_configured",
      redis_route: "not_configured",
    });
    expect(field(result.report, "deployment", "effective_draining_proven")).toBe(false);
    expect(field(result.report, "deployment", "recipe", "start_command_kind")).toBe("pnpm_start");
    expect(field(result.report, "sampling")).toMatchObject({ samples_requested: 1, samples_taken: 1, budget_seconds: 300, budget_exhausted: false });
    expect(result.stdout).not.toContain(IDENTITY.deployment);
    expect(result.stdout).not.toContain(IDENTITY.commit);
  }, ceilingFor(1));

  it("should print neither credentials nor hosts from a failing connection", async () => {
    const result = await runScript([...identityArgs(), "--samples", "1"], {
      ...identityVars(),
      DATABASE_URL: "mysql://sentinel_user:Sentinel-Pass-123@127.0.0.1:1/sentinel_db",
      REDIS_URL: "redis://:Sentinel-Pass-456@127.0.0.1:1",
    });
    expect(result.code, result.stdout).toBe(EXIT.report);
    expect(field(result.report, "read_only_controls", "database_connection")).toBe("unreachable");
    expect(field(result.report, "read_only_controls", "redis_connection")).toBe("unreachable");
    for (const secret of ["Sentinel", "sentinel", "127.0.0.1", "Pass-"]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
  }, ceilingFor(1));

  it.each([
    ["an exception", "throw new Error('Sentinel-Uncaught-Text')"],
    ["a rejected promise", "Promise.reject(new Error('Sentinel-Rejected-Text'))"],
  ])("should print only a fixed code when %s escapes from a callback", async (_label, fault) => {
    // Planted while the script sleeps between samples.
    const plant = `data:text/javascript,setTimeout(() => { ${fault}; }, 1500)`;
    const result = await runScript([...identityArgs(), "--samples", "2", "--interval-seconds", "4"], identityVars(), undefined, ["--import", plant]);
    expect(result.code).toBe(EXIT.failed);
    expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "preflight_failed" });
    expect(result.stdout + result.stderr).not.toContain("Sentinel");
  }, ceilingFor(1));

  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("should print only a fixed code when stopped by %s", async (signal) => {
    let child: number | undefined;
    const run = new Promise<ScriptRun>((resolve, reject) => {
      const proc = spawn(process.execPath, [SCRIPT, ...identityArgs(), "--samples", "2", "--interval-seconds", "20"], {
        cwd: REPO,
        env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...identityVars() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc.pid;
      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("sample 1/2 complete")) proc.kill(signal);
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code, killed: false, stdout, stderr: "", report: undefined, verdict: undefined }));
    });
    const result = await run;
    expect(child).toBeDefined();
    expect(result.code).toBe(EXIT.interrupted);
    expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "interrupted" });
  }, ceilingFor(1));
});

// ─── Always on: TLS, against fake servers with certificates made for the run ─

type Identity = { key: string; cert: string };
type Pki = { dir: string; caFile: string; caPem: string; localhost: Identity; otherName: Identity; selfSigned: Identity };

/** A CA, a certificate it issued for localhost, one for another name, and a self-signed one. */
function makePki(): Pki {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-pki-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Preflight Test CA");
  const issue = (name: string, altName: string) => {
    openssl("req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${altName}`);
    writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${altName}\n`);
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
  };
  issue("localhost", "localhost");
  issue("other", "other.invalid");
  openssl("req", "-x509", ...ec, "-keyout", "self.key", "-out", "self.pem", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  return {
    dir,
    caFile: path.join(dir, "ca.pem"),
    caPem: read("ca.pem"),
    localhost: { key: read("localhost.key"), cert: read("localhost.pem") },
    otherName: { key: read("other.key"), cert: read("other.pem") },
    selfSigned: { key: read("self.key"), cert: read("self.pem") },
  };
}

type FakeServer = { port: number; close: () => Promise<void> };

async function listen(server: net.Server, sockets: Set<net.Socket>): Promise<FakeServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function mysqlPacket(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

/**
 * Just enough of a MySQL server to test TLS: a protocol-10 greeting that offers
 * TLS (or, with `identity` null, does not), the upgrade on the client's SSL
 * request, acceptance of any credentials, and an error for every statement.
 */
async function fakeMysqlServer(identity: Identity | null): Promise<FakeServer> {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  // LONG_PASSWORD, CONNECT_WITH_DB, PROTOCOL_41, TRANSACTIONS, SECURE_CONNECTION, PLUGIN_AUTH (+ SSL)
  const capabilities = 0x1 | 0x8 | 0x200 | 0x2000 | 0x8000 | 0x80000 | (identity ? 0x800 : 0);
  const greeting = Buffer.concat([
    Buffer.from([10]),
    Buffer.from("8.0.99-fake\0"),
    Buffer.from([7, 0, 0, 0]),
    Buffer.alloc(8, 0x61),
    Buffer.from([0]),
    u16(capabilities & 0xffff),
    Buffer.from([0x21]),
    u16(0x0002),
    u16(capabilities >>> 16),
    Buffer.from([21]),
    Buffer.alloc(10),
    Buffer.alloc(12, 0x62),
    Buffer.from([0]),
    Buffer.from("mysql_native_password\0"),
  ]);
  const accepted = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
  const refusedStatement = Buffer.concat([Buffer.from([0xff]), u16(1064), Buffer.from("#42000no statements here")]);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(mysqlPacket(0, greeting));
    if (!identity) return;
    // The client's SSL request is 36 bytes; the TLS hello may arrive with it.
    let plain = Buffer.alloc(0);
    const bridge = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        socket.write(chunk, callback);
      },
    });
    const onPlain = (chunk: Buffer) => {
      plain = Buffer.concat([plain, chunk]);
      if (plain.length < 36) return;
      socket.off("data", onPlain);
      socket.on("data", (more: Buffer) => bridge.push(more));
      socket.on("end", () => bridge.push(null));
      if (plain.length > 36) bridge.push(plain.subarray(36));
      const secure = new tls.TLSSocket(bridge, { isServer: true, key: identity.key, cert: identity.cert });
      secure.on("error", () => socket.destroy());
      let inbound = Buffer.alloc(0);
      secure.on("data", (data: Buffer) => {
        inbound = Buffer.concat([inbound, data]);
        while (inbound.length >= 4) {
          const length = inbound.readUIntLE(0, 3);
          if (inbound.length < 4 + length) break;
          const sequence = inbound[3];
          const command = inbound[4];
          inbound = inbound.subarray(4 + length);
          if (sequence === 2) secure.write(mysqlPacket(3, accepted));
          else if (command === 0x01) secure.end();
          else secure.write(mysqlPacket(sequence + 1, refusedStatement));
        }
      });
    };
    socket.on("data", onPlain);
  });
  return listen(server, sockets);
}

/** A TLS server that answers the preflight's read-only Redis commands with empty results. */
async function fakeRedisTlsServer(identity: Identity): Promise<FakeServer & { commands: string[] }> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const reply = (command: string, args: string[]) => {
    switch (command) {
      case "PING":
        return "+PONG\r\n";
      case "AUTH":
      case "SELECT":
      case "QUIT":
        return "+OK\r\n";
      case "GET":
        return "$-1\r\n";
      case "LRANGE":
      case "ZRANGE":
        return "*0\r\n";
      case "HMGET":
        return `*${args.length - 1}\r\n${"$-1\r\n".repeat(args.length - 1)}`;
      case "SCAN":
        return "*2\r\n$1\r\n0\r\n*0\r\n";
      default:
        return ":0\r\n";
    }
  };
  const server = tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // One RESP array of bulk strings: *N, then $len and the bytes, N times.
        let at = 0;
        const line = () => {
          const end = buffer.indexOf("\r\n", at);
          if (end < 0) return null;
          const text = buffer.toString("utf8", at, end);
          at = end + 2;
          return text;
        };
        const head = line();
        if (head === null || !head.startsWith("*")) return;
        const args: string[] = [];
        for (let k = 0; k < Number(head.slice(1)); k += 1) {
          const size = line();
          if (size === null) return;
          const length = Number(size.slice(1));
          if (buffer.length < at + length + 2) return;
          args.push(buffer.toString("utf8", at, at + length));
          at += length + 2;
        }
        buffer = buffer.subarray(at);
        const command = String(args[0]).toUpperCase();
        commands.push(command);
        socket.write(reply(command, args.slice(1)));
      }
    });
  });
  server.on("tlsClientError", () => {});
  return { ...(await listen(server, sockets)), commands };
}

describe("when the database or Redis is reached over TLS", () => {
  let pki: Pki;
  beforeAll(() => {
    pki = makePki();
  });
  afterAll(() => {
    if (pki) rmSync(pki.dir, { recursive: true, force: true });
  });
  const withCa = (port: number, setting: Record<string, unknown> = {}) =>
    `mysql://u:p@localhost:${port}/x?ssl=${encodeURIComponent(JSON.stringify({ ca: pki.caPem, ...setting }))}`;

  it("should connect to a database whose certificate is trusted and names the host, over a verified socket", async () => {
    const server = await fakeMysqlServer(pki.localhost);
    try {
      const db = await openDatabase(planDatabaseRoute(withCa(server.port)), REPO);
      expect(db.error).toBeUndefined();
      await db.close();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["an untrusted issuer", (p: Pki) => p.selfSigned, {}, "tls_certificate_refused"],
    ["a trusted certificate for another name", (p: Pki) => p.otherName, {}, "tls_hostname_refused"],
    // The URL switches the certificate check off; the preflight checks anyway.
    ["an untrusted issuer, with the URL's checks off", (p: Pki) => p.selfSigned, { rejectUnauthorized: false }, "tls_certificate_refused"],
  ] as const)("should refuse a database with %s", async (_label, pick, setting, code) => {
    const server = await fakeMysqlServer(pick(pki));
    try {
      expect(await openDatabase(planDatabaseRoute(withCa(server.port, setting)), REPO)).toEqual({ error: code });
    } finally {
      await server.close();
    }
  });

  it("should refuse a database that offers no TLS", async () => {
    const server = await fakeMysqlServer(null);
    try {
      expect(await openDatabase(planDatabaseRoute(withCa(server.port)), REPO)).toEqual({ error: "tls_unavailable" });
    } finally {
      await server.close();
    }
  });

  it("should confirm verified TLS on both routes in its report, as labels only", async () => {
    const database = await fakeMysqlServer(pki.localhost);
    const redis = await fakeRedisTlsServer(pki.localhost);
    try {
      const result = await runScript([...identityArgs(), "--samples", "1"], {
        ...identityVars(),
        // No TLS setting in the URL: the preflight asks for it, and verifies.
        DATABASE_URL: `mysql://sentinel:Sentinel-Pass@localhost:${database.port}/x`,
        REDIS_URL: `rediss://:Sentinel-Pass@localhost:${redis.port}`,
        NODE_EXTRA_CA_CERTS: pki.caFile,
      });
      expect(result.code, result.stdout).toBe(EXIT.report);
      expect(field(result.report, "read_only_controls")).toMatchObject({
        database_route: "tls_verified_identity",
        database_connection: "ok",
        redis_route: "tls_verified",
        redis_connection: "ok",
      });
      expect(field(result.report, "deployment", "application", "database_tls")).toBe("not_requested");
      expect(field(result.report, "samples", 0, "redis", "queues", "webhook-delivery")).toMatchObject({ reading: "ok", runnable: 0 });
      expect(field(result.report, "samples", 0, "redis", "unknown_queues")).toMatchObject({ reading: "ok", scan_complete: true });
      // The fake database refuses every statement, so the evidence is incomplete.
      expect(result.verdict).toBe("no_go_incomplete_evidence");
      // The session: AUTH for the URL's password, the guarded reads, QUIT. No CLIENT SETINFO.
      expect(redis.commands.length).toBeGreaterThan(QUEUE_NAMES.length);
      expect(new Set(redis.commands)).toEqual(new Set(["AUTH", "PING", "LLEN", "ZCARD", "SCARD", "HEXISTS", "GET", "LRANGE", "ZRANGE", "SCAN", "QUIT"]));
      for (const text of ["localhost", "Sentinel", "sentinel"]) expect(result.stdout + result.stderr).not.toContain(text);
    } finally {
      await database.close();
      await redis.close();
    }
  }, ceilingFor(1));

  it.each([
    ["for another name", (p: Pki) => p.otherName, "tls_hostname_refused"],
    ["from an untrusted issuer", (p: Pki) => p.selfSigned, "tls_certificate_refused"],
  ] as const)("should refuse Redis presenting a certificate %s", async (_label, pick, code) => {
    const redis = await fakeRedisTlsServer(pick(pki));
    try {
      const result = await runScript([...identityArgs(), "--samples", "1"], {
        ...identityVars(),
        REDIS_URL: `rediss://localhost:${redis.port}`,
        NODE_EXTRA_CA_CERTS: pki.caFile,
      });
      expect(field(result.report, "read_only_controls", "redis_connection")).toBe(code);
      expect(redis.commands).toEqual([]);
    } finally {
      await redis.close();
    }
  }, ceilingFor(1));
});

// ─── Database: disposable databases copied from the real schema ─────────────

const testDbUrl = process.env.DATABASE_URL;
/**
 * TiDB is production's engine, and it treats READ ONLY differently from MySQL,
 * so the database cases also run against a local, migrated TiDB when
 * RECONCILEAI_TEST_TIDB_URL names one. Like the MySQL fixture, it must be local.
 */
const tidbUrl = process.env.RECONCILEAI_TEST_TIDB_URL;
if (tidbUrl && !classifyDatabaseTarget(tidbUrl).local) throw new Error("preflight_test_requires_local_tidb");
const tablesUsed = [...new Set([...DB_SURFACES.map((s) => s.table), ...INTAKE_SOURCES.map((i) => i.table)])];

type Engine = { name: "MySQL" | "TiDB"; url: string; enabled: boolean };
const ENGINES: Engine[] = [
  { name: "MySQL", url: testDbUrl ?? "", enabled: classifyDatabaseTarget(testDbUrl).local },
  { name: "TiDB", url: tidbUrl ?? "", enabled: Boolean(tidbUrl) },
];
const localDatabase = ENGINES[0].enabled;

/** A connection to a local fixture, writing timestamps in UTC as the app does. */
async function fixtureConnection(baseUrl: string): Promise<mysql.Connection> {
  const connection = await mysql.createConnection({ uri: baseUrl, timezone: "Z" });
  await connection.query("SET time_zone = '+00:00'");
  return connection;
}

/** A database of its own, holding empty copies of every table the script reads. */
async function createDisposableDatabase(admin: mysql.Connection, baseUrl: string, prefix: string): Promise<{ name: string; url: string }> {
  const source = new URL(baseUrl).pathname.slice(1);
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE \`${name}\``);
  for (const table of tablesUsed) await admin.query(`CREATE TABLE \`${name}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** Each table's rows, hashed in a fixed order. Works on both engines, unlike CHECKSUM TABLE. */
async function tableDigests(conn: mysql.Connection, schema: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const table of tablesUsed) {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT * FROM \`${schema}\`.\`${table}\``);
    const lines = rows.map((row) => JSON.stringify(row)).sort();
    digests[table] = `${rows.length}:${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)}`;
  }
  return digests;
}

type ColumnInfo = { name: string; nullable: boolean; hasDefault: boolean; dataType: string; columnType: string; skip: boolean; maxLength: number | null; unique: boolean };

async function columnsOf(conn: mysql.Connection, schema: string, table: string): Promise<ColumnInfo[]> {
  const [cols] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS maxLength FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [schema, table],
  );
  const [unique] = await conn.query<mysql.RowDataPacket[]>(
    // Primary keys too: not every table's key is an auto-increment id.
    "SELECT DISTINCT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0",
    [schema, table],
  );
  const uniqueNames = new Set(unique.map((u) => String(u.name)));
  return cols.map((c) => {
    const extra = String(c.extra ?? "");
    return {
      name: String(c.name),
      nullable: c.nullable === "YES",
      hasDefault: c.def !== null || /DEFAULT_GENERATED/i.test(extra),
      dataType: String(c.dataType).toLowerCase(),
      columnType: String(c.columnType),
      // Auto-increment ids and generated columns are filled in by MySQL.
      skip: /auto_increment|\b(VIRTUAL|STORED) GENERATED\b/i.test(extra),
      maxLength: c.maxLength === null ? null : Number(c.maxLength),
      unique: uniqueNames.has(String(c.name)),
    };
  });
}

let serial = 0;
/** A synthetic value of the column's type. Unique columns get distinct values. */
function syntheticValue(col: ColumnInfo): unknown {
  serial += 1;
  const t = col.dataType;
  if (t === "enum") return /^enum\('([^']*)'/.exec(col.columnType)?.[1] ?? "";
  if (t === "set") return "";
  if (["int", "bigint", "smallint", "mediumint", "tinyint"].includes(t)) return col.unique ? 1_000_000 + serial : 0;
  if (["decimal", "float", "double", "bit"].includes(t)) return 0;
  if (["timestamp", "datetime"].includes(t)) return new Date();
  if (t === "date") return "2026-01-01";
  if (t === "time") return "00:00:00";
  if (t === "year") return 2026;
  if (t === "json") return "{}";
  if (["blob", "varbinary", "binary", "longblob", "mediumblob", "tinyblob"].includes(t)) return Buffer.from(`s${serial}`);
  const text = `${serial.toString(36)}s${randomBytes(6).toString("hex")}`;
  return col.maxLength ? text.slice(0, Math.max(1, col.maxLength)) : text;
}

/** Insert synthetic rows, filling every required column a row does not name. */
async function insertRows(conn: mysql.Connection, schema: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const columns = await columnsOf(conn, schema, table);
  for (const row of rows) {
    const full: Record<string, unknown> = {};
    for (const col of columns) {
      if (col.name in row) full[col.name] = row[col.name];
      else if (!col.skip && (col.unique || (!col.nullable && !col.hasDefault))) full[col.name] = syntheticValue(col);
    }
    const names = Object.keys(full);
    await conn.query(
      `INSERT INTO \`${schema}\`.\`${table}\` (${names.map((n) => `\`${n}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      names.map((n) => full[n]),
    );
  }
}

const now = () => new Date();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000);

/**
 * Synthetic rows per table: one in EVERY state the schema defines for the
 * columns the predicates read, so widening or narrowing a predicate changes a
 * count. The coverage test below fails when the schema gains a state.
 */
const SEED: Record<string, Record<string, unknown>[]> = {
  reconciliation_jobs: [
    { status: "pending" },
    { status: "pending" },
    { status: "running", heartbeatAt: now() },
    { status: "running", heartbeatAt: minutesAgo(60), startedAt: minutesAgo(90), createdAt: minutesAgo(2 * 24 * 60) },
    { status: "completed" },
    { status: "failed" },
    { status: "cancelled" },
    { status: "running", abandonedAt: now() },
    { status: "pending", abandonedAt: now() },
  ],
  upload_batches: [{ status: "pending" }, { status: "processing" }, { status: "completed" }, { status: "failed" }],
  schedule_run_history: [{ status: "running" }, { status: "success" }, { status: "failed" }, { status: "skipped" }],
  wc_connector_sync_runs: [{ status: "running" }, { status: "completed" }, { status: "partial" }, { status: "failed" }],
  webhook_deliveries: [{ status: "pending" }, { status: "pending" }, { status: "pending" }, { status: "delivered" }, { status: "failed" }],
  shopify_privacy_queue_outbox: [{ status: "pending" }, { status: "dispatching" }, { status: "failed_retryable" }, { status: "dispatched" }, { status: "failed_terminal" }],
  shopify_privacy_requests: [
    "received", "processing", "awaiting_delivery", "manual_review", "blocked_dependency",
    "blocked_legal_retention", "failed_retryable", "failed_terminal", "completed", "failed",
  ].map((status) => ({ status })),
  shopify_privacy_data_request_jobs: [
    "received", "processing", "awaiting_delivery", "manual_review", "blocked_dependency",
    "blocked_legal_retention", "failed_retryable", "failed_terminal", "completed",
  ].map((status) => ({ status })),
  shopify_privacy_customer_redaction_jobs: [
    "received", "processing", "manual_review", "blocked_dependency", "failed_retryable", "failed_terminal", "completed",
  ].map((status) => ({ status })),
  shopify_shop_redaction_jobs: [
    "admitted", "processing", "blocked_dependency", "manual_review", "failed_retryable", "failed_terminal", "completed", "redacting", "failed",
  ].map((status) => ({ status })),
  shopify_privacy_artifacts: [
    { status: "writing", deliveryStatus: "pending" },
    { status: "ready", deliveryStatus: "pending" },
    { status: "ready", deliveryStatus: "acknowledged" },
    { status: "deleted", deliveryStatus: "pending" },
    { status: "deleted", deliveryStatus: "acknowledged" },
  ],
  shopify_webhook_events: [{ status: "received" }, { status: "received" }, { status: "processed" }, { status: "failed" }, { status: "ignored" }],
  shopify_sync_requests: [{ status: "queued" }, { status: "succeeded" }, { status: "failed" }],
  shopify_install_leases: [{ expiresAt: minutesAhead(60) }, { expiresAt: minutesAgo(60) }],
  shopify_connector_stores: [
    ...["pending_claim", "active", "reauthorization_required", "uninstalled", "redacting"].map((status) => ({ status, privacyRedactionState: "active" })),
    { status: "active", privacyRedactionState: "customer_redacting" },
  ],
  organizations: [{ deletionState: "redacting", redactingAt: now() }, { deletionState: "active" }],
  sl_connector_webhook_events: [
    { status: "pending", attempts: 0 },
    { status: "processing", attempts: 1 },
    { status: "failed", attempts: 2 },
    { status: "failed", attempts: 3 },
    { status: "pending", attempts: 3 },
    { status: "processed", attempts: 0 },
    { status: "dlq", attempts: 0 },
  ],
  sl_connector_gdpr_requests: ["received", "completed", "failed", "unresolved_store"].map((status) => ({ status })),
  wc_connector_webhook_events: ["received", "processed", "failed", "duplicate", "quarantined"].map((status) => ({ status })),
  wc_connector_dead_letters: ["pending", "retrying", "resolved", "exhausted", "discarded"].map((status) => ({ status })),
  data_deletion_requests: ["pending", "in_progress", "completed", "failed"].map((status) => ({ status })),
};

/** What each surface must report for SEED. */
const EXPECTED: Record<string, number> = {
  "reconciliation_jobs.unfinished": 4,
  "reconciliation_jobs.running_stale_heartbeat": 1,
  "upload_batches.in_progress": 2,
  "schedule_run_history.running": 1,
  "wc_connector_sync_runs.running": 1,
  "webhook_deliveries.pending": 3,
  "shopify_privacy_queue_outbox.undispatched": 3,
  "shopify_privacy_requests.in_progress": 5,
  "shopify_privacy_requests.parked": 2,
  "shopify_privacy_data_request_jobs.in_progress": 5,
  "shopify_privacy_customer_redaction_jobs.in_progress": 4,
  "shopify_shop_redaction_jobs.in_progress": 5,
  "shopify_privacy_artifacts.writing": 1,
  "shopify_privacy_artifacts.awaiting_acknowledgement": 1,
  "shopify_webhook_events.acknowledged_unprocessed": 2,
  "shopify_sync_requests.queued": 1,
  "shopify_install_leases.unexpired": 1,
  "shopify_connector_stores.redacting": 2,
  "organizations.redacting": 1,
  "sl_connector_webhook_events.acknowledged_unprocessed": 3,
  "sl_connector_gdpr_requests.received": 1,
  "wc_connector_webhook_events.received": 1,
  "wc_connector_dead_letters.retryable": 2,
  "data_deletion_requests.open": 2,
};

/** What the script must report about its own database controls, per engine. */
const CONTROLS: Record<Engine["name"], Record<string, unknown>> = {
  MySQL: { engine: "mysql", snapshot: "consistent_snapshot", database_write_prevention: "statement_guard_only" },
  TiDB: { engine: "tidb", snapshot: "consistent_snapshot", database_write_prevention: "statement_guard_only" },
};

/** The run's variables for a fixture database, with the identity that passes the fence. */
const onDatabase = (url: string, extra: Record<string, string> = {}) => ({ ...identityVars(), DATABASE_URL: url, ...extra });

for (const engine of ENGINES) {
  describe.runIf(engine.enabled)(`when the script reads a ${engine.name} database copied from the real schema`, () => {
    let admin: mysql.Connection;
    let seeded: { name: string; url: string } | undefined;
    let empty: { name: string; url: string } | undefined;
    const disposable = (db: { name: string; url: string } | undefined) => {
      if (!db) throw new Error("disposable_database_missing");
      return db;
    };

    beforeAll(async () => {
      admin = await fixtureConnection(engine.url);
      seeded = await createDisposableDatabase(admin, engine.url, "preflight_seeded");
      empty = await createDisposableDatabase(admin, engine.url, "preflight_empty");
      for (const [table, rows] of Object.entries(SEED)) await insertRows(admin, seeded.name, table, rows);
    }, 120_000);

    afterAll(async () => {
      if (!admin) return;
      for (const db of [seeded, empty]) if (db) await admin.query(`DROP DATABASE IF EXISTS \`${db.name}\``);
      await admin.end();
    });

    it("should seed every state the schema defines, so a new state cannot slip past the predicates", async () => {
      // A new status in the schema fails here until someone decides whether the
      // preflight must count it as unfinished work.
      const source = new URL(engine.url).pathname.slice(1);
      for (const [table, rows] of Object.entries(SEED)) {
        const named = new Set(rows.flatMap((row) => Object.keys(row)));
        const [columns] = await admin.query<mysql.RowDataPacket[]>(
          "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND DATA_TYPE = 'enum'",
          [source, table],
        );
        for (const column of columns) {
          const name = String(column.name);
          if (!named.has(name)) continue;
          const states = [...String(column.type).matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
          const seededStates = [...new Set(rows.map((row) => row[name]).filter((v) => v !== undefined))].sort();
          expect(seededStates, `${table}.${name}`).toEqual(states);
        }
      }
    });

    it("should count every surface exactly, and leave the database unchanged", async () => {
      expect(Object.keys(EXPECTED).sort()).toEqual(DB_SURFACES.map((s) => s.id).sort());
      const target = disposable(seeded);
      const before = await tableDigests(admin, target.name);
      const result = await runScript([...identityArgs(), "--samples", "1"], onDatabase(target.url));
      expect(result.code, result.stdout).toBe(EXIT.report);
      for (const surface of DB_SURFACES) {
        expect(field(result.report, "samples", 0, "database", "surfaces", surface.id), surface.id).toMatchObject({ reading: "ok", count: EXPECTED[surface.id] });
      }
      // Two pending and one live running job are fresh; the stale one is two days old.
      expect(field(result.report, "samples", 0, "database", "surfaces", "reconciliation_jobs.unfinished")).toMatchObject({ under_15_minutes: 3, over_1_day: 1 });
      expect(field(result.report, "samples", 0, "database", "surfaces", "reconciliation_jobs.running_stale_heartbeat", "oldest_minutes")).toBeGreaterThanOrEqual(2 * 24 * 60 - 1);
      expect(field(result.report, "verdicts", "reconciliation_unfinished")).toBe("fail_unfinished_work");
      expect(field(result.report, "verdicts", "accepted_unfinished")).toBe("fail_unfinished_work");
      expect(result.verdict).toBe("no_go_unfinished_work");
      expect(() => assertAggregateOnly(result.report)).not.toThrow();
      expect(await tableDigests(admin, target.name)).toEqual(before);
    }, ceilingFor(1));

    it("should read one snapshot, and claim no write control but its statement guard", async () => {
      const result = await runScript([...identityArgs(), "--samples", "1"], onDatabase(disposable(empty).url));
      expect(field(result.report, "read_only_controls")).toMatchObject({
        database_route: "local_loopback",
        database_connection: "ok",
        session_time_zone_utc: true,
        ...CONTROLS[engine.name],
      });
      for (const surface of DB_SURFACES) {
        expect(field(result.report, "samples", 0, "database", "surfaces", surface.id, "count"), surface.id).toBe(0);
      }
      expect(field(result.report, "verdicts", "accepted_unfinished")).toBe("pass_zero_observed");
    }, ceilingFor(1));

    it("should read each sample from one snapshot, blind to rows committed after it began", async () => {
      const target = disposable(empty);
      const uploads = DB_SURFACES.find((s) => s.id === "upload_batches.in_progress");
      if (!uploads) throw new Error("surface_missing");
      const db = await openDatabase(planDatabaseRoute(target.url), REPO);
      try {
        await db.beginSnapshot();
        await insertRows(admin, target.name, "upload_batches", [{ status: "pending" }]);
        const [during] = await db.run(surfaceSql(uploads));
        expect(Number(during.n)).toBe(0);
        await db.endSnapshot();
        await db.beginSnapshot();
        const [next] = await db.run(surfaceSql(uploads));
        expect(Number(next.n)).toBe(1);
        await db.endSnapshot();
      } finally {
        await db.close();
        await admin.query(`DELETE FROM \`${target.name}\`.upload_batches`);
      }
    });

    it("should refuse a write through its own connection, inside its snapshot", async () => {
      const db = await openDatabase(planDatabaseRoute(disposable(empty).url), REPO);
      try {
        await db.beginSnapshot();
        expect(db.controls?.snapshot).toBe("consistent_snapshot");
        await expect(db.run("INSERT INTO upload_batches (status) VALUES ('pending')")).rejects.toMatchObject({ code: "sql_refused" });
        await expect(db.run("SET SESSION TRANSACTION READ WRITE")).rejects.toMatchObject({ code: "sql_refused" });
        await db.endSnapshot();
      } finally {
        await db.close();
      }
      const [[rows]] = await admin.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${disposable(empty).name}\`.upload_batches`);
      expect(Number(rows.n)).toBe(0);
    });

    it.runIf(engine.name === "MySQL")("should refuse the fixture by name: TLS is required, and its certificate is not trusted", async () => {
      // The same server, named instead of addressed: off the loopback address
      // the preflight insists on a verified certificate, which MySQL's own
      // generated one is not.
      const byName = new URL(disposable(empty).url);
      byName.hostname = "localhost";
      expect(await openDatabase(planDatabaseRoute(byName.toString()), REPO)).toEqual({ error: "tls_certificate_refused" });
    });

    it.runIf(engine.name === "MySQL")("should finish with fixed codes when its connection is killed between samples", async () => {
      const target = disposable(empty);
      let killed: Promise<unknown> | undefined;
      const result = await runScript([...identityArgs(), "--samples", "2", "--interval-seconds", "3"], onDatabase(target.url), (line) => {
        if (line.includes("sample 1/2 complete") && !killed) {
          killed = admin
            .query<mysql.RowDataPacket[]>("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()", [target.name])
            .then(([rows]) => Promise.all(rows.map((row) => admin.query(`KILL ${Number(row.id)}`))));
        }
      });
      expect(killed).toBeDefined();
      await killed;
      expect(result.code, result.stdout).toBe(EXIT.report);
      expect(field(result.report, "samples", 1, "database", "surfaces", "upload_batches.in_progress")).toEqual({ reading: "unknown", error: "unreachable" });
      expect(result.verdict).toBe("no_go_incomplete_evidence");
      expect(() => assertAggregateOnly(result.report)).not.toThrow();
    }, ceilingFor(1));

    it("should report producers as active when work arrives between samples", async () => {
      const target = disposable(empty);
      let inserted: Promise<void> | undefined;
      const result = await runScript([...identityArgs(), "--samples", "2", "--interval-seconds", "2"], onDatabase(target.url), (line) => {
        if (line.includes("sample 1/2 complete") && !inserted) {
          inserted = insertRows(admin, target.name, "sl_connector_webhook_events", [{ status: "processed", receivedAt: now() }]);
        }
      });
      expect(inserted).toBeDefined();
      await inserted;
      expect(field(result.report, "samples", 1, "database", "intake", "sl_connector_webhook_events")).toEqual({ reading: "ok", count: 1 });
      expect(field(result.report, "samples", 1, "database", "surfaces", "sl_connector_webhook_events.acknowledged_unprocessed", "count")).toBe(0);
      expect(field(result.report, "verdicts", "producer_activity")).toBe("producers_active");
    }, ceilingFor(1));
  });
}

// ─── Redis: a disposable loopback fixture, in database indexes of its own ───

const fixtureUrl = process.env.RECONCILEAI_TEST_REDIS_URL;
if (fixtureUrl && !/^redis:\/\/127\.0\.0\.1:\d+\/?$/.test(fixtureUrl)) {
  throw new Error("preflight_test_requires_isolated_loopback_redis");
}
/**
 * ioredis as BullMQ loads it. It is not a direct dependency of the app, which
 * is also why the script loads it the same way.
 */
type RedisClient = {
  scan(cursor: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  type(key: string): Promise<string>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  zrange(key: string, start: number, stop: number, withScores: "WITHSCORES"): Promise<string[]>;
  xrange(key: string, start: "-", end: "+"): Promise<unknown[]>;
  del(key: string): Promise<number>;
  disconnect(): void;
};
function redisClient(url: string): RedisClient {
  const fromApp = createRequire(path.join(REPO, "package.json"));
  const loaded = createRequire(fromApp.resolve("bullmq"))("ioredis");
  const IORedis = (loaded.default ?? loaded.Redis ?? loaded) as new (url: string) => RedisClient;
  return new IORedis(url);
}

/** The fixture at a database index only this file uses. */
const redisIndex = (index: number) => `${(fixtureUrl ?? "").replace(/\/$/, "")}/${index}`;

describe.skipIf(!fixtureUrl)("when the script reads queues on a disposable Redis fixture", () => {
  const url = redisIndex(9);
  const connection = { url } as never;
  const synthetic = ["reconciliation-runs", "webhook-delivery", "shopify-privacy", "shopline-realtime-sync", "legacy-synthetic-queue"];

  afterAll(async () => {
    const { Queue } = await import("bullmq");
    for (const name of synthetic) {
      const queue = new Queue(name, { connection });
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  /**
   * Every key, with its type, whether it expires, and a hash of its LOGICAL
   * value, so a diff names the key. Not DUMP: a plain read can finish a hash
   * table's incremental rehash, which reorders DUMP's output while every field
   * and value stays the same. That happened here, on a job hash the script had
   * only read with HMGET.
   */
  async function fingerprint(): Promise<Record<string, string>> {
    const client = redisClient(url);
    try {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await client.scan(cursor, "COUNT", 500);
        keys.push(...batch);
        cursor = next;
      } while (cursor !== "0");
      const prints: Record<string, string> = {};
      for (const key of keys.sort()) {
        const type = await client.type(key);
        let value: unknown = type;
        if (type === "string") value = await client.get(key);
        else if (type === "hash") value = Object.entries(await client.hgetall(key)).sort();
        else if (type === "list") value = await client.lrange(key, 0, -1);
        else if (type === "set") value = (await client.smembers(key)).sort();
        else if (type === "zset") value = await client.zrange(key, 0, -1, "WITHSCORES");
        else if (type === "stream") value = await client.xrange(key, "-", "+");
        const expiry = (await client.pttl(key)) === -1 ? "persistent" : "expiring";
        prints[key] = `${type}:${expiry}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
      }
      return prints;
    } finally {
      client.disconnect();
    }
  }

  it("should count every state, retry and orphaned active job, and write nothing", async () => {
    const { Queue, Worker } = await import("bullmq");
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("fixture_wait_timeout");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    const recon = new Queue("reconciliation-runs", { connection });
    await recon.add("synthetic-a", { synthetic: true });
    await recon.add("synthetic-b", { synthetic: true });

    // One plain delayed job, and one that failed once and waits for its retry.
    const delivery = new Queue("webhook-delivery", { connection });
    await delivery.add("synthetic-delayed", { synthetic: true }, { delay: 3_600_000 });
    await delivery.add("synthetic-retry", { synthetic: true }, { attempts: 3, backoff: { type: "fixed", delay: 3_600_000 } });
    const failing = new Worker("webhook-delivery", async () => {
      throw new Error("synthetic");
    }, { connection });
    failing.on("error", () => {});
    await until(async () => (await delivery.getJobCounts("delayed")).delayed === 2);
    await failing.close();

    const privacy = new Queue("shopify-privacy", { connection });
    await privacy.add("synthetic-prioritized", { synthetic: true }, { priority: 5 });

    // An active job whose worker died: its lock is gone, and it is still listed active.
    const realtime = new Queue("shopline-realtime-sync", { connection });
    const orphan = await realtime.add("synthetic-orphan", { synthetic: true });
    const hanging = new Worker("shopline-realtime-sync", () => new Promise<void>(() => {}), { connection });
    hanging.on("error", () => {});
    await until(async () => (await realtime.getJobCounts("active")).active === 1);
    await hanging.close(true);
    const raw = redisClient(url);
    await raw.del(`bull:shopline-realtime-sync:${orphan.id}:lock`);
    raw.disconnect();

    const legacy = new Queue("legacy-synthetic-queue", { connection });
    await legacy.add("synthetic-unknown", { synthetic: true });
    for (const queue of [recon, delivery, privacy, realtime, legacy]) await queue.close();

    const before = await fingerprint();
    const result = await runScript([...identityArgs(), "--samples", "1"], { ...identityVars(), REDIS_URL: url });
    expect(await fingerprint()).toEqual(before);

    const queue = (name: string) => field(result.report, "samples", 0, "redis", "queues", name);
    expect(field(result.report, "read_only_controls", "redis_route")).toBe("local_loopback");
    expect(queue("reconciliation-runs")).toMatchObject({ reading: "ok", wait: 2, runnable: 2, job_inspection: "complete" });
    expect(queue("webhook-delivery")).toMatchObject({ delayed: 2, runnable: 2, retrying_waiting_or_delayed: 1 });
    expect(queue("shopify-privacy")).toMatchObject({ prioritized: 1, runnable: 1 });
    expect(queue("shopline-realtime-sync")).toMatchObject({ active: 1, runnable: 1, active_without_live_lock: 1 });
    expect(queue("shopify-order-sync")).toMatchObject({ reading: "ok", runnable: 0 });
    expect(queue("shopify-manual-sync")).toMatchObject({ reading: "ok", runnable: 0 });
    expect(field(result.report, "samples", 0, "redis", "unknown_queues")).toMatchObject({ reading: "ok", count: 1, runnable: 1, scan_complete: true });
    expect(field(result.report, "verdicts", "queues_runnable")).toBe("fail_unfinished_work");
    expect(() => assertAggregateOnly(result.report)).not.toThrow();
  }, ceilingFor(1) + 20_000);
});

describe.skipIf(!fixtureUrl || !localDatabase)("when the script reads an idle database and an idle Redis", () => {
  let admin: mysql.Connection;
  let idle: { name: string; url: string } | undefined;
  const idleDb = () => {
    if (!idle) throw new Error("disposable_database_missing");
    return idle;
  };

  beforeAll(async () => {
    admin = await fixtureConnection(ENGINES[0].url);
    idle = await createDisposableDatabase(admin, ENGINES[0].url, "preflight_idle");
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    if (idle) await admin.query(`DROP DATABASE IF EXISTS \`${idle.name}\``);
    await admin.end();
  });

  it("should still say only 'zero observed, not proof'", async () => {
    const result = await runScript([...identityArgs(), "--samples", "2", "--interval-seconds", "1"], onDatabase(idleDb().url, { REDIS_URL: redisIndex(10) }));
    expect(field(result.report, "verdicts")).toMatchObject({
      reconciliation_unfinished: "pass_zero_observed",
      queues_runnable: "pass_zero_observed",
      accepted_unfinished: "pass_zero_observed",
      producer_activity: "no_intake_observed",
    });
    expect(result.verdict).toBe("zero_observed_not_proof");
  }, ceilingFor(1));

  it("should say 'producers active' when work arrives between samples", async () => {
    const target = idleDb();
    let inserted: Promise<void> | undefined;
    const result = await runScript([...identityArgs(), "--samples", "2", "--interval-seconds", "2"], onDatabase(target.url, { REDIS_URL: redisIndex(10) }), (line) => {
      if (line.includes("sample 1/2 complete") && !inserted) {
        inserted = insertRows(admin, target.name, "transactions", [{ createdAt: now() }]);
      }
    });
    expect(inserted).toBeDefined();
    await inserted;
    expect(result.verdict).toBe("no_go_producers_active");
  }, ceilingFor(1));
});
