/**
 * start-test-mysql.sh — the retry loop that keeps a registry blip from failing
 * the whole Tests job.
 *
 * Everything this script exists for happens only when Docker Hub is having a
 * bad day, so a healthy CI run proves none of it: broken retries, an ignored
 * attempt cap, a readiness wait that never gives up, or a swallowed container
 * log would all sail through a green pipeline. These tests run the REAL script
 * against a fake `docker` on PATH, so the outage behaviour is exercised on
 * every run.
 *
 * The fake is a shell script on PATH rather than an injected command, so the
 * script under test is invoked exactly as CI invokes it — no seam that exists
 * only for tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

/**
 * Every variable the script reads, scrubbed from the inherited environment
 * before each run.
 *
 * The child otherwise inherits the developer's shell, where an exported
 * `MYSQL_IMAGE` or `MYSQL_DATABASE` silently changes what the script does and
 * fails the assertions below for a reason that has nothing to do with the
 * script. Scrubbed rather than pinned to the defaults, because CI passes none
 * of these: clearing them is what makes these runs the CI run. A test's own
 * override is applied afterwards and still wins.
 */
const SCRIPT_ENV_KNOBS = [
  "MYSQL_IMAGE",
  "MYSQL_CONTAINER",
  "MYSQL_ROOT_PASSWORD",
  "MYSQL_DATABASE",
  "MYSQL_PULL_ATTEMPTS",
  "MYSQL_PULL_BACKOFF_SECONDS",
  "MYSQL_READY_ATTEMPTS",
  "MYSQL_READY_INTERVAL_SECONDS",
] as const;

/** Forward slashes: bash reads this path on Windows too (Git Bash). */
const SCRIPT = path
  .resolve(__dirname, "start-test-mysql.sh")
  .replace(/\\/g, "/");

/**
 * A `docker` whose behaviour is chosen by FAKE_DOCKER_MODE, and which tallies
 * pull attempts into COUNT_FILE so the attempt cap can be asserted rather than
 * inferred from the exit code.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  pull)
    n=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$COUNT_FILE"
    echo "pull $* (attempt $n)" >> "$CALL_LOG"
    case "$FAKE_DOCKER_MODE" in
      pull_fails_twice) if [ "$n" -ge 3 ]; then exit 0; fi; echo "fake: auth.docker.io timeout" >&2; exit 1 ;;
      pull_always_fails) echo "fake: auth.docker.io timeout" >&2; exit 1 ;;
      *) exit 0 ;;
    esac ;;
  run) echo "run $*" >> "$CALL_LOG"; echo "fakecontainerid"; exit 0 ;;
  exec)
    echo "exec $*" >> "$CALL_LOG"
    # "ready" answers the ping; every other mode never does.
    if [ "$FAKE_DOCKER_MODE" = "never_ready" ] || [ "$FAKE_DOCKER_MODE" = "container_dies" ]; then exit 1; fi
    exit 0 ;;
  inspect)
    if [ "$FAKE_DOCKER_MODE" = "container_dies" ]; then echo "false"; exit 0; fi
    echo "true"; exit 0 ;;
  logs) echo "FAKE CONTAINER LOG LINE"; exit 0 ;;
  *) exit 0 ;;
esac
`;

let workDir: string;
let countFile: string;
let callLog: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "start-mysql-test-"));
  const bin = path.join(workDir, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "docker");
  fs.writeFileSync(fake, FAKE_DOCKER);
  fs.chmodSync(fake, 0o755);
  countFile = path.join(workDir, "pulls");
  callLog = path.join(workDir, "calls");
  fs.writeFileSync(countFile, "");
  fs.writeFileSync(callLog, "");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

type Result = { code: number; out: string; pulls: number; calls: string };

/**
 * Run the script with the fake ahead of the real `docker`.
 *
 * PATH is assembled INSIDE bash: on Windows the host PATH uses `;` while the
 * shell wants `:`, and letting bash join them avoids that mismatch entirely.
 */
async function runScript(
  mode: string,
  env: Record<string, string> = {},
): Promise<Result> {
  const bin = path.join(workDir, "bin").replace(/\\/g, "/");
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const knob of SCRIPT_ENV_KNOBS) delete inherited[knob];
  const shared = {
    ...inherited,
    FAKE_BIN: bin,
    SCRIPT_PATH: SCRIPT,
    FAKE_DOCKER_MODE: mode,
    COUNT_FILE: countFile.replace(/\\/g, "/"),
    CALL_LOG: callLog.replace(/\\/g, "/"),
    // Zero waits: the loop's COUNTING is what matters, not wall-clock backoff.
    MYSQL_PULL_ATTEMPTS: "3",
    MYSQL_PULL_BACKOFF_SECONDS: "0",
    MYSQL_READY_ATTEMPTS: "4",
    MYSQL_READY_INTERVAL_SECONDS: "0",
    ...env,
  };
  const command = [
    // The fake's directory has to reach PATH as a POSIX path. Git Bash ignores
    // a Windows-style `C:/...` entry outright, so prefixing PATH with one is a
    // no-op and `docker` resolves to the REAL Docker Desktop binary — the
    // tests then drive the actual daemon instead of the fake, slowly and
    // wrongly. cygpath exists only there; on Linux the path is already POSIX.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    // chmod runs HERE rather than through fs.chmodSync, which on Windows only
    // toggles the read-only flag and leaves the shell refusing to execute it.
    'chmod +x "$FAKE_BIN/docker"',
    'export PATH="$FAKE_BIN:$PATH"',
    // Proves the fake won the lookup. Without it, a PATH that failed to apply
    // would make every case below pass or fail for the wrong reason.
    'case "$(command -v docker)" in "$FAKE_BIN"/*) ;; *) echo "FAKE NOT ON PATH: $(command -v docker)" >&2; exit 97 ;; esac',
    'exec bash "$SCRIPT_PATH"',
  ].join("; ");
  let code = 0;
  let out = "";
  try {
    const { stdout, stderr } = await run("bash", ["-c", command], {
      env: shared,
      timeout: 30_000,
    });
    out = stdout + stderr;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    code = typeof e.code === "number" ? e.code : 1;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  return {
    code,
    out,
    pulls: Number(fs.readFileSync(countFile, "utf8").trim() || "0"),
    calls: fs.readFileSync(callLog, "utf8"),
  };
}

