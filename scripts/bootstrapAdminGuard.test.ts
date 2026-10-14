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

/** How long one run of the script may take before it is killed. */
const RUN_TIMEOUT_MS = 20_000;

/**
 * A case's ceiling must outlast every run it makes, so the run's timeout fires
 * before vitest's. Then a hung run still returns what the script printed, plus
 * a note that it was killed; the other way round, all that survives is "Test
 * timed out".
 */
const ceilingFor = (runs: number) => runs * RUN_TIMEOUT_MS + 10_000;

/** Every DEPLOYMENT_MODE that is not the on-prem signal. */
const NOT_ON_PREM = ["cloud", "on-premise", "onprem", "production", ""];

async function runGuard(env: Record<string, string | undefined>) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [SCRIPT, "--email", "attacker@example.com", "--name", "X"],
      { env: { ...process.env, DEPLOYMENT_MODE: undefined, ...env }, timeout: RUN_TIMEOUT_MS },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const killed = e.killed ? `\n[killed by the test after ${RUN_TIMEOUT_MS}ms (${e.signal})]` : "";
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") + killed };
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
  }, ceilingFor(1));

  it("should refuse without opening a database connection", async () => {
    // Ordering is the point: a refusal must not reach a production socket. The
    // URL is unroutable, so a connection attempt would surface as a timeout or
    // ECONNREFUSED instead of our refusal.
    const { out } = await runGuard({ DATABASE_URL: UNREACHABLE });
    expect(out).toContain("No database connection was opened.");
    expect(out).not.toMatch(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect /i);
  }, ceilingFor(1));

  it("should refuse an unrecognised DEPLOYMENT_MODE rather than assume it is on-prem", async () => {
    // Fails closed. "on-premise", "onprem" and a typo are all not the signal.
    for (const mode of NOT_ON_PREM) {
      const { code } = await runGuard({ DEPLOYMENT_MODE: mode, DATABASE_URL: UNREACHABLE });
      expect(code, `DEPLOYMENT_MODE=${JSON.stringify(mode)} must be refused`).not.toBe(0);
    }
  }, ceilingFor(NOT_ON_PREM.length));

  it("should name the documented on-prem invocation in the refusal", async () => {
    // A refusal that does not say what to do instead gets worked around.
    const { out } = await runGuard({ DATABASE_URL: UNREACHABLE });
    expect(out).toContain("DEPLOYMENT_MODE=on_premise");
    expect(out).toContain("docker compose");
  }, ceilingFor(1));
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
  }, ceilingFor(1));

  it("should accept the signal whatever the casing", async () => {
    const { out } = await runGuard({ DEPLOYMENT_MODE: "On_Premise", DATABASE_URL: UNREACHABLE });
    expect(out).not.toContain("REFUSING");
  }, ceilingFor(1));
});
