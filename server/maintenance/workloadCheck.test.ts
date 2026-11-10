/**
 * The workload check's verdicts, against connections whose every answer the
 * test controls. The real connections are proven separately: the database
 * reader against CI's MySQL (workloadCheck.db.test.ts) and the Redis reader
 * against a disposable Redis (workloadReaders.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DB_SURFACES,
  INTAKE_SOURCES,
  LIMITS,
  QUEUE_IDS,
  QUEUE_STATES,
  RUNNABLE_STATES,
  type DatabaseStatementId,
  type RedisReadId,
} from "./workloadCatalogue";
import {
  runWorkloadCheck,
  type WorkloadCheckDependencies,
  type WorkloadCheckReport,
  type WorkloadReplica,
} from "./workloadCheck";

const UNKNOWN_QUEUE = "secret-tenant-export";
const REPLICA: WorkloadReplica = {
  lifecycle: "running",
  trackedOperations: 1,
  uptimeSeconds: 42,
  commit: "a".repeat(40),
  deploymentId: "11111111-1111-4111-8111-111111111111",
  replicaId: null,
};

interface DatabaseScript {
  notConfigured?: boolean;
  openFails?: boolean;
  rows?: Partial<Record<DatabaseStatementId, unknown>>;
  fail?: DatabaseStatementId;
  hang?: DatabaseStatementId;
  /** Every statement answers after this long. */
  delayMs?: number;
}
interface RedisScript {
  notConfigured?: boolean;
  openFails?: boolean;
  states?: Partial<Record<RedisReadId, unknown>>;
  fail?: RedisReadId;
  scanReplies?: unknown[];
  /** Every SCAN reply continues: discovery never finishes. */
  scanForever?: boolean;
}

function defaultRow(id: DatabaseStatementId): unknown {
  if (id === "session.timezone") return { tz: "+00:00" };
  if (id === "session.snapshot" || id === "session.rollback") return undefined;
  if (id.startsWith("intake.")) return { count: 0 };
  return { count: 0, oldestAgeSeconds: null };
}

function harness(database: DatabaseScript = {}, redis: RedisScript = {}) {
  const calls = {
    statements: [] as DatabaseStatementId[],
    released: 0,
    dropped: 0,
    reads: [] as RedisReadId[],
    scans: 0,
    redisClosed: 0,
    redisDropped: 0,
  };
  const settle = <T>(value: () => T, signal: AbortSignal, hang: boolean, delayMs = 0): Promise<T> =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (hang) return;
      const answer = (): void => {
        try {
          resolve(value());
        } catch (error) {
          reject(error);
        }
      };
      if (delayMs > 0) setTimeout(answer, delayMs);
      else answer();
    });
  const deps: WorkloadCheckDependencies = {
    openDatabase: async () => {
      if (database.openFails) throw new Error("unavailable");
      if (database.notConfigured) return null;
      return {
        run: (id, signal) => {
          calls.statements.push(id);
          return settle(
            () => {
              if (database.fail === id) throw new Error("statement_failed");
              return database.rows && id in database.rows ? database.rows[id] : defaultRow(id);
            },
            signal,
            database.hang === id,
            database.delayMs,
          );
        },
        release: () => void calls.released++,
        drop: () => void calls.dropped++,
      };
    },
    openRedis: async () => {
      if (redis.openFails) throw new Error("unavailable");
      if (redis.notConfigured) return null;
      const replies = [...(redis.scanReplies ?? [["0", QUEUE_IDS.map(q => `bull:${q}:meta`)]])];
      return {
        read: (id, signal) => {
          calls.reads.push(id);
          return settle(
            () => {
              if (redis.fail === id) throw new Error("read_failed");
              return redis.states && id in redis.states ? redis.states[id] : 0;
            },
            signal,
            false,
          );
        },
        scan: (_cursor, signal) => {
          calls.scans++;
          return settle(() => (redis.scanForever ? ["17", []] : replies.shift() ?? ["0", []]), signal, false);
        },
        close: async () => void calls.redisClosed++,
        drop: () => void calls.redisDropped++,
      };
    },
    monotonicMs: () => Date.now(),
    wallClock: () => new Date("2026-11-10T12:00:00.000Z"),
    replica: () => REPLICA,
  };
  return { deps, calls };
}

const EVERY_STATEMENT: DatabaseStatementId[] = [
  "session.timezone",
  "session.snapshot",
  ...DB_SURFACES.map(s => s.id),
  ...INTAKE_SOURCES.map(s => `intake.${s.id}` as const),
  "session.rollback",
];
const surface = (report: WorkloadCheckReport, id: string) => report.database.surfaces.find(s => s.id === id);

afterEach(() => {
  vi.useRealTimers();
});

