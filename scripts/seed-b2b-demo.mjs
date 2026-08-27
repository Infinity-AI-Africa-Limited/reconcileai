/**
 * Seed the Corporate B2B demo tenant (BrightGoods Nigeria Ltd (Demo)).
 *
 *   node scripts/seed-b2b-demo.mjs             # dry run — reports, writes nothing
 *   node scripts/seed-b2b-demo.mjs --commit    # actually writes
 *
 * ── Why this script exists ────────────────────────────────────────────────
 *
 * The Corporate B2B tenant held 0 transactions, 0 distributors and 0 channels,
 * so the one action the pilot closure register permits today — "demonstrate the
 * Corporate B2B portal with controlled/synthetic data" — could not be performed
 * at all. `demoSeedEngine` has an FMCG seed written for exactly this tenant that
 * had never been run against it; the tRPC procedure that calls it takes the
 * organisation from the caller's session, and BrightGoods has no users, so there
 * was no path to invoke it.
 *
 * ── Guards (CLAUDE.md §12) ────────────────────────────────────────────────
 *
 * This is the "never legitimate against a real tenant" class, so it refuses on
 * a PROVEN PROPERTY rather than trusting the caller to pass the right id:
 *
 *   - the target organisation must have segment `corporate_b2b`; AND
 *   - its name must contain "(Demo)".
 *
 * A real client tenant can therefore never be the target, even if someone edits
 * TARGET_ORG. Dry run by default — `--commit` is required to write anything.
 *
 * Idempotency is the seeder's own: distributors are matched by canonical name
 * before insert, and re-running appends a further batch/job rather than
 * duplicating the roster. Prefer `superAdmin.wipeDemoData` over re-running if a
 * clean slate is wanted.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const COMMIT = process.argv.includes("--commit");
/**
 * Seed only the Super Agent memory layer, leaving transactions alone.
 *
 * `seedMemoryLayer`'s dedupe check was unscoped, so it matched another
 * organisation's row with the same seeded reference and skipped the insert —
 * the full seed reported 15 memory ids while leaving this tenant with none.
 * Re-running the WHOLE seeder to fix that would append a second 2,000-row
 * batch, so the memory layer can be seeded on its own.
 */
const MEMORY_ONLY = process.argv.includes("--memory-only");
/** BrightGoods Nigeria Ltd (Demo) — verified against both guards below. */
const TARGET_ORG = 30001;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSING: DATABASE_URL is not set.");
  process.exit(1);
}

const db = await mysql.createConnection(url);
const q = async (sql, args = []) => (await db.query(sql, args))[0];

const [org] = await q("SELECT id, name, segment FROM organizations WHERE id = ?", [TARGET_ORG]);
if (!org) throw new Error(`REFUSING: organisation ${TARGET_ORG} does not exist`);
if (org.segment !== "corporate_b2b") {
  throw new Error(`REFUSING: org ${org.id} "${org.name}" is segment=${org.segment}, not corporate_b2b`);
}
if (!org.name.includes("(Demo)")) {
  throw new Error(`REFUSING: org ${org.id} "${org.name}" is not marked (Demo). This script never targets a real tenant.`);
}

// Provenance for the batches and jobs the seeder creates. BrightGoods has no
// users of its own; Infinity AI staff demo it through the super-admin portal
// switcher, so the platform owner is the honest answer for "who seeded this".
const [owner] = await q("SELECT id, email FROM users WHERE role = 'super_admin' AND isActive = 1 ORDER BY id LIMIT 1");
if (!owner) throw new Error("REFUSING: no active super_admin user to own the seeded batches");

const counts = async () => {
  const one = async (sql) => (await q(sql, [TARGET_ORG]))[0].n;
  return {
    transactions: await one("SELECT COUNT(*) n FROM transactions WHERE organizationId = ?"),
    distributors: await one("SELECT COUNT(*) n FROM distributors WHERE organizationId = ?"),
    channels: await one("SELECT COUNT(*) n FROM channels WHERE organizationId = ?"),
    jobs: await one("SELECT COUNT(*) n FROM reconciliation_jobs WHERE organizationId = ?"),
    matches: await one("SELECT COUNT(*) n FROM matches m JOIN reconciliation_jobs j ON j.id = m.jobId WHERE j.organizationId = ?"),
    exceptions: await one("SELECT COUNT(*) n FROM exceptions WHERE organizationId = ?"),
    agentMemory: await one("SELECT COUNT(*) n FROM agent_memory WHERE organizationId = ?"),
  };
};

const before = await counts();
console.log(`\nTarget: [${org.id}] ${org.name} — segment=${org.segment}`);
console.log(`Owner:  [${owner.id}] ${owner.email}`);
console.log("\nBefore:", before);

if (!COMMIT) {
  console.log("\nDRY RUN — nothing written. Re-run with --commit to apply.\n");
  await db.end();
  process.exit(0);
}

let result;
if (MEMORY_ONLY) {
  console.log("\nSeeding memory layer only...");
  const [{ getDb }, { seedMemoryLayer }] = await Promise.all([
    import("../server/db.ts"),
    import("../server/demoSeedEngine.ts"),
  ]);
  const orm = await getDb();
  if (!orm) throw new Error("Database not available");
  result = { memoryIds: await seedMemoryLayer(orm, TARGET_ORG) };
} else {
  console.log("\nSeeding full FMCG demo dataset...");
  const { seedFmcgDemoData } = await import("../server/demoSeedEngine.ts");
  result = await seedFmcgDemoData(owner.id, TARGET_ORG);
}

const after = await counts();
console.log("\nSeeder result:", result);
console.log("After:", after);
console.log("\nDelta:");
for (const k of Object.keys(after)) console.log(`  ${k.padEnd(13)} ${before[k]} -> ${after[k]}  (+${after[k] - before[k]})`);
console.log();
await db.end();
process.exit(0);
