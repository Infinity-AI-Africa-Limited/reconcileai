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
 * there — ER_TABLE_EXISTS (1050), ER_DUP_KEYNAME (1061) or ER_DUP_FIELDNAME
 * (1060). The deploy fails, someone rewrites the migration file to match the
 * database, and the repository drifts further from being the source of truth.
 *
 * Each time, that was discovered by a broken deploy. This finds it in seconds,
 * beforehand, and says exactly which statement will fail.
 *
 * ─── What it does ────────────────────────────────────────────────────────────
 *
 * 1. Reads the journal and the `__drizzle_migrations` watermark.
 * 2. Works out which migrations drizzle would apply on the next deploy.
 * 3. For each, parses the objects its DDL would create and asks the database
 *    whether they already exist.
 * 4. Reports any that would collide, and exits non-zero.
 *
 * Read-only. It never writes to the database.
 *
 * Exit codes: 0 = no drift · 1 = drift found · 2 = could not determine.
 * The third matters: a checker that cannot tell "clean" from "I don't know" is
 * worse than none, because the unknown gets read as clean.
 *
 * Usage:
 *   pnpm db:drift              # uses DATABASE_URL
 *   pnpm db:drift --verbose    # also list pending migrations that are clean
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(__dirname, "..", "drizzle");
const VERBOSE = process.argv.includes("--verbose");

/** MySQL's "that table isn't there" — the ONLY error that means "never migrated". */
const ER_NO_SUCH_TABLE = "ER_NO_SUCH_TABLE";

/**
 * Objects a migration would create.
 *
 * Covers every collision-producing form this repo actually uses:
 *   CREATE TABLE                          -> ER_TABLE_EXISTS   (1050)
 *   CREATE [UNIQUE] INDEX                 -> ER_DUP_KEYNAME    (1061)
 *   ALTER TABLE ... ADD CONSTRAINT        -> ER_DUP_KEYNAME    (1061)
 *   ALTER TABLE ... ADD INDEX|KEY         -> ER_DUP_KEYNAME    (1061)
 *   ALTER TABLE ... ADD [COLUMN] `c`      -> ER_DUP_FIELDNAME  (1060)
 *
 * That last one is the commonest form in this repository by a wide margin (74
 * occurrences) and is exactly what 0085 did to `organizations.aiAssistanceEnabled`.
 * An earlier version of this script parsed only CREATE statements and would have
 * reported that migration as clean — a false negative, which is the failure mode
 * that matters most here.
 *
 * `MODIFY COLUMN` is deliberately not parsed: re-applying it is idempotent.
 * Statements already guarded by `IF NOT EXISTS` are skipped, because they cannot
 * collide and flagging them would train people to ignore this tool.
 */
export function objectsCreatedBy(sql) {
  const tables = [];
  const indexes = [];
  const columns = [];

  // Strip comments so a `-- CREATE TABLE ...` in a file header is never parsed
  // as DDL. Migration 0090 carries exactly such a header.
  const code = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const rx = (body) => new RegExp(body, "gi");
  const UNGUARDED = "(?!IF\\s+NOT\\s+EXISTS)";
  const NAME = "[`\"]?(\\w+)[`\"]?";
  const ALTER = "ALTER\\s+TABLE\\s+" + NAME + "\\s+ADD\\s+";

  for (const m of code.matchAll(rx("CREATE\\s+TABLE\\s+" + UNGUARDED + NAME))) {
    tables.push(m[1]);
  }

  for (const m of code.matchAll(
    rx("CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+" + UNGUARDED + NAME + "\\s+ON\\s+" + NAME),
  )) {
    // A CREATE INDEX inside a quoted string belongs to an information_schema +
    // PREPARE guard, which is conditional by construction — only bare statements
    // can collide.
    const before = code.slice(Math.max(0, m.index - 120), m.index);
    if (/['"]\s*$/.test(before)) continue;
    indexes.push({ index: m[1], table: m[2] });
  }

  // A UNIQUE constraint materialises as an index, so it collides identically.
  for (const m of code.matchAll(rx(ALTER + "CONSTRAINT\\s+" + UNGUARDED + NAME))) {
    indexes.push({ index: m[2], table: m[1] });
  }

  for (const m of code.matchAll(rx(ALTER + "(?:UNIQUE\\s+)?(?:INDEX|KEY)\\s+" + UNGUARDED + NAME))) {
    indexes.push({ index: m[2], table: m[1] });
  }

  // The BACKTICK after ADD/COLUMN is what stops this swallowing `ADD CONSTRAINT`
  // and `ADD INDEX`, whose next token is an unquoted keyword.
  for (const m of code.matchAll(rx(ALTER + "(?:COLUMN\\s+)?" + UNGUARDED + "`(\\w+)`"))) {
    columns.push({ column: m[2], table: m[1] });
  }

  return { tables, indexes, columns };
}

/**
 * Read the applied watermark.
 *
 * Only a missing table means "this database has never been migrated". Any other
 * failure — unreachable host, denied permission, wrong schema — must NOT be
 * silently treated as watermark 0, because that makes every migration look
 * pending and produces a confident, wrong, whole-database drift report. Fail
 * loudly instead.
 */
async function readWatermark(connection) {
  try {
    const [rows] = await connection.query(
      "SELECT created_at FROM `__drizzle_migrations` ORDER BY created_at DESC LIMIT 1",
    );
    return { watermark: rows.length ? Number(rows[0].created_at) : 0, virgin: rows.length === 0 };
  } catch (err) {
    if (err && err.code === ER_NO_SUCH_TABLE) {
      return { watermark: 0, virgin: true };
    }
    err.message = `could not read __drizzle_migrations (${err.code ?? "unknown"}): ${err.message}`;
    throw err;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8"));
  const connection = await mysql.createConnection(url);

  try {
    const { watermark, virgin } = await readWatermark(connection);
    if (virgin) {
      console.log("`__drizzle_migrations` is absent or empty — this database has never been migrated.");
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
        collisions.push(`${entry.tag}:\n    journal entry has no .sql file`);
        continue;
      }
      const { tables, indexes, columns } = objectsCreatedBy(fs.readFileSync(file, "utf8"));
      const hits = [];

      for (const table of tables) {
        const [r] = await connection.query(
          "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [table],
        );
        if (r[0].n > 0) hits.push(`table \`${table}\` already exists -> ER_TABLE_EXISTS (1050)`);
      }

      for (const { index, table } of indexes) {
        const [r] = await connection.query(
          "SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
          [table, index],
        );
        if (r[0].n > 0) {
          hits.push(`index \`${index}\` on \`${table}\` already exists -> ER_DUP_KEYNAME (1061)`);
        }
      }

      for (const { column, table } of columns) {
        const [r] = await connection.query(
          "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
          [table, column],
        );
        if (r[0].n > 0) {
          hits.push(`column \`${table}\`.\`${column}\` already exists -> ER_DUP_FIELDNAME (1060)`);
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
    for (const c of collisions) console.error(`  ${c}`);
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
    await connection.end();
  }
}

// Only run when invoked directly, so the parser above can be unit-tested by
// importing this module without opening a database connection.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main().catch((err) => {
  console.error(`\nCOULD NOT DETERMINE DRIFT: ${err.message}`);
  console.error("Treat this as unknown, NOT as clean.");
  process.exit(2);
});
