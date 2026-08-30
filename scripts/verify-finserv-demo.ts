/**
 * verify-finserv-demo.ts — activate the Financial Services controlled demo and
 * prove every view it feeds has coherent data behind it.
 *
 *   pnpm demo:finserv:verify              # check current state, write nothing
 *   pnpm demo:finserv:activate            # activate, then check
 *   pnpm demo:finserv:verify --org 30002  # target a specific demo tenant
 *
 * WHY THIS EXISTS
 *
 * Financial Services demo activation shipped twice with a green test suite and a
 * clean typecheck, and failed both times in production:
 *
 *   1. `upload_batches.fileHash` overflowed varchar(64) — 8 of 9 batches
 *   2. the match loop indexed CORE_BANKING as a settlement SOURCE, though it is
 *      the reconciliation TARGET and deliberately has no source batch
 *
 * Neither was visible to the existing tests, because those exercise
 * `buildFinServDemoPlan` — a pure function over counts — and nothing ran the
 * seeder end to end. This script closes that gap: it calls the REAL seeder, the
 * same one `demo.activate({ segment: "finserv" })` invokes, and then asserts on
 * what actually landed in the database.
 *
 * Output is written to be filmed: numbered steps, one line per check, an explicit
 * PASS or FAIL against a stated expectation. Exit code is non-zero if any check
 * fails, so CI or a shell can gate on it.
 *
 * SAFETY
 *
 *   - Verification is the DEFAULT. Writing requires --activate.
 *   - Refuses any organisation not flagged `isDemo`, so a real tenant can never
 *     be seeded by this script.
 *   - Reports every other tenant's row counts before and after, so an unintended
 *     reach is visible in the output rather than needing to be looked for.
 */
import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agentMemory,
  channels,
  exceptions,
  matches,
  organizations,
  reconciliationJobs,
  transactions,
  uploadBatches,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { seedFinServDemoData } from "../server/demoSeedFinServ";

const ACTIVATE = process.argv.includes("--activate");
const orgFlagIndex = process.argv.indexOf("--org");
const TARGET_ORG = orgFlagIndex !== -1 ? Number(process.argv[orgFlagIndex + 1]) : 30002;
const FILE_HASH_LIMIT = 64;

let step = 0;
let failures = 0;

const heading = (title: string) => console.log(`\n${"─".repeat(72)}\n${++step}. ${title}\n${"─".repeat(72)}`);

