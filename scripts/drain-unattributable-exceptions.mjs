/**
 * Drain exceptions whose owning tenant cannot be derived (migration 0084).
 *
 * ─── Why this is a script and not part of the migration ─────────────────────
 *
 * Migration 0084 requires `exceptions.organizationId` to be NOT NULL. It
 * backfills ownership from the parent reconciliation job, falls back to the
 * transaction where the job is gone, and then ASSERTS that nothing is left
 * unattributable. If anything is, the migration fails closed and the deploy
 * stops.
 *
 * It does not delete those rows, and it must not. `pnpm db:migrate` runs
 * unattended as a Railway pre-deploy step and inside on-premise bank
 * installations whose data nobody here has seen. An exception is a financial
 * control record. "The backfill could not name an owner, so it was removed
 * during a deploy" is not an answer that survives an audit — and an earlier
 * revision of 0084 did exactly that, copying each row to quarantine and then
 * issuing an unconditional DELETE with no impact assertion and no operator
 * confirmation.
 *
 * So the destructive half lives here: dry-run by default, explicit --execute,
 * and it prints exactly what it will move before it moves anything.
 *
 * ─── What it does ───────────────────────────────────────────────────────────
 *
 * Copies each unattributable exception into `exception_ownership_quarantine`
 * (preserved, not deleted — the table is created by migration 0084), then
 * removes it from the operational table so the NOT NULL constraint can be
 * applied. Re-runnable: the copy uses INSERT IGNORE keyed on the primary key,
 * so an interrupted run resumes cleanly.
 *
 * Recovery: the quarantine table holds the full row. To restore one, INSERT it
 * back into `exceptions` with a resolved organizationId — never by renaming the
 * table over the live one.
 *
 * Usage:
 *   node scripts/drain-unattributable-exceptions.mjs             # dry run (default)
 *   node scripts/drain-unattributable-exceptions.mjs --execute   # perform the drain
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const EXECUTE = process.argv.includes("--execute");

const COLUMNS = [
  "id", "organizationId", "jobId", "transactionId", "category", "subCategory",
  "severity", "currency", "description", "suggestedResolution", "aiAnalysis",
  "status", "assignedTo", "assignedAt", "assignedBy", "resolvedBy", "resolvedAt",
  "resolutionNotes", "cbsStillAnomalous", "cbsVerificationNote", "userKeptResolved",
  "createdAt",
];

// Suffixed per row with the transaction tenant candidate (or "none").
const QUARANTINE_REASON = "no derivable owner; txn tenant candidate: ";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const c = await mysql.createConnection(url);
  try {
    const [[{ n: total }]] = await c.query("SELECT COUNT(*) n FROM `exceptions`");
    const [[{ n: orphaned }]] = await c.query(
      "SELECT COUNT(*) n FROM `exceptions` WHERE `organizationId` IS NULL",
    );

    console.log(`exceptions total .................. ${total}`);
    console.log(`unattributable (organizationId NULL) ${orphaned}`);

    if (orphaned === 0) {
      console.log("\nNothing to drain. Migration 0084 will pass its assertion.");
      return;
    }

    // Show what is about to be destroyed, grouped, so the operator is deciding
    // about identifiable work rather than about a number.
    const [breakdown] = await c.query(
      "SELECT `category`, `severity`, `status`, COUNT(*) n FROM `exceptions` " +
        "WHERE `organizationId` IS NULL GROUP BY `category`, `severity`, `status` ORDER BY n DESC",
    );
    console.log("\nBreakdown of rows to be quarantined:");
    for (const r of breakdown) {
      console.log(`  ${String(r.n).padStart(6)}  ${r.category} / ${r.severity} / ${r.status}`);
    }

    const [sample] = await c.query(
      "SELECT `id`, `jobId`, `transactionId`, `category`, `createdAt` FROM `exceptions` " +
        "WHERE `organizationId` IS NULL ORDER BY `id` LIMIT 10",
    );
    console.log("\nSample (first 10):");
    for (const r of sample) {
      console.log(`  id=${r.id} job=${r.jobId} txn=${r.transactionId} ${r.category} ${r.createdAt}`);
    }

    if (!EXECUTE) {
      console.log(
        `\nDRY RUN — nothing was changed. ${orphaned} row(s) would be copied to ` +
          "`exception_ownership_quarantine` and removed from `exceptions`.\n" +
          "Re-run with --execute to perform the drain.",
      );
      return;
    }

    const selectCols = COLUMNS.map((x) => `\`e\`.\`${x}\``).join(", ");
    const insertCols = COLUMNS.map((x) => `\`${x}\``).join(", ");
    // Record the transaction tenant CANDIDATE per row. Migration 0084 refuses to
    // backfill from it (with the job gone there is nothing to corroborate it
    // against), but a quarantined record carrying no trace of who it might have
    // belonged to makes later recovery pure guesswork. Evidence, not a rule.
    const [ins] = await c.query(
      `INSERT IGNORE INTO \`exception_ownership_quarantine\` (${insertCols}, \`quarantineReason\`) ` +
        `SELECT ${selectCols}, CONCAT(?, COALESCE(CAST(\`t\`.\`organizationId\` AS CHAR), 'none')) ` +
        `FROM \`exceptions\` \`e\` ` +
        `LEFT JOIN \`transactions\` \`t\` ON \`t\`.\`id\` = \`e\`.\`transactionId\` ` +
        `WHERE \`e\`.\`organizationId\` IS NULL`,
      [QUARANTINE_REASON],
    );
    console.log(`\nquarantined ...... ${ins.affectedRows}`);

    // Delete ONLY rows confirmed present in quarantine. If the copy silently
    // dropped anything, that row stays in `exceptions` and the migration
    // assertion trips again — which is the correct outcome, not a stuck state.
    const [del] = await c.query(
      "DELETE `e` FROM `exceptions` `e` " +
        "JOIN `exception_ownership_quarantine` `q` ON `q`.`id` = `e`.`id` " +
        "WHERE `e`.`organizationId` IS NULL",
    );
    console.log(`removed from exceptions ... ${del.affectedRows}`);

    const [[{ n: remaining }]] = await c.query(
      "SELECT COUNT(*) n FROM `exceptions` WHERE `organizationId` IS NULL",
    );
    console.log(`remaining unattributable .. ${remaining}`);
    console.log(
      remaining === 0
        ? "\nDone. Migration 0084 will now pass its assertion."
        : "\nWARNING: rows remain unattributable — 0084 will still fail closed. Investigate before retrying.",
    );
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
