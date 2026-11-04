/**
 * Startup recovery policy uses synthetic rows and mocked helpers only.
 * Durable/uncertain work must be preserved before DB access or queue creation;
 * the fresh process-local legacy path retains its conditional race protections.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "./jobQueue";
import type { ReconciliationRunPayload } from "./reconciliationQueue";
import { rowOf, scriptedDb, type RecordedOp } from "./connectors/shopify/scriptedDb.testkit";

const state = vi.hoisted(() => ({
  db: null as unknown,
  env: { deploymentMode: "cloud", reconciliationRequireDurableQueue: false },
  getDb: vi.fn<() => Promise<unknown>>(),
  createQueue: vi.fn<() => Promise<JobQueue<ReconciliationRunPayload>>>(),
  enqueue: vi.fn<() => Promise<void>>(),
  remove: vi.fn<(name: string) => Promise<void>>(),
  stats: vi.fn<() => Promise<{ backend: "in-process"; durable: false }>>(),
}));

vi.mock("./db", () => ({ getDb: state.getDb }));
vi.mock("./_core/env", () => ({ ENV: state.env }));
vi.mock("./dbErrors", () => ({ loggableError: () => "synthetic_queue_error" }));
vi.mock("./jobQueue", () => ({
  createQueue: state.createQueue,
  QueueOperationTimeoutError: class extends Error {},
}));

const JOBS = "reconciliation_jobs";
const NOW = new Date("2026-11-04T04:00:00.000Z");
const OLD = new Date("2026-11-04T00:00:00.000Z");
const CUTOFF = new Date("2026-11-04T02:00:00.000Z");
const DEFER_CODE = "[reconciliationQueue] recovery_deferred_unproven_orphanhood";
const LOCAL_DATABASE_URL = "mysql://synthetic:synthetic@127.0.0.1:3306/synthetic";

function staleRows() {
  return [
    { id: 1, status: "pending", createdAt: OLD, startedAt: null, heartbeatAt: null },
    { id: 2, status: "running", createdAt: OLD, startedAt: OLD, heartbeatAt: OLD },
  ].map(row => ({
    ...row, completedAt: null, abandonedAt: null,
    matchedCount: 4, exceptionCount: 2, unmatchedCount: 1, matchRate: "57.14",
  }));
}

function mockQueue(backend: "in-process" | "bullmq" = "in-process"): JobQueue<ReconciliationRunPayload> {
  return {
    backend, enqueue: state.enqueue, stats: state.stats, close: async () => {},
    ...(backend === "bullmq" ? { remove: state.remove } : {}),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("REDIS_URL", undefined);
  vi.stubEnv("DATABASE_URL", LOCAL_DATABASE_URL);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.db = null;
  state.env.deploymentMode = "cloud";
  state.env.reconciliationRequireDurableQueue = false;
  state.getDb.mockImplementation(async () => state.db);
  state.createQueue.mockImplementation(async () => mockQueue());
  state.enqueue.mockResolvedValue(undefined);
  state.remove.mockResolvedValue(undefined);
  state.stats.mockResolvedValue({ backend: "in-process", durable: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function expectDeferredBeforeAccess(reason: string) {
  const rows = staleRows();
  const snapshot = structuredClone(rows);
  const db = scriptedDb({ select: { [JOBS]: [rows, rows] }, update: { [JOBS]: [2] } });
  state.db = db.db;
  const { recoverStuckReconciliationJobs } = await import("./reconciliationQueue");

  await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 0 });

  expect(state.getDb).not.toHaveBeenCalled();
  expect(db.ops).toEqual([]); // no selection, abandonment, artifact writes or deletes
  expect(rows).toEqual(snapshot);
  expect(state.createQueue).not.toHaveBeenCalled();
  expect(state.enqueue).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.stats).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(DEFER_CODE, { reason });
  expect(console.error).not.toHaveBeenCalled();
}

describe("when stale pending/running jobs have configured or required durability", () => {
  it.each(["available", "outage", "fallback", "unknown"] as const)(
    "should defer before inspecting or constructing a configured Redis queue with %s availability",
    async availability => {
      vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
      if (availability === "outage") {
        state.createQueue.mockRejectedValue(new Error("synthetic_secret_must_not_be_logged"));
      } else if (availability === "unknown") {
        state.createQueue.mockImplementation(() => new Promise(() => {}));
      } else {
        state.createQueue.mockResolvedValue(mockQueue(availability === "fallback" ? "in-process" : "bullmq"));
      }
      await expectDeferredBeforeAccess("redis_configured");
    },
  );

  it("should defer when durability is required but Redis is missing", async () => {
    state.env.reconciliationRequireDurableQueue = true;
    await expectDeferredBeforeAccess("durability_required");
  });

  it("should defer in on-premise mode even without Redis or the explicit durable flag", async () => {
    state.env.deploymentMode = "on_premise";
    await expectDeferredBeforeAccess("deployment_not_cloud");
  });

  it("should defer rather than infer a process-local boundary from an unknown deployment mode", async () => {
    state.env.deploymentMode = "unknown";
    await expectDeferredBeforeAccess("deployment_not_cloud");
  });
});

describe("when current missing Redis configuration cannot prove historical orphanhood", () => {
  it.each(["production", "staging", "", undefined])(
    "should preserve stale rows when NODE_ENV is %s rather than explicit development/test",
    async nodeEnv => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      await expectDeferredBeforeAccess("environment_not_development_or_test");
    },
  );
});

describe("when a reconciliation queue is already cached", () => {
  it.each(["in-process", "bullmq"] as const)(
    "should preserve even with no current Redis configuration and a cached %s queue",
    async backend => {
      state.createQueue.mockResolvedValue(mockQueue(backend));
      const { assertReconciliationQueueAvailable } = await import("./reconciliationQueue");
      await assertReconciliationQueueAvailable();
      state.createQueue.mockClear();
      // Neither a local backend nor missing current config authorises disposal
      // of accepted entries. Do not even inspect the existing queue.
      await expectDeferredBeforeAccess("queue_cached");
    },
  );

  it("should return without awaiting an in-progress queue initialization", async () => {
    let resolveQueue!: (queue: JobQueue<ReconciliationRunPayload>) => void;
    state.createQueue.mockImplementation(() => new Promise(resolve => { resolveQueue = resolve; }));
    const { assertReconciliationQueueAvailable } = await import("./reconciliationQueue");
    const initializing = assertReconciliationQueueAvailable();
    state.createQueue.mockClear();
    try {
      await expectDeferredBeforeAccess("queue_cached");
    } finally {
      resolveQueue(mockQueue());
      await initializing;
    }
  });

  it("should defer abandonment if queue initialization starts during candidate selection", async () => {
    const rows = staleRows();
    const db = scriptedDb({ select: { [JOBS]: [rows] }, update: { [JOBS]: [2] } });
    state.db = db.db;
    const { assertReconciliationQueueAvailable, recoverStuckReconciliationJobs } = await import("./reconciliationQueue");
    state.getDb.mockImplementation(async () => {
      await assertReconciliationQueueAvailable();
      return state.db;
    });

    await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 0 });

    expect(db.ops.map(op => op.kind)).toEqual(["select"]);
    expect(db.writes("update", JOBS)).toEqual([]);
    expect(state.createQueue).toHaveBeenCalledTimes(1); // the simulated other caller only
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(DEFER_CODE, { reason: "queue_cached" });
  });
});

describe("when development or test points at a database that is not provably local", () => {
  // `pnpm dev` loads a .env that can name the production database (CLAUDE.md
  // §12). Its stale rows may belong to production's durable queue, which a
  // development process cannot see, so it must not judge them abandoned.
  it.each([
    ["a remote host", "mysql://synthetic:synthetic@db.synthetic.invalid:4000/app"],
    ["a single-label host any network can define", "mysql://synthetic:synthetic@mysql:3306/app"],
    ["unset", undefined],
    ["unparseable", "not a database url"],
  ])("should defer before access when DATABASE_URL is %s", async (_label, url) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", url);
    await expectDeferredBeforeAccess("database_not_local");
  });
});

function expectLegacyPredicates(select: RecordedOp, update: RecordedOp, ids: number[]) {
  const activity = "COALESCE(`reconciliation_jobs`.`heartbeatAt`, `reconciliation_jobs`.`startedAt`, `reconciliation_jobs`.`createdAt`)";
  const predicates = `\`reconciliation_jobs\`.\`status\` in (?, ?) and ${activity} < ? and \`reconciliation_jobs\`.\`abandonedAt\` is null`;
  expect(select.where).toEqual({ sql: `(${predicates})`, params: ["pending", "running", CUTOFF] });
  expect(update.where).toEqual({
    sql: `(\`reconciliation_jobs\`.\`id\` in (${ids.map(() => "?").join(", ")}) and ${predicates})`,
    params: [...ids, "pending", "running", CUTOFF],
  });
  expect(rowOf(update)).toEqual({ status: "failed", completedAt: NOW, abandonedAt: NOW });
}

describe("when a fresh development/test cloud process has no Redis or required durability", () => {
  it.each(["development", "test"])(
    "should retain the legacy conditional sweep and actual affected-row reporting in %s",
    async nodeEnv => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const rows = staleRows();
      const db = scriptedDb({ select: { [JOBS]: [rows, [{ id: 1 }]] }, update: { [JOBS]: [1] } });
      state.db = db.db;
      state.createQueue.mockImplementation(async () => {
        expect(db.ops.map(op => op.kind)).toEqual(["select", "update", "select"]);
        return mockQueue();
      });
      const { recoverStuckReconciliationJobs } = await import("./reconciliationQueue");

      await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 1 });

      expectLegacyPredicates(db.ops[0], db.ops[1], [1, 2]);
      expect(db.ops[2].where).toEqual({
        sql: "(`reconciliation_jobs`.`id` in (?, ?) and `reconciliation_jobs`.`abandonedAt` is not null)",
        params: [1, 2],
      });
      expect(db.ops.map(op => `${op.kind}:${op.table}`)).toEqual([
        `select:${JOBS}`, `update:${JOBS}`, `select:${JOBS}`,
      ]);
      expect(state.createQueue).toHaveBeenCalledTimes(1);
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.enqueue).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith("[reconciliationQueue] boot sweep abandoned 1 stuck job(s) as failed");
    },
  );

  it.each(["completion", "heartbeat", "cancellation", "abandonment"] as const)(
    "should report zero and perform no cleanup when %s wins between selection and update",
    async race => {
      const rows = staleRows();
      const db = scriptedDb({ select: { [JOBS]: [rows] }, update: { [JOBS]: [0] } });
      state.db = db.db;
      const settledRows = rows.map(row => ({
        ...row,
        ...(race === "completion" ? { status: "completed", completedAt: NOW } : {}),
        ...(race === "heartbeat" ? { heartbeatAt: NOW } : {}),
        ...(race === "cancellation" ? { status: "cancelled" } : {}),
        ...(race === "abandonment" ? { status: "failed", abandonedAt: NOW } : {}),
      }));
      const snapshot = structuredClone(settledRows);
      // scriptedDb records predicates, not a SQL evaluator. Zero affected rows
      // models the concurrent write; exact predicates prove it is excluded.
      const { recoverStuckReconciliationJobs } = await import("./reconciliationQueue");

      await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 0 });

      expectLegacyPredicates(db.ops[0], db.ops[1], [1, 2]);
      expect(db.ops.map(op => op.kind)).toEqual(["select", "update"]);
      expect(settledRows).toEqual(snapshot);
      expect(state.createQueue).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.enqueue).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("should not construct a queue or write when the legacy select finds no candidates", async () => {
    const db = scriptedDb({ select: { [JOBS]: [[]] } });
    state.db = db.db;
    const { recoverStuckReconciliationJobs } = await import("./reconciliationQueue");
    await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 0 });
    expect(db.ops.map(op => op.kind)).toEqual(["select"]);
    expect(state.createQueue).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("should not construct a queue or write when the legacy database helper is unavailable", async () => {
    const { recoverStuckReconciliationJobs } = await import("./reconciliationQueue");
    await expect(recoverStuckReconciliationJobs()).resolves.toEqual({ recovered: 0 });
    expect(state.getDb).toHaveBeenCalledTimes(1);
    expect(state.createQueue).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
});

describe("when an instance restarts with reconciliation runs retained in Redis", () => {
  it("should build the worker at boot, so retained runs resume without anyone creating a new run", async () => {
    vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
    state.createQueue.mockResolvedValue(mockQueue("bullmq"));
    const { startReconciliationWorker } = await import("./reconciliationQueue");

    await startReconciliationWorker();

    expect(state.createQueue).toHaveBeenCalledTimes(1);
    expect(state.createQueue).toHaveBeenCalledWith("reconciliation-runs", expect.any(Function), expect.objectContaining({ uniqueJobNames: true }));
    expect(state.enqueue).not.toHaveBeenCalled(); // delivery only: nothing is re-enqueued or replayed
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("should leave the startup sweep deferred while the worker starts", async () => {
    vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
    state.createQueue.mockResolvedValue(mockQueue("bullmq"));
    const { recoverStuckReconciliationJobs, startReconciliationWorker } = await import("./reconciliationQueue");

    const [sweep] = await Promise.all([recoverStuckReconciliationJobs(), startReconciliationWorker()]);

    expect(sweep).toEqual({ recovered: 0 });
    expect(state.getDb).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(DEFER_CODE, { reason: "redis_configured" });
    expect(state.createQueue).toHaveBeenCalledTimes(1);
  });

  it("should not build an in-process queue at boot: it holds nothing across a restart, and would defer the development sweep", async () => {
    const { startReconciliationWorker } = await import("./reconciliationQueue");
    await startReconciliationWorker();
    expect(state.createQueue).not.toHaveBeenCalled();
  });

  it("should be started by the server's boot sequence", () => {
    const boot = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    const hook = boot.indexOf('.then((q) => q.startReconciliationWorker())');
    expect(hook).toBeGreaterThan(-1);
    expect(boot.slice(Math.max(0, hook - 120), hook)).toContain('import("../reconciliationQueue")');
  });
});
