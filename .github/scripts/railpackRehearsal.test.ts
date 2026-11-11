/**
 * railpack-rehearsal.sh — the runtime half of the Railpack build rehearsal.
 *
 * A green rehearsal exercises only the happy path, so it proves nothing about
 * the checks that are meant to fail it. These tests run the REAL script against
 * a fake `docker` on PATH and watch those checks fire: a database that records
 * fewer migrations than the journal holds, an app that exits before it answers,
 * an app that never answers. They also pin what the app is given, because the
 * rehearsal's promise is that it receives synthetic settings and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

/** How long one run of the script may take before it is killed. */
const SCRIPT_TIMEOUT_MS = 30_000;

// Looser than the script's own kill timeout, so a stuck run fails on what it
// printed rather than on vitest's bare "Test timed out" (see startTestMysql.test.ts).
vi.setConfig({ testTimeout: SCRIPT_TIMEOUT_MS + 5_000 });

/** Forward slashes: bash reads this path on Windows too (Git Bash). */
const SCRIPT = path.resolve(__dirname, "railpack-rehearsal.sh").replace(/\\/g, "/");

/**
 * Logs every call, then answers by FAKE_DOCKER_MODE:
 *   healthy    the health probe succeeds;
 *   app_exits  the probe fails and the app container is no longer running;
 *   never      the probe fails and the app keeps running.
 * `docker exec` (the migration count) answers FAKE_RECORDED_MIGRATIONS.
 * pnpm's no-op answers by FAKE_PNPM: "needs_registry" fails with the
 * registry error unless the fetched-pnpm volume is mounted; anything else runs.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  volume) ;;
  run)
    case " $* " in
      *" --entrypoint printenv "*) echo /opt/pnpm ;;
      *" --entrypoint node "*" -p "*) echo 10.18.0 ;;
      *" --entrypoint node "*) if [ "$FAKE_DOCKER_MODE" = healthy ]; then exit 0; fi; exit 1 ;;
      *"command -v pnpm"*) echo /app/node_modules/.bin/pnpm ;;
      *"pnpm exec node --version"*)
        case " $* " in
          *" --volume "*) echo v22.0.0 ;;
          *) if [ "$FAKE_PNPM" = needs_registry ]; then
               echo "request to https://registry.npmjs.org/pnpm/-/pnpm-10.4.1.tgz failed" >&2; exit 1
             fi
             echo v22.0.0 ;;
        esac ;;
      *" --detach "*) echo fakecontainerid ;;
    esac ;;
  exec) echo "$FAKE_RECORDED_MIGRATIONS" ;;
  inspect)
    case "$*" in
      *Running*) if [ "$FAKE_DOCKER_MODE" = app_exits ]; then echo false; else echo true; fi ;;
      *ExitCode*) echo 0 ;;
    esac ;;
  logs)
    echo "FAKE APP LOG LINE"
    echo "[shutdown] stopped; scope=tracked_process_only" ;;
esac
exit 0
`;

/** Every variable the script reads. Each run sets all of them explicitly. */
const SCRIPT_ENV_KNOBS = [
  "IMAGE",
  "NETWORK",
  "MYSQL_CONTAINER",
  "MYSQL_DATABASE",
  "MYSQL_ROOT_PASSWORD",
  "RESULTS",
  "JOURNAL",
  "HEALTH_TIMEOUT_SECONDS",
  "PROBE_INTERVAL_SECONDS",
  "STOP_TIMEOUT_SECONDS",
  "PNPM_TOOLS_VOLUME",
] as const;

let workDir: string;
let callLog: string;
let results: string;
let journal: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "railpack-rehearsal-test-"));
  const bin = path.join(workDir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER);
  callLog = path.join(workDir, "calls");
  results = path.join(workDir, "results.env");
  journal = path.join(workDir, "journal.json");
  fs.writeFileSync(callLog, "");
  fs.writeFileSync(results, "");
  // Three committed migrations.
  fs.writeFileSync(journal, JSON.stringify({ entries: [{ idx: 0 }, { idx: 1 }, { idx: 2 }] }));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

type Result = { code: number; out: string; calls: string[]; results: string };

