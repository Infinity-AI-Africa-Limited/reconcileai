/**
 * Migration-chain integrity.
 *
 * Two failure modes, both of which have already cost this project a broken or
 * silently-incomplete deploy, and neither of which is visible in a diff review.
 *
 * 1. NON-MONOTONIC JOURNAL TIMESTAMPS — a migration that never runs.
 *    drizzle-orm's MySQL migrator does not order by `idx`. It reads the single
 *    most recent applied row and applies an entry only when:
 *
 *      Number(lastDbMigration.created_at) < migration.folderMillis
 *
 *    (node_modules/drizzle-orm/mysql-core/dialect.js). `folderMillis` is the
 *    journal's `when`. So a new migration whose `when` is LOWER than one
 *    already applied is skipped in silence — no error, no log, and the column
 *    the application expects simply is not there.
 *
 *    This is not hypothetical: 0085-0087 were hand-written with fabricated
 *    future timestamps, so `drizzle-kit generate` stamped 0088 with a real
 *    clock value BELOW them. Left alone it would have deployed green and the
 *    `abandonedAt` column would never have existed in production.
 *
 * 2. HAND-WRITTEN MIGRATIONS WITH NO META SNAPSHOT.
 *    `drizzle-kit generate` diffs against the newest snapshot. A migration
 *    added by hand leaves the snapshot chain behind, and the next generate can
 *    re-emit DDL that has already been applied — which is how a duplicate
 *    migration broke a Railway deploy before (ER_TABLE_EXISTS).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DRIZZLE = path.join(__dirname, "..", "drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("the migration journal", () => {
  it("should order `when` strictly ascending, so no migration is silently skipped", () => {
    const offenders: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const cur = journal.entries[i];
      if (cur.when <= prev.when) {
        offenders.push(`${cur.tag} (when=${cur.when}) does not come after ${prev.tag} (when=${prev.when})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("should list entries in idx order with no gaps or repeats", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("should have a .sql file for every entry", () => {
    const missing = journal.entries
      .map((e) => `${e.tag}.sql`)
      .filter((f) => !fs.existsSync(path.join(DRIZZLE, f)));
    expect(missing).toEqual([]);
  });
});

describe("migration meta snapshots", () => {
  /**
   * Migrations added by hand rather than by `drizzle-kit generate`, each with
   * the reason it is tolerated. Keep this list EMPTY where possible — every
   * entry is a break in the snapshot chain.
   */
  const SNAPSHOTLESS: Record<string, string> = {
    "0050_cheerful_captain_america":
      "PRE-EXISTING, from the Uganda mobile-money work (49d99f0, 2026-07-04) — not introduced " +
      "by this change. Two enum-widening MODIFY COLUMNs on mm_runs / mm_exceptions. Recorded " +
      "rather than back-filled: hand-writing a snapshot for an applied migration is riskier " +
      "than the gap it closes, and later generates have diffed cleanly past it.",
    "0084_exception_ownership_required":
      "hand-written data migration (backfill + ownership assertion). It only MODIFYs an " +
      "existing column and creates two auxiliary tables that are not modelled in schema.ts, " +
      "so the snapshot chain stays consistent: 0088 generated cleanly from 0087 with no " +
      "spurious DDL. Do not add more entries here — generate migrations instead.",
  };

  it("should have a snapshot for every generated migration", () => {
    const missing = journal.entries
      .filter((e) => !fs.existsSync(path.join(DRIZZLE, "meta", `${String(e.idx).padStart(4, "0")}_snapshot.json`)))
      .map((e) => e.tag)
      .filter((tag) => !(tag in SNAPSHOTLESS));
    expect(missing).toEqual([]);
  });
});

