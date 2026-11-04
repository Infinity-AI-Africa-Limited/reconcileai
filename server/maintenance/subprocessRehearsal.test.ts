import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import {
  bounded, childEnvironment, fixtureConfig, FixtureProcess, loopbackRedisUrl, parseCommand,
} from "./subprocessRehearsal.testkit";

/**
 * Controlled cross-process ADAPTER rehearsal, not a full-platform/production rehearsal.
 * HTTP handlers and queue work are injected synthetic gates/effects, not model/source
 * runners or an integrated DB recovery flow. Existing reconciliationQueue.test.ts
 * and reconciliationQueue.sweepTimeout.test.ts cover runner/sweep recovery policy
 * with injected helpers and scripted DB assertions; they are NOT integrated DB proof.
 * Opt in ONLY with a parent-owned disposable Redis, outside the repo. No FLUSHDB.
 */
const configured = process.env.RECONCILEAI_TEST_REDIS_URL;
const fixtureUrl = configured === undefined ? undefined : loopbackRedisUrl(configured);
if (fixtureUrl && process.env.REDIS_URL !== fixtureUrl) throw new Error("rehearsal_fixture_environment_mismatch");
const children: FixtureProcess[] = [];
const inspectors: Queue[] = [];
const uniqueName = () => `test-recovery-rehearsal-${randomUUID().replaceAll("-", "")}`;

async function worker(name: string, shortDeadline = false) {
  if (!fixtureUrl) throw new Error("rehearsal_fixture_not_configured");
  const child = new FixtureProcess(fixtureUrl, name, shortDeadline);
  children.push(child); // Own even a fixture that fails its first handshake.
  const ready = await child.take("ready");
  expect(ready.backend).toBe("bullmq");
  expect(Number.isInteger(ready.port) && ready.port! > 0 && ready.port! <= 65_535).toBe(true);
  return { child, port: ready.port! };
}

async function inspect(name: string): Promise<Queue> {
  if (!fixtureUrl || !/^test-recovery-rehearsal-[a-f0-9]{32}$/.test(name)) throw new Error("rehearsal_inspector_guard");
  const { Queue } = await import("bullmq");
  const inspector = new Queue(name, {
    connection: {
      host: "127.0.0.1", port: Number(new URL(fixtureUrl).port),
      connectTimeout: 1_000, maxRetriesPerRequest: 1, retryStrategy: () => null,
    },
  });
  inspector.on("error", () => {}); // No raw transport diagnostics or payloads.
  inspectors.push(inspector);
  await bounded(inspector.waitUntilReady());
  return inspector;
}

async function http(port: number, method: "GET" | "POST", path: string) {
  let active: ReturnType<typeof request> | undefined;
  try {
    return await bounded(new Promise<{ status: number; body: unknown; retryAfter?: string; cacheControl?: string }>((resolve, reject) => {
      active = request({ hostname: "127.0.0.1", port, method, path, agent: false }, response => {
        let body = "";
        response.on("data", chunk => {
          body += String(chunk);
          if (body.length > 1_024) { active?.destroy(); reject(new Error("rehearsal_response_too_large")); }
        });
        response.once("error", () => reject(new Error("rehearsal_http_failed")));
        response.once("end", () => {
          try {
            resolve({ status: response.statusCode!, body: JSON.parse(body),
              retryAfter: response.headers["retry-after"], cacheControl: response.headers["cache-control"] });
          } catch { reject(new Error("rehearsal_http_invalid_response")); }
        });
      });
      active.once("error", () => reject(new Error("rehearsal_http_failed")));
      active.end();
    }));
  } finally { active?.destroy(); }
}

async function assertFenced(port: number) {
  for (const [method, path] of [
    ["POST", "/synthetic/work"], ["POST", "/api/healthz"], ["GET", "/api/healthz/extra"],
  ] as const) {
    expect(await http(port, method, path)).toEqual({
      status: 503, body: { code: "maintenance_unavailable" }, retryAfter: "60", cacheControl: "no-store",
    });
  }
  expect((await http(port, "GET", "/api/healthz")).status).toBe(200);
  expect((await http(port, "GET", "/api/readyz")).status).toBe(503);
}

async function stopped(child: FixtureProcess, signal: "SIGTERM" | "SIGINT" = "SIGTERM") {
  child.signal(signal);
  expect(await child.take("shutdown_result")).toMatchObject({
    status: "stopped", scope: "tracked_process_only", state: "drained",
    active: 0, stopFailures: 0, resourcesClosed: true, listening: false,
  });
  expect(await bounded(child.exit)).toEqual({ code: 0, signal: null });
}

