/** Synthetic fixture ONLY. The parent finite harness applies COMMITTED migrations
 * to a NEW reconcileai_test database and starts nonpersistent Redis on random
 * 127.0.0.1 ports. Setup writes below are not observer operations. No TiDB proof.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import mysql, { type Connection } from "mysql2/promise";
import { DB_SURFACES, INTAKE_SOURCES, QUEUE_IDS, QUEUE_STATES, compileDatabaseQuery } from "./catalogue";
import { observeDurableStores, type ObserverDependencies } from "./core";
import { serializeReport } from "./report";
import { openRuntimeReaders } from "./runtimeAdapters";
import { openDatabase, prepareRedis, connectRedis } from "./vendor/production-workload-preflight.mjs";
import {
  createFixtureRedisClient, createLoopbackReaders, fixtureMysqlOptions,
  requireLoopbackFixture, allocateFixturePair, type FixtureRedisClient, type LoopbackFixture,
} from "./loopback.testkit";

const mysqlPort = process.env.DURABLE_OBSERVER_TEST_MYSQL_PORT;
const redisPort = process.env.DURABLE_OBSERVER_TEST_REDIS_PORT;
const enabled = mysqlPort !== undefined || redisPort !== undefined;
// Partial/invalid opt-in fails closed at collection, rather than quietly skipping.
const fixture = enabled ? requireLoopbackFixture() : undefined;
const require = createRequire(import.meta.url);
const testInputs = { DURABLE_OBSERVER_TEST_MYSQL_PORT: "40123", DURABLE_OBSERVER_TEST_REDIS_PORT: "40124" };

describe("when loopback fixture inputs are absent or disguised", () => {
  it("should refuse missing, default, noncanonical and out-of-range ports before any client exists", () => {
    for (const invalid of [undefined, "", "3306", "6379", "0", "32767", "65536", "040123", "40123 ", "+40123", "40123/x", "localhost:40123"]) {
      expect(() => requireLoopbackFixture({ ...testInputs, DURABLE_OBSERVER_TEST_MYSQL_PORT: invalid })).toThrow("loopback_fixture_refused");
      expect(() => requireLoopbackFixture({ ...testInputs, DURABLE_OBSERVER_TEST_REDIS_PORT: invalid })).toThrow("loopback_fixture_refused");
    }
    expect(() => requireLoopbackFixture({ ...testInputs, DURABLE_OBSERVER_TEST_REDIS_PORT: "40123" })).toThrow("loopback_fixture_refused");
  });
  it("should refuse host aliases, IPv6, credentials and a different database before opening a socket", async () => {
    const local = requireLoopbackFixture(testInputs);
    for (const host of ["localhost", "127.1", "127.0.0.1.", "::1", "0.0.0.0", "example.invalid", "root@127.0.0.1"]) {
      await expect(createLoopbackReaders({ ...local, host } as LoopbackFixture)).rejects.toThrow("loopback_fixture_refused");
    }
    await expect(createLoopbackReaders({ ...local, database: "other" } as unknown as LoopbackFixture)).rejects.toThrow("loopback_fixture_refused");
    expect(local.host).toBe("127.0.0.1");
    expect(local.database).toBe("reconcileai_test");
    expect(compileDatabaseQuery("session.snapshot")).toBe("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  });
  it("should dispose a partially allocated pair and never release constructor or cleanup error text", () => {
    let drops = 0;
    expect(() => allocateFixturePair(
      () => ({ destroy() { drops += 1; throw new Error("PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE"); } }),
      () => { throw new Error("PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE"); },
    )).toThrow(/^fixture_connection_failed$/);
    expect(drops).toBe(1);
    let redisConstructed = false;
    expect(() => allocateFixturePair(
      () => { throw new Error("PRIVATE_TEST_SENTINEL_DO_NOT_RELEASE"); },
      () => { redisConstructed = true; return { disconnect() {} }; },
    )).toThrow(/^fixture_connection_failed$/);
    expect(redisConstructed).toBe(false);
  });
});

const BASE = 910_000;
const OLD = "2020-01-01 00:00:00";
interface Seed {
  table: string;
  key: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number | null)[])[];
}
const seeds: readonly Seed[] = [
  { table: "reconciliation_jobs", key: "id", columns: ["id", "userId", "name", "sourceChannelId", "targetChannelId", "dateFrom", "dateTo", "status", "createdAt", "heartbeatAt", "abandonedAt"],
    rows: [[BASE, 1, "synthetic", 1, 2, OLD, OLD, "pending", OLD, null, null], [BASE + 1, 1, "synthetic", 1, 2, OLD, OLD, "running", OLD, OLD, null], [BASE + 2, 1, "synthetic", 1, 2, OLD, OLD, "running", OLD, OLD, OLD], [BASE + 3, 1, "synthetic", 1, 2, OLD, OLD, "completed", OLD, null, null]] },
  { table: "upload_batches", key: "id", columns: ["id", "userId", "channelId", "fileName", "status", "createdAt"], rows: ["pending", "processing", "completed", "failed"].map((s, i) => [BASE + i, 1, 1, "synthetic.csv", s, OLD]) },
  { table: "schedule_run_history", key: "id", columns: ["id", "scheduledTaskId", "status", "startedAt"], rows: [[BASE, 1, "running", OLD], [BASE + 1, 1, "success", OLD]] },
  { table: "wc_connector_sync_runs", key: "id", columns: ["id", "configId", "organizationId", "trigger", "windowFrom", "windowTo", "status", "startedAt"], rows: [[BASE, 1, 1, "manual", OLD, OLD, "running", OLD], [BASE + 1, 1, 1, "manual", OLD, OLD, "completed", OLD]] },
  { table: "webhook_deliveries", key: "id", columns: ["id", "webhookId", "event", "url", "status", "createdAt"], rows: [[BASE, 1, "synthetic", "https://example.invalid", "pending", OLD], [BASE + 1, 1, "synthetic", "https://example.invalid", "delivered", OLD]] },
  { table: "shopify_privacy_queue_outbox", key: "id", columns: ["id", "kind", "jobId", "status", "createdAt"], rows: ["pending", "dispatching", "failed_retryable", "failed_terminal", "dispatched"].map((s, i) => [BASE + i, "customer_request", BASE + i, s, OLD]) },
  { table: "shopify_privacy_requests", key: "id", columns: ["id", "topic", "requestHash", "status", "receivedAt"], rows: ["received", "processing", "awaiting_delivery", "failed_retryable", "blocked_dependency", "manual_review", "blocked_legal_retention", "completed"].map((s, i) => [BASE + i, "customers/data_request", `synthetic-${i}`, s, OLD]) },
  { table: "shopify_privacy_data_request_jobs", key: "requestId", columns: ["requestId", "organizationId", "storeId", "status", "createdAt"], rows: ["received", "processing", "awaiting_delivery", "failed_retryable", "blocked_dependency", "manual_review", "blocked_legal_retention", "completed"].map((s, i) => [BASE + i, 1, 1, s, OLD]) },
  { table: "shopify_privacy_customer_redaction_jobs", key: "requestId", columns: ["requestId", "organizationId", "storeId", "status", "createdAt"], rows: ["received", "processing", "failed_retryable", "blocked_dependency", "manual_review", "failed_terminal", "completed"].map((s, i) => [BASE + i, 1, 1, s, OLD]) },
  { table: "shopify_shop_redaction_jobs", key: "id", columns: ["id", "runId", "organizationId", "storeId", "requestHash", "webhookId", "status", "createdAt"], rows: ["admitted", "processing", "failed_retryable", "blocked_dependency", "redacting", "manual_review", "failed_terminal", "completed"].map((s, i) => [BASE + i, `synthetic-run-${i}`, 1, BASE + i, `synthetic-${i}`, `synthetic-${i}`, s, OLD]) },
  { table: "shopify_privacy_artifacts", key: "requestId", columns: ["requestId", "organizationId", "storeId", "publicId", "artifactKind", "objectKey", "recipientUserId", "generatedAt", "expiresAt", "status", "deliveryStatus", "createdAt"], rows: [[BASE, 1, 1, "synthetic-0", "zero_record_attestation", "synthetic", 1, OLD, OLD, "writing", "pending", OLD], [BASE + 1, 1, 1, "synthetic-1", "zero_record_attestation", "synthetic", 1, OLD, OLD, "ready", "pending", OLD], [BASE + 2, 1, 1, "synthetic-2", "zero_record_attestation", "synthetic", 1, OLD, OLD, "ready", "acknowledged", OLD]] },
  { table: "shopify_webhook_events", key: "id", columns: ["id", "webhookId", "topic", "payloadSha256", "status", "receivedAt"], rows: [[BASE, "synthetic-0", "orders/create", "synthetic", "received", OLD], [BASE + 1, "synthetic-1", "orders/create", "synthetic", "processed", OLD]] },
  { table: "shopify_sync_requests", key: "id", columns: ["id", "storeId", "organizationId", "status", "requestedAt"], rows: [[BASE, 1, 1, "queued", OLD], [BASE + 1, 1, 1, "succeeded", OLD]] },
  { table: "shopify_install_leases", key: "shopDomain", columns: ["shopDomain", "leaseId", "expiresAt", "createdAt"], rows: [["synthetic-0.invalid", "synthetic", "2037-01-01 00:00:00", OLD], ["synthetic-1.invalid", "synthetic", OLD, OLD]] },
  { table: "shopify_connector_stores", key: "id", columns: ["id", "organizationId", "shopDomain", "shopId", "displayName", "grantedScopes", "requestedScopes", "status", "privacyRedactionState", "updatedAt"], rows: [[BASE, 1, "synthetic-0.invalid", "synthetic-0", "synthetic", "", "", "redacting", "active", OLD], [BASE + 1, 1, "synthetic-1.invalid", "synthetic-1", "synthetic", "", "", "active", "customer_redacting", OLD], [BASE + 2, 1, "synthetic-2.invalid", "synthetic-2", "synthetic", "", "", "active", "active", OLD]] },
  { table: "organizations", key: "id", columns: ["id", "name", "code", "deletionState", "redactingAt", "updatedAt"], rows: [[BASE, "Synthetic", "synthetic", "redacting", OLD, OLD]] },
  { table: "sl_connector_webhook_events", key: "id", columns: ["id", "organizationId", "slStoreId", "webhookId", "topic", "status", "attempts", "receivedAt"], rows: [[BASE, 1, 1, "synthetic-0", "orders/create", "pending", 0, OLD], [BASE + 1, 1, 1, "synthetic-1", "orders/create", "processing", 1, OLD], [BASE + 2, 1, 1, "synthetic-2", "orders/create", "failed", 2, OLD], [BASE + 3, 1, 1, "synthetic-3", "orders/create", "failed", 3, OLD], [BASE + 4, 1, 1, "synthetic-4", "orders/create", "processed", 0, OLD]] },
  { table: "sl_connector_gdpr_requests", key: "id", columns: ["id", "topic", "status", "receivedAt"], rows: [[BASE, "shop/redact", "received", OLD], [BASE + 1, "shop/redact", "completed", OLD]] },
  { table: "wc_connector_webhook_events", key: "id", columns: ["id", "configId", "organizationId", "eventId", "status", "receivedAt"], rows: [[BASE, 1, 1, "synthetic-0", "received", OLD], [BASE + 1, 1, 1, "synthetic-1", "processed", OLD]] },
  { table: "wc_connector_dead_letters", key: "id", columns: ["id", "configId", "organizationId", "source", "error", "status", "createdAt"], rows: ["pending", "retrying", "resolved", "exhausted", "discarded"].map((s, i) => [BASE + i, 1, 1, "webhook", "synthetic", s, OLD]) },
  { table: "data_deletion_requests", key: "id", columns: ["id", "requestedByUserId", "status", "createdAt"], rows: ["pending", "in_progress", "completed", "failed"].map((s, i) => [BASE + i, 1, s, OLD]) },
  { table: "transactions", key: "id", columns: ["id", "batchId", "channelId", "userId", "amount", "transactionDate", "debitCredit", "createdAt"], rows: [[BASE, BASE, 1, 1, "0.00", OLD, "credit", OLD]] },
];
const counts = [2, 1, 2, 1, 1, 1, 3, 5, 2, 5, 4, 5, 1, 1, 1, 1, 1, 2, 1, 3, 1, 1, 2, 2];
async function keys(client: FixtureRedisClient): Promise<string[]> {
  const result = await client.call("KEYS", "*"); // Inspector only, on the fresh fixture.
  if (!Array.isArray(result) || result.some(k => typeof k !== "string")) throw new Error("fixture_inspection_failed");
  return (result as string[]).sort();
}
async function rows(connection: Connection): Promise<string> {
  const snapshots: unknown[] = [];
  for (const seed of seeds) {
    const [result] = await connection.query(`SELECT * FROM \`${seed.table}\` ORDER BY \`${seed.key}\``);
    snapshots.push(result);
  }
  return JSON.stringify(snapshots);
}
async function observe(): Promise<ReturnType<typeof observeDurableStores> extends Promise<infer T> ? T : never> {
  return observeDurableStores(await createLoopbackReaders(fixture));
}

describe.skipIf(!fixture)("when the finite harness supplies NEW committed-migration MySQL and nonpersistent Redis fixtures", () => {
  // The runtime adapter's real-driver case lives here, first, because it needs
  // the fixture empty. Vitest runs separate files in parallel: in a file of its
  // own it read the rows and keys the cases below seed, and failed four runs in
  // five. Within one file the cases run in order. It writes nothing itself.
  it("should reuse Claude’s actual driver openers for every fixed catalogue read and preserve HOLD", async () => {
    if (!fixture) throw new Error("loopback_fixture_refused");
    const abort = new AbortController();
    const readers = await openRuntimeReaders(
      {
        databaseUrl: `mysql://root@127.0.0.1:${fixture.mysqlPort}/reconcileai_test`,
        redisUrl: `redis://127.0.0.1:${fixture.redisPort}`,
        appDir: require
          .resolve("../../package.json")
          .replace(/\/package\.json$/, ""),
        signal: abort.signal,
      },
      {
        isolatedLoopback: true,
        database: openDatabase,
        prepareRedis,
        connectRedis,
      }
    );
    let time = 0;
    const report = await observeDurableStores({
      ...readers,
      clock: {
        now: () => time,
        wait: async (ms, signal) => {
          if (signal.aborted) throw new Error("fixture_aborted");
          time += ms;
        },
      },
    });
    expect(serializeReport(report)).toContain('"hold":true');
    expect(report.execution).toBe("synthetic_only");
    expect(report.databaseControl).toBe("statement_guard_only");
    expect(report.verdict).toBe("zero_observed_not_proof");
    expect(report.errors).toEqual([]);
    expect(report.samples).toHaveLength(3);
    expect(
      report.samples.every(
        sample =>
          sample.database.snapshot === "consistent_snapshot" &&
          sample.database.cleanup === "ok"
      )
    ).toBe(true);
    await expect(
      readers.database.read("session.utc", abort.signal)
    ).rejects.toThrow("connection_unusable");
    await expect(readers.redis.scan("0", abort.signal)).rejects.toThrow(
      "connection_unusable"
    );
  }, 15_000);

  it("should execute every catalogue query on empty and seeded schema without changing durable states or creating keys", async () => {
    if (!fixture) throw new Error("loopback_fixture_refused");
    let connection: Connection | undefined;
    let inspector: FixtureRedisClient | undefined;
    let renamed = false;
    let setupStarted = false;
    try {
      connection = await mysql.createConnection(fixtureMysqlOptions(fixture));
      await connection.query("SET time_zone = '+00:00'");
      inspector = createFixtureRedisClient(fixture);
      await inspector.connect();
      for (const seed of seeds) {
        const [result] = await connection.query(`SELECT COUNT(*) AS count FROM \`${seed.table}\``);
        if (!Array.isArray(result) || result.length !== 1 || (result[0] as { count: number }).count !== 0) {
          throw new Error("fixture_not_new_and_empty");
        }
      }
      if ((await keys(inspector)).length !== 0) throw new Error("fixture_not_new_and_empty");
      const empty = await observe();
      expect(empty.hold).toBe(true);
      expect(empty.verdict).toBe("zero_observed_not_proof");
      expect(empty.errors).toEqual([]);
      expect(empty.samples).toHaveLength(3);
      for (const sample of empty.samples) expect(sample.database.surfaces.map(s => s.count)).toEqual(DB_SURFACES.map(() => 0));
      expect(await keys(inspector)).toEqual([]);

      // Setup writes only: all identities and content are synthetic constants.
      setupStarted = true;
      for (const seed of seeds) for (const values of seed.rows) {
        await connection.execute(`INSERT INTO \`${seed.table}\` (${seed.columns.map(c => `\`${c}\``).join(",")}) VALUES (${values.map(() => "?").join(",")})`, [...values]);
      }
      for (const queue of QUEUE_IDS) {
        await inspector.call("HSET", `bull:${queue}:meta`, "synthetic", "1");
        for (const state of QUEUE_STATES) {
          const key = `bull:${queue}:${state}`;
          if (["wait", "paused", "active"].includes(state)) await inspector.call("RPUSH", key, "synthetic-job");
          else await inspector.call("ZADD", key, "1", "synthetic-job");
        }
        await inspector.call("ZADD", `bull:${queue}:completed`, "1", "synthetic-completed");
        await inspector.call("HSET", `bull:${queue}:synthetic-job`, "data", "synthetic", "finishedOn", "1", "processedOn", "1");
      }
      const beforeRows = await rows(connection);
      const beforeKeys = await keys(inspector);
      const seeded = await observe();
      expect(seeded.hold).toBe(true);
      expect(seeded.verdict).toBe("no_go_unfinished_work");
      expect(seeded.errors).toEqual([]);
      for (const sample of seeded.samples) {
        expect(sample.database.surfaces.map(s => s.count)).toEqual(counts);
        expect(sample.database.surfaces.map(s => s.id)).toEqual(DB_SURFACES.map(s => s.id));
        expect(sample.database.surfaces.every(s => (s.oldestAgeSeconds ?? 0) > 0)).toBe(true);
        expect(sample.redis.discovery).toBe("complete");
        expect(sample.redis.unknownQueues).toBe(0);
        for (const queue of sample.redis.queues) expect(Object.values(queue.states)).toEqual(QUEUE_STATES.map(() => 1));
      }
      for (const sample of seeded.samples.slice(1)) expect(sample.database.intake.map(s => s.count)).toEqual(INTAKE_SOURCES.map(() => 0));
      expect(await rows(connection)).toBe(beforeRows);
      expect(await keys(inspector)).toEqual(beforeKeys);
      for (const queue of QUEUE_IDS) {
        expect(await inspector.call("ZRANGE", `bull:${queue}:completed`, "0", "-1", "WITHSCORES")).toEqual(["synthetic-completed", "1"]);
        expect(await inspector.call("LRANGE", `bull:${queue}:wait`, "0", "-1")).toEqual(["synthetic-job"]);
        expect(await inspector.call("ZRANGE", `bull:${queue}:delayed`, "0", "-1", "WITHSCORES")).toEqual(["synthetic-job", "1"]);
        expect(await inspector.call("HMGET", `bull:${queue}:synthetic-job`, "data", "finishedOn", "processedOn")).toEqual(["synthetic", "1", "1"]);
        expect(await inspector.call("HLEN", `bull:${queue}:synthetic-job`)).toBe(3);
      }
      await inspector.call("HSET", "bull:synthetic-unknown:meta", "synthetic", "1");
      const unknown = await observe();
      expect(unknown.errors).toContain("unknown_queue_observed");
      expect(unknown.samples.every(s => s.redis.unknownQueues === 1)).toBe(true);
      expect(unknown.hold).toBe(true);
      await inspector.call("DEL", "bull:synthetic-unknown:meta");

      // Every intake SELECT executes after a recent synthetic row is admitted.
      for (const source of INTAKE_SOURCES) {
        const seed = seeds.find(s => s.table === source.table);
        if (!seed) throw new Error("fixture_intake_seed_missing");
        await connection.execute(`UPDATE \`${seed.table}\` SET \`${source.time}\` = NOW() WHERE \`${seed.key}\` = ?`, [seed.rows[0][0]]);
      }
      const intake = await observe();
      expect(intake.errors).toContain("intake_observed");
      for (const sample of intake.samples.slice(1)) expect(sample.database.intake.map(s => s.count)).toEqual(INTAKE_SOURCES.map(() => 1));
      expect(intake.hold).toBe(true);

      // Missing migrated table is a real driver query failure, not a mock row.
      await connection.query("RENAME TABLE reconciliation_jobs TO observer_fixture_missing_jobs");
      renamed = true;
      const missing = await observe();
      expect(missing.errors).toContain("database_read_failed");
      expect(missing.errors).toContain("database_cleanup_failed");
      expect(missing.samples.every(s => s.database.surfaces.every(v => v.count === null))).toBe(true);
      expect(missing.hold).toBe(true);
      await connection.query("RENAME TABLE observer_fixture_missing_jobs TO reconciliation_jobs");
      renamed = false;
    } catch (error) {
      // Do not emit raw driver messages, options or fixture result rows.
      if (error instanceof Error && error.name === "AssertionError") throw error;
      if (error instanceof Error && (error.message.startsWith("fixture_") || error.message.startsWith("loopback_"))) throw error;
      throw new Error("synthetic_catalogue_assertion_failed");
    } finally {
      if (connection) {
        if (renamed) await connection.query("RENAME TABLE observer_fixture_missing_jobs TO reconciliation_jobs").catch(() => {});
        // Only seeded exact identities, never table-wide deletes.
        if (setupStarted) for (const seed of [...seeds].reverse()) for (const values of seed.rows) {
          await connection.execute(`DELETE FROM \`${seed.table}\` WHERE \`${seed.key}\` = ?`, [values[0]]).catch(() => {});
        }
        await connection.end().catch(() => {});
      }
      if (inspector) {
        if (setupStarted) for (const queue of QUEUE_IDS) {
          for (const state of [...QUEUE_STATES, "meta", "completed", "synthetic-job"]) {
            await inspector.call("DEL", `bull:${queue}:${state}`).catch(() => {});
          }
        }
        if (setupStarted) await inspector.call("DEL", "bull:synthetic-unknown:meta").catch(() => {});
        inspector.disconnect(false);
      }
    }
  }, 30_000);

  it("should drop a real owned socket on abort and keep rollback failure incomplete with hold", async () => {
    const deps = await createLoopbackReaders(fixture);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(deps.database.read("session.utc", cancelled.signal)).rejects.toThrow("fixture_operation_failed");
    await expect(deps.database.read("session.utc", new AbortController().signal)).rejects.toThrow("fixture_read_refused");
    deps.redis.drop();
    const readers = await createLoopbackReaders(fixture);
    let rollbacks = 0;
    const failing: ObserverDependencies = { ...readers, database: {
      read: async (id, signal) => {
        if (id === "session.rollback") { rollbacks += 1; readers.database.drop(); throw new Error("fixture_rollback_failure"); }
        return readers.database.read(id, signal);
      }, close: signal => readers.database.close(signal), drop: () => readers.database.drop(),
    } };
    const report = await observeDurableStores(failing);
    expect(rollbacks).toBe(1);
    expect(report.errors).toContain("database_cleanup_failed");
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(report.hold).toBe(true);
  }, 10_000);

  it("should finish discovery on a real Redis holding as many job keys as the app's retention allows", async () => {
    if (!fixture) throw new Error("loopback_fixture_refused");
    // 1,000 completed + 5,000 failed jobs per queue (server/jobQueue.ts), six queues.
    const jobs = 36_000;
    const prefix = "bull:reconciliation-runs:synthetic-retained-";
    const inspector = createFixtureRedisClient(fixture);
    let setupStarted = false;
    try {
      await inspector.connect();
      if ((await keys(inspector)).length !== 0) throw new Error("fixture_not_new_and_empty");
      // Setup writes only: each known queue's meta key, and synthetic job-shaped hashes.
      setupStarted = true;
      for (const queue of QUEUE_IDS) await inspector.call("HSET", `bull:${queue}:meta`, "synthetic", "1");
      await inspector.call("EVAL", "for i = 1, tonumber(ARGV[1]) do redis.call('HSET', ARGV[2] .. i, 'synthetic', '1') end return 1", "0", String(jobs), prefix);
      expect(await inspector.call("DBSIZE")).toBe(jobs + QUEUE_IDS.length);
      const report = await observe();
      expect(report.hold).toBe(true);
      expect(report.errors).not.toContain("redis_discovery_incomplete");
      for (const sample of report.samples) expect(sample.redis).toMatchObject({ discovery: "complete", unknownQueues: 0 });
      expect(report.verdict).toBe("zero_observed_not_proof");
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
      if (error instanceof Error && (error.message.startsWith("fixture_") || error.message.startsWith("loopback_"))) throw error;
      throw new Error("synthetic_catalogue_assertion_failed");
    } finally {
      // Only the seeded exact identities.
      if (setupStarted) {
        await inspector.call("EVAL", "for i = 1, tonumber(ARGV[1]) do redis.call('DEL', ARGV[2] .. i) end return 1", "0", String(jobs), prefix).catch(() => {});
        for (const queue of QUEUE_IDS) await inspector.call("DEL", `bull:${queue}:meta`).catch(() => {});
      }
      inspector.disconnect(false);
    }
  }, 30_000);
});
