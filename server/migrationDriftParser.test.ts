/**
 * Migration drift detector — DDL parser.
 *
 * The parser is the part that can be quietly wrong. A false NEGATIVE here is the
 * dangerous direction: the tool reports "no drift", the deploy runs anyway, and
 * we are back to discovering the problem from a broken deploy — with the added
 * harm that a green check said it was fine.
 *
 * That is not hypothetical. The first version of this script parsed only CREATE
 * statements, so it would have reported migration 0085 clean — 0085 is
 * `ALTER TABLE organizations ADD aiAssistanceEnabled`, one of the three
 * migrations that actually caused this incident class. Every ALTER form the
 * repository uses is therefore pinned below.
 *
 * The parser is exported from the script and tested directly; the script only
 * opens a database connection when invoked as a command.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no type declarations by design.
import { objectsCreatedBy } from "../scripts/check-migration-drift.mjs";

type Parsed = {
  tables: string[];
  indexes: { index: string; table: string }[];
  columns: { column: string; table: string }[];
};

const parse = (sql: string): Parsed => objectsCreatedBy(sql) as Parsed;

describe("statements that WILL collide are detected", () => {
  it("should find a bare CREATE TABLE", () => {
    expect(parse("CREATE TABLE `widgets` (`id` int);").tables).toEqual(["widgets"]);
  });

  it("should find a bare CREATE INDEX", () => {
    const { indexes } = parse("CREATE INDEX `idx_a` ON `widgets` (`x`);");
    expect(indexes).toEqual([{ index: "idx_a", table: "widgets" }]);
  });

  it("should find ALTER TABLE ... ADD `column` — the commonest form in this repo", () => {
    // 74 occurrences across drizzle/. Missing this was the original defect.
    const { columns } = parse("ALTER TABLE `organizations` ADD `aiAssistanceEnabled` boolean;");
    expect(columns).toEqual([{ column: "aiAssistanceEnabled", table: "organizations" }]);
  });

  it("should find the explicit ADD COLUMN spelling too", () => {
    const { columns } = parse("ALTER TABLE `jobs` ADD COLUMN `heartbeatAt` timestamp;");
    expect(columns).toEqual([{ column: "heartbeatAt", table: "jobs" }]);
  });

  it("should treat ADD CONSTRAINT as an index, because a UNIQUE constraint is one", () => {
    const { indexes, columns } = parse(
      "ALTER TABLE `resolution_templates` ADD CONSTRAINT `uniq_dedupe` UNIQUE(`dedupe_key`);",
    );
    expect(indexes).toEqual([{ index: "uniq_dedupe", table: "resolution_templates" }]);
    // And must NOT be mistaken for a column.
    expect(columns).toEqual([]);
  });

  it("should find ADD INDEX / ADD KEY", () => {
    expect(parse("ALTER TABLE `t` ADD INDEX `idx_b` (`x`);").indexes).toEqual([
      { index: "idx_b", table: "t" },
    ]);
    expect(parse("ALTER TABLE `t` ADD UNIQUE KEY `k_c` (`x`);").indexes).toEqual([
      { index: "k_c", table: "t" },
    ]);
  });
});

describe("statements that CANNOT collide are ignored", () => {
  // Flagging these would produce noise on every clean migration, and a tool that
  // cries wolf is one people stop running.

  it("should ignore guarded CREATE TABLE / CREATE INDEX", () => {
    const parsed = parse(
      "CREATE TABLE IF NOT EXISTS `a` (`id` int);\nCREATE INDEX IF NOT EXISTS `i` ON `a` (`id`);",
    );
    expect(parsed.tables).toEqual([]);
    expect(parsed.indexes).toEqual([]);
  });

  it("should ignore MODIFY COLUMN, which is idempotent", () => {
    const parsed = parse("ALTER TABLE `exceptions` MODIFY COLUMN `organizationId` int NOT NULL;");
    expect(parsed.columns).toEqual([]);
    expect(parsed.indexes).toEqual([]);
  });

  it("should ignore a CREATE INDEX inside a PREPARE guard", () => {
    // Conditional by construction — this is the pattern migration 0090 uses.
    const sql = [
      "SET @i := (SELECT COUNT(1) FROM information_schema.statistics WHERE index_name = 'idx_x');",
      "SET @sql := IF(@i = 0, 'CREATE INDEX `idx_x` ON `t` (`c`)', 'SELECT 1');",
      "PREPARE stmt FROM @sql;",
    ].join("\n");
    expect(parse(sql).indexes).toEqual([]);
  });

  it("should ignore DDL that only appears inside a comment", () => {
    // Migration 0090 carries a long explanatory header quoting its own errors.
    const sql = "-- CREATE TABLE `ghost` (`id` int);\n-- ALTER TABLE `t` ADD `c` int;\nSELECT 1;";
    const parsed = parse(sql);
    expect(parsed.tables).toEqual([]);
    expect(parsed.columns).toEqual([]);
  });
});

describe("against the repository's own migrations", () => {
  const DRIZZLE = path.join(__dirname, "..", "drizzle");
  const read = (tag: string) => fs.readFileSync(path.join(DRIZZLE, `${tag}.sql`), "utf8");

  it("should detect what migration 0089 would create", () => {
    // ALTER TABLE `reconciliation_jobs` ADD `heartbeatAt` timestamp;
    const { columns } = parse(read("0089_reconciliation_job_heartbeat"));
    expect(columns).toEqual([{ column: "heartbeatAt", table: "reconciliation_jobs" }]);
  });

  it("should report migration 0090 as collision-free now that it is guarded", () => {
    // Every statement in 0090 is guarded after PR #104, so a re-run cannot
    // collide — which is exactly why the deploy finally succeeded.
    const parsed = parse(read("0090_typical_the_executioner"));
    expect(parsed.tables).toEqual([]);
    expect(parsed.indexes).toEqual([]);
    expect(parsed.columns).toEqual([]);
  });

  it("should find at least one collision-producing statement across the migration set", () => {
    // Guards against the parser silently matching nothing at all — the failure
    // mode that would make every other assertion here vacuous.
    const all = fs
      .readdirSync(DRIZZLE)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => parse(fs.readFileSync(path.join(DRIZZLE, f), "utf8")));
    const totalColumns = all.reduce((n, p) => n + p.columns.length, 0);
    const totalTables = all.reduce((n, p) => n + p.tables.length, 0);
    expect(totalColumns).toBeGreaterThan(50); // 74 ADD-column statements at time of writing
    expect(totalTables).toBeGreaterThan(10);
  });
});
