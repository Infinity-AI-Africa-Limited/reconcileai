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

  it("should derive ownership from the reconciliation job before the transaction", () => {
    // Runtime ownership comes from the parent job (runReconciliation's
    // `runOrganizationId`), and migration 0078 backfilled the same column the
    // same way. A transaction-first backfill files the exception against the
    // wrong tenant wherever the two differ — visible to an org that never ran
    // the reconciliation, and missing from the reports of the job that did.
    const jobJoin = sql.indexOf("JOIN `reconciliation_jobs` AS `j`");
    const txnJoin = sql.indexOf("JOIN `transactions` AS `t`");
    expect(jobJoin).toBeGreaterThan(-1);
    expect(txnJoin).toBeGreaterThan(jobJoin);
  });

  it("should use the transaction only where the job cannot supply an owner", () => {
    expect(sql).toContain("AND `j`.`organizationId` IS NULL");
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
