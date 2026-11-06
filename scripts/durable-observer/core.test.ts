import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  DB_SURFACES, INTAKE_SOURCES, QUEUE_IDS, QUEUE_STATES, LIMITS,
  compileDatabaseQuery, compileRedisRead, compileRedisScan,
  type DatabaseQueryId, type RedisReadId,
} from "./catalogue";
import { observeDurableStores, type ObserverDependencies } from "./core";
import { ERROR_CODES, NOT_COLLECTED } from "./contracts";

function fixture() {
  let time = 0;
  const databaseRead = vi.fn(async (id: DatabaseQueryId, _signal: AbortSignal): Promise<unknown> =>
    id.startsWith("session.") ? undefined : { count: "0", oldestAgeSeconds: null });
  const redisRead = vi.fn(async (_id: RedisReadId, _signal: AbortSignal): Promise<unknown> => "0");
  const scan = vi.fn(async (_cursor: string, _signal: AbortSignal): Promise<unknown> =>
    ["0", QUEUE_IDS.map(id => `bull:${id}:meta`)]);
  const databaseClose = vi.fn(async (_signal: AbortSignal): Promise<void> => {});
  const redisClose = vi.fn(async (_signal: AbortSignal): Promise<void> => {});
  const databaseDrop = vi.fn((): void => {}), redisDrop = vi.fn((): void => {});
  const wait = vi.fn(async (milliseconds: number, _signal: AbortSignal): Promise<void> => { time += milliseconds; });
  const deps: ObserverDependencies = {
    database: { read: databaseRead, close: databaseClose, drop: databaseDrop },
    redis: { read: redisRead, scan, close: redisClose, drop: redisDrop },
    clock: { now: () => time, wait },
  };
  return { deps, databaseRead, redisRead, scan, databaseClose, redisClose, databaseDrop, redisDrop, wait };
}
afterEach(() => vi.useRealTimers());

describe("when all fixed durable populations are observed as zero", () => {
  it("should keep a hold and never claim safety or exact intake proof", async () => {
    const f = fixture();
    const result = await observeDurableStores(f.deps);
    expect(result).toMatchObject({ schema: "reconcileai_durable_observer_v1", execution: "synthetic_only",
      hold: true, databaseControl: "statement_guard_only", verdict: "zero_observed_not_proof", errors: [] });
    expect(result.notCollected).toEqual(NOT_COLLECTED);
    expect(result.samples).toHaveLength(3);
    expect(result.samples.map(s => s.elapsedMs)).toEqual([0, 60_000, 120_000]);
    expect(f.wait.mock.calls.map(c => c[0])).toEqual([60_000, 60_000]);
    expect(result.samples[0].database.intake.every(s => s.count === null)).toBe(true);
    expect(result.samples.slice(1).every(s => s.database.intake.every(i => i.count === 0))).toBe(true);
    expect(f.databaseRead.mock.calls.map(c => c[0]).filter(id => id === "session.utc")).toEqual(["session.utc"]);
    expect(f.databaseRead.mock.calls.map(c => c[0]).filter(id => id === "session.snapshot")).toHaveLength(3);
    expect(f.databaseRead.mock.calls.map(c => c[0]).filter(id => id === "session.rollback")).toHaveLength(3);
    expect(f.databaseRead.mock.calls.length).toBeLessThanOrEqual(LIMITS.databaseCommands);
    expect(f.redisRead.mock.calls.length + f.scan.mock.calls.length).toBeLessThanOrEqual(LIMITS.redisCommands);
    expect(f.databaseClose).toHaveBeenCalledTimes(1);
    expect(f.redisClose).toHaveBeenCalledTimes(1);
  });
});

