/**
 * The workload check may send only the catalogue's statements and commands.
 * These tests prove what those are, and that the catalogue still matches the
 * code it describes: every queue the code creates, and every migration since
 * the surfaces were last reconciled.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allStatements,
  compileRedisRead,
  compileStatement,
  DB_SURFACES,
  INTAKE_SOURCES,
  QUEUE_IDS,
  QUEUE_STATES,
  RUNNABLE_STATES,
  SCAN_MATCH,
  type DatabaseStatementId,
  type RedisReadId,
} from "./workloadCatalogue";

const REPO = path.resolve(__dirname, "..", "..");

/**
 * The newest migration the surfaces were reconciled against. When a migration
 * lands after it, this fails until someone checks the new tables and states for
 * work a replacement could cut off, updates DB_SURFACES if needed, and moves
 * this forward. Carried over from the reviewed preflight and observer.
 */
const COVERAGE_RECONCILED_THROUGH_MIGRATION = "0119_shopline_billing_charges";

/** Every createQueue call in the server, by file, and the queues it names. */
const QUEUE_CALL_SITES: Record<string, string[]> = {
  "server/reconciliationQueue.ts": ["reconciliation-runs"],
  "server/webhookDelivery.ts": ["webhook-delivery"],
  "server/connectors/shopify/syncQueue.ts": ["shopify-manual-sync", "shopify-order-sync"],
  "server/connectors/shopify/privacyQueue.ts": ["shopify-privacy"],
  "server/connectors/shopline/realtimeSync.ts": ["shopline-realtime-sync"],
};

const SESSION_STATEMENTS = new Map<string, string>([
  ["session.timezone", "SELECT @@session.time_zone AS tz"],
  ["session.snapshot", "START TRANSACTION WITH CONSISTENT SNAPSHOT"],
  ["session.rollback", "ROLLBACK"],
]);
const WRITES_OR_LOCKS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|LOAD|HANDLER|SET|COMMIT|SAVEPOINT|FOR\s+SHARE|SHARE\s+MODE|SLEEP|BENCHMARK|INTO)\b/i;

describe("when the check sends a database statement", () => {
  it("should only open, read in and end one snapshot", () => {
    const entries = allStatements();
    expect(entries).toHaveLength(SESSION_STATEMENTS.size + DB_SURFACES.length + INTAKE_SOURCES.length);
    for (const [id, sql] of entries) {
      if (SESSION_STATEMENTS.has(id)) {
        expect(sql).toBe(SESSION_STATEMENTS.get(id));
        continue;
      }
      expect(sql.startsWith("SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count")).toBe(true);
      expect(sql).not.toContain(";");
      expect(sql.replace(/\/\*\+ MAX_EXECUTION_TIME\(1000\) \*\//, "")).not.toMatch(/\/\*|--|#/);
      expect(sql, id).not.toMatch(WRITES_OR_LOCKS);
    }
  });

  it("should refuse an id that is not in the catalogue", () => {
    expect(() => compileStatement("DELETE FROM organizations" as DatabaseStatementId)).toThrow("statement_refused");
    expect(() => compileStatement("intake.organizations" as DatabaseStatementId)).toThrow("statement_refused");
  });

  it("should count every surface and intake source by its own table", () => {
    for (const s of DB_SURFACES) expect(compileStatement(s.id)).toContain(` FROM ${s.table} WHERE `);
    for (const s of INTAKE_SOURCES)
      expect(compileStatement(`intake.${s.id}`)).toBe(
        `SELECT /*+ MAX_EXECUTION_TIME(1000) */ COUNT(*) AS count FROM ${s.table} WHERE ${s.time} >= NOW() - INTERVAL 360 SECOND`,
      );
  });

  it("should name only tables the schema defines", () => {
    const schema = readdirSync(path.join(REPO, "drizzle"))
      .filter(file => file.endsWith(".ts"))
      .map(file => readFileSync(path.join(REPO, "drizzle", file), "utf8"))
      .join("\n");
    for (const table of new Set([...DB_SURFACES.map(s => s.table), ...INTAKE_SOURCES.map(s => s.table)]))
      expect(new RegExp(`mysqlTable\\(\\s*"${table}"`).test(schema), table).toBe(true);
  });
});

describe("when the check sends a Redis command", () => {
  it("should read one queue state key with LLEN or ZCARD and nothing else", () => {
    for (const q of QUEUE_IDS)
      for (const s of QUEUE_STATES) {
        const read = compileRedisRead(`${q}.${s}`);
        expect(read.key).toBe(`bull:${q}:${s}`);
        expect(read.command).toBe(s === "wait" || s === "paused" || s === "active" ? "LLEN" : "ZCARD");
      }
    expect(() => compileRedisRead("reconciliation-runs.completed" as RedisReadId)).toThrow("redis_read_refused");
  });

  it("should only discover queues through their metadata keys", () => {
    expect(SCAN_MATCH).toBe("bull:*:meta");
  });

  it("should treat failed jobs and repeat schedules as not running", () => {
    expect(RUNNABLE_STATES).toEqual(["wait", "paused", "active", "delayed", "prioritized", "waiting-children"]);
  });
});

describe("when the deployed code is compared with what the check counts", () => {
  it("should know every queue the code creates", () => {
    const sites: Record<string, number> = {};
    for (const entry of readdirSync(path.join(REPO, "server"), { recursive: true })) {
      const file = `server/${String(entry).split(path.sep).join("/")}`;
      if (!file.endsWith(".ts") || /\.(test|testkit|d)\.ts$/.test(file) || /\.fixture\./.test(file)) continue;
      const text = readFileSync(path.join(REPO, file), "utf8");
      const calls = text.match(/(?<!function\s+)\bcreateQueue\s*(?:<[^<>()]*>)?\s*\(/g);
      if (calls) sites[file] = calls.length;
    }
    expect(sites).toEqual(Object.fromEntries(Object.entries(QUEUE_CALL_SITES).map(([file, names]) => [file, names.length])));
    const named = new Set<string>();
    for (const [file, names] of Object.entries(QUEUE_CALL_SITES)) {
      const text = readFileSync(path.join(REPO, file), "utf8");
      for (const name of names) {
        expect(text, `${file} names ${name}`).toContain(`"${name}"`);
        named.add(name);
      }
    }
    expect([...named].sort()).toEqual([...QUEUE_IDS].sort());
  });

  it("should have been reconciled against the newest migration", () => {
    const journal = JSON.parse(readFileSync(path.join(REPO, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.at(-1)?.tag).toBe(COVERAGE_RECONCILED_THROUGH_MIGRATION);
  });
});
