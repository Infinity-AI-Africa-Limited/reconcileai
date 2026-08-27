/**
 * Preflight for `pnpm db:push`. Refuses unless DATABASE_URL is a local database.
 *
 * See server/dbTarget.ts for why this exists: db:push generates a migration from
 * the working tree and applies it, so pointing it at a shared database publishes
 * an unreviewed schema there and breaks the next deploy.
 *
 * There is no override, deliberately. An earlier revision allowed one for hosts
 * outside the production list, and that gate was a denylist — an alias of
 * production (its DNS-root spelling, its IP, a CNAME) is not in the list and
 * would have been authorised as an ordinary remote host. Allow-listing local is
 * the only direction that fails closed.
 */
import "dotenv/config";
import { classifyDatabaseTarget, describeDbTargetRefusal } from "../server/dbTarget";

const verdict = classifyDatabaseTarget(process.env.DATABASE_URL, process.env.PRODUCTION_DB_HOSTS);

if (verdict.local) {
  console.log(`[db:push] target is local (${verdict.host}) — proceeding.`);
  process.exit(0);
}

console.error(describeDbTargetRefusal(verdict));
process.exit(1);
