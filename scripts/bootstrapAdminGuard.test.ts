/**
 * bootstrap-admin mints a super_admin and prints a working sign-in link, and its
 * only input is DATABASE_URL — which in this repo's local .env is production.
 *
 * These run the real script as a subprocess rather than testing a copy of its
 * logic, because the property that matters is about the script as invoked:
 * it must refuse, and it must refuse WITHOUT opening a connection.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "bootstrap-admin.mjs");

/** An address that cannot connect, so a connection ATTEMPT is distinguishable. */
const UNREACHABLE = "mysql://u:p@203.0.113.1:3306/x"; // TEST-NET-3, RFC 5737

async function runGuard(env: Record<string, string | undefined>) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [SCRIPT, "--email", "attacker@example.com", "--name", "X"],
      { env: { ...process.env, DEPLOYMENT_MODE: undefined, ...env }, timeout: 20_000 },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("when bootstrap-admin is run outside an on-premise deployment", () => {
  it("should refuse, because DEPLOYMENT_MODE defaults to cloud", async () => {
    // The accident this prevents: `pnpm bootstrap:admin` from a developer's
    // checkout, whose .env holds the production DATABASE_URL, granting
    // platform-wide admin on the live product and printing the credential.
    const { code, out } = await runGuard({ DATABASE_URL: UNREACHABLE });
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSING");
  }, 30_000);

  it("should refuse without opening a database connection", async () => {
    // Ordering is the point: a refusal must not reach a production socket. The
    // URL is unroutable, so a connection attempt would surface as a timeout or
    // ECONNREFUSED instead of our refusal.
    const { out } = await runGuard({ DATABASE_URL: UNREACHABLE });
    expect(out).toContain("No database connection was opened.");
    expect(out).not.toMatch(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect /i);
  }, 30_000);

  it("should refuse an unrecognised DEPLOYMENT_MODE rather than assume it is on-prem", async () => {
    // Fails closed. "on-premise", "onprem" and a typo are all not the signal.
    for (const mode of ["cloud", "on-premise", "onprem", "production", ""]) {
      const { code } = await runGuard({ DEPLOYMENT_MODE: mode, DATABASE_URL: UNREACHABLE });
      expect(code, `DEPLOYMENT_MODE=${JSON.stringify(mode)} must be refused`).not.toBe(0);
    }
  }, 60_000);

  it("should name the documented on-prem invocation in the refusal", async () => {
    // A refusal that does not say what to do instead gets worked around.
    const { out } = await runGuard({ DATABASE_URL: UNREACHABLE });
    expect(out).toContain("DEPLOYMENT_MODE=on_premise");
    expect(out).toContain("docker compose");
  }, 30_000);
});

describe("when bootstrap-admin is run on an on-premise deployment", () => {
  it("should get past the guard and attempt its work", async () => {
    // The guard must not break the one workflow it exists to allow. With the
    // signal present it proceeds to the connection — which fails here, because
    // the address is unroutable, and that failure IS the proof it got through.
    const { code, out } = await runGuard({
      DEPLOYMENT_MODE: "on_premise",
      DATABASE_URL: UNREACHABLE,
    });
    expect(code).not.toBe(0); // no database in the test environment
    expect(out).not.toContain("REFUSING");
  }, 30_000);

  it("should accept the signal whatever the casing", async () => {
    const { out } = await runGuard({ DEPLOYMENT_MODE: "On_Premise", DATABASE_URL: UNREACHABLE });
    expect(out).not.toContain("REFUSING");
  }, 30_000);
});
