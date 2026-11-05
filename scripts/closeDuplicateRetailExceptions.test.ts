/**
 * close-duplicate-retail-exceptions dismisses exception rows, and the
 * DATABASE_URL a maintainer has exported is usually production's. These run
 * the real script as a subprocess, like bootstrapAdminGuard.test.ts, because
 * the property is about the script as invoked: a bad invocation must stop
 * before any database code is even loaded.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "close-duplicate-retail-exceptions.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
/** An address that cannot connect: a run that tried would hang, not exit 2. */
const UNREACHABLE = "mysql://u:p@203.0.113.1:3306/x"; // TEST-NET-3, RFC 5737
const RUN_TIMEOUT_MS = 30_000;

async function runScript(args: string[], env: Record<string, string | undefined>) {
  try {
    const { stdout, stderr } = await run(process.execPath, [TSX, SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: undefined, ...env },
      timeout: RUN_TIMEOUT_MS,
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") + (e.killed ? "\n[killed]" : "") };
  }
}

describe("when the script is invoked with an argument it does not know", () => {
  it("should refuse before connecting, so a misspelt --org cannot widen a commit to every tenant", async () => {
    const { code, out } = await runScript(["--orgs", "5", "--commit"], { DATABASE_URL: UNREACHABLE });
    expect(code).toBe(2);
    expect(out).toContain('Unknown argument "--orgs"');
    expect(out).not.toContain("Target:");
  }, RUN_TIMEOUT_MS + 10_000);

  it.each([["0"], ["abc"], ["-1"], [""]])("should refuse --org %j", async (value) => {
    const { code, out } = await runScript(["--org", value, "--commit"], { DATABASE_URL: UNREACHABLE });
    expect(code).toBe(2);
    expect(out).toContain("--org needs a tenant id");
  }, RUN_TIMEOUT_MS + 10_000);
});

describe("when DATABASE_URL is not exported", () => {
  it("should refuse rather than fall back to a .env file", async () => {
    const { code, out } = await runScript(["--commit"], {});
    expect(code).toBe(2);
    expect(out).toContain("does not read .env");
  }, RUN_TIMEOUT_MS + 10_000);
});
