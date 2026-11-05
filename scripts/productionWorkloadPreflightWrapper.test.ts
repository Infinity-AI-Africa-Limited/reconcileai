/**
 * production-workload-preflight.sh is the routine an operator runs inside the
 * production container. These tests run it, under dash and bash, with a
 * stand-in curl and a stand-in probe, to show that it:
 *   - checks its arguments, tools and application directory before it
 *     downloads anything;
 *   - downloads into a private directory of its own, never a fixed path, and
 *     touches no other file;
 *   - runs only bytes whose SHA-256 matches the pin, read once;
 *   - passes the probe's exit status through, and bounds the probe's run;
 *   - removes its directory on success, on failure and when interrupted.
 * And that its pin names the committed probe.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPORT_SCHEMA, isPlaceholderIdentifier, parseArgs } from "./production-workload-preflight.mjs";

const WRAPPER = path.resolve(__dirname, "production-workload-preflight.sh");
const PROBE = path.resolve(__dirname, "production-workload-preflight.mjs");
const REPO = path.resolve(__dirname, "..");
const source = readFileSync(WRAPPER, "utf8");

/** One `readonly NAME=value` line of the routine. */
const CONSTANT = (name: string) => new RegExp(`^(  readonly ${name}=)("[^"\\n]*"|\\d+)$`, "m");

function constant(name: string): string {
  const match = CONSTANT(name).exec(source);
  if (!match) throw new Error(`constant_missing:${name}`);
  return match[2].replace(/^"|"$/g, "");
}

/** The loader's JavaScript, as the routine hands it to node. */
const LOADER = (() => {
  const match = /^ {2}readonly LOADER='([^']*)'$/m.exec(source);
  if (!match) throw new Error("loader_missing");
  return match[1];
})();

