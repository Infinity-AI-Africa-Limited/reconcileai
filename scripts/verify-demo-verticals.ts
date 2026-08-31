/**
 * verify-demo-verticals.ts — is each vertical's demo tenant fit to be filmed?
 *
 *   pnpm demo:verify                 # all three verticals
 *   pnpm demo:verify --vertical fs   # one of: fs | b2b | retail
 *
 * Companion to `verify-finserv-demo.ts`, which proves the Financial Services
 * dataset in depth. This one answers a different question across all three:
 * would a viewer, shown this tenant, see a product that looks operated — or an
 * empty screen?
 *
 * It is deliberately a READINESS report rather than a pass/fail gate on
 * correctness. A vertical can be perfectly correct and still be unfilmable
 * because nobody has seeded it, and those two failures need telling apart.
 *
 * Read-only. It never writes.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { channels, exceptions, organizations, reconciliationJobs, transactions } from "../drizzle/schema";
import { getDb } from "../server/db";

type Vertical = "fs" | "b2b" | "retail";

/**
 * What "ready to film" means per vertical, and why the thresholds differ.
 *
 * These are not arbitrary. Each is the point below which the hero screen for
 * that vertical reads as empty or synthetic to someone watching:
 *
 *   fs      Multi-Channel is the hero, and it is a per-rail table. Fewer than
 *           8 populated rails and the story "every rail, one run" is not on
 *           screen. 16 control cases fill an exception queue without scrolling.
 *   b2b     The Distributor Registry is the differentiator; the dashboard needs
 *           enough volume that a 95% match rate is not 19/20.
 *   retail  Settlement Monitor leads on settled-vs-pending value. A handful of
 *           rows makes the match rate a rounding artefact rather than a signal.
 */
const EXPECTATIONS: Record<Vertical, {
  label: string;
  orgId: number;
  heroScreen: string;
  minTransactions: number;
  minChannels: number;
  minExceptions: number;
  minJobs: number;
}> = {
  fs:     { label: "Financial Services", orgId: 120001, heroScreen: "Multi-Channel",      minTransactions: 500, minChannels: 8, minExceptions: 12, minJobs: 1 },
  b2b:    { label: "Corporate B2B",      orgId: 30001,  heroScreen: "Distributor Registry", minTransactions: 500, minChannels: 2, minExceptions: 10, minJobs: 1 },
  retail: { label: "Retail Commerce",    orgId: 60001,  heroScreen: "Settlement Monitor", minTransactions: 200, minChannels: 2, minExceptions: 5,  minJobs: 1 },
};

const vFlag = process.argv.indexOf("--vertical");
const only = vFlag !== -1 ? (process.argv[vFlag + 1] as Vertical) : null;
const targets: Vertical[] = only ? [only] : ["fs", "b2b", "retail"];

let notReady = 0;

function line(label: string, actual: number, min: number, unit: string) {
  const ok = actual >= min;
  if (!ok) notReady++;
  console.log(`   ${ok ? "OK  " : "THIN"}  ${label.padEnd(22)} ${String(actual).padStart(6)} ${unit.padEnd(14)} (want >= ${min})`);
  return ok;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable — is DATABASE_URL set?");

  console.log("\nReconcileAI — demo readiness across verticals (read-only)\n");

  for (const v of targets) {
    const exp = EXPECTATIONS[v];
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, segment: organizations.segment, isDemo: organizations.isDemo })
      .from(organizations)
      .where(eq(organizations.id, exp.orgId))
      .limit(1);

    console.log(`${"─".repeat(72)}`);
    console.log(`${exp.label}  —  hero screen: ${exp.heroScreen}`);
    console.log(`${"─".repeat(72)}`);
    if (!org) {
      console.log(`   MISSING  organisation ${exp.orgId} does not exist\n`);
      notReady++;
      continue;
    }
    console.log(`   tenant: ${org.name} (id ${org.id}, segment ${org.segment}, isDemo=${org.isDemo})`);
    if (!org.isDemo) {
      // A vertical demo living in a non-demo tenant is a live hazard, not just
      // untidy: the SLA monitor treats its fabricated exceptions as real.
      console.log(`   WARN  this tenant is NOT flagged isDemo — its demo exceptions will page the on-call owner`);
      notReady++;
    }

    const [t] = await db.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.organizationId, exp.orgId));
    const [j] = await db.select({ n: sql<number>`count(*)` }).from(reconciliationJobs).where(eq(reconciliationJobs.organizationId, exp.orgId));
    const [e] = await db.select({ n: sql<number>`count(*)` }).from(exceptions).where(eq(exceptions.organizationId, exp.orgId));
    const populated = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(transactions, eq(transactions.channelId, channels.id))
      .where(eq(transactions.organizationId, exp.orgId))
      .groupBy(channels.id);

    line("transactions", Number(t?.n ?? 0), exp.minTransactions, "rows");
    line("populated channels", populated.length, exp.minChannels, "channels");
    line("reconciliation runs", Number(j?.n ?? 0), exp.minJobs, "jobs");
    line("exception cases", Number(e?.n ?? 0), exp.minExceptions, "cases");

    // A match rate computed from a handful of rows is a rounding artefact, and
    // putting it on screen invites exactly the question you do not want asked.
    const [rate] = await db
      .select({ matched: sql<number>`sum(${transactions.status} in ('matched','manually_matched'))`, total: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.organizationId, exp.orgId));
    const total = Number(rate?.total ?? 0);
    const pct = total > 0 ? ((Number(rate?.matched ?? 0) / total) * 100).toFixed(1) : "n/a";
    console.log(`         match rate ${pct}%${total > 0 && total < 100 ? "  <- from too few rows to be meaningful on camera" : ""}`);
    console.log("");
  }

  console.log(`${"═".repeat(72)}`);
  console.log(notReady === 0
    ? "READY — every vertical checked has a dataset that will look operated on camera."
    : `NOT READY — ${notReady} threshold(s) unmet. Seed the thin verticals before filming.`);
  console.log(`${"═".repeat(72)}\n`);
  process.exitCode = notReady === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`\nERROR — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