describe("when the registry is healthy", () => {
  it("should pull once, start the container, and report ready", async () => {
    const result = await runScript("ready");

    expect(result.code).toBe(0);
    expect(result.pulls).toBe(1);
    expect(result.out).toContain("ready on 127.0.0.1:3306");
  });

  it("should start the pinned image with the credentials and port the suite expects", async () => {
    // A typo in `docker run` would otherwise surface only as a confusing
    // connection failure two steps later, in `pnpm db:push`.
    const result = await runScript("ready");

    const runLine = result.calls
      .split("\n")
      .find(line => line.startsWith("run "));
    expect(runLine).toBeDefined();
    expect(runLine).toContain("mysql:8.0");
    expect(runLine).toContain("MYSQL_ROOT_PASSWORD=root");
    expect(runLine).toContain("MYSQL_DATABASE=reconcileai_test");
    expect(runLine).toContain("3306:3306");
  });
});

describe("when the developer's own shell exports the script's variables", () => {
  it("should still run the defaults CI runs, not the developer's values", async () => {
    // Without the scrub these assertions fail on one machine and pass on every
    // other, which reads as a flaky script rather than a dirty environment.
    const hostile = { MYSQL_IMAGE: "mysql:5.5", MYSQL_DATABASE: "my_local_db" };
    const saved = new Map(
      Object.keys(hostile).map(key => [key, process.env[key]])
    );
    Object.assign(process.env, hostile);
    try {
      const result = await runScript("ready");

      const runLine = result.calls
        .split("\n")
        .find(line => line.startsWith("run "));
      expect(runLine).toContain("mysql:8.0");
      expect(runLine).toContain("MYSQL_DATABASE=reconcileai_test");
      expect(runLine).not.toContain("mysql:5.5");
      expect(runLine).not.toContain("my_local_db");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("should still let a test override one, so the pinned waits keep working", async () => {
    // The scrub must not also discard the overrides the other cases depend on
    // — they are what keeps the readiness loop from waiting in real seconds.
    const result = await runScript("ready", { MYSQL_DATABASE: "chosen_by_test" });

    const runLine = result.calls
      .split("\n")
      .find(line => line.startsWith("run "));
    expect(runLine).toContain("MYSQL_DATABASE=chosen_by_test");
  });
});

describe("when the registry fails and then recovers", () => {
  it("should keep retrying and succeed, rather than failing the job", async () => {
    // The whole point of the script: run 37995168085 died on three timeouts
    // inside about a minute, with the image perfectly available afterwards.
    const result = await runScript("pull_fails_twice");

    expect(result.code).toBe(0);
    expect(result.pulls).toBe(3);
    expect(result.out).toContain("pulled mysql:8.0 on attempt 3");
  });
});

describe("when the registry is down for the whole window", () => {
  it("should give up at the attempt cap rather than hanging the job", async () => {
    const result = await runScript("pull_always_fails");

    expect(result.code).not.toBe(0);
    // Exactly the cap: one more would mean the cap is not read, one fewer
    // that a retry was skipped.
    expect(result.pulls).toBe(3);
    expect(result.out).toContain("could not pull");
  });

  it("should honour a different attempt cap", async () => {
    // Pins that the cap is read from the environment and not a constant the
    // loop ignores.
    const result = await runScript("pull_always_fails", {
      MYSQL_PULL_ATTEMPTS: "2",
    });

    expect(result.pulls).toBe(2);
    expect(result.code).not.toBe(0);
  });

  it("should never start a container it could not pull", async () => {
    const result = await runScript("pull_always_fails");

    expect(result.calls).not.toContain("run ");
  });
});

describe("when the container exits during startup", () => {
  it("should fail fast and print the container log", async () => {
    // Without the log, a MySQL that refuses to initialise leaves only a
    // timeout and nothing to diagnose it with.
    const result = await runScript("container_dies");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("no longer running");
    expect(result.out).toContain("FAKE CONTAINER LOG LINE");
  });
});

describe("when the container starts but never becomes ready", () => {
  it("should stop at the readiness cap and print the container log", async () => {
    // Distinct from the case above: the container stays up and simply never
    // answers the ping, so the loop has to end on its own count. An unbounded
    // wait here would hang the job until GitHub's 6-hour limit.
    const result = await runScript("never_ready");

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("did not become ready");
    expect(result.out).toContain("FAKE CONTAINER LOG LINE");
  });

  it("should ping exactly as many times as it was told to", async () => {
    // Pins the readiness cap the same way the pull cap is pinned: read from
    // the environment, not a constant the loop ignores. Zero pings would mean
    // the wait never ran; more than the cap would mean it is not bounded.
    const result = await runScript("never_ready", {
      MYSQL_READY_ATTEMPTS: "2",
    });

    const pings = result.calls
      .split("\n")
      .filter(line => line.startsWith("exec ")).length;
    expect(result.code).not.toBe(0);
    expect(pings).toBe(2);
  });
});