describe("migration 0084 (exception ownership)", () => {
  const sql = fs.readFileSync(path.join(DRIZZLE, "0084_exception_ownership_required.sql"), "utf8");

  it("should derive ownership from the reconciliation job, and from nothing else", () => {
    // Runtime ownership comes from the parent job (runReconciliation's
    // `runOrganizationId`), and migration 0078 backfilled the same column the
    // same way. The job is the only authority.
    expect(sql).toContain("JOIN `reconciliation_jobs` AS `j`");
  });

  it("should not guess an owner from the transaction when the job cannot supply one", () => {
    // Those are exactly the rows where the authoritative evidence is gone: with
    // no job there is nothing to corroborate the transaction's tenant against,
    // and the two can differ. Filing a control record against a guessed tenant
    // is the defect this migration exists to prevent, so unattributable rows
    // fall through to the assertion and are preserved by the operator drain.
    expect(sql).not.toContain("JOIN `transactions`");
  });

  it("should never delete exception rows during an unattended deploy", () => {
    // `pnpm db:migrate` is a Railway pre-deploy step and runs unattended in
    // on-premise installations. Destroying financial control records there is
    // not a decision a deploy hook may take — an earlier revision of this file
    // issued an unconditional DELETE with no impact assertion.
    expect(sql).not.toMatch(/DELETE\s+FROM\s+`exceptions`/i);
  });

  it("should fail closed when any exception is left unattributable", () => {
    expect(sql).toContain("_migration_0084_ownership_assertion");
    // The assertion must run BEFORE the column is tightened, or the migration
    // fails on the ALTER with a far less legible error.
    const assertion = sql.indexOf("SELECT NULL FROM `exceptions` WHERE `organizationId` IS NULL");
    const alter = sql.indexOf("MODIFY COLUMN `organizationId` int NOT NULL");
    expect(assertion).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(assertion);
  });

  it("should point the operator at the drain script it names", () => {
    expect(sql).toContain("scripts/drain-unattributable-exceptions.mjs");
    expect(fs.existsSync(path.join(__dirname, "..", "scripts", "drain-unattributable-exceptions.mjs"))).toBe(true);
  });
});

/**
 * Engine portability.
 *
 * Migrations run against TWO engines, and they do not accept the same SQL:
 *   - production is TiDB (8.0.11-TiDB-v8.5.3-serverless)
 *   - CI is mysql:8.0, via `pnpm db:push` = `drizzle-kit generate && migrate`
 *
 * TiDB accepts several extensions MySQL rejects outright. `CREATE INDEX IF NOT
 * EXISTS` is the one that has already cost time: it is valid TiDB, and MySQL
 * 8.0 answers `ERROR 1064` — a parse error, so the migration cannot even start.
 * A migration using it passes against production and fails in CI and on any
 * MySQL-based on-premise install.
 *
 * Verified both ways on real engines (2026-08-22) rather than inferred from
 * documentation.
 *
 * The portable way to make index creation idempotent is the information_schema
 * + PREPARE guard, which both engines accept.
 */
describe("migration SQL portability", () => {
  /** Constructs TiDB accepts and MySQL 8.0 does not. */
  const TIDB_ONLY: { pattern: RegExp; why: string }[] = [
    {
      pattern: /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i,
      why: "MySQL 8.0 rejects `CREATE INDEX IF NOT EXISTS` with ERROR 1064. Guard the index with information_schema + PREPARE instead.",
    },
    {
      pattern: /DROP\s+INDEX\s+IF\s+EXISTS/i,
      why: "MySQL 8.0 rejects `DROP INDEX IF EXISTS`. Guard it with information_schema + PREPARE instead.",
    },
  ];

  /**
   * Executable SQL only.
   *
   * A migration header may legitimately NAME a forbidden construct while
   * explaining why not to use it. Migration 0090's header does exactly that, and
   * it tripped this guard in CI — the guard fired on the documentation telling
   * people not to do the thing. Scanning raw text teaches readers to delete the
   * explanation rather than fix the SQL.
   *
   * Only WHOLE-LINE comments are dropped. A trailing `-- note` after real DDL
   * leaves that DDL on the line and still scannable, so this narrows what is
   * examined without creating a place to hide a statement.
   */
  const executableSql = (sql: string): string =>
    sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

  it("should contain no TiDB-only syntax that MySQL would reject", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(DRIZZLE).filter((f) => f.endsWith(".sql"))) {
      const sql = executableSql(fs.readFileSync(path.join(DRIZZLE, file), "utf8"));
      for (const { pattern, why } of TIDB_ONLY) {
        if (pattern.test(sql)) offenders.push(`${file}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  const matches = (sql: string) => TIDB_ONLY.filter(({ pattern }) => pattern.test(executableSql(sql)));

  it("should ignore a forbidden construct that appears only in a comment", () => {
    // 0090's header explains why `CREATE INDEX IF NOT EXISTS` is wrong. That
    // explanation must not itself read as a violation.
    expect(matches("-- WHY NOT `CREATE INDEX IF NOT EXISTS`. It is a TiDB extension.")).toEqual([]);
  });

  it("should still catch the construct when it is REAL SQL", () => {
    // The pair that makes the test above evidence rather than a loophole: if
    // dropping comments also hid executable statements, the guard would be
    // decoration.
    expect(matches("CREATE INDEX IF NOT EXISTS `idx_x` ON `t` (`c`);")).toHaveLength(1);
  });

  it("should still catch it when a trailing comment follows the statement", () => {
    expect(matches("CREATE INDEX IF NOT EXISTS `idx_y` ON `t` (`c`); -- added later")).toHaveLength(1);
  });
});