describe("when any catalogued durable population is positive", () => {
  it.each(DB_SURFACES.map(s => s.id))("should retain %s as a blocker, including parked subsets", async id => {
    const f = fixture();
    f.databaseRead.mockImplementation(async query => query === id ? { count: "3", oldestAgeSeconds: "7" } :
      query.startsWith("session.") ? undefined : { count: 0, oldestAgeSeconds: null });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_unfinished_work");
    expect(result.samples[0].database.surfaces.find(s => s.id === id)).toEqual({ id, count: 3, oldestAgeSeconds: 7 });
  });
  it.each(QUEUE_STATES)("should retain Redis %s entries without assuming terminal work is safe", async state => {
    const f = fixture();
    f.redisRead.mockImplementation(async id => id === `reconciliation-runs.${state}` ? 1 : 0);
    expect((await observeDurableStores(f.deps)).verdict).toBe("no_go_unfinished_work");
  });
  it("should preserve unfinished no-go when later reads or rollback fail", async () => {
    const f = fixture();
    f.databaseRead.mockImplementation(async id => {
      if (id === DB_SURFACES[0].id) return { count: 4, oldestAgeSeconds: null };
      if (id === DB_SURFACES[1].id) throw new Error("secret-table-row-diagnostics");
      return undefined;
    });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_unfinished_work");
    expect(result.samples[0].database.cleanup).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret-table-row-diagnostics");
    expect(f.databaseDrop).toHaveBeenCalled();
  });
});

describe("when the owned database session cannot establish or clean its snapshot", () => {
  it.each(["session.utc", "session.snapshot", "session.rollback"] as const)("should poison rather than fall back after %s fails", async failed => {
    const f = fixture();
    f.databaseRead.mockImplementation(async id => {
      if (id === failed) throw { message: "private://host?credential=hidden" };
      return id.startsWith("session.") ? undefined : { count: 0, oldestAgeSeconds: null };
    });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(f.databaseDrop).toHaveBeenCalled();
    expect(f.databaseClose).not.toHaveBeenCalled();
    const ids = f.databaseRead.mock.calls.map(c => c[0]);
    expect(ids.filter(id => id === failed)).toHaveLength(1);
    if (failed !== "session.rollback") {
      expect(ids.some(id => !id.startsWith("session."))).toBe(false);
      expect(result.samples.every(s => s.database.snapshot === "unavailable")).toBe(true);
    } else expect(result.samples[0].database.cleanup).toBe("failed");
    expect(result.errors.every(code => ERROR_CODES.includes(code))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private://");
  });
  it("should mark database cleanup failed on a rejected close", async () => {
    const f = fixture();
    f.databaseClose.mockRejectedValue(new Error("sensitive-close-message"));
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.samples[2].database.cleanup).toBe("failed");
    expect(result.errors).toContain("cleanup_failed");
  });
  it("should keep cleanup failures fixed and retain Redis work read before a later error", async () => {
    const f = fixture();
    f.redisRead.mockImplementation(async id => {
      if (id === "reconciliation-runs.wait") return 2;
      throw new Error("redis-secret-key");
    });
    f.redisDrop.mockImplementation(() => { throw new Error("drop-private-socket"); });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_unfinished_work");
    expect(result.errors).toContain("cleanup_failed");
    expect(f.redisRead).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/redis-secret-key|drop-private-socket/);
  });
});

