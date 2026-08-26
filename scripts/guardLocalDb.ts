/**
 * Preflight for `pnpm db:push`. Refuses unless DATABASE_URL is a local database.
 *
 * See server/dbTarget.ts for why this exists: db:push generates a migration from
 * the working tree and applies it, so pointing it at a shared database publishes
 * an unreviewed schema there and breaks the next deploy.
 *
 * Production is refused unconditionally. Every other remote host can be
 * authorised, but only by NAMING it — a bare `=1` is not accepted, so an
 * override left in a shell profile cannot quietly authorise tomorrow's target.
 */
import "dotenv/config";
import { classifyDatabaseTarget, describeDbTargetRefusal } from "../server/dbTarget";

const OVERRIDE = "ALLOW_REMOTE_DB_PUSH";

const verdict = classifyDatabaseTarget(process.env.DATABASE_URL, process.env.PRODUCTION_DB_HOSTS);

if (verdict.local) {
  console.log(`[db:push] target is local (${verdict.host}) — proceeding.`);
  process.exit(0);
}

// Production is not overridable, so this check comes BEFORE the override is even
// read. There is no task that needs generate-and-apply against the live product.
if (verdict.reason !== "production") {
  const named = (process.env[OVERRIDE] ?? "").trim().toLowerCase();
  if (named && verdict.host && named === verdict.host.toLowerCase()) {
    // Deliberate, and loud: this is the line that should appear in a postmortem.
    console.warn(
      `[db:push] ${OVERRIDE}=${verdict.host} — proceeding. A migration generated from ` +
        `this working tree is about to be applied there.`,
    );
    process.exit(0);
  }
}

console.error(describeDbTargetRefusal(verdict, OVERRIDE));
process.exit(1);