// Failed assertions never leave owned workers alive. Forced kill is test cleanup,
// never drain authorisation. Delete only our UUID queue, after ALL workers exit.
afterEach(async () => {
  const results = await Promise.allSettled(children.splice(0).map(child => child.killAndWait()));
  const cleanup = await Promise.allSettled(inspectors.splice(0).map(async inspector => {
    try {
      if (results.every(result => result.status === "fulfilled")) {
        try { await bounded(inspector.obliterate({ force: true }), undefined, "cleanup_queue_delete"); }
        catch { throw new Error("rehearsal_cleanup_queue_delete_failed"); }
      }
    } finally {
      try { await bounded(inspector.close(), undefined, "cleanup_inspector_close"); }
      catch { throw new Error("rehearsal_cleanup_inspector_close_failed"); }
    }
  }));
  if (results.some(result => result.status === "rejected")) throw new Error("rehearsal_cleanup_child_exit_failed");
  const failed = cleanup.find(result => result.status === "rejected");
  if (failed?.status === "rejected") {
    // Only locally constructed fixed codes, never transport rejection text.
    throw new Error(failed.reason instanceof Error && failed.reason.message === "rehearsal_cleanup_inspector_close_failed"
      ? "rehearsal_cleanup_inspector_close_failed" : "rehearsal_cleanup_queue_delete_failed");
  }
}, 20_000);

describe("when subprocess rehearsal safety boundaries are configured", () => {
  it("should reject non-exact loopback URLs, mismatched Redis and non-synthetic queue names before connecting", () => {
    for (const url of [undefined, "", "redis://localhost:6379", "redis://127.0.0.1:6379/", "redis://127.0.0.1:0",
      "redis://127.0.0.1:65536", "redis://127.0.0.1:06379", "redis://user:pass@127.0.0.1:6379", "rediss://127.0.0.1:6379",
      "redis://127.0.0.1:6379?db=1", "redis://192.0.2.1:6379"]) {
      expect(() => loopbackRedisUrl(url)).toThrow("rehearsal_requires_exact_loopback_redis");
    }
    const env = childEnvironment("redis://127.0.0.1:16379", uniqueName());
    expect(Object.keys(env).sort()).toEqual([
      "NODE_ENV", "RECONCILEAI_TEST_QUEUE_NAME", "RECONCILEAI_TEST_REDIS_URL", "RECONCILEAI_TEST_SHUTDOWN_MS", "REDIS_URL",
    ]);
    expect(() => fixtureConfig({ ...env, REDIS_URL: "redis://127.0.0.1:16380" })).toThrow("environment_mismatch");
    expect(() => fixtureConfig({ ...env, RECONCILEAI_TEST_QUEUE_NAME: "shared" })).toThrow("unique_synthetic_queue");
    expect(() => fixtureConfig({ ...env, DATABASE_URL: "synthetic_forbidden" })).toThrow("unexpected_environment");
    expect(() => fixtureConfig({ ...env, NODE_ENV: "production" })).toThrow("environment_mismatch");
    expect(() => fixtureConfig({ ...env, RECONCILEAI_TEST_SHUTDOWN_MS: "0" })).toThrow("invalid_deadline");
  });

  it("should allow only fixed IPC commands with safe correlation ids and no arbitrary payload", () => {
    expect(parseCommand({ id: 1, command: "snapshot" })).toEqual({ id: 1, command: "snapshot" });
    for (const value of [null, {}, { id: 1, command: "resume" }, { id: 0, command: "snapshot" },
      { id: 1, command: "snapshot", payload: { synthetic: true } }, { id: "1", command: "snapshot" }]) {
      expect(() => parseCommand(value)).toThrow("rehearsal_invalid_command");
    }
  });
});