/** The routine with some constants replaced. Each must appear exactly once. */
function wrapperWith(overrides: Record<string, string>): string {
  let text = source;
  for (const [name, value] of Object.entries(overrides)) {
    expect([...text.matchAll(new RegExp(CONSTANT(name).source, "gm"))], name).toHaveLength(1);
    text = text.replace(CONSTANT(name), `$1${/^\d+$/.test(value) ? value : `"${value}"`}`);
  }
  return text;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const randomCommit = () => {
  for (;;) {
    const value = randomBytes(20).toString("hex");
    if (!isPlaceholderIdentifier(value)) return value;
  }
};
const DEPLOYMENT = "5e773d16-4f8a-4c2b-9d1e-7a3b6c0f2e91";
const COMMIT = randomCommit();

/** The stand-in probe: records how it was run, then reports, or hangs. */
const STUB_PROBE = `
import { appendFileSync, statSync } from "node:fs";
import path from "node:path";
export async function main(args) {
  const file = process.argv[1];
  const log = (entry) => appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + "\\n");
  log({ args, cwd: process.cwd(), pid: process.pid, dirMode: (statSync(path.dirname(file)).mode & 0o777).toString(8), fileMode: (statSync(file).mode & 0o777).toString(8) });
  const behaviour = process.env.STUB_BEHAVIOUR ?? "report";
  if (behaviour === "hang" || behaviour === "hang_ignoring_term") {
    process.on("SIGTERM", () => {
      if (behaviour === "hang") {
        log({ terminated: true });
        process.exit(5);
      }
    });
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write('{"stub":true}\\nVERDICT: zero_observed_not_proof\\n');
  process.exit(Number(process.env.STUB_EXIT ?? "0"));
}
`;

/** curl's stand-in: logs its arguments, then copies FAKE_CURL_SOURCE to --output, or fails. */
const FAKE_CURL = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
out=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --output) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "\${FAKE_CURL_FAIL:-}" ]; then exit 22; fi
cat -- "$FAKE_CURL_SOURCE" > "$out"
`;

type Sandbox = {
  root: string;
  tmp: string;
  bin: string;
  app: string;
  probe: string;
  wrapper: string;
  curlLog: string;
  stubLog: string;
};

const sandboxes: string[] = [];
afterAll(() => {
  for (const root of sandboxes) {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh world: TMPDIR, a curl on PATH, an application directory and the stand-in probe. */
function sandbox(options: { overrides?: Record<string, string>; app?: "complete" | "unbuilt" | "no_drivers"; probe?: string } = {}): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "preflight-wrapper-"));
  sandboxes.push(root);
  const tmp = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  const app = path.join(root, "app");
  for (const dir of [tmp, bin, app]) mkdirSync(dir);
  writeFileSync(path.join(bin, "curl"), FAKE_CURL);
  chmodSync(path.join(bin, "curl"), 0o755);

  const kind = options.app ?? "complete";
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "stand-in-app", private: true }));
  if (kind !== "unbuilt") {
    mkdirSync(path.join(app, "dist"));
    writeFileSync(path.join(app, "dist", "index.js"), "");
  }
  if (kind !== "no_drivers") {
    for (const [name, file] of [["mysql2", "promise.js"], ["bullmq", "index.js"]]) {
      mkdirSync(path.join(app, "node_modules", name), { recursive: true });
      writeFileSync(path.join(app, "node_modules", name, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
      writeFileSync(path.join(app, "node_modules", name, file), "");
    }
  }

  const probe = path.join(root, "probe-served.mjs");
  writeFileSync(probe, options.probe ?? STUB_PROBE);
  const wrapper = path.join(root, "wrapper.sh");
  writeFileSync(wrapper, wrapperWith({ PROBE_COMMIT: COMMIT, PROBE_SHA256: sha256(STUB_PROBE), ...options.overrides }));
  return { root, tmp, bin, app, probe, wrapper, curlLog: path.join(root, "curl.log"), stubLog: path.join(root, "stub.log") };
}

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** Sources the routine in `shell` and calls it with `args`; `whileRunning` may signal it. */
function runWrapper(
  box: Sandbox,
  args: string[],
  options: { shell?: string; env?: Record<string, string>; path?: string; whileRunning?: (pid: number) => Promise<void> } = {},
): Promise<Run> {
  const script = '. "$0"; reconcileai_preflight "$@"; status=$?; printf "after:%s:%s\\n" "${workdir-unset}" "${PROBE_SHA256-unset}" >&2; exit $status';
  return new Promise((resolve, reject) => {
    const child = spawn(options.shell ?? "/bin/sh", ["-c", script, box.wrapper, ...args], {
      cwd: box.root,
      detached: true,
      env: {
        PATH: options.path ?? `${box.bin}:${process.env.PATH ?? ""}`,
        HOME: box.root,
        TMPDIR: box.tmp,
        FAKE_CURL_SOURCE: box.probe,
        FAKE_CURL_LOG: box.curlLog,
        STUB_LOG: box.stubLog,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    if (options.whileRunning && child.pid) void options.whileRunning(child.pid);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const stubRuns = (box: Sandbox) =>
  existsSync(box.stubLog) ? readFileSync(box.stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
const curlCalls = (box: Sandbox) => (existsSync(box.curlLog) ? readFileSync(box.curlLog, "utf8").split("\n").filter(Boolean) : []);
const leftovers = (box: Sandbox) => readdirSync(box.tmp).filter((name) => name.startsWith("reconcileai-preflight."));
const failure = (run: Run) => /PREFLIGHT_WRAPPER: (\w+)/.exec(run.stderr)?.[1];

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A process's parent, from /proc. */
const parentOf = (pid: number) => Number(/^PPid:\s*(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);

const SHELLS = ["/bin/sh", "/bin/bash"].filter((shell) => existsSync(shell));

// ─── The pin ─────────────────────────────────────────────────────────────────

describe("when the routine's pin is compared with the committed probe", () => {
  it("should name the committed probe's exact bytes", () => {
    expect(constant("PROBE_SHA256")).toBe(sha256(readFileSync(PROBE)));
    expect(constant("PROBE_SHA256")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should pin a full commit, on the authoritative repository, over HTTPS", () => {
    const commit = constant("PROBE_COMMIT");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(isPlaceholderIdentifier(commit)).toBe(false);
    expect(constant("PROBE_URL")).toBe(
      "https://raw.githubusercontent.com/Infinity-AI-Africa-Limited/reconcileai/${PROBE_COMMIT}/scripts/production-workload-preflight.mjs",
    );
  });

  it("should pin a commit whose probe has these bytes, where the commit is in this checkout", () => {
    const commit = constant("PROBE_COMMIT");
    let pinned: Buffer;
    try {
      pinned = execFileSync("git", ["show", `${commit}:scripts/production-workload-preflight.mjs`], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // A shallow checkout (CI's) may not hold the pinned commit.
      return;
    }
    expect(sha256(pinned)).toBe(constant("PROBE_SHA256"));
  });

  it("should run the probe with options it accepts, under the same report schema", () => {
    const budget = constant("BUDGET_SECONDS");
    expect(() => parseArgs(["--samples", constant("SAMPLES"), "--interval-seconds", constant("INTERVAL_SECONDS"), "--budget-seconds", budget])).not.toThrow();
    expect(LOADER).toContain(`schema: "${REPORT_SCHEMA}"`);
  });
});

// ─── Runs ────────────────────────────────────────────────────────────────────

describe("when the routine runs", () => {
  it.each(SHELLS)("should run the verified probe from a private directory, then remove it (%s)", async (shell) => {
    const box = sandbox();
    // Left by an earlier command block, or by another run: neither is read or removed.
    writeFileSync(path.join(box.tmp, "preflight.mjs"), "stale");
    mkdirSync(path.join(box.tmp, "reconcileai-preflight.someoneelse"));
    writeFileSync(path.join(box.tmp, "reconcileai-preflight.someoneelse", "probe.mjs"), "other run");

    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { shell });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('{"stub":true}\nVERDICT: zero_observed_not_proof\n');
    expect(failure(run)).toBeUndefined();

    const [started] = stubRuns(box);
    expect(started.args).toEqual([
      "--env-from-app", "--expect-deployment", DEPLOYMENT, "--expect-commit", COMMIT,
      "--samples", "3", "--interval-seconds", "60", "--budget-seconds", "300",
    ]);
    expect(started.cwd).toBe(box.app);
    // Its own directory, closed to everyone else, and the code read-only.
    expect(started).toMatchObject({ dirMode: "500", fileMode: "400" });

    const [call] = curlCalls(box);
    expect(call.startsWith("-q --fail --silent --proto =https --tlsv1.2 --max-time 60 --output ")).toBe(true);
    expect(call.endsWith(` -- https://raw.githubusercontent.com/Infinity-AI-Africa-Limited/reconcileai/${COMMIT}/scripts/production-workload-preflight.mjs`)).toBe(true);

    expect(leftovers(box)).toEqual(["reconcileai-preflight.someoneelse"]);
    expect(readFileSync(path.join(box.tmp, "preflight.mjs"), "utf8")).toBe("stale");
    expect(readFileSync(path.join(box.tmp, "reconcileai-preflight.someoneelse", "probe.mjs"), "utf8")).toBe("other run");
    // Scoped: none of the routine's variables reach the caller's shell.
    expect(run.stderr).toContain("after:unset:unset");
  }, 60_000);

  it.each([0, 2, 3, 4, 5])("should exit with the probe's own status, %i", async (status) => {
    const box = sandbox();
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { env: { STUB_EXIT: String(status) } });
    expect(run.code).toBe(status);
    expect(failure(run)).toBeUndefined();
    expect(leftovers(box)).toEqual([]);
  }, 60_000);
});

