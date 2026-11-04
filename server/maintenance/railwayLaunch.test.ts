import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAIN_TIMEOUT_MS, readDrainTimeout } from "./config";

const startCommand = "NODE_ENV=production exec node dist/index.js";
const recipePath = new URL("../../railway.json", import.meta.url);

async function recipe(): Promise<unknown> {
  return JSON.parse(await readFile(recipePath, "utf8")) as unknown;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("launch_fixture_timeout")), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only this synthetic dist/index.js runs: no app imports, sockets or inherited keys. */
const fixtureSource = `
const scope = "synthetic_launch_only";
process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  process.stdout.write(JSON.stringify({
    event: "stopped", pid: process.pid, nodeEnv: process.env.NODE_ENV,
    scope, signal: "SIGTERM", handled: true, exitCode: 0
  }) + "\\n", () => process.exit(0));
});
const keepAlive = setInterval(() => {}, 1000);
process.stdout.write(JSON.stringify({
  event: "ready", pid: process.pid, nodeEnv: process.env.NODE_ENV, scope
}) + "\\n");
`;

async function assertSyntheticLaunch(sourceNodeEnv: "test" | "development"): Promise<void> {
  // Refuse a changed recipe BEFORE executing anything, not after a shell effect.
  const settings = await recipe();
  expect(settings).toMatchObject({ deploy: { startCommand } });
  const folder = await mkdtemp(join(tmpdir(), "railway-launch-fixture-"));
  try {
    await mkdir(join(folder, "dist"));
    await writeFile(join(folder, "dist", "index.js"), fixtureSource);
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: folder,
      LANG: "C", LC_ALL: "C", TMPDIR: folder, NODE_ENV: sourceNodeEnv, CI: "true",
    };
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "LANG", "LC_ALL", "NODE_ENV", "PATH", "TMPDIR"]);
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", startCommand], {
      cwd: folder, env, stdio: ["ignore", "pipe", "ignore"],
    });
    let closed = false;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    let output = "";
    const ready = new Promise<unknown>((resolve, reject) => {
      child.once("error", () => reject(new Error("launch_fixture_spawn_failed")));
      child.stdout.on("error", () => reject(new Error("launch_fixture_stdout_failed")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 4_096) {
          reject(new Error("launch_fixture_output_too_large"));
          return;
        }
        const newline = output.indexOf("\n");
        if (newline >= 0) {
          try { resolve(JSON.parse(output.slice(0, newline)) as unknown); }
          catch { reject(new Error("launch_fixture_invalid_metadata")); }
        }
      });
    });
    try {
      expect(await bounded(Promise.race([
        ready,
        exit.then(() => { throw new Error("launch_fixture_exited_before_ready"); }),
      ]))).toEqual({ event: "ready", pid: child.pid, nodeEnv: "production", scope: "synthetic_launch_only" });
      expect(child.pid).toBeGreaterThan(0);
      // Same PID proves bash was replaced by Node; signal only our owned fixture.
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await bounded(exit)).toEqual({ code: 0, signal: null });
      const lines = output.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]) as unknown).toEqual({
        event: "stopped", pid: child.pid, nodeEnv: "production", scope: "synthetic_launch_only",
        signal: "SIGTERM", handled: true, exitCode: 0,
      });
    } finally {
      if (!closed) child.kill("SIGKILL");
      await bounded(exit); // Await exit even when readiness or an assertion failed.
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("when the Railway deployment recipe is reviewed", () => {
  it("should pin direct exec, 120-second draining and zero overlap while preserving every other setting", async () => {
    expect(await recipe()).toEqual({
      $schema: "https://railway.com/railway.schema.json",
      build: { builder: "NIXPACKS", buildCommand: "pnpm build" },
      deploy: {
        preDeployCommand: "pnpm db:migrate", startCommand,
        drainingSeconds: 120, overlapSeconds: 0,
        healthcheckPath: "/api/healthz", healthcheckTimeout: 120,
        restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10,
      },
    });
  });

  it("should retain a 90-second default below the host budget without guaranteeing configured drains fit", async () => {
    const settings = await recipe();
    expect(settings).toMatchObject({ deploy: { drainingSeconds: 120 } });
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(90_000);
    expect(readDrainTimeout(undefined)).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeLessThan(120_000);
    // Valid process overrides can exceed the recipe; ordering is not drain completion,
    // provider signal delivery, cluster quiescence or permission to freeze a database.
    expect(readDrainTimeout("300000")).toBeGreaterThan(120_000);
  });

  it("should leave startup-mode and process drain-timeout overrides out of the launcher", async () => {
    expect(await recipe()).toMatchObject({ deploy: { startCommand } });
    expect(startCommand).not.toContain("RECONCILEAI_STARTUP_MODE");
    expect(startCommand).not.toContain("RECONCILEAI_DRAIN_TIMEOUT_MS");
  });
});

describe("when the exact Railway shell launcher runs only a synthetic Node fixture", () => {
  it.each(["test", "development"] as const)(
    "should replace the shell PID, override source NODE_ENV=%s and handle SIGTERM with a clean exit",
    async sourceNodeEnv => { await assertSyntheticLaunch(sourceNodeEnv); },
    12_000,
  );
});