async function runScript(
  args: string[],
  mode: string,
  env: Record<string, string> = {},
): Promise<Result> {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const knob of SCRIPT_ENV_KNOBS) delete inherited[knob];
  const shared = {
    ...inherited,
    FAKE_BIN: path.join(workDir, "bin").replace(/\\/g, "/"),
    SCRIPT_PATH: SCRIPT,
    FAKE_DOCKER_MODE: mode,
    FAKE_RECORDED_MIGRATIONS: "3",
    FAKE_PNPM: "runs_offline",
    CALL_LOG: callLog.replace(/\\/g, "/"),
    IMAGE: "rehearsal-image:test",
    NETWORK: "rehearsal-net",
    MYSQL_CONTAINER: "rehearsal-db",
    MYSQL_DATABASE: "rehearsal",
    MYSQL_ROOT_PASSWORD: "synthetic",
    RESULTS: results.replace(/\\/g, "/"),
    JOURNAL: journal.replace(/\\/g, "/"),
    // Short waits: the loop's decisions matter here, not wall-clock time.
    HEALTH_TIMEOUT_SECONDS: "1",
    PROBE_INTERVAL_SECONDS: "0.1",
    STOP_TIMEOUT_SECONDS: "1",
    ...env,
  };
  const command = [
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'chmod +x "$FAKE_BIN/docker"',
    'export PATH="$FAKE_BIN:$PATH"',
    // Proves the fake won the lookup, so no case passes by driving real Docker.
    'case "$(command -v docker)" in "$FAKE_BIN"/*) ;; *) echo "FAKE NOT ON PATH" >&2; exit 97 ;; esac',
    'exec bash "$SCRIPT_PATH" "$@"',
  ].join("; ");
  let code = 0;
  let out = "";
  try {
    const { stdout, stderr } = await run("bash", ["-c", command, "rehearsal", ...args], {
      env: shared,
      timeout: SCRIPT_TIMEOUT_MS,
    });
    out = stdout + stderr;
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    code = typeof e.code === "number" ? e.code : 1;
    out = (e.stdout ?? "") + (e.stderr ?? "");
    if (e.killed) out += `\n[killed by the test after ${SCRIPT_TIMEOUT_MS}ms]`;
  }
  return {
    code,
    out,
    calls: fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean),
    results: fs.readFileSync(results, "utf8"),
  };
}

const IN_NETWORK_URL = "DATABASE_URL=mysql://root:synthetic@rehearsal-db:3306/rehearsal";

describe("when the pre-deploy command records every committed migration", () => {
  it("should run it twice in the image, on the internal network, and record the counts", async () => {
    const result = await runScript(["migrate"], "healthy");

    expect(result.code, result.out).toBe(0);
    const migrations = result.calls.filter((c) => c.startsWith("run ") && c.includes("pnpm db:migrate"));
    expect(migrations).toHaveLength(2);
    for (const call of migrations) {
      expect(call).toContain("--network rehearsal-net");
      expect(call).toContain(IN_NETWORK_URL);
      expect(call).toContain("rehearsal-image:test");
    }
    expect(result.results).toContain("migrations_journal=3");
    expect(result.results).toContain("migrations_recorded=3");
  });
});

describe("when the database records fewer migrations than the journal holds", () => {
  it("should fail and say both numbers", async () => {
    const result = await runScript(["migrate"], "healthy", { FAKE_RECORDED_MIGRATIONS: "2" });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("records 2 migrations; the committed journal has 3");
    expect(result.results).not.toContain("migrations_recorded");
  });
});

describe("when the app answers its health check", () => {
  it("should record how long it took", async () => {
    const result = await runScript(["start", "app-one"], "healthy");

    expect(result.code, result.out).toBe(0);
    expect(result.results).toMatch(/^app-one_healthy_after_seconds=\d+$/m);
  });

  it("should give the app only the synthetic settings, on the internal network, with no published port", async () => {
    const result = await runScript(["start", "app-one"], "healthy");

    const start = result.calls.find((c) => c.startsWith("run ") && c.includes("--detach"));
    expect(start).toBeDefined();
    expect(start).toContain("--name app-one --network rehearsal-net");
    expect(start).toContain("PORT=3000");
    expect(start).toContain(IN_NETWORK_URL);
    expect(start).toMatch(/JWT_SECRET=[0-9a-f]{64}/);
    expect(start?.match(/--env /g)).toHaveLength(3);
    expect(start).not.toContain("--publish");
    expect(start).not.toMatch(/(^| )-p /);
    // No fetched-pnpm volume unless one is asked for.
    expect(start).not.toContain("--volume");
  });

  it("should probe from a separate container on the same network", async () => {
    const result = await runScript(["start", "app-one"], "healthy");

    const probe = result.calls.find((c) => c.includes("--entrypoint node"));
    expect(probe).toContain("--rm --network rehearsal-net");
    expect(probe).toContain("http://app-one:3000/api/healthz");
  });

  it("should pass a given start command to the image as its command", async () => {
    const launcher = "NODE_ENV=production exec node dist/index.js";
    const result = await runScript(["start", "app-two", launcher], "healthy");

    expect(result.code, result.out).toBe(0);
    const start = result.calls.find((c) => c.startsWith("run ") && c.includes("--detach"));
    expect(start?.endsWith(`rehearsal-image:test ${launcher}`)).toBe(true);
  });
});

