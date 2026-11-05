/**
 * woodcore-sync.sh — the scheduled job that must turn red when the Woodcore
 * mirror sync fails.
 *
 * The server answers the POST with 202 before the sync does anything, so the
 * job's verdict comes entirely from what it reads while polling afterwards. A
 * healthy production run exercises only the happy path. These tests run the
 * REAL script against a fake server that plays the sync endpoint and GitHub's
 * token endpoint, so every failure the job exists to report is exercised on
 * every CI run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long one run of the script may take before it is killed. */
const SCRIPT_TIMEOUT_MS = 30_000;
// Looser than the kill timeout, so a stuck run fails on its own output (see
// startTestMysql.test.ts for why the order matters).
vi.setConfig({ testTimeout: SCRIPT_TIMEOUT_MS + 5_000 });

/** Forward slashes: bash reads this path on Windows too (Git Bash). */
const SCRIPT = path.resolve(__dirname, "woodcore-sync.sh").replace(/\\/g, "/");
const SYNC_PATH = "/api/woodcore/sync";

/**
 * Every variable the script reads, plus the proxy settings that would send
 * curl's requests for 127.0.0.1 somewhere else, scrubbed from the inherited
 * environment before each run.
 */
const INHERITED_KNOBS = [
  "SYNC_URL",
  "OIDC_AUDIENCE",
  "SYNC_SECRET",
  "SECRET_SOURCE",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "WOODCORE_SYNC_POLL_INTERVAL_SECONDS",
  "WOODCORE_SYNC_DEADLINE_SECONDS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

/**
 * jq reads the sync's status. GitHub's runners have it; a developer's Git Bash
 * may not. CI runs these whatever, so a runner without jq fails here loudly
 * instead of skipping.
 */
const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

type Reply = { status: number; body: unknown };
type Scenario = {
  /** The answer to the POST; `startedAt` is the time the fake stamped on it. */
  post?: (startedAt: string) => Reply;
  /** The answer to the nth GET (0-based). */
  get?: (n: number, startedAt: string) => Reply;
};
type Seen = { method: string; authorization?: string; secret?: string };

type TableResult = { mirror: string; status: "ok" | "skipped" | "error"; copied: number; reason?: string };

const table = (mirror: string, status: TableResult["status"], reason?: string): TableResult => ({
  mirror,
  status,
  copied: status === "ok" ? 1200 : 0,
  ...(reason ? { reason } : {}),
});

const BRIDGES_SKIPPED = [
  table("wc_acc_to_gl_journal_entry", "skipped", "database error (ER_TABLEACCESS_DENIED_ERROR)"),
  table("wc_acc_to_gl_journal_entry_savings", "skipped", "database error (ER_TABLEACCESS_DENIED_ERROR)"),
];

const running = (startedAt: string | null) => ({
  running: true,
  startedAt,
  finishedAt: null,
  durationMs: null,
  tables: [table("wc_acc_gl_account", "ok"), table("wc_m_loan", "ok")],
  error: null,
});

const finished = (startedAt: string | null, tables: TableResult[], error: string | null = null) => ({
  running: false,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs: 61_500,
  tables,
  error,
});

/** What the server shows after a restart: no run at all. */
const IDLE = { running: false, startedAt: null, finishedAt: null, durationMs: null, tables: [], error: null };

const ok = (body: unknown): Reply => ({ status: 200, body });

/** Started, ran twice, then finished with the given tables. */
const finishesWith =
  (tables: TableResult[], error: string | null = null): Scenario["get"] =>
  (n, startedAt) =>
    ok(n < 2 ? running(startedAt) : finished(startedAt, tables, error));

let server: http.Server | null = null;

afterEach(async () => {
  const closing = server;
  server = null;
  if (closing) await new Promise((resolve) => closing.close(resolve));
});

async function startFake(scenario: Scenario) {
  const seen: Seen[] = [];
  let startedAt = "";
  let gets = 0;
  let tokens = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (reply: Reply) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    };
    if (url.pathname === "/oidc") {
      tokens += 1;
      return send(ok({ count: tokens, value: `oidc-${tokens}` }));
    }
    if (url.pathname !== SYNC_PATH) return send({ status: 404, body: { error: "not found" } });
    seen.push({
      method: req.method ?? "",
      authorization: req.headers.authorization,
      secret: req.headers["x-sync-secret"] as string | undefined,
    });
    if (req.method === "POST") {
      startedAt = new Date().toISOString();
      return send(scenario.post?.(startedAt) ?? { status: 202, body: { started: true } });
    }
    send(scenario.get?.(gets++, startedAt) ?? ok(IDLE));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

type Result = { code: number; out: string; seen: Seen[] };

async function runScript(
  scenario: Scenario,
  { oidc = true, env = {} }: { oidc?: boolean; env?: Record<string, string> } = {},
): Promise<Result> {
  const fake = await startFake(scenario);
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const knob of INHERITED_KNOBS) delete inherited[knob];
  const childEnv: NodeJS.ProcessEnv = {
    ...inherited,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    SYNC_URL: `${fake.origin}${SYNC_PATH}`,
    OIDC_AUDIENCE: "https://reconcileai.test",
    ...(oidc
      ? {
          ACTIONS_ID_TOKEN_REQUEST_URL: `${fake.origin}/oidc?api-version=2.0`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
        }
      : {}),
    // Zero waits: what the loop decides matters, not how long it sleeps.
    WOODCORE_SYNC_POLL_INTERVAL_SECONDS: "0",
    WOODCORE_SYNC_DEADLINE_SECONDS: "60",
    ...env,
  };
  let code = 0;
  let out = "";
  try {
    const { stdout, stderr } = await run("bash", [SCRIPT], { env: childEnv, timeout: SCRIPT_TIMEOUT_MS });
    out = stdout + stderr;
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    code = typeof e.code === "number" ? e.code : 1;
    out = (e.stdout ?? "") + (e.stderr ?? "");
    if (e.killed) out += `\n[killed by the test after ${SCRIPT_TIMEOUT_MS}ms (${e.signal})]`;
  }
  return { code, out, seen: fake.seen };
}

