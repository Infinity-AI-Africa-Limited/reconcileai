import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildRuntimePreparation } from "./buildRuntimePreparation.mjs";

describe("when the separate runtime library is prepared offline", () => {
  it("should keep the vendored CLI separate and expose a refusing default entrypoint", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "observer-runtime-artifact-test-")
    );
    try {
      const result = await buildRuntimePreparation(directory);
      expect(result.hold).toBe(true);
      expect(result.liveEnabled).toBe(false);
      const library = await readFile(
        join(directory, "runtimeLibrary.mjs"),
        "utf8"
      );
      expect(library).toContain("./vendor/production-workload-preflight.mjs");
      expect(library).not.toContain("SELECT VERSION()");
      expect(library).not.toContain("process.argv.slice(2)");
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      const refused = spawnSync(
        process.execPath,
        [join(directory, "refuseLive.mjs")],
        { env, encoding: "utf8", timeout: 3000 }
      );
      expect(refused.status).toBe(2);
      expect(refused.stderr).toBe("");
      expect(refused.stdout).toBe(
        '{"schema":"observer_runtime_preparation","hold":true,"liveEnabled":false}\n'
      );
      // Importing the library must not invoke the preserved original main.
      const imported = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m=await import(${JSON.stringify("file://" + join(directory, "runtimeLibrary.mjs"))});process.stdout.write(String(typeof m.openRuntimeReaders)+":"+String(typeof m.inspectPlatformIdentity));`,
        ],
        { env, encoding: "utf8", timeout: 5000 }
      );
      expect(imported.status).toBe(0);
      expect(imported.stderr).toBe("");
      expect(imported.stdout).toBe("function:function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