describe("when the app exits before it answers", () => {
  it("should fail and show the app's own log", async () => {
    const result = await runScript(["start", "app-one"], "app_exits");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("app-one stopped before /api/healthz answered");
    expect(result.out).toContain("FAKE APP LOG LINE");
    expect(result.results).not.toContain("healthy_after_seconds");
  });
});

describe("when the app never answers", () => {
  it("should give up at the health-check allowance and show the app's log", async () => {
    const result = await runScript(["start", "app-one"], "never");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("did not answer 200 within 1s");
    expect(result.out).toContain("FAKE APP LOG LINE");
  });
});

describe("when a started app is stopped", () => {
  it("should record the exit code and whether the app's shutdown handler logged", async () => {
    const result = await runScript(["stop", "app-one"], "healthy");

    expect(result.code, result.out).toBe(0);
    expect(result.calls).toContain("stop --time 1 app-one");
    expect(result.results).toMatch(/^app-one_stop_seconds=\d+$/m);
    expect(result.results).toContain("app-one_exit_code=0");
    expect(result.results).toContain("app-one_shutdown_logged=stopped");
  });
});

describe("when pnpm in the image needs the npm registry before it runs", () => {
  it("should record which pnpm runs, its version and the dependency, warn, and not fail", async () => {
    const result = await runScript(["pnpm-check"], "healthy", { FAKE_PNPM: "needs_registry" });

    expect(result.code, result.out).toBe(0);
    expect(result.results).toContain("runtime_pnpm_path=/app/node_modules/.bin/pnpm");
    expect(result.results).toContain("project_pnpm_version=10.18.0");
    expect(result.results).toContain("runtime_pnpm_needs_registry=yes");
    expect(result.out).toContain("::warning::");
  });

  it("should check with no route out: every container it starts is on the internal network", async () => {
    const result = await runScript(["pnpm-check"], "healthy", { FAKE_PNPM: "needs_registry" });

    const runs = result.calls.filter((c) => c.startsWith("run "));
    expect(runs.length).toBeGreaterThan(0);
    for (const call of runs) expect(call).toContain("--network rehearsal-net");
  });
});

describe("when pnpm in the image runs without the network", () => {
  it("should record that it needs nothing, without a warning", async () => {
    const result = await runScript(["pnpm-check"], "healthy");

    expect(result.code, result.out).toBe(0);
    expect(result.results).toContain("runtime_pnpm_needs_registry=no");
    expect(result.out).not.toContain("::warning::");
  });
});

describe("when pnpm fetches its pinned version once, outside the app", () => {
  it("should refuse without a volume to keep it in", async () => {
    const result = await runScript(["pnpm-seed"], "healthy");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("pnpm-seed needs PNPM_TOOLS_VOLUME");
  });

  it("should run pnpm alone, with the volume where pnpm keeps fetched versions and no app settings", async () => {
    const result = await runScript(["pnpm-seed"], "healthy", {
      FAKE_PNPM: "needs_registry",
      PNPM_TOOLS_VOLUME: "rehearsal-tools",
    });

    expect(result.code, result.out).toBe(0);
    expect(result.calls).toContain("volume create rehearsal-tools");
    const seed = result.calls.find((c) => c.startsWith("run ") && c.includes("pnpm exec node --version"));
    expect(seed).toContain("--volume rehearsal-tools:/opt/pnpm/.tools");
    // The one container with a route out: it gets no app settings at all.
    expect(seed).not.toContain("--network");
    expect(seed).not.toContain("--env");
    expect(seed).not.toContain("DATABASE_URL");
    expect(result.results).toContain("pnpm_seeded=yes");
  });

  it("should give the fetched copy to the pre-deploy command and the start, still on the internal network", async () => {
    const env = { PNPM_TOOLS_VOLUME: "rehearsal-tools" };
    const migrate = await runScript(["migrate"], "healthy", env);
    const start = await runScript(["start", "app-one"], "healthy", env);

    expect(migrate.code, migrate.out).toBe(0);
    expect(start.code, start.out).toBe(0);
    const calls = [
      ...migrate.calls.filter((c) => c.includes("pnpm db:migrate")),
      ...start.calls.filter((c) => c.includes("--detach")),
    ];
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call).toContain("--network rehearsal-net");
      expect(call).toContain("--volume rehearsal-tools:/opt/pnpm/.tools");
    }
  });
});

describe("when the script is called without a known command", () => {
  it("should refuse with its usage", async () => {
    const result = await runScript([], "healthy");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("usage:");
    expect(result.calls).toEqual([]);
  });
});