describe("when nothing is in flight anywhere it looks", () => {
  it("should say nothing was observed, and still hold", async () => {
    const { deps, calls } = harness();
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("zero_observed_not_proof");
    expect(report.hold).toBe(true);
    expect(report.databaseControl).toBe("statement_guard_only");
    expect(report.errors).toEqual([]);
    expect(report.checkedAt).toBe("2026-11-10T12:00:00.000Z");
    expect(report.replica).toEqual(REPLICA);
    expect(report.notCollected.length).toBeGreaterThan(0);
    expect(report.database.surfaces.every(s => s.count === 0 && s.oldestAgeSeconds === null)).toBe(true);
    expect(report.database.intake.every(s => s.count === 0)).toBe(true);
    expect(report.redis).toMatchObject({ backend: "redis", discovery: "complete", unknownQueues: 0 });
  });

  it("should read one snapshot in order, end it, and only then return the connection", async () => {
    const { deps, calls } = harness();
    await runWorkloadCheck(deps);
    expect(calls.statements).toEqual(EVERY_STATEMENT);
    expect(calls.released).toBe(1);
    expect(calls.dropped).toBe(0);
  });

  it("should read every queue state once, discover queues, then quit and drop its Redis connection", async () => {
    const { deps, calls } = harness();
    await runWorkloadCheck(deps);
    expect(calls.reads).toEqual(QUEUE_IDS.flatMap(q => QUEUE_STATES.map(s => `${q}.${s}`)));
    expect(calls.scans).toBe(1);
    expect(calls.redisClosed).toBe(1);
    expect(calls.redisDropped).toBe(1);
  });
});

describe("when work is in flight", () => {
  it("should say so for a work surface, with the age of its oldest item", async () => {
    const { deps } = harness({ rows: { "reconciliation_jobs.unfinished": { count: 2, oldestAgeSeconds: 95 } } });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("no_go_unfinished_work");
    expect(surface(report, "reconciliation_jobs.unfinished")).toMatchObject({ count: 2, oldestAgeSeconds: 95 });
  });

  it.each(RUNNABLE_STATES)("should say so for a queue's %s jobs", async state => {
    const { deps } = harness({}, { states: { [`webhook-delivery.${state}`]: 3 } });
    expect((await runWorkloadCheck(deps)).verdict).toBe("no_go_unfinished_work");
  });

  it("should outrank evidence that is also incomplete", async () => {
    const { deps } = harness({ rows: { "data_deletion_requests.open": { count: 1, oldestAgeSeconds: 5 } } }, { notConfigured: true });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("no_go_unfinished_work");
    expect(report.errors).toContain("redis_not_configured");
  });
});

describe("when only items that are not running are present", () => {
  it("should report parked items without calling them running work", async () => {
    const { deps } = harness({ rows: { "shopify_privacy_requests.parked": { count: 4, oldestAgeSeconds: 86_400 } } });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("zero_observed_not_proof");
    expect(surface(report, "shopify_privacy_requests.parked")?.count).toBe(4);
  });

  it("should report failed jobs and repeat schedules without calling them running work", async () => {
    const { deps } = harness({}, { states: { "reconciliation-runs.failed": 5000, "shopify-order-sync.repeat": 1 } });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("zero_observed_not_proof");
    expect(report.redis.queues.find(q => q.id === "reconciliation-runs")?.states.failed).toBe(5000);
  });
});

describe("when the app is still taking in work", () => {
  it("should call the evidence incomplete rather than quiet", async () => {
    const { deps } = harness({ rows: { "intake.transactions": { count: 12 } } });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(report.errors).toEqual(["intake_observed"]);
  });
});