/** One assertion, rendered so a viewer can see the expectation and the reading. */
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`         ${detail}`);
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable — is DATABASE_URL set?");

  console.log(`\nReconcileAI — Financial Services controlled demo verification`);
  console.log(`Mode:   ${ACTIVATE ? "ACTIVATE then verify (writes)" : "VERIFY ONLY (writes nothing)"}`);
  console.log(`Target: organisation ${TARGET_ORG}`);

  // ── 1. Target must be a demo tenant ──────────────────────────────────────
  heading("Confirm the target is a demo tenant");
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, segment: organizations.segment, isDemo: organizations.isDemo })
    .from(organizations)
    .where(eq(organizations.id, TARGET_ORG))
    .limit(1);
  if (!org) throw new Error(`Organisation ${TARGET_ORG} does not exist`);
  if (!org.isDemo) {
    throw new Error(
      `REFUSING: "${org.name}" is not flagged isDemo. This script only ever touches demo tenants.`,
    );
  }
  check("target is a demo tenant", true, `${org.name} (segment ${org.segment}, isDemo=true)`);

  // Baseline for the isolation check at the end.
  const tenantCounts = async () =>
    db
      .select({ id: organizations.id, name: organizations.name, txns: sql<number>`(select count(*) from transactions t where t.organizationId = organizations.id)` })
      .from(organizations)
      .orderBy(organizations.id);
  const before = await tenantCounts();

  // ── 2. Activation ────────────────────────────────────────────────────────
  if (ACTIVATE) {
    heading("Activate the controlled demo (the real seeder)");
    const owner = await db
      .select({ id: sql<number>`id` })
      .from(sql`users`)
      .where(sql`organizationId = ${TARGET_ORG}`)
      .limit(1);
    const userId = Number((owner as Array<{ id: number }>)[0]?.id ?? 0);
    if (!userId) throw new Error(`Organisation ${TARGET_ORG} has no user to own the demo rows`);
    const t0 = Date.now();
    const result = await seedFinServDemoData(userId, TARGET_ORG, "both");
    console.log(`   seeded in ${Math.round((Date.now() - t0) / 1000)}s as user ${userId}`);
    console.log(`   ${result.message}`);
  } else {
    heading("Activation skipped (verify-only)");
    console.log("   Re-run with --activate to seed before verifying.");
  }

  // ── 3. Source ingestion ──────────────────────────────────────────────────
  heading("Source ingestion — upload batches and their channels");
  const batches = await db
    .select({ fileName: uploadBatches.fileName, fileHash: uploadBatches.fileHash, totalRows: uploadBatches.totalRows, status: uploadBatches.status })
    .from(uploadBatches)
    .where(and(eq(uploadBatches.organizationId, TARGET_ORG), sql`${uploadBatches.fileName} like 'FinServ\\_Demo\\_%'`));
  check("every demo settlement feed has a batch", batches.length === 8, `${batches.length} of 8 batches present`);
  const overLimit = batches.filter((b) => (b.fileHash ?? "").length > FILE_HASH_LIMIT);
  check(
    `every fileHash fits varchar(${FILE_HASH_LIMIT})`,
    overLimit.length === 0,
    overLimit.length === 0
      ? `longest is ${Math.max(0, ...batches.map((b) => (b.fileHash ?? "").length))} characters`
      : `${overLimit.length} exceed the column: ${overLimit.map((b) => b.fileName).join(", ")}`,
  );
  check("every batch completed", batches.every((b) => b.status === "completed"), `${batches.filter((b) => b.status === "completed").length} completed`);

  // ── 4. Reconciliation ────────────────────────────────────────────────────
  heading("Reconciliation — the control run and its matches");
  const [job] = await db
    .select({ id: reconciliationJobs.id, name: reconciliationJobs.name, status: reconciliationJobs.status, matched: reconciliationJobs.matchedCount, excs: reconciliationJobs.exceptionCount, rate: reconciliationJobs.matchRate })
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.organizationId, TARGET_ORG))
    .orderBy(sql`id desc`)
    .limit(1);
  check("a completed control run exists", !!job && job.status === "completed", job ? `job #${job.id} "${job.name}" — ${job.status}` : "no job found");
  const [matchCount] = await db.select({ n: sql<number>`count(*)` }).from(matches).where(eq(matches.organizationId, TARGET_ORG));
  check("matched pairs are persisted", Number(matchCount?.n ?? 0) === 304, `${Number(matchCount?.n ?? 0)} match rows (expected 304)`);
  check("headline match rate is stated", job?.rate === "95.00", `matchRate = ${job?.rate ?? "none"}`);

  // ── 5. Exceptions ────────────────────────────────────────────────────────
  heading("Exceptions — the control cases an operator reviews");
  const excRows = await db
    .select({ status: exceptions.status, severity: exceptions.severity, n: sql<number>`count(*)` })
    .from(exceptions)
    .where(eq(exceptions.organizationId, TARGET_ORG))
    .groupBy(exceptions.status, exceptions.severity);
  const totalExc = excRows.reduce((s, r) => s + Number(r.n), 0);
  check("16 control cases raised", totalExc === 16, `${totalExc} exceptions across ${new Set(excRows.map((r) => r.status)).size} statuses`);
  for (const r of excRows) console.log(`         ${String(r.status).padEnd(11)} ${String(r.severity).padEnd(9)} ${r.n}`);

  // ── 6. Investigation ─────────────────────────────────────────────────────
  heading("Investigation — every case carries a diagnosis");
  const [diag] = await db
    .select({
      withDescription: sql<number>`sum(${exceptions.description} is not null and ${exceptions.description} <> '')`,
      withRecommendation: sql<number>`sum(${exceptions.suggestedResolution} is not null and ${exceptions.suggestedResolution} <> '')`,
      withAnalysis: sql<number>`sum(${exceptions.aiAnalysis} is not null and ${exceptions.aiAnalysis} <> '')`,
      total: sql<number>`count(*)`,
    })
    .from(exceptions)
    .where(eq(exceptions.organizationId, TARGET_ORG));
  const t = Number(diag?.total ?? 0);
  check("all cases have a description", Number(diag?.withDescription) === t, `${diag?.withDescription}/${t}`);
  check("all cases have a recommended action", Number(diag?.withRecommendation) === t, `${diag?.withRecommendation}/${t}`);
  check("all cases have an AI analysis", Number(diag?.withAnalysis) === t, `${diag?.withAnalysis}/${t}`);

  // ── 7. Approval ──────────────────────────────────────────────────────────
  heading("Approval — assignment and resolution trail");
  const approval = await db
    .select({ status: exceptions.status, assigned: sql<number>`sum(${exceptions.assignedTo} is not null)`, resolved: sql<number>`sum(${exceptions.resolvedBy} is not null)`, n: sql<number>`count(*)` })
    .from(exceptions)
    .where(eq(exceptions.organizationId, TARGET_ORG))
    .groupBy(exceptions.status);
  const inReview = approval.find((r) => r.status === "in_review");
  const resolved = approval.find((r) => r.status === "resolved");
  check("in-review cases are assigned to someone", Number(inReview?.assigned ?? 0) > 0, `${inReview?.assigned ?? 0} of ${inReview?.n ?? 0} in review are assigned`);
  check("resolved cases record who closed them", Number(resolved?.resolved ?? 0) > 0, `${resolved?.resolved ?? 0} of ${resolved?.n ?? 0} resolved have a resolver`);

  // ── 8. Multi-channel ─────────────────────────────────────────────────────
  heading("Multi-channel — every rail carries data");
  const rails = await db
    .select({ rail: channels.name, legs: sql<number>`count(${transactions.id})` })
    .from(channels)
    .innerJoin(transactions, and(eq(transactions.channelId, channels.id), eq(transactions.organizationId, TARGET_ORG)))
    .where(eq(channels.organizationId, TARGET_ORG))
    .groupBy(channels.name);
  check("all 8 rails are populated", rails.length === 8, `${rails.length} of 8 rails have transactions`);
  for (const r of rails.sort((a, b) => Number(b.legs) - Number(a.legs))) console.log(`         ${String(r.rail).padEnd(36)} ${r.legs} legs`);
  // AGENT_BANKING was silently excluded by the rail-indexing defect, so it is
  // named explicitly rather than left to the count above.
  check("Agent Banking is present", rails.some((r) => String(r.rail).includes("Agent Banking")), "the rail the indexing defect used to drop");

  // ── 9. Flywheel ──────────────────────────────────────────────────────────
  heading("Exception intelligence — the agent's evidence store");
  const mem = await db
    .select({ outcome: agentMemory.outcome, n: sql<number>`count(*)` })
    .from(agentMemory)
    .where(eq(agentMemory.organizationId, TARGET_ORG))
    .groupBy(agentMemory.outcome);
  const memTotal = mem.reduce((s, r) => s + Number(r.n), 0);
  check("closed cases fed the memory layer", memTotal > 0, `${memTotal} records: ${mem.map((r) => `${r.outcome}=${r.n}`).join(", ") || "none"}`);

  // ── 10. Tenant isolation ─────────────────────────────────────────────────
  heading("Tenant isolation — no other organisation moved");
  const after = await tenantCounts();
  const moved = after.filter((a) => {
    const b = before.find((x) => x.id === a.id);
    return a.id !== TARGET_ORG && b && Number(b.txns) !== Number(a.txns);
  });
  check("only the target tenant changed", moved.length === 0, moved.length === 0 ? "every other tenant's transaction count is unchanged" : `moved: ${moved.map((m) => m.name).join(", ")}`);
  for (const a of after) console.log(`         ${String(a.id).padEnd(8)} ${String(a.name).padEnd(34)} ${a.txns} txns${a.id === TARGET_ORG ? "   <- target" : ""}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(failures === 0 ? "RESULT: PASS — the controlled demo is activatable and complete." : `RESULT: FAIL — ${failures} check(s) failed.`);
  console.log(`${"═".repeat(72)}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`\nRESULT: ERROR — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
