/**
 * production-workload-preflight.mjs is the read-only check run before a
 * deployment is replaced.
 *
 * What matters is how the script behaves when an operator runs it. So these
 * tests run the REAL script as a subprocess, and import its guards, to show:
 *   - it never writes, to the database or to Redis;
 *   - it prints only numbers, booleans and fixed labels, even when a
 *     connection fails with a password in the URL;
 *   - its counts are right for every surface, against the REAL schema;
 *   - its verdicts never say "safe", and say "producers active" when work
 *     arrives between samples.
 *
 * Database cases build disposable databases of their own on the local MySQL
 * fixture. Their tables are copied from the migrated test database with CREATE
 * TABLE LIKE, so a misspelt column fails here, not in production. Redis cases
 * run only on a disposable loopback fixture named by RECONCILEAI_TEST_REDIS_URL,
 * in database indexes no other test uses.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import {
  DB_SURFACES,
  INTAKE_SOURCES,
  QUEUE_NAMES,
  allSqlStatements,
  assertAggregateOnly,
  assertReadOnlyRedis,
  assertReadOnlySql,
  classifyCommand,
  classifyStartCommand,
  inspectProcesses,
  judge,
  openDatabase,
  parseArgs,
  readAppEnvironment,
  readDrainTimeoutSetting,
  readStartupModeSetting,
  readWholeNumber,
  runPreflight,
  signalMaskHas,
  surfaceSql,
  type Sample,
} from "./production-workload-preflight.mjs";
import { classifyDatabaseTarget } from "../server/dbTarget";

const SCRIPT = path.resolve(__dirname, "production-workload-preflight.mjs");
const REPO = path.resolve(__dirname, "..");

/** How long one run of the script may take before it is killed. */
const RUN_TIMEOUT_MS = 30_000;
/** A case's ceiling outlasts its runs, so a hung run still returns its output. */
const ceilingFor = (runs: number) => runs * RUN_TIMEOUT_MS + 15_000;

// ─── Running the real script ─────────────────────────────────────────────────

type ScriptRun = { code: number | null; killed: boolean; stdout: string; stderr: string; report: unknown; verdict: string | undefined };

/**
 * Run the script with ONLY the variables given, never the test runner's own
 * DATABASE_URL or REDIS_URL. `onStderr` lets a test act between samples.
 */