describe("when the database cannot be read as asked", () => {
  it("should refuse a session that is not pinned to UTC, and destroy the connection", async () => {
    const { deps, calls } = harness({ rows: { "session.timezone": { tz: "SYSTEM" } } });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(report.errors).toContain("database_session_failed");
    expect(calls.statements).toEqual(["session.timezone"]);
    expect(calls).toMatchObject({ released: 0, dropped: 1 });
    expect(report.database.surfaces.every(s => s.count === null)).toBe(true);
  });

  it("should leave unread surfaces null, never zero, and destroy a connection that failed mid-snapshot", async () => {
    const failing = DB_SURFACES[5].id;
    const { deps, calls } = harness({ fail: failing });
    const report = await runWorkloadCheck(deps);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(report.errors).toEqual(expect.arrayContaining(["database_read_failed", "database_cleanup_failed"]));
    expect(report.database.surfaces.slice(0, 5).every(s => s.count === 0)).toBe(true);
    expect(report.database.surfaces.slice(5).every(s => s.count === null)).toBe(true);
    expect(report.database.intake.every(s => s.count === null)).toBe(true);
    expect(report.database.cleanup).toBe("failed");
    expect(calls.statements).not.toContain("session.rollback");
    expect(calls).toMatchObject({ released: 0, dropped: 1 });
  });

  it("should time out a statement that never answers, and destroy its connection", async () => {
    vi.useFakeTimers();
    const { deps, calls } = harness({ hang: "upload_batches.in_progress" });
    const pending = runWorkloadCheck(deps);
    await vi.advanceTimersByTimeAsync(LIMITS.queryMs + 1);
    const report = await pending;
    expect(report.errors).toEqual(expect.arrayContaining(["operation_timeout", "database_read_failed"]));
    expect(calls).toMatchObject({ released: 0, dropped: 1 });
    expect(report.verdict).toBe("no_go_incomplete_evidence");
  });

  it("should stop at the run's budget and say so", async () => {
    vi.useFakeTimers();
    const { deps, calls } = harness({ delayMs: LIMITS.queryMs - 100 });
    const pending = runWorkloadCheck(deps);
    await vi.advanceTimersByTimeAsync(LIMITS.runMs + LIMITS.queryMs);
    const report = await pending;
    expect(report.errors).toContain("run_budget_exhausted");
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(calls.dropped).toBe(1);
    expect(report.redis.backend).toBe("unavailable");
  });

  it.each([
    [{ count: "abc", oldestAgeSeconds: null }],
    [{ count: -1, oldestAgeSeconds: null }],
    [{ count: 3, oldestAgeSeconds: null }],
    [{ count: 0, oldestAgeSeconds: 7 }],
    [undefined],
  ])("should refuse a malformed count %j rather than read it as zero", async row => {
    const { deps } = harness({ rows: { "webhook_deliveries.pending": row } });
    const report = await runWorkloadCheck(deps);
    expect(report.errors).toContain("invalid_database_result");
    expect(report.verdict).not.toBe("zero_observed_not_proof");
  });

  it("should still read Redis when the app has no database", async () => {
    const { deps, calls } = harness({ notConfigured: true });
    const report = await runWorkloadCheck(deps);
    expect(report.errors).toContain("database_unavailable");
    expect(report.database.snapshot).toBe("unavailable");
    expect(calls.reads.length).toBe(QUEUE_IDS.length * QUEUE_STATES.length);
  });

  it("should report a database it could not reach", async () => {
    const { deps } = harness({ openFails: true });
    expect((await runWorkloadCheck(deps)).errors).toContain("database_unavailable");
  });
});

describe("when Redis cannot be read as asked", () => {
  it("should call an app without Redis incomplete: its queued work lives only in memory", async () => {
    const { deps } = harness({}, { notConfigured: true });
    const report = await runWorkloadCheck(deps);
    expect(report.redis.backend).toBe("not_configured");
    expect(report.errors).toEqual(["redis_not_configured"]);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
  });

  it("should report Redis it could not reach", async () => {
    const { deps } = harness({}, { openFails: true });
    const report = await runWorkloadCheck(deps);
    expect(report.errors).toContain("redis_unavailable");
    expect(report.redis.backend).toBe("unavailable");
  });

  it("should leave unread states null and drop the connection after a failed read", async () => {
    const { deps, calls } = harness({}, { fail: "shopify-privacy.wait" });
    const report = await runWorkloadCheck(deps);
    expect(report.errors).toContain("redis_read_failed");
    expect(report.redis.queues.find(q => q.id === "shopify-privacy")?.states.wait).toBeNull();
    expect(calls.redisDropped).toBe(1);
    expect(calls.redisClosed).toBe(0);
    expect(report.verdict).toBe("no_go_incomplete_evidence");
  });

  it("should call discovery incomplete when it cannot finish within its rounds", async () => {
    const { deps, calls } = harness({}, { scanForever: true });
    const report = await runWorkloadCheck(deps);
    expect(calls.scans).toBe(LIMITS.scanRounds);
    expect(report.redis.discovery).toBe("incomplete");
    expect(report.redis.unknownQueues).toBeNull();
    expect(report.errors).toContain("redis_discovery_incomplete");
  });

  it("should count a queue it does not know without ever naming it", async () => {
    const { deps } = harness({}, { scanReplies: [["9", ["bull:reconciliation-runs:meta"]], ["0", [`bull:${UNKNOWN_QUEUE}:meta`]]] });
    const report = await runWorkloadCheck(deps);
    expect(report.redis.unknownQueues).toBe(1);
    expect(report.errors).toContain("unknown_queue_observed");
    expect(report.verdict).toBe("no_go_incomplete_evidence");
    expect(JSON.stringify(report)).not.toContain(UNKNOWN_QUEUE);
  });

  it.each([
    [["0", ["bull:reconciliation-runs:id"]]],
    [["0", ["x".repeat(LIMITS.keyLength + 1)]]],
    [["0", Array.from({ length: LIMITS.scanKeysPerRead + 1 }, () => "bull:reconciliation-runs:meta")]],
    [["not-a-cursor", []]],
    ["0"],
  ])("should refuse a SCAN reply that is not a page of queue metadata keys", async reply => {
    const { deps } = harness({}, { scanReplies: [reply] });
    const report = await runWorkloadCheck(deps);
    expect(report.errors).toContain("invalid_redis_result");
    expect(report.redis.discovery).toBe("incomplete");
    expect(JSON.stringify(report)).not.toContain("bull:");
  });
});