describe("when the routine must stop before running anything", () => {
  it("should refuse bytes that do not match the pin, and run none of them", async () => {
    const box = sandbox({ probe: `${STUB_PROBE}\n// one changed byte\n` });
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app]);
    expect(run.code).toBe(16);
    expect(failure(run)).toBe("checksum_mismatch");
    expect(stubRuns(box)).toEqual([]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it("should stop when the download fails", async () => {
    const box = sandbox();
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { env: { FAKE_CURL_FAIL: "1" } });
    expect(run.code).toBe(15);
    expect(failure(run)).toBe("download_failed");
    expect(stubRuns(box)).toEqual([]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it.each([
    ["unbuilt", "app_dir_invalid"],
    ["no_drivers", "app_dependencies_missing"],
  ] as const)("should refuse an application directory that is %s, before downloading", async (kind, code) => {
    const box = sandbox({ app: kind });
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app]);
    expect(run.code).toBe(13);
    expect(failure(run)).toBe(code);
    expect(curlCalls(box)).toEqual([]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it("should refuse a missing directory as well", async () => {
    const box = sandbox();
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, path.join(box.root, "absent")]);
    expect([run.code, failure(run)]).toEqual([13, "app_dir_invalid"]);
  }, 60_000);

  it.each([
    [["5e773d16", COMMIT], 12, "expected_deployment_malformed"],
    [["<deployment-id>", COMMIT], 12, "expected_deployment_malformed"],
    [[DEPLOYMENT.toUpperCase(), COMMIT], 12, "expected_deployment_malformed"],
    [[DEPLOYMENT, COMMIT.slice(0, 7)], 12, "expected_commit_malformed"],
    [[DEPLOYMENT], 10, "usage"],
    [[DEPLOYMENT, COMMIT, "/app", "extra"], 10, "usage"],
  ] as const)("should refuse %j before downloading", async (args, status, code) => {
    const box = sandbox();
    const run = await runWrapper(box, [...args]);
    expect([run.code, failure(run)]).toEqual([status, code]);
    expect(curlCalls(box)).toEqual([]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it("should refuse when a tool it needs is missing", async () => {
    const box = sandbox();
    // Every tool but curl.
    const tools = path.join(box.root, "tools");
    mkdirSync(tools);
    for (const name of ["node", "sha256sum", "mktemp", "timeout", "chmod", "rm", "true", "cat", "sh", "dash", "bash"]) {
      const found = (process.env.PATH ?? "").split(":").map((dir) => path.join(dir, name)).find((file) => existsSync(file));
      if (found) symlinkSync(found, path.join(tools, name));
    }
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { path: tools });
    expect([run.code, failure(run)]).toEqual([11, "missing_curl"]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);
});

describe("when the probe is bounded or the routine interrupted", () => {
  const short = { BUDGET_SECONDS: "1", HARD_LIMIT_MARGIN_SECONDS: "1", KILL_AFTER_SECONDS: "1" };

  it("should stop a probe that outlasts the time limit, and say so", async () => {
    const box = sandbox({ overrides: short });
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { env: { STUB_BEHAVIOUR: "hang" } });
    expect([run.code, failure(run)]).toEqual([124, "probe_time_limit"]);
    expect(stubRuns(box).at(-1)).toEqual({ terminated: true });
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it("should kill a probe that ignores the stop signal", async () => {
    const box = sandbox({ overrides: short });
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], { env: { STUB_BEHAVIOUR: "hang_ignoring_term" } });
    expect([run.code, failure(run)]).toEqual([137, "probe_time_limit"]);
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it("should stop the probe and clean up on Ctrl-C", async () => {
    const box = sandbox();
    let probePid = 0;
    const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], {
      // Ctrl-C reaches the terminal's foreground process group: the shells.
      shell: "/bin/bash",
      env: { STUB_BEHAVIOUR: "hang" },
      whileRunning: async (group) => {
        await until(() => stubRuns(box).length > 0);
        probePid = Number(stubRuns(box)[0].pid);
        process.kill(-group, "SIGINT");
      },
    });
    expect([run.code, failure(run)]).toEqual([17, "interrupted"]);
    expect(stubRuns(box).at(-1)).toEqual({ terminated: true });
    expect(() => process.kill(probePid, 0)).toThrow();
    expect(leftovers(box)).toEqual([]);
  }, 60_000);

  it.each(SHELLS.flatMap((shell) => (["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, shell] as const)))(
    "should stop the probe and clean up on %s (%s)",
    async (signal, shell) => {
      const box = sandbox();
      const run = await runWrapper(box, [DEPLOYMENT, COMMIT, box.app], {
        shell,
        env: { STUB_BEHAVIOUR: "hang" },
        whileRunning: async () => {
          await until(() => stubRuns(box).length > 0);
          // node's parent is `timeout`; its parent is the routine's subshell.
          const routine = parentOf(parentOf(Number(stubRuns(box)[0].pid)));
          process.kill(routine, signal);
        },
      });
      expect([run.code, failure(run)]).toEqual([17, "interrupted"]);
      expect(stubRuns(box).at(-1)).toEqual({ terminated: true });
      expect(leftovers(box)).toEqual([]);
    },
    60_000,
  );
});

// ─── The loader: what node actually runs ─────────────────────────────────────

describe("when the loader is handed a file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-loader-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const load = (file: string, expected: string, ...args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", LOADER, "--", file, expected, ...args], {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });

  it("should run nothing whose bytes differ from the expected hash, even after a check passed elsewhere", async () => {
    const marker = path.join(dir, "ran");
    const file = path.join(dir, "replaced.mjs");
    // A file replaced after the routine's own check: it would leave a marker if run.
    writeFileSync(file, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export async function main() {}`);
    const result = await load(file, sha256(STUB_PROBE));
    expect(result.code).toBe(16);
    expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "probe_checksum_mismatch" });
    expect(existsSync(marker)).toBe(false);
  });

  it("should refuse a file it cannot read, and a module without the probe's entry point", async () => {
    expect(await load(path.join(dir, "absent.mjs"), sha256(STUB_PROBE))).toEqual({
      code: 16,
      stdout: `${JSON.stringify({ schema: REPORT_SCHEMA, error: "probe_unreadable" })}\n`,
    });
    const file = path.join(dir, "no-main.mjs");
    writeFileSync(file, "export const nothing = true;");
    const result = await load(file, sha256(readFileSync(file)));
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "probe_load_failed" });
  });

  it("should run the real probe's own entry point, which refuses an unproven target before anything else", async () => {
    // Not the stand-in: the committed probe, through the loader, as the routine runs it.
    const result = await load(PROBE, sha256(readFileSync(PROBE)), "--samples", "1");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toEqual({ schema: REPORT_SCHEMA, error: "identity_expected_deployment_missing" });
  });
});