function runScript(
  args: string[],
  vars: Record<string, string>,
  onStderr?: (line: string) => Promise<void> | void,
  nodeOptions: string[] = [],
): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeOptions, SCRIPT, ...args], {
      cwd: REPO,
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
    ["LRANGE", ["bull:webhook-delivery:active", "0", "999"]],
    ["ZRANGE", ["bull:webhook-delivery:delayed", "0", "999"]],
    ["HMGET", ["bull:webhook-delivery:42", "atm", "attemptsMade", "stc"]],
    ["HMGET", ["bull:shopify-order-sync:shop:1:webhook:2", "atm", "attemptsMade", "stc"]],
    ["EXISTS", ["bull:webhook-delivery:42:lock"]],
    ["SCAN", ["0", "MATCH", "bull:*:meta", "COUNT", "500"]],
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
        schema: "reconcileai_workload_preflight_v1",
        generated_at: "2026-11-04T10:00:00.000Z",
        counts: { a: 0, b: 12 },
        flag: true,
        none: null,
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
    ["a nested secret", { a: { b: [{ c: "s3cr3t" }] } }],
    ["a key with spaces", { "a key": 1 }],
  ])("should refuse %s", (_label, value) => {
    expect(() => assertAggregateOnly(value)).toThrow("output_refused");
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

// Above PID_MAX_LIMIT (2^22), so no real process, the test runner included,
// can share a fake process's id.
const SHELL_PID = 4_194_400;
const APP_PID = 4_194_401;

/**
 * A fake /proc holding the chain `pnpm start` produces: pnpm as PID 1, then a
 * shell, then the app. `environ` gives a process an environment file.
 */
function fakeProcTree(environ: Partial<Record<number, Record<string, string>>> = {}): string {
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
  fake(APP_PID, ["node", "dist/index.js"], SHELL_PID, "0000000180004a02");
  return procRoot;
}

describe("when the processes are read inside the service container", () => {
  const procRoot = fakeProcTree();
  afterAll(() => rmSync(procRoot, { recursive: true, force: true }));

  it("should report the launcher chain and which process catches SIGTERM, as fixed classes only", () => {
    expect(inspectProcesses({ RAILWAY_REPLICA_ID: "replica" }, procRoot)).toEqual({
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
    expect(inspectProcesses({}, procRoot)).toEqual({ inspected: false, reason: "not_in_service_container" });
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

describe("when the settings are taken from the running application", () => {
  const appEnv = {
    DATABASE_URL: "mysql://sentinel_user:Sentinel-Pass-789@127.0.0.1:1/sentinel_db",
    RAILWAY_REPLICA_ID: "Sentinel-Replica-0042",
    RECONCILEAI_DRAIN_TIMEOUT_MS: "120000",
    JWT_SECRET: "Sentinel-Secret-Not-Read",
  };
  const roots: string[] = [];
  const tree = (environ: Partial<Record<number, Record<string, string>>>) => {
    const root = fakeProcTree(environ);
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("should accept the flag anywhere among the options", () => {
    expect(parseArgs(["--env-from-app", "--samples", "1"])).toMatchObject({ envFromApp: true, samples: 1 });
    expect(parseArgs(["--samples", "2", "--env-from-app"])).toMatchObject({ envFromApp: true, samples: 2 });
    expect(parseArgs([])).toMatchObject({ envFromApp: false });
    expect(() => parseArgs(["--env-from-app", "yes"])).toThrow("usage_error");
  });

  it("should read only the variables the script uses, from the app process first", () => {
    expect(readAppEnvironment(tree({ [APP_PID]: appEnv, 1: { DATABASE_URL: "mysql://pid1" } }))).toEqual({
      source: "app_process",
      env: { DATABASE_URL: appEnv.DATABASE_URL, RAILWAY_REPLICA_ID: appEnv.RAILWAY_REPLICA_ID, RECONCILEAI_DRAIN_TIMEOUT_MS: "120000" },
    });
    expect(readAppEnvironment(tree({ 1: { REDIS_URL: "redis://pid1", OTHER: "x" } }))).toEqual({ source: "pid1", env: { REDIS_URL: "redis://pid1" } });
    expect(readAppEnvironment(tree({}))).toEqual({ source: "app_process_unreadable", env: {} });
  });

  it("should use the app's values, including the ones it leaves unset, and print none of them", async () => {
    const report = await runPreflight({
      argv: ["--samples", "1", "--env-from-app"],
      // The operator's shell: a stale override, and no database at all.
      env: { RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30", PATH: process.env.PATH },
      appDir: REPO,
      procRoot: tree({ [APP_PID]: appEnv }),
    });
    expect(field(report, "deployment", "env_source")).toBe("app_process");
    expect(field(report, "read_only_controls", "database_connection")).toBe("unreachable");
    expect(field(report, "deployment", "application", "drain_timeout_ms")).toEqual({ state: "set", value: 120_000 });
    expect(field(report, "deployment", "provider_overrides", "draining_seconds")).toEqual({ state: "unset", value: null });
    expect(field(report, "processes", "inspected")).toBe(true);
    const printed = JSON.stringify(report);
    for (const secret of ["Sentinel", "sentinel", "127.0.0.1"]) expect(printed).not.toContain(secret);
  }, ceilingFor(1));
});

describe("when the verdicts are judged", () => {
  /** One sample: uploads in progress, runnable deliveries, transactions taken in. */
  const sample = (upload: number | null, delivery: number | null, intake: number | null, idCounter = 5): Sample => ({
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
      unknown_queues: { reading: "ok", runnable: 0 },
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
      "sl_connector_gdpr_requests.received": "accepted/work",
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
});

describe("when a report would carry a value outside the fixed vocabulary", () => {
  it("should refuse to return it", async () => {
    // A clock past year 9999 stamps the report with a time outside the fixed
    // format: a value the output guard must refuse rather than print.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("+010000-01-01T00:00:00.000Z"));
    try {
      await expect(runPreflight({ argv: ["--samples", "1"], env: {}, appDir: REPO })).rejects.toMatchObject({ code: "output_refused" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Always on: the real script, without a database or Redis ────────────────

describe("when the script runs without a database or Redis", () => {
  it("should report incomplete evidence, and nothing but aggregate labels", async () => {
    const result = await runScript(["--samples", "1"], {});
    expect(result.code, result.stdout).toBe(0);
    // One line of JSON, then the verdict and the group verdicts.
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(result.stdout).toMatch(/\nGROUPS: reconciliation=\w+ queues=\w+ accepted=\w+ producers=\w+\n$/);
    expect(field(result.report, "deployment", "env_source")).toBe("own");
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(() => assertAggregateOnly(result.report)).not.toThrow();
    expect(field(result.report, "read_only_controls", "queue_objects_constructed")).toBe(false);
    expect(field(result.report, "deployment", "effective_draining_proven")).toBe(false);
    expect(field(result.report, "deployment", "recipe", "start_command_kind")).toBe("pnpm_start");
    expect(field(result.report, "processes")).toEqual({ inspected: false, reason: "not_in_service_container" });
  }, ceilingFor(1));

  it("should print neither credentials nor hosts from a failing connection", async () => {
    const result = await runScript(["--samples", "1"], {
      DATABASE_URL: "mysql://sentinel_user:Sentinel-Pass-123@127.0.0.1:1/sentinel_db",
      REDIS_URL: "redis://:Sentinel-Pass-456@127.0.0.1:1",
    });
    expect(result.code, result.stdout).toBe(0);
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
    const result = await runScript(["--samples", "2", "--interval-seconds", "4"], {}, undefined, ["--import", plant]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ schema: "reconcileai_workload_preflight_v1", error: "preflight_failed" });
    expect(result.stdout + result.stderr).not.toContain("Sentinel");
  }, ceilingFor(1));

  it("should refuse bad arguments before opening any connection", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      for (const args of [["--samples", "0"], ["--expect-commit", "not-hex"], ["--interval-seconds", "9999"], ["--unknown", "1"], ["--samples"]]) {
        const result = await runScript(args, {
          DATABASE_URL: `mysql://u:p@127.0.0.1:${port}/x`,
          REDIS_URL: `redis://127.0.0.1:${port}`,
        });
        expect(result.code, args.join(" ")).toBe(2);
        expect(JSON.parse(result.stdout)).toEqual({ schema: "reconcileai_workload_preflight_v1", error: "usage_error" });
      }
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, ceilingFor(5));
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
      const result = await runScript(["--samples", "1"], { DATABASE_URL: target.url });
      expect(result.code, result.stdout).toBe(0);
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
      const result = await runScript(["--samples", "1"], { DATABASE_URL: disposable(empty).url });
      expect(field(result.report, "read_only_controls")).toMatchObject({
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
      const db = await openDatabase(target.url, REPO);
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
      const db = await openDatabase(disposable(empty).url, REPO);
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

    it.runIf(engine.name === "MySQL")("should finish with fixed codes when its connection is killed between samples", async () => {
      const target = disposable(empty);
      let killed: Promise<unknown> | undefined;
      const result = await runScript(["--samples", "2", "--interval-seconds", "3"], { DATABASE_URL: target.url }, (line) => {
        if (line.includes("sample 1/2 complete") && !killed) {
          killed = admin
            .query<mysql.RowDataPacket[]>("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()", [target.name])
            .then(([rows]) => Promise.all(rows.map((row) => admin.query(`KILL ${Number(row.id)}`))));
        }
      });
      expect(killed).toBeDefined();
      await killed;
      expect(result.code, result.stdout).toBe(0);
      expect(field(result.report, "samples", 1, "database", "surfaces", "upload_batches.in_progress")).toEqual({ reading: "unknown", error: "unreachable" });
      expect(result.verdict).toBe("no_go_incomplete_evidence");
      expect(() => assertAggregateOnly(result.report)).not.toThrow();
    }, ceilingFor(1));

    it("should report producers as active when work arrives between samples", async () => {
      const target = disposable(empty);
      let inserted: Promise<void> | undefined;
      const result = await runScript(["--samples", "2", "--interval-seconds", "2"], { DATABASE_URL: target.url }, (line) => {
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
    const result = await runScript(["--samples", "1"], { REDIS_URL: url });
    expect(await fingerprint()).toEqual(before);

    const queue = (name: string) => field(result.report, "samples", 0, "redis", "queues", name);
    expect(queue("reconciliation-runs")).toMatchObject({ reading: "ok", wait: 2, runnable: 2 });
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
    const result = await runScript(["--samples", "2", "--interval-seconds", "1"], { DATABASE_URL: idleDb().url, REDIS_URL: redisIndex(10) });
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
    const result = await runScript(["--samples", "2", "--interval-seconds", "2"], { DATABASE_URL: target.url, REDIS_URL: redisIndex(10) }, (line) => {
      if (line.includes("sample 1/2 complete") && !inserted) {
        inserted = insertRows(admin, target.name, "transactions", [{ createdAt: now() }]);
      }
    });
    expect(inserted).toBeDefined();
    await inserted;
    expect(result.verdict).toBe("no_go_producers_active");
  }, ceilingFor(1));
});
