/**
 * Preflight for `pnpm db:push`. Refuses unless DATABASE_URL is a local database.
 *
 * See server/dbTarget.ts for why this exists: db:push generates a migration from
 * the working tree and applies it, so pointing it at a shared database publishes
 * an unreviewed schema there and breaks the next deploy.
 */
import "dotenv/config";
import { classifyDatabaseTarget, describeDbTargetRefusal } from "../server/dbTarget";

const OVERRIDE = "ALLOW_REMOTE_DB_PUSH";

const verdict = classifyDatabaseTarget(process.env.DATABASE_URL);

if (verdict.local) {
  console.log(`[db:push] target is local (${verdict.host}) — proceeding.`);
  process.exit(0);
}

if (process.env[OVERRIDE] === "1") {
  // Deliberate, and loud: this is the line that should appear in a postmortem.
  console.warn(
    `[db:push] ${OVERRIDE}=1 — proceeding against ${verdict.host ?? "an unparseable DATABASE_URL"}. ` +
      `A migration generated from this working tree is about to be applied there.`,
  );
  process.exit(0);
}

console.error(describeDbTargetRefusal(verdict, OVERRIDE));
process.exit(1);
