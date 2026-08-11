/**
 * Archive the org-less legacy data pool (CLAUDE.md §19.2).
 *
 * ~35M transaction rows carry `organizationId IS NULL` — prototype and seed data
 * from Feb–Jun 2026 that belongs to no tenant. They are invisible to every
 * org-scoped query, so they leak nothing, but they inflate the table, skew any
 * unscoped aggregate, and are awkward to explain in a client's security review.
 * Owner decision (2026-08-11): ARCHIVE them — move out of the live tables into
 * `*_legacy_archive` tables, preserved rather than deleted.
 *
 * ─── Why a script and not a migration ────────────────────────────────────────
 *
 * `pnpm db:migrate` runs as a Railway PRE-DEPLOY step. A multi-minute data move
 * there blocks every deploy, and a failure mid-way leaves the deploy wedged.
 * CLAUDE.md's own note says to switch to a controlled online change once a core
 * table reaches tens of millions of rows. This is that point, so the move is a
 * deliberate one-off run instead.
 *
 * ─── Why "keep the survivors" and not "delete the rest" ──────────────────────
 *
 * 99.76% of `transactions` is legacy: 35,036,289 org-less against 85,499 owned.
 * Deleting 35M rows in batches would take roughly an hour of sustained write
 * load. Copying the 85,499 survivors into a fresh table and swapping the two by
 * RENAME is seconds of work, and RENAME TABLE is atomic — there is no moment
 * where the app sees a half-built table.
 *
 * The trade-off is a narrow write window: rows inserted between the copy and the
 * rename land in the old table, which becomes the archive. Step 4 sweeps those
 * back. Nothing is lost, but run this when reconciliation jobs are not firing.
 *
 * ─── Storage ────────────────────────────────────────────────────────────────
 *
 * Archiving does NOT reclaim the ~11 GB. The rows still exist, in a table the
 * application never reads. Reclaiming space means dropping the archive later,
 * which is a separate and irreversible decision — deliberately not automated
 * here.
 *
 * Usage:
 *   node scripts/archive-orgless-legacy.mjs              # dry run (default)
 *   node scripts/archive-orgless-legacy.mjs --execute    # perform the archive
 *   node scripts/archive-orgless-legacy.mjs --execute --only=transactions
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const EXECUTE = process.argv.includes("--execute");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;

/**
 * Tables to archive, and how.
 *
 * `swap`  — copy survivors to a new table and RENAME. For tables where almost
 *           everything is legacy; cost scales with what is KEPT.
 * `move`  — INSERT…SELECT the legacy rows into the archive then DELETE them.
 *           For small tables where a straight move is simpler and safe.
 *
 * `legacyWhere` defines what counts as legacy. It is the ONLY place that
 * decision is expressed, so the count, the copy and the delete can never
 * disagree about which rows are in scope.
 */
const PLAN = [
  {
    table: "transactions",
    strategy: "swap",
    legacyWhere: "organizationId IS NULL",
  },
  {
    table: "matches",
    strategy: "move",
    legacyWhere: "organizationId IS NULL",
  },
  {
    table: "exceptions",
    strategy: "move",
    legacyWhere: "organizationId IS NULL",
  },
  {
    // The 44 misfiled distributor rows: 14 under organizationId 0 (no tenant at
    // all) and 30 on the financial-services demo tenant, which since PR #64 may
    // not hold distributors — the registry is corporate B2B only. BrightGoods,
    // the corporate-B2B tenant, holds none of them. Neither set is reachable
    // through the UI.
    table: "distributors",
    strategy: "move",
    legacyWhere: "organizationId = 0 OR organizationId = 1",
  },
];

const archiveName = (t) => `${t}_legacy_archive`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const conn = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    // A 35M-row table scan is legitimately slow; do not sever it mid-flight.
    connectTimeout: 60_000,
  });

  console.log(EXECUTE ? "\n=== EXECUTE — this WILL modify the database ===\n" : "\n=== DRY RUN — no changes will be made ===\n");

  for (const step of PLAN) {
    if (ONLY && ONLY !== step.table) continue;
    const { table, strategy, legacyWhere } = step;
    const archive = archiveName(table);

    const [[counts]] = await conn.query(
      `SELECT
         SUM(CASE WHEN ${legacyWhere} THEN 1 ELSE 0 END) AS legacy,
         SUM(CASE WHEN ${legacyWhere} THEN 0 ELSE 1 END) AS keep,
         COUNT(*) AS total
       FROM \`${table}\``,
    );
    const legacy = Number(counts.legacy ?? 0);
    const keep = Number(counts.keep ?? 0);
    console.log(`${table}: ${legacy.toLocaleString()} legacy / ${keep.toLocaleString()} kept / ${Number(counts.total).toLocaleString()} total  [${strategy}]`);

    if (!EXECUTE) continue;
    if (legacy === 0) { console.log(`  nothing to archive, skipping`); continue; }

    const [exists] = await conn.query(`SHOW TABLES LIKE '${archive}'`);
    if (exists.length > 0) {
      // Re-running must never stack a second copy on top of the first.
      throw new Error(`${archive} already exists — refusing to run twice. Inspect it before re-running.`);
    }

    if (strategy === "swap") {
      const staging = `${table}_new`;
      console.log(`  creating ${staging} with the same schema`);
      await conn.query(`CREATE TABLE \`${staging}\` LIKE \`${table}\``);

      console.log(`  copying ${keep.toLocaleString()} surviving rows`);
      await conn.query(`INSERT INTO \`${staging}\` SELECT * FROM \`${table}\` WHERE NOT (${legacyWhere})`);

      console.log(`  swapping tables (atomic)`);
      await conn.query(`RENAME TABLE \`${table}\` TO \`${archive}\`, \`${staging}\` TO \`${table}\``);

      // Anything written between the copy and the rename landed in the old
      // table. Sweep it across so the window costs nothing.
      const [sweep] = await conn.query(
        `INSERT INTO \`${table}\` SELECT * FROM \`${archive}\` a
          WHERE NOT (${legacyWhere.replace(/organizationId/g, "a.organizationId")})
            AND NOT EXISTS (SELECT 1 FROM \`${table}\` t WHERE t.id = a.id)`,
      );
      if (sweep.affectedRows > 0) console.log(`  swept ${sweep.affectedRows} row(s) written during the swap`);
    } else {
      console.log(`  creating ${archive}`);
      await conn.query(`CREATE TABLE \`${archive}\` LIKE \`${table}\``);
      const [moved] = await conn.query(`INSERT INTO \`${archive}\` SELECT * FROM \`${table}\` WHERE ${legacyWhere}`);
      const [deleted] = await conn.query(`DELETE FROM \`${table}\` WHERE ${legacyWhere}`);
      if (moved.affectedRows !== deleted.affectedRows) {
        throw new Error(`${table}: copied ${moved.affectedRows} but deleted ${deleted.affectedRows} — STOP and inspect`);
      }
      console.log(`  moved ${moved.affectedRows.toLocaleString()} rows`);
    }

    // Prove it, rather than assume it.
    const [[after]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    const [[arch]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${archive}\``);
    console.log(`  verified: ${table}=${Number(after.n).toLocaleString()} rows, ${archive}=${Number(arch.n).toLocaleString()} rows`);
    if (Number(after.n) < keep) {
      throw new Error(`${table}: expected at least ${keep} surviving rows, found ${after.n} — STOP`);
    }
  }

  console.log(EXECUTE ? "\nDone.\n" : "\nDry run complete. Re-run with --execute to apply.\n");
  await conn.end();
}

main().catch((err) => { console.error("\nFAILED:", err.message, "\n"); process.exit(1); });