const gets = (seen: Seen[]) => seen.filter((s) => s.method === "GET");

describe.runIf(hasJq || Boolean(process.env.CI))("woodcore-sync.sh", () => {
  describe("when the sync refreshes every table it may read", () => {
    it("should pass, and warn about the bridge tables it skipped", async () => {
      const result = await runScript({
        get: finishesWith([table("wc_acc_gl_account", "ok"), table("wc_m_loan", "ok"), ...BRIDGES_SKIPPED]),
      });

      expect(result.out).toContain("Woodcore mirror refreshed.");
      expect(result.out).toContain(
        "::warning::Skipped, and kept their previous data: wc_acc_to_gl_journal_entry, wc_acc_to_gl_journal_entry_savings.",
      );
      expect(result.out).not.toContain("::error::");
      expect(result.code).toBe(0);
    });

    it("should send a fresh OIDC token, and the secret, on every request", async () => {
      const result = await runScript(
        { get: finishesWith([table("wc_m_loan", "ok")]) },
        { env: { SYNC_SECRET: "test-secret", SECRET_SOURCE: "CRON_SECRET" } },
      );

      expect(result.code).toBe(0);
      expect(gets(result.seen)).toHaveLength(3);
      expect(result.seen.every((s) => s.secret === "test-secret")).toBe(true);
      const tokens = result.seen.map((s) => s.authorization);
      expect(tokens.every((t) => /^Bearer oidc-\d+$/.test(t ?? ""))).toBe(true);
      expect(new Set(tokens).size).toBe(tokens.length);
    });
  });

  describe("when a table fails to write", () => {
    it("should fail, naming the table and its error code", async () => {
      // The production outage of 2026-10-26: Woodcore answered, our database refused.
      const result = await runScript({
        get: finishesWith([
          table("wc_acc_gl_account", "error", "database error (ER_ACCESS_DENIED_ERROR)"),
          table("wc_m_loan", "error", "database error (ER_ACCESS_DENIED_ERROR)"),
          ...BRIDGES_SKIPPED,
        ]),
      });

      expect(result.out).toContain("wc_acc_gl_account: error, 0 rows (database error (ER_ACCESS_DENIED_ERROR))");
      expect(result.out).toContain("::error::These mirror tables failed to refresh: wc_acc_gl_account, wc_m_loan.");
      expect(result.out).not.toContain("Woodcore mirror refreshed.");
      expect(result.code).toBe(1);
    });

    it("should keep a reason that can name a host out of the public log", async () => {
      const result = await runScript({
        get: finishesWith([table("wc_m_loan", "error", "connect ETIMEDOUT 203.0.113.5:3306")]),
      });

      expect(result.out).not.toContain("203.0.113.5");
      expect(result.out).toContain("wc_m_loan: error, 0 rows (reason withheld from this public log; see the server log)");
      expect(result.code).toBe(1);
    });
  });

  describe("when the run itself reports an error", () => {
    it("should fail even though no table is marked in error", async () => {
      const result = await runScript({
        get: finishesWith([table("wc_m_loan", "ok")], "database error (ER_LOCK_WAIT_TIMEOUT)"),
      });

      expect(result.out).toContain("::error::The sync stopped: database error (ER_LOCK_WAIT_TIMEOUT).");
      expect(result.code).toBe(1);
    });
  });

  describe("when a run finishes without reporting any table", () => {
    it("should fail rather than call an empty run a refresh", async () => {
      const result = await runScript({ get: finishesWith([]) });

      expect(result.out).toContain("::error::The sync finished without reporting any table.");
      expect(result.code).toBe(1);
    });
  });

  describe("when the server first shows an earlier, failed run", () => {
    it("should judge only the run this job started", async () => {
      const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
      const result = await runScript({
        get: (n, startedAt) =>
          n === 0
            ? ok(finished(yesterday, [table("wc_old_table", "error", "database error (ER_ACCESS_DENIED_ERROR)")]))
            : ok(finished(startedAt, [table("wc_m_loan", "ok")])),
      });

      expect(result.out).not.toContain("wc_old_table");
      expect(result.out).toContain("Woodcore mirror refreshed.");
      expect(result.code).toBe(0);
    });
  });

  describe("when a sync is already running", () => {
    it("should wait for that run and report its result, not pass on the 409", async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      const result = await runScript({
        post: () => ({ status: 409, body: { error: "already running", state: running(tenMinutesAgo) } }),
        get: (n) =>
          ok(
            n < 2
              ? running(tenMinutesAgo)
              : finished(tenMinutesAgo, [table("wc_m_loan", "error", "database error (ER_ACCESS_DENIED_ERROR)")]),
          ),
      });

      expect(result.out).toContain(`A sync was already running (started ${tenMinutesAgo})`);
      expect(result.out).toContain("::error::These mirror tables failed to refresh: wc_m_loan.");
      expect(result.code).toBe(1);
    });
  });

  describe("when the run disappears from the server", () => {
    it("should fail after a few polls, saying a restart can lose a run", async () => {
      const result = await runScript({ get: () => ok(IDLE) });

      expect(result.out).toContain("::error::The run this job is waiting for is no longer visible on the server");
      expect(gets(result.seen)).toHaveLength(3);
      expect(result.code).toBe(1);
    });
  });

  describe("when the status endpoint does not answer", () => {
    it("should ride out one failed poll", async () => {
      const result = await runScript({
        get: (n, startedAt) =>
          n === 0 ? { status: 502, body: { error: "bad gateway" } } : ok(finished(startedAt, [table("wc_m_loan", "ok")])),
      });

      expect(result.out).toContain("Status check: HTTP 502 (1 of 5 failures allowed in a row)");
      expect(result.code).toBe(0);
    });

    it("should fail after five failed polls in a row", async () => {
      const result = await runScript({ get: () => ({ status: 502, body: { error: "bad gateway" } }) });

      expect(result.out).toContain("stopped answering (last: HTTP 502 (bad gateway))");
      expect(gets(result.seen)).toHaveLength(5);
      expect(result.code).toBe(1);
    });
  });

  describe("when the sync outlasts the deadline", () => {
    it("should fail, saying the result is unknown", async () => {
      const result = await runScript(
        { get: (_n, startedAt) => ok(running(startedAt)) },
        { env: { WOODCORE_SYNC_DEADLINE_SECONDS: "1", WOODCORE_SYNC_POLL_INTERVAL_SECONDS: "0.2" } },
      );

      expect(result.out).toContain("::error::The sync was still running after 0 minutes, so its result is unknown.");
      expect(result.code).toBe(1);
    });
  });

  describe("when the POST is refused or fails", () => {
    it("should keep the 403 diagnosis that names the secret actually sent", async () => {
      const result = await runScript(
        { post: () => ({ status: 403, body: { error: "forbidden" } }) },
        { oidc: false, env: { SYNC_SECRET: "stale", SECRET_SOURCE: "CRON_SECRET" } },
      );

      expect(result.out).toContain("403 forbidden — the secret this workflow sent (CRON_SECRET)");
      expect(result.out).toContain("WOODCORE_SYNC_SECRET is IGNORED while CRON_SECRET exists");
      expect(gets(result.seen)).toHaveLength(0);
      expect(result.code).toBe(1);
    });

    it("should print a short error field, and never a long one", async () => {
      const plain = await runScript({ post: () => ({ status: 500, body: { error: "internal error" } }) });
      expect(plain.out).toContain("Unexpected status 500");
      expect(plain.out).toContain("(internal error)");
      expect(plain.code).toBe(1);

      const leaky = await runScript({
        post: () => ({ status: 500, body: { error: "Failed query: select * from users where email = 'a@b.c'" } }),
      });
      expect(leaky.out).not.toContain("Failed query");
      expect(leaky.code).toBe(1);
    });
  });

  describe("when there is no credential at all", () => {
    it("should fail before calling the server", async () => {
      const result = await runScript({}, { oidc: false });

      expect(result.out).toContain("::error::No credential available");
      expect(result.seen).toHaveLength(0);
      expect(result.code).toBe(1);
    });
  });
});
