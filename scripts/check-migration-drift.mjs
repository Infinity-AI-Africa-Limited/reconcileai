/**
 * Migration drift detector — find a deploy-breaking migration BEFORE deploying.
 *
 * ─── The failure this exists to prevent ──────────────────────────────────────
 *
 * Three times now (0084, 0085, 0090) a migration's DDL reached the production
 * database WITHOUT the matching `__drizzle_migrations` row: someone applied the
 * schema change by hand. The objects exist; the ledger does not know it.
 *
 * drizzle-orm's MySQL migrator applies a migration when
 *
 *     Number(lastDbMigration.created_at) < migration.folderMillis
 *
 * i.e. purely on the journal `when` watermark. So an unrecorded-but-applied
 * migration is retried on EVERY deploy, and dies on the object that is already
 * there — `ER_TABLE_EXISTS` (1050) or `ER_DUP_KEYNAME` (1061). The deploy fails,
 * someone rewrites the migration file to match the database, and the repository
 * drifts a little further from being the source of truth.
 *
 * Each time, that was discovered by a broken deploy. This finds it in seconds,
 * beforehand, and says exactly which statement will fail.
 *
 * ─── What it does ────────────────────────────────────────────────────────────
 *
 * 1. Reads the journal and the `__drizzle_migrations` watermark.
 * 2. Works out which migrations drizzle would apply on the next deploy.
 * 3. For each, parses the objects its DDL would CREATE and asks the database
 *    whether they already exist.
 * 4. Reports any that would collide, and exits non-zero.
 *
 * Read-only. It never writes to the database.
 *
 * Usage:
 *   node scripts/check-migration-drift.mjs            # uses DATABASE_URL
 *   node scripts/check-migration-drift.mjs --verbose  # also list pending migrations that are clean
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(__dirname, "..", "drizzle");
const VERBOSE = process.argv.includes("--verbose");

/**
 * Objects a migration would create.
 *
 * Deliberately ignores anything already guarded — `IF NOT EXISTS`, and the
 * information_schema/PREPARE pattern — because those are precisely the
 * statements that CANNOT collide. Flagging them would train people to ignore
 * this tool.
 */
function objectsCreatedBy(sql) {
  const tables = [];
  const indexes = [];

  // Strip comments so a `-- CREATE TABLE ...` in a header is never parsed.
  const code = sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  // CREATE TABLE `x` — unguarded only.
  for (const m of code.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)[`"]?(\w+)[`"]?/gi)) {
    tables.push(m[1]);
  }
  // CREATE [UNIQUE] INDEX `i` ON `t` — unguarded only.
  for (const m of code.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?/gi,
  )) {
    // A CREATE INDEX inside a quoted string is part of a PREPARE guard, which
    // is conditional by construction; only bare statements can collide.
    const line = code.slice(Math.max(0, m.index - 120), m.index);
    if (/['"]\s*$/.test(line)) continue;
    indexes.push({ index: m[1], table: m[2] });
  }
  return { tables, indexes };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8"));
  const c = await mysql.createConnection(url);

  try {
    let watermark = 0;
    try {
      const [rows] = await c.query(
        "SELECT created_at FROM `__drizzle_migrations` ORDER BY created_at DESC LIMIT 1",
      );
      watermark = rows.length ? Number(rows[0].created_at) : 0;
    } catch {
      console.log("No `__drizzle_migrations` table — this database has never been migrated.");
    }

    const pending = journal.entries.filter((e) => Number(e.when) > watermark);
    console.log(`applied watermark : ${watermark}`);
    console.log(`pending migrations: ${pending.length}`);
    if (pending.length === 0) {
      console.log("\nNothing pending. The next deploy has no migration to run.");
      return;
    }

    const collisions = [];
    for (const entry of pending) {
      const file = path.join(DRIZZLE, `${entry.tag}.sql`);
      if (!fs.existsSync(file)) {
        collisions.push(`${entry.tag}: journal entry has no .sql file`);
        continue;
      }
      const { tables, indexes } = objectsCreatedBy(fs.readFileSync(file, "utf8"));
      const hits = [];

      for (const t of tables) {
        const [r] = await c.query(
          "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [t],
        );
        if (r[0].n > 0) hits.push(`table \`${t}\` already exists -> ER_TABLE_EXISTS (1050)`);
      }
      for (const { index, table } of indexes) {
        const [r] = await c.query(
          "SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
          [table, index],
        );
        if (r[0].n > 0) {
          hits.push(`index \`${index}\` on \`${table}\` already exists -> ER_DUP_KEYNAME (1061)`);
        }
      }

      if (hits.length) {
        collisions.push(`${entry.tag}:\n    ` + hits.join("\n    "));
      } else if (VERBOSE) {
        console.log(`  ok  ${entry.tag}`);
      }
    }

    if (collisions.length === 0) {
      console.log("\nNo drift. Every pending migration targets objects that do not exist yet.");
      return;
    }

    console.error("\nDRIFT DETECTED — the next deploy will fail on these:\n");
    for (const c2 of collisions) console.error(`  ${c2}`);
    console.error(
      "\nThe objects exist but the migration is not recorded as applied, which means\n" +
        "DDL reached this database outside the migration runner.\n\n" +
        "Two ways out, and the choice is an operator's:\n" +
        "  1. Make the migration idempotent (guard with IF NOT EXISTS / information_schema\n" +
        "     + PREPARE). Keeps the file runnable everywhere; deviates from append-only.\n" +
        "  2. Record it as applied so drizzle skips it, leaving the file untouched:\n" +
        "       INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES ('<hash>', <when>);\n" +
        "     Audit-cleaner, but it is a write to a production ledger — get it approved.\n",
    );
    process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
