/**
 * Remove Super Agent memory rows filed against a NON-EXISTENT organisation.
 *
 *   node scripts/purge-orgless-agent-memory.mjs            # dry run + backup preview
 *   node scripts/purge-orgless-agent-memory.mjs --commit   # writes the backup, then deletes
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * `seedMemoryLayer` used to write `organizationId: orgId ?? 0`, so demo seeds
 * run without an owning tenant filed their rows against organisation 0 — which
 * is not a tenant at all, has no `organizations` row, and is unreachable by
 * every org-scoped query. This is the phantom-tenant failure CLAUDE.md §9C
 * describes, and the same shape as the 14 misfiled distributors in §19.2.
 *
 * The write path is fixed (a seed with no organisation now writes nothing).
 * This clears what the old path left behind.
 *
 * ── Guards (CLAUDE.md §12: deliberate production maintenance) ────────────
 *
 *   - The target id must have NO `organizations` row. If someone ever creates a
 *     real organisation with that id, this refuses rather than deleting a live
 *     tenant's institutional learning.
 *   - Any row carrying an `exceptionId` is a REAL learned outcome from a real
 *     resolution, not a seed. If even one is present, this refuses entirely
 *     rather than deleting selectively — a mixed population means the
 *     assumption behind this script is wrong and it should not run at all.
 *   - Every row is written to a timestamped JSON backup before the delete, so
 *     the operation is recoverable despite being a hard delete.
 *   - Dry run unless `--commit`.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const COMMIT = process.argv.includes("--commit");
/** Not a tenant: the fallback value the old `orgId ?? 0` wrote. */
const ORPHAN_ORG_ID = 0;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSING: DATABASE_URL is not set.");
  process.exit(1);
}

const db = await mysql.createConnection(url);
const q = async (sql, args = []) => (await db.query(sql, args))[0];

const [org] = await q("SELECT id, name FROM organizations WHERE id = ?", [ORPHAN_ORG_ID]);
if (org) {
  throw new Error(
    `REFUSING: organisation ${org.id} "${org.name}" EXISTS. This script only removes memory filed against a non-existent tenant.`,
  );
}

const rows = await q("SELECT * FROM agent_memory WHERE organizationId = ?", [ORPHAN_ORG_ID]);
if (rows.length === 0) {
  console.log("Nothing to do — no agent_memory rows are filed against a non-existent organisation.");
  await db.end();
  process.exit(0);
}

const learned = rows.filter((r) => r.exceptionId !== null);
if (learned.length > 0) {
  throw new Error(
    `REFUSING: ${learned.length} of ${rows.length} rows carry an exceptionId, so they are real learned outcomes rather than seed data. ` +
      `A mixed population means this script's assumption is wrong; investigate before deleting anything.`,
  );
}

console.log(`\nTarget: agent_memory rows with organizationId = ${ORPHAN_ORG_ID} (no such organisation)`);
console.log(`Rows:   ${rows.length}  (ids ${Math.min(...rows.map((r) => r.id))}–${Math.max(...rows.map((r) => r.id))})`);
console.log(`        all have exceptionId = NULL, i.e. seeded rather than learned`);
const byCategory = {};
for (const r of rows) byCategory[r.exceptionCategory] = (byCategory[r.exceptionCategory] ?? 0) + 1;
console.log("By category:", byCategory);

if (!COMMIT) {
  console.log("\nDRY RUN — nothing written or deleted. Re-run with --commit to apply.\n");
  await db.end();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// Written OUTSIDE the repository by default: it is a dump of tenant data and
// must not become a committed file. Override with BACKUP_DIR.
const backupDir = process.env.BACKUP_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", "reconcileai-backups");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `agent_memory-org${ORPHAN_ORG_ID}-backup-${stamp}.json`);
fs.writeFileSync(backup, JSON.stringify(rows, null, 2), "utf8");
console.log(`\nBackup written: ${backup} (${rows.length} rows)`);

const result = await q("DELETE FROM agent_memory WHERE organizationId = ? AND exceptionId IS NULL", [ORPHAN_ORG_ID]);
console.log(`Deleted: ${result.affectedRows} rows`);

const [remaining] = await q("SELECT COUNT(*) n FROM agent_memory WHERE organizationId = ?", [ORPHAN_ORG_ID]);
const byOrg = await q("SELECT organizationId, COUNT(*) n FROM agent_memory GROUP BY organizationId ORDER BY organizationId");
console.log(`Remaining at org ${ORPHAN_ORG_ID}: ${remaining.n}`);
console.log("agent_memory by org:", byOrg.map((r) => `${r.organizationId}=${r.n}`).join(" ") || "(empty)");
console.log();
await db.end();
process.exit(0);
