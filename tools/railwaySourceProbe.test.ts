/**
 * The Railway source probe (tools/railway-source-probe/fixture) is copied into
 * its own small repository for a separate, non-production Railway project; see
 * that folder's README for the test it serves. These tests prove, before anyone
 * creates that project, that the probe:
 *
 * - reports its source marker, its build time and Railway's commit, branch,
 *   deployment and snapshot identifiers, in its start log and at GET /;
 * - echoes PROBE_VARIABLE only when it is a dummy marker such as `v2`;
 * - reads no other environment variable and makes no outbound connection, so
 *   it cannot print or send a secret even if one is set on its service;
 * - stops cleanly on SIGTERM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE = path.resolve(__dirname, "railway-source-probe/fixture");
const SOURCES = ["server.mjs", "build.mjs"];
const ALLOWED_ENV = new Set([
  "PORT",
  "PROBE_VARIABLE",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_GIT_BRANCH",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_SNAPSHOT_ID",
]);
const RAILWAY_IDS = {
  RAILWAY_GIT_COMMIT_SHA: "d0beb8f5c55b36df7d674d55965a23b8d54ad69b",
  RAILWAY_GIT_BRANCH: "main",
  RAILWAY_DEPLOYMENT_ID: "deployment-1",
  RAILWAY_SNAPSHOT_ID: "snapshot-1",
};
/** Stands in for a real credential someone might set on the service by mistake. */
const SECRET = "sk-ant-api03-not-a-real-key";

type Running = { child: ChildProcess; port: number; output: () => string; exit: Promise<number | null> };

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A copy of the fixture, so its build step never writes into the repository. */
function copyFixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "railway-source-probe-"));
  temporaryDirectories.push(directory);
  cpSync(FIXTURE, directory, { recursive: true });
  return directory;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Start the probe with exactly this environment: nothing is inherited but PATH. */
async function start(directory: string, env: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (!output.includes("[probe] start")) {
    if (Date.now() > deadline) throw new Error(`probe did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, port, output: () => output, exit };
}

function build(directory: string): void {
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: directory, env: { PATH: process.env.PATH ?? "" } });
  expect(result.status).toBe(0);
}

describe("when the probe starts after its build step", () => {
  it("should report the marker, the build time and Railway's identifiers, in its log and at GET /", async () => {
    const directory = copyFixture();
    build(directory);
    const builtAt = JSON.parse(readFileSync(path.join(directory, "build-info.json"), "utf8")).builtAt;
    const probe = await start(directory, { ...RAILWAY_IDS, PROBE_VARIABLE: "v2" });

    const report = await (await fetch(`http://127.0.0.1:${probe.port}/`)).json();

    expect(report).toMatchObject({
      marker: "main-1",
      builtAt,
      probeVariable: "v2",
      railwayCommit: RAILWAY_IDS.RAILWAY_GIT_COMMIT_SHA,
      railwayBranch: "main",
      railwayDeployment: "deployment-1",
      railwaySnapshot: "snapshot-1",
    });
    expect(Object.keys(report).sort()).toEqual(
      ["builtAt", "marker", "probeVariable", "railwayBranch", "railwayCommit", "railwayDeployment", "railwaySnapshot", "startedAt"].sort(),
    );
    expect(probe.output()).toContain(
      `[probe] start marker=main-1 builtAt=${builtAt} probeVariable=v2 railwayCommit=${RAILWAY_IDS.RAILWAY_GIT_COMMIT_SHA} railwayBranch=main`,
    );
  });

  it("should say when the build step did not run, and when Railway set no identifiers", async () => {
    const probe = await start(copyFixture(), {});
    const report = await (await fetch(`http://127.0.0.1:${probe.port}/`)).json();
    expect(report).toMatchObject({ builtAt: "not built", probeVariable: "unset", railwayCommit: "unset", railwayBranch: "unset" });
  });
});

describe("when a real-looking value is set on the service", () => {
  it("should not echo a PROBE_VARIABLE that is not a dummy marker", async () => {
    const probe = await start(copyFixture(), { PROBE_VARIABLE: SECRET });
    const body = await (await fetch(`http://127.0.0.1:${probe.port}/`)).text();
    expect(JSON.parse(body).probeVariable).toBe("set (not shown)");
    expect(body + probe.output()).not.toContain(SECRET);
  });

  it("should never print or serve any other variable", async () => {
    const probe = await start(copyFixture(), { ...RAILWAY_IDS, DIRECT_LLM_API_KEY: SECRET, DATABASE_URL: `mysql://u:${SECRET}@h/db` });
    const body = await (await fetch(`http://127.0.0.1:${probe.port}/`)).text();
    expect(body + probe.output()).not.toContain(SECRET);
  });
});

describe("when the probe is asked for anything else, or told to stop", () => {
  it("should answer only GET / and GET /healthz", async () => {
    const probe = await start(copyFixture(), {});
    expect((await fetch(`http://127.0.0.1:${probe.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${probe.port}/env`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${probe.port}/`, { method: "POST" })).status).toBe(405);
  });

  it("should log its stop and exit 0 on SIGTERM", async () => {
    const probe = await start(copyFixture(), { ...RAILWAY_IDS });
    probe.child.kill("SIGTERM");
    expect(await probe.exit).toBe(0);
    expect(probe.output()).toContain("[probe] stop signal=SIGTERM marker=main-1");
  });
});

describe("when the probe's source is read", () => {
  const source = SOURCES.map((file) => readFileSync(path.join(FIXTURE, file), "utf8")).join("\n");

  it("should import only node:fs and node:http, so it opens no outbound connection", () => {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).sort();
    expect([...new Set(imports)]).toEqual(["node:fs", "node:http"]);
    expect(source).not.toMatch(/\bfetch\s*\(|\brequest\s*\(|\bimport\s*\(|\brequire\s*\(/);
  });

  it("should read only its allow-listed environment variables", () => {
    // Every use of process.env is either `.NAME` or the one computed lookup in
    // railway(name); a bare process.env (logged, spread, iterated) fails here.
    const uses = [...source.matchAll(/process\.env(?:\.([A-Z_]+)|\[(\w+)\])?/g)];
    for (const [use, name, computed] of uses) {
      expect(name !== undefined || computed === "name", `bare or unexpected use: ${use}`).toBe(true);
      if (name !== undefined) expect(ALLOWED_ENV.has(name), name).toBe(true);
    }
    expect(uses.filter(([, , computed]) => computed === "name")).toHaveLength(1);
    const viaRailway = [...source.matchAll(/railway\("([A-Z_]+)"\)/g)].map((match) => match[1]);
    expect(viaRailway.length).toBeGreaterThan(0);
    for (const name of viaRailway) expect(ALLOWED_ENV.has(name), name).toBe(true);
  });

  it("should have no dependencies, a lockfile, and only build and start scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(FIXTURE, "package.json"), "utf8"));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "start"]);
    const lock = JSON.parse(readFileSync(path.join(FIXTURE, "package-lock.json"), "utf8"));
    expect(Object.keys(lock.packages)).toEqual([""]);
    expect(existsSync(path.join(FIXTURE, "railway.json"))).toBe(false);
    expect(existsSync(path.join(FIXTURE, "railway.toml"))).toBe(false);
    expect(existsSync(path.join(FIXTURE, "Dockerfile"))).toBe(false);
  });
});