describe.skipIf(!fixtureUrl)("when shipped adapters run in child processes against isolated local Redis", () => {
  it("should await post-response HTTP work and active queue acknowledgement, refuse admission, retain waiting work, and restart with retry", async () => {
    const name = uniqueName();
    const inspector = await inspect(name);
    const first = await worker(name);
    expect((await http(first.port, "POST", "/synthetic/work")).status).toBe(202);
    await first.child.take("http_started");
    expect((await first.child.command("enqueue_active")).status).toBe("enqueued");
    await first.child.take("job_started", event => event.job === "active");
    expect((await first.child.command("enqueue_waiting")).status).toBe("enqueued");
    first.child.signal();
    expect(await first.child.take("fenced")).toMatchObject({ state: "draining", resourcesClosed: false, listening: true });
    await assertFenced(first.port);
    expect((await first.child.command("enqueue_refused")).status).toBe("maintenance_unavailable");
    const held = await first.child.command("snapshot");
    expect(held.active).toBeGreaterThanOrEqual(2);
    expect(held.resourcesClosed).toBe(false);
    expect(held.effects).toBe(0);
    expect(held.state).toBe("draining");

    await first.child.command("release_http");
    await first.child.take("http_settled");
    const queueHeld = await first.child.command("snapshot");
    expect(queueHeld.state).toBe("draining");
    expect(queueHeld.active).toBeGreaterThan(0);
    expect(queueHeld.resourcesClosed).toBe(false);
    expect(queueHeld.effects).toBe(1); // admitted descendant finished after the fence
    await first.child.command("release_job");
    await first.child.take("job_settled", event => event.job === "active");
    expect(await first.child.take("shutdown_result")).toMatchObject({
      status: "stopped", scope: "tracked_process_only", state: "drained", active: 0,
      stopFailures: 0, effects: 2, resourcesClosed: true, listening: false,
    });
    expect(await bounded(first.child.exit)).toEqual({ code: 0, signal: null });
    const counts = await bounded(inspector.getJobCounts("waiting", "active", "completed", "failed"));
    expect(counts).toMatchObject({ waiting: 1, active: 0, completed: 1, failed: 0 });
    expect(await bounded(inspector.getJob("synthetic-refused"))).toBeUndefined();
    const retained = await bounded(inspector.getJob("synthetic-waiting"));
    expect(retained).toBeDefined();
    expect(await bounded(retained!.getState())).toBe("waiting");

    const replacement = await worker(name);
    await replacement.child.take("job_started", event => event.job === "waiting" && event.attempt === 1);
    await replacement.child.take("job_settled", event => event.job === "waiting");
    expect((await replacement.child.command("enqueue_retry")).status).toBe("enqueued");
    await replacement.child.take("job_started", event => event.job === "retry" && event.attempt === 1);
    await replacement.child.take("job_started", event => event.job === "retry" && event.attempt === 2);
    await replacement.child.take("job_settled", event => event.job === "retry" && event.attempt === 2);
    await stopped(replacement.child, "SIGINT"); // drain proves final Redis acknowledgement
    expect(await bounded(inspector.getJobCounts("waiting", "active", "completed", "failed", "delayed")))
      .toMatchObject({ waiting: 0, active: 0, completed: 3, failed: 0, delayed: 0 });
    expect((await bounded(inspector.getJob("synthetic-retry")))?.attemptsMade).toBe(2);
  }, 40_000);

  it("should prove one stopped worker is not cluster-wide quiescence because a second process still accepts and executes shared-queue work", async () => {
    const name = uniqueName();
    const inspector = await inspect(name);
    const first = await worker(name);
    const second = await worker(name);
    await stopped(first.child);
    expect(await second.child.command("snapshot")).toMatchObject({ state: "running", resourcesClosed: false, listening: true });
    expect((await second.child.command("enqueue_peer")).status).toBe("enqueued");
    await second.child.take("job_started", event => event.job === "peer");
    await second.child.take("job_settled", event => event.job === "peer");
    await stopped(second.child);
    expect(await bounded(inspector.getJobCounts("waiting", "active", "completed")))
      .toMatchObject({ waiting: 0, active: 0, completed: 1 });
  }, 30_000);

  it("should report an incomplete deadline without stopping resources or reopening admission, even after held work completes", async () => {
    const name = uniqueName();
    const inspector = await inspect(name);
    const { child, port } = await worker(name, true);
    expect((await child.command("enqueue_active")).status).toBe("enqueued");
    await child.take("job_started", event => event.job === "active");
    expect((await http(port, "POST", "/synthetic/work")).status).toBe(202);
    await child.take("http_started");
    child.signal();
    await child.take("fenced");
    expect(await child.take("shutdown_result")).toMatchObject({
      status: "incomplete", scope: "tracked_process_only", state: "incomplete",
      resourcesClosed: false, listening: true, effects: 0,
    });
    await assertFenced(port); // Real live listener, not just a diagnostic snapshot.
    expect((await child.command("enqueue_refused")).status).toBe("maintenance_unavailable");
    expect(await child.command("snapshot")).toMatchObject({ state: "incomplete", resourcesClosed: false, listening: true });
    await child.command("release_http");
    await child.take("http_settled");
    await child.command("release_job");
    await child.take("job_settled", event => event.job === "active");
    expect(await child.command("snapshot")).toMatchObject({ state: "incomplete", resourcesClosed: false, listening: true });
    await assertFenced(port);
    expect(await bounded(inspector.getJob("synthetic-refused"))).toBeUndefined();
    // afterEach force-kills and awaits this intentionally fenced live child.
  }, 25_000);
});