describe("when responses are corrupted or contain unknown metadata", () => {
  it.each([NaN, Infinity, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "01", "1e3", "0x10", "9007199254740992", {}, null])(
    "should refuse invalid finite integer input %s", async value => {
      const f = fixture();
      f.databaseRead.mockImplementation(async id => id.startsWith("session.") ? undefined : { count: value, oldestAgeSeconds: null });
      f.redisRead.mockResolvedValue(value);
      const result = await observeDurableStores(f.deps);
      expect(result.verdict).toBe("no_go_incomplete_evidence");
      expect(result.samples[0].database.surfaces.every(s => s.count === null)).toBe(true);
      expect(result.samples[0].redis.queues.every(q => Object.values(q.states).every(c => c === null))).toBe(true);
    });
  it("should avoid invoking accessor diagnostics and preserve a valid positive count with an invalid age", async () => {
    const f = fixture();
    const value = { count: 2, get oldestAgeSeconds(): never { throw new Error("secret-age"); } };
    f.databaseRead.mockImplementation(async id => id.startsWith("session.") ? undefined : value);
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_unfinished_work");
    expect(result.errors).toContain("invalid_database_result");
    expect(result.samples[0].database.surfaces[0].count).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret-age");
  });
  it.each([0, null])("should discard corrupt ages for %s counts without dropping valid counts", async count => {
    const f = fixture();
    f.databaseRead.mockImplementation(async id => id.startsWith("session.") ? undefined : { count, oldestAgeSeconds: 12 });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.samples.every(s => s.database.surfaces.every(row => row.oldestAgeSeconds === null))).toBe(true);
  });
  it("should retain and deduplicate unknown queues internally without querying arbitrary names", async () => {
    const f = fixture();
    f.scan.mockResolvedValue(["0", ["bull:unknown_private_queue:meta", "bull:unknown_private_queue:meta"]]);
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.samples.every(s => s.redis.unknownQueues === 1)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("unknown_private_queue");
    expect(f.redisRead.mock.calls.every(([id]) => QUEUE_IDS.some(q => id.startsWith(`${q}.`)))).toBe(true);
  });
  it.each([
    ["invalid-cursor", []], ["0", ["bull:bad:name:meta"]], ["0", ["bull:secret-☃:meta"]],
    ["0", Array(257).fill("bull:x:meta")], ["0", [`bull:${"x".repeat(257)}:meta`]],
    ["0", Array.from({ length: 129 }, (_, n) => `bull:unknown_${n}:meta`)],
  ])("should retain incomplete discovery for malformed or capped SCAN %s", async (cursor, keys) => {
    const f = fixture(); f.scan.mockResolvedValue([cursor, keys]);
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.samples.every(s => s.redis.discovery === "incomplete")).toBe(true);
  });
  it("should stop discovery at its round limit and retain unknown evidence already found", async () => {
    const f = fixture(); f.scan.mockResolvedValue(["1", ["bull:hidden:meta"]]);
    const result = await observeDurableStores(f.deps);
    expect(f.scan).toHaveBeenCalledTimes(LIMITS.scanRounds * LIMITS.samples);
    expect(result.samples[0].redis).toMatchObject({ discovery: "incomplete", unknownQueues: 1 });
  });
  it("should finish discovery over the keyspace the app's own job retention allows", async () => {
    // About 36,000 job keys (1,000 completed + 5,000 failed per queue, six
    // queues) took 37 SCAN calls of COUNT 1000 on a real Redis 7.
    const f = fixture();
    let call = 0;
    f.scan.mockImplementation(async () => {
      call += 1;
      const round = ((call - 1) % 37) + 1;
      return round === 37 ? ["0", QUEUE_IDS.map(id => `bull:${id}:meta`)] : [String(round * 4096), []];
    });
    const result = await observeDurableStores(f.deps);
    expect(f.scan).toHaveBeenCalledTimes(37 * LIMITS.samples);
    expect(result.samples.every(s => s.redis.discovery === "complete" && s.redis.unknownQueues === 0)).toBe(true);
    expect(result.verdict).toBe("zero_observed_not_proof");
    expect(f.redisRead.mock.calls.length + f.scan.mock.calls.length).toBeLessThanOrEqual(LIMITS.redisCommands);
  });
  it("should block intake activity without treating it as unfinished work", async () => {
    const f = fixture();
    f.databaseRead.mockImplementation(async id => id.startsWith("intake.") ? { count: 1 } :
      id.startsWith("session.") ? undefined : { count: 0, oldestAgeSeconds: null });
    const result = await observeDurableStores(f.deps);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.errors).toContain("intake_observed");
  });
});

describe("when an operation does not settle", () => {
  it.each(["database", "redis"] as const)("should cancel and drop the one %s connection rather than reuse it", async store => {
    vi.useFakeTimers();
    const f = fixture(); let signal: AbortSignal | undefined;
    const hang = async (_id: string, cancellation: AbortSignal): Promise<unknown> => {
      signal = cancellation; return new Promise(() => {});
    };
    if (store === "database") f.databaseRead.mockImplementation(hang);
    else f.redisRead.mockImplementation(hang);
    const pending = observeDurableStores(f.deps);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.verdict).toBe("no_go_incomplete_evidence");
    expect(result.errors).toContain("operation_timeout");
    expect(store === "database" ? f.databaseRead : f.redisRead).toHaveBeenCalledTimes(1);
    expect(store === "database" ? f.databaseDrop : f.redisDrop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("should bound hung cleanup and never expose its raw error", async () => {
    vi.useFakeTimers(); const f = fixture(); let signal: AbortSignal | undefined;
    f.databaseClose.mockImplementation(async cancellation => { signal = cancellation; return new Promise(() => {}); });
    const pending = observeDurableStores(f.deps); await vi.runAllTimersAsync();
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.samples[2].database.cleanup).toBe("failed");
    expect(result.verdict).toBe("no_go_incomplete_evidence");
  });
  it("should stop a hung clock wait and classify a regressing clock as incomplete", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.wait.mockImplementation(async () => new Promise(() => {}));
    const pending = observeDurableStores(f.deps); await vi.runAllTimersAsync();
    expect((await pending).samples).toHaveLength(1);
    const g = fixture(); let n = 0; g.deps.clock.now = () => n++ === 0 ? 10 : 0;
    expect((await observeDurableStores(g.deps)).verdict).toBe("no_go_incomplete_evidence");
  });
  it("should reject a prematurely returned injected wait without altering sample limits", async () => {
    const f = fixture(); f.wait.mockImplementation(async () => {});
    const result = await observeDurableStores(f.deps);
    expect(result.samples).toHaveLength(1);
    expect(result.errors).toContain("clock_invalid");
  });
  it("should stop at the fixed whole-run elapsed budget and drop owned resources", async () => {
    const f = fixture(); let n = 0;
    f.deps.clock.now = () => n++ === 0 ? 0 : LIMITS.runMs;
    const result = await observeDurableStores(f.deps);
    expect(result.samples).toHaveLength(0);
    expect(result.errors).toContain("run_budget_exhausted");
    expect(f.databaseRead).not.toHaveBeenCalled();
    expect(f.databaseDrop).toHaveBeenCalled();
    expect(f.redisDrop).toHaveBeenCalled();
  });
});

const root = resolve(import.meta.dirname, "../..");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") && !/\.(test|spec|testkit)\.ts$/.test(entry.name) ? [path] : [];
  });
}
describe("when the pinned finite catalogue is checked against the fresh source tree", () => {
  it("should cover every production createQueue site and its literal or reviewed default", () => {
    const expected: Record<string, readonly string[]> = {
      "server/reconciliationQueue.ts": ["reconciliation-runs"],
      "server/webhookDelivery.ts": ["webhook-delivery"],
      "server/connectors/shopify/syncQueue.ts": ["shopify-order-sync", "shopify-manual-sync"],
      "server/connectors/shopify/privacyQueue.ts": ["shopify-privacy"],
      "server/connectors/shopline/realtimeSync.ts": ["shopline-realtime-sync"],
    };
    const found: string[] = [];
    for (const file of sourceFiles(resolve(root, "server"))) {
      const source = readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const relative = file.slice(root.length + 1);
      let calls = 0;
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createQueue") {
          calls++;
          expect(expected[relative], `unreviewed queue site ${relative}`).toBeDefined();
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) expect(QUEUE_IDS).toContain(argument.text);
          else {
            expect(argument?.getText(parsed)).toBe("name");
            if (relative === "server/connectors/shopline/realtimeSync.ts") {
              expect(source).toMatch(/name: string = SHOPLINE_REALTIME_QUEUE/);
              expect(source).toMatch(/SHOPLINE_REALTIME_QUEUE = "shopline-realtime-sync"/);
            } else {
              expect(relative).toBe("server/connectors/shopify/syncQueue.ts");
              expect(source).toMatch(/name: string = SHOPIFY_MANUAL_SYNC_QUEUE/);
              expect(source).toMatch(/SHOPIFY_MANUAL_SYNC_QUEUE = "shopify-manual-sync"/);
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(parsed);
      if (calls > 0) { expect(calls).toBe(expected[relative].length); found.push(...expected[relative]); }
    }
    expect(found.sort()).toEqual([...QUEUE_IDS].sort());
  });
  it("should find every catalogue table and referenced column in SQL migration DDL", () => {
    const migrations = readdirSync(resolve(root, "drizzle")).filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
    const ddl = migrations.map(name => readFileSync(resolve(root, "drizzle", name), "utf8")).join("\n");
    const columns = new Map<string, Set<string>>();
    for (const match of ddl.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`\s*\(([\s\S]*?)\n\);/g)) {
      columns.set(match[1], new Set([...match[2].matchAll(/^\s*`([^`]+)`\s+/gm)].map(m => m[1])));
    }
    for (const match of ddl.matchAll(/ALTER TABLE `([^`]+)` ADD(?: COLUMN)? `([^`]+)`/g)) columns.get(match[1])?.add(match[2]);
    for (const s of [...DB_SURFACES, ...INTAKE_SOURCES]) {
      const tableColumns = columns.get(s.table);
      expect(tableColumns, `missing ${s.table} migration`).toBeDefined();
      const expressions = "where" in s ? `${s.where} ${s.time}` : s.time;
      const identifiers = expressions.replace(/'[^']*'/g, "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const id of identifiers.filter(id => !["IN", "AND", "IS", "NULL", "OR", "COALESCE", "NOW", "INTERVAL", "MINUTE"].includes(id))) {
        expect(tableColumns?.has(id), `missing ${s.table}.${id} migration`).toBe(true);
      }
    }
  });
  it("should accept only exact fixed query/read tokens and fixed capped SCAN syntax", () => {
    for (const s of DB_SURFACES) expect(compileDatabaseQuery(s.id)).toMatch(/^SELECT .*COUNT\(\*\).*TIMESTAMPDIFF\(SECOND/);
    for (const s of INTAKE_SOURCES) expect(compileDatabaseQuery(`intake.${s.id}`)).toContain("INTERVAL 360 SECOND");
    expect(compileDatabaseQuery("session.utc")).toBe("SET time_zone = '+00:00'");
    expect(compileDatabaseQuery("session.snapshot")).toBe("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    expect(compileDatabaseQuery("session.rollback")).toBe("ROLLBACK");
    for (const q of QUEUE_IDS) for (const state of QUEUE_STATES) expect(compileRedisRead(`${q}.${state}`)).toEqual({
      command: ["wait", "paused", "active"].includes(state) ? "LLEN" : "ZCARD", args: [`bull:${q}:${state}`] });
    expect(compileRedisScan("0")).toEqual({ command: "SCAN", args: ["0", "MATCH", "bull:*:meta", "COUNT", "1000"] });
    expect(() => compileDatabaseQuery("SELECT COUNT(*) FROM users" as DatabaseQueryId)).toThrow("query_refused");
    expect(() => compileRedisRead("other.active" as RedisReadId)).toThrow("redis_read_refused");
    expect(() => compileRedisScan("0 MATCH *")).toThrow("redis_scan_refused");
  });
  it("should keep production modules free of driver imports, runtime reads, logging, and unsafe type escapes", () => {
    for (const name of ["catalogue.ts", "contracts.ts", "core.ts"]) {
      const source = readFileSync(resolve(root, "scripts/durable-observer", name), "utf8");
      const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        expect(node.kind).not.toBe(ts.SyntaxKind.AnyKeyword);
        if (ts.isImportDeclaration(node)) expect((node.moduleSpecifier as ts.StringLiteral).text).toMatch(/^\.\/(catalogue|contracts)$/);
        if (ts.isIdentifier(node)) expect(["process", "console", "require", "fetch", "Queue", "Worker"]).not.toContain(node.text);
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
  });
});
