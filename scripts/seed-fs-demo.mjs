/**
 * Seed a realistic Nigerian bank dataset onto the FINANCIAL SERVICES demo tenant.
 *
 *   node scripts/seed-fs-demo.mjs              # dry run — reports, writes nothing
 *   node scripts/seed-fs-demo.mjs --commit     # actually writes
 *   node scripts/seed-fs-demo.mjs --commit --wipe-only   # remove seeded data, restore nothing
 *
 * WHY THIS EXISTS
 *
 * The demo tenant's data was shaped by earlier ad-hoc seeding and demoed badly:
 * 84,250 of its 85,496 transactions sat on ONE channel that is switched OFF, and
 * the eight live channels carried 120–200 rows each in a near-flat distribution.
 * No real bank looks like that — NIP dwarfs everything, POS is second, and cheque
 * volume is tiny but high-value. A flat distribution reads as synthetic to
 * exactly the audience being demoed to.
 *
 * It also left the intelligence moat invisible: 41 exceptions against a
 * catalogue of 130. This seeds exceptions carrying REAL taxonomy keys in
 * `subCategory`, so Exception Intelligence, the Age Tracker and the Super Agent
 * have something true to reason about.
 *
 * SAFETY
 *
 *  - Dry run by default. `--commit` is required to write anything.
 *  - Refuses to run unless the target org is `financial_services` AND its name
 *    contains "(Demo)". A real client tenant can never be the target.
 *  - Only ever touches rows it can prove it created: every batch it writes is
 *    tagged with SEED_MARKER, and the wipe deletes strictly within that set,
 *    scoped to the one organisation.
 *  - Retail and corporate-B2B tenants are never referenced.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const mysql = require("mysql2/promise");

const COMMIT = process.argv.includes("--commit");
const WIPE_ONLY = process.argv.includes("--wipe-only");
/**
 * Clear ALL of the demo tenant's reconciliation data first, not just rows this
 * script previously wrote.
 *
 * Without it the earlier ad-hoc rows survive alongside the new ones — 200 old
 * NIP rows with synthetic references sitting under 5,040 realistic ones — which
 * defeats the point. Behind an explicit flag because "delete everything for this
 * org" should never be what `--commit` quietly means, even on a demo tenant.
 */
const REPLACE_ALL = process.argv.includes("--replace-all");
const SEED_MARKER = "FSDEMO-v2";
/** Globus Bank Nigeria (Demo) — verified below before anything is written. */
const TARGET_ORG = Number(process.env.FS_DEMO_ORG_ID ?? 1);
const DAYS = 30;

// ─── Channel mix ────────────────────────────────────────────────────────────
// Shares and match rates reflect how a Nigerian commercial bank's volume
// actually distributes: instant transfer dominates, POS is a distant second,
// cheque is a rounding error by count and material by value. Match rates are
// per-channel because that is what makes the Multi-Channel View worth looking
// at — a uniform 95% everywhere tells an operator nothing.
const CHANNELS = [
  { code: "NIBSS_NIP",          name: "NIBSS NIP (Instant Payments)",   type: "nibss",           share: 0.42, match: 0.991, min: 500,     max: 2_500_000,   prefix: "NIP" },
  { code: "POS_INTERSWITCH",    name: "POS Transactions (Interswitch)", type: "pos",             share: 0.18, match: 0.964, min: 500,     max: 300_000,     prefix: "POS" },
  { code: "USSD_CHANNEL",       name: "USSD Transactions",              type: "ussd",            share: 0.12, match: 0.982, min: 100,     max: 100_000,     prefix: "USSD" },
  { code: "MOBILE_BANKING_GTB", name: "Mobile Banking (App)",           type: "mobile_banking",  share: 0.10, match: 0.988, min: 500,     max: 1_000_000,   prefix: "MOB" },
  { code: "CARD_PAYMENTS",      name: "Card Payments (Visa/Mastercard)",type: "card_payments",   share: 0.07, match: 0.946, min: 1_000,   max: 500_000,     prefix: "CARD" },
  { code: "AGENT_MONIEPOINT",   name: "Agent Banking (Moniepoint)",     type: "agent_banking",   share: 0.05, match: 0.958, min: 500,     max: 200_000,     prefix: "AGT" },
  { code: "ATM_CHANNEL",        name: "ATM Withdrawals",                type: "atm",             share: 0.04, match: 0.973, min: 1_000,   max: 150_000,     prefix: "ATM" },
  { code: "CHEQUE_CLEARING",    name: "Cheque Clearing (NIBSS NACS)",   type: "cheque_clearing", share: 0.012,match: 0.985, min: 50_000,  max: 9_500_000,   prefix: "CHQ" },
  { code: "RTGS_TRANSFER",      name: "RTGS Large Value Transfers",     type: "rtgs",            share: 0.008,match: 0.996, min: 10_000_000, max: 250_000_000, prefix: "RTGS" },
];
/** The counter-side every channel reconciles against. */
const GL = { code: "BANK_CORE_GL", name: "Bank Core / GL (CBS)", type: "bank_core", prefix: "CBS" };

/**
 * Rows per side. Sized so the SMALL rails are still big enough to carry a
 * demonstrable exception queue without their match rate collapsing: at 12,000,
 * cheque clearing got 144 rows and the exception floor dragged it to 88.9%,
 * which no bank would recognise as its own cheque performance. At 40,000 the
 * same floor is ~2.5% of the channel and the rate stays credible — and 16,800
 * NIP rows reads far more like a bank's daily instant-payment volume than 5,040.
 */
const TOTAL_PER_SIDE = 40_000;

// ─── Exception scenarios, keyed to the real taxonomy ────────────────────────
// `category` is the coarse core enum the list filters use; `subCategory` is the
// precise catalogue key the intelligence flywheel learns on. Both are set,
// which is the contract exceptionIntelligence.captureExceptionOutcome expects.
const SCENARIOS = [
  { sub: "nip_timeout_debit_no_credit",        cat: "missing_counterparty",  sev: "critical", ch: "NIBSS_NIP",       desc: "NIP transfer timed out at beneficiary bank — customer debited, no credit confirmation received", res: "Raise NIBSS reversal within the 24h window; credit customer on confirmation." },
  { sub: "nip_duplicate_transfer",             cat: "duplicate_transaction", sev: "high",     ch: "NIBSS_NIP",       desc: "Same session ID presented twice — customer debited twice for one instruction", res: "Reverse the second leg and confirm the session ID against the NIBSS log." },
  { sub: "nip_inward_credit_not_applied",      cat: "missing_counterparty",  sev: "high",     ch: "NIBSS_NIP",       desc: "Inward NIP credit received on settlement but not applied to the beneficiary account", res: "Apply credit and investigate the posting rule that suppressed it." },
  { sub: "pos_declined_but_debited",           cat: "amount_mismatch",       sev: "critical", ch: "POS_INTERSWITCH", desc: "Terminal displayed DECLINED, issuer debited the customer — response code 68 (timeout)", res: "Reverse within 48h per CBN e-payment guidelines; escalate to switch via IDRS at 24h." },
  { sub: "pos_settlement_shortfall",           cat: "amount_mismatch",       sev: "high",     ch: "POS_INTERSWITCH", desc: "Acquirer settlement short of expected net after interchange and MSC", res: "Recompute net of fees and chargebacks; raise settlement query with the processor." },
  { sub: "pos_chargeback",                     cat: "missing_counterparty",  sev: "high",     ch: "POS_INTERSWITCH", desc: "Chargeback raised by issuer — funds debited from settlement account", res: "Retrieve terminal evidence and represent within the scheme deadline." },
  { sub: "ussd_timeout_debit",                 cat: "missing_counterparty",  sev: "high",     ch: "USSD_CHANNEL",    desc: "USSD session expired mid-transaction — customer debited, no value delivered", res: "Auto-reverse; confirm the session did not complete downstream before crediting." },
  { sub: "mobile_app_transaction_not_posted",  cat: "missing_counterparty",  sev: "medium",   ch: "MOBILE_BANKING_GTB", desc: "App confirmed the transfer to the customer; no corresponding CBS posting exists", res: "Post to CBS or reverse the app confirmation; reconcile the confirmation queue." },
  { sub: "card_switch_settlement_variance",    cat: "amount_mismatch",       sev: "high",     ch: "CARD_PAYMENTS",   desc: "Switch settlement position differs from the bank's clearing-derived expectation", res: "Decompose by interchange, scheme fees and disputes; fund the settled position first." },
  { sub: "card_rrn_stan_mismatch",             cat: "format_error",          sev: "medium",   ch: "CARD_PAYMENTS",   desc: "RRN and STAN disagree between the switch record and the CBS entry", res: "Match on RRN; correct the CBS narration and check the batch for re-keying." },
  { sub: "chargeback_inbound_acquirer",        cat: "missing_counterparty",  sev: "high",     ch: "CARD_PAYMENTS",   desc: "Inbound chargeback debited before merchant recovery was raised", res: "Recover from the merchant settlement or absorb; log against the dispute case." },
  { sub: "agent_banking_float_reconciliation", cat: "amount_mismatch",       sev: "medium",   ch: "AGENT_MONIEPOINT",desc: "Agent float balance disagrees with the bank's record of agent-initiated activity", res: "Reconcile agent float movements against commission and settlement postings." },
  { sub: "agent_cash_in_not_credited",         cat: "missing_counterparty",  sev: "high",     ch: "AGENT_MONIEPOINT",desc: "Customer deposited cash with an agent; the account was never credited", res: "Credit the customer and recover from the agent's float; a customer-conduct issue if aged." },
  { sub: "atm_dispense_error_on_us",           cat: "amount_mismatch",       sev: "critical", ch: "ATM_CHANNEL",     desc: "ATM recorded a dispense the cash count does not support — customer disputes receipt", res: "Reconcile against the ATM journal and cash-count variance; credit within CBN timelines." },
  { sub: "atm_journal_switch_mismatch",        cat: "amount_mismatch",       sev: "medium",   ch: "ATM_CHANNEL",     desc: "ATM electronic journal disagrees with the switch record for the same RRN", res: "Treat the journal as authoritative for dispense; correct the switch-derived posting." },
  { sub: "cheque_returned_credit_not_reversed",cat: "reversal_unmatched",    sev: "critical", ch: "CHEQUE_CLEARING", desc: "Cheque returned unpaid; the provisional credit was never reversed in the CBS", res: "Post the contra immediately and lien the balance; escalate as a credit exposure if withdrawn." },
  { sub: "cheque_duplicate_presentment",       cat: "duplicate_transaction", sev: "critical", ch: "CHEQUE_CLEARING", desc: "Same MICR serial cleared twice — the instrument is retained by the presenting bank", res: "Recall within the session or raise an inter-bank claim citing the truncation rules." },
  { sub: "cheque_dud_not_reported",            cat: "unmatched",             sev: "critical", ch: "CHEQUE_CLEARING", desc: "Cheque returned INSUFFICIENT FUNDS with no CRMS submission recorded", res: "Report to CRMS and two credit bureaux; cancel unissued cheque books at the third occurrence." },
  { sub: "rtgs_value_date_discrepancy",        cat: "timing_difference",     sev: "high",     ch: "RTGS_TRANSFER",   desc: "RTGS settlement value date differs from the instruction date on a large-value transfer", res: "Confirm the CBN settlement advice and restate the value date; assess interest impact." },
  { sub: "rtgs_cut_off_time_breach",           cat: "timing_difference",     sev: "medium",   ch: "RTGS_TRANSFER",   desc: "Instruction presented after the RTGS cut-off and carried to the next session", res: "Notify the customer and re-present at session open; review the submission workflow." },
];

const FIRST = ["Adebayo","Chinelo","Ibrahim","Ngozi","Olusegun","Fatima","Emeka","Aisha","Tunde","Blessing","Suleiman","Chiamaka","Yusuf","Folake","Obinna","Halima","Kelechi","Amina","Segun","Nkechi"];
const LAST = ["Okonkwo","Adeyemi","Bello","Okafor","Balogun","Musa","Eze","Abubakar","Oyelaran","Nwosu","Danjuma","Chukwu","Lawal","Adesanya","Ibeh","Sani","Uche","Mohammed","Ogunleye","Onyeka"];
const MERCHANTS = ["SHOPRITE LEKKI","TOTAL FILLING STN","MTN RECHARGE","JUMIA NG","DSTV SUBSCRIPTION","IKEDC PREPAID","MEDPLUS PHARMACY","CHICKEN REPUBLIC","SPAR IKEJA","AIRTEL DATA"];

let seed = 20260813;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const person = () => `${pick(FIRST)} ${pick(LAST)}`;
const money = (min, max) => (min + rnd() * (max - min)).toFixed(2);
const pad = (n, w) => String(n).padStart(w, "0");

function refFor(ch, i, date) {
  const d = date.toISOString().slice(2, 10).replace(/-/g, "");
  // NIP session IDs are a fixed 30-char scheme; the rest carry their own shape.
  if (ch.code === "NIBSS_NIP") return `0000${d}${pad(Math.floor(rnd() * 1e12), 12)}`.slice(0, 30);
  if (ch.code === "CHEQUE_CLEARING") return `CHQ${pad(100000 + i, 6)}`;
  return `${ch.prefix}-${d}-${pad(i, 7)}`;
}

function narrationFor(ch) {
  switch (ch.code) {
    case "NIBSS_NIP": return `TRF FRM ${person().toUpperCase()} TO ${person().toUpperCase()}`;
    case "POS_INTERSWITCH": return `POS PURCHASE ${pick(MERCHANTS)}`;
    case "USSD_CHANNEL": return `*737# TRANSFER TO ${person().toUpperCase()}`;
    case "MOBILE_BANKING_GTB": return `MOBILE TRF ${person().toUpperCase()}`;
    case "CARD_PAYMENTS": return `CARD PURCHASE ${pick(MERCHANTS)} 539983******${pad(Math.floor(rnd() * 9999), 4)}`;
    case "AGENT_MONIEPOINT": return `AGENT ${rnd() > 0.5 ? "CASH-IN" : "CASH-OUT"} ${person().toUpperCase()}`;
    case "ATM_CHANNEL": return `ATM WDL LAGOS ${pad(Math.floor(rnd() * 999), 3)}`;
    case "CHEQUE_CLEARING": return `CHEQUE CLEARING INWARD ${person().toUpperCase()}`;
    case "RTGS_TRANSFER": return `RTGS TRANSFER ${person().toUpperCase()} LTD`;
    default: return "TRANSACTION";
  }
}

// ─── Connect ────────────────────────────────────────────────────────────────
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const url = env.match(/^DATABASE_URL=['"]?([^'"\n\r]+)/m)[1];
const u = new URL(url);
const db = await mysql.createConnection({
  host: u.hostname, port: Number(u.port || 3306),
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""), ssl: { minVersion: "TLSv1.2" },
});

const q = async (sql, args = []) => (await db.query(sql, args))[0];

try {
  // ── Guard: prove the target is the financial-services DEMO tenant ─────────
  const [org] = await q("SELECT id, name, segment FROM organizations WHERE id = ?", [TARGET_ORG]);
  if (!org) throw new Error(`Organisation ${TARGET_ORG} does not exist`);
  if (org.segment !== "financial_services") {
    throw new Error(`REFUSING: org ${org.id} "${org.name}" is segment=${org.segment}, not financial_services`);
  }
  if (!/\(demo\)/i.test(org.name)) {
    throw new Error(`REFUSING: org ${org.id} "${org.name}" is not marked (Demo). This script never targets a real tenant.`);
  }
  const [usr] = await q("SELECT id FROM users WHERE organizationId = ? ORDER BY id LIMIT 1", [TARGET_ORG]);
  if (!usr) throw new Error(`Organisation ${TARGET_ORG} has no user to own the seeded rows`);

  console.log(`\nTarget: [${org.id}] ${org.name} — segment=${org.segment}, ownerUser=${usr.id}`);
  console.log(`Mode:   ${COMMIT ? (WIPE_ONLY ? "COMMIT (wipe only)" : "COMMIT (wipe + seed)") : "DRY RUN — nothing will be written"}\n`);

  const before = await q(
    `SELECT c.code, c.isActive, COUNT(t.id) n,
            SUM(t.status IN ('matched','manually_matched')) matched,
            SUM(t.status='exception') exc
       FROM channels c LEFT JOIN transactions t ON t.channelId=c.id AND t.organizationId=?
      WHERE c.organizationId=? GROUP BY c.code, c.isActive ORDER BY n DESC`, [TARGET_ORG, TARGET_ORG]);
  console.log("BEFORE — channels owned by this org:");
  console.table(before);
  const [beforeTot] = await q("SELECT COUNT(*) txns FROM transactions WHERE organizationId=?", [TARGET_ORG]);
  const [beforeExc] = await q("SELECT COUNT(*) exceptions FROM exceptions WHERE organizationId=?", [TARGET_ORG]);
  console.log(`BEFORE totals — transactions=${beforeTot.txns}  exceptions=${beforeExc.exceptions}\n`);

  if (!COMMIT) {
    console.log("Planned channel mix:");
    console.table(CHANNELS.map((c) => ({
      channel: c.name,
      share: `${(c.share * 100).toFixed(1)}%`,
      txns: Math.round(TOTAL_PER_SIDE * c.share),
      matchRate: `${(c.match * 100).toFixed(1)}%`,
    })));
    console.log(`\nPlus ${TOTAL_PER_SIDE} counter-entries on ${GL.name}, ${SCENARIOS.length} exception scenarios`);
    console.log(`across ${new Set(SCENARIOS.map(s=>s.sub)).size} distinct taxonomy keys, and one job per channel.`);
    console.log("\nRe-run with --commit to apply.\n");
    process.exit(0);
  }

  // ── Wipe: strictly rows this script created, for this org only ────────────
  const priorBatches = await q(
    "SELECT id FROM upload_batches WHERE organizationId=? AND fileName LIKE ?", [TARGET_ORG, `%${SEED_MARKER}%`]);
  const priorIds = priorBatches.map((b) => b.id);
  if (priorIds.length) {
    const [pj] = await q("SELECT COUNT(*) n FROM reconciliation_jobs WHERE organizationId=? AND name LIKE ?", [TARGET_ORG, `%${SEED_MARKER}%`]);
    await q("DELETE FROM exceptions WHERE organizationId=? AND jobId IN (SELECT id FROM reconciliation_jobs WHERE organizationId=? AND name LIKE ?)", [TARGET_ORG, TARGET_ORG, `%${SEED_MARKER}%`]);
    await q("DELETE FROM matches WHERE organizationId=? AND jobId IN (SELECT id FROM reconciliation_jobs WHERE organizationId=? AND name LIKE ?)", [TARGET_ORG, TARGET_ORG, `%${SEED_MARKER}%`]);
    await q("DELETE FROM reconciliation_jobs WHERE organizationId=? AND name LIKE ?", [TARGET_ORG, `%${SEED_MARKER}%`]);
    await q(`DELETE FROM transactions WHERE organizationId=? AND batchId IN (${priorIds.map(()=>"?").join(",")})`, [TARGET_ORG, ...priorIds]);
    await q(`DELETE FROM upload_batches WHERE organizationId=? AND id IN (${priorIds.map(()=>"?").join(",")})`, [TARGET_ORG, ...priorIds]);
    console.log(`Wiped prior ${SEED_MARKER} data: ${priorIds.length} batches, ${pj.n} jobs\n`);
  } else {
    console.log(`No prior ${SEED_MARKER} data to wipe.\n`);
  }

  if (REPLACE_ALL) {
    // Every predicate here names the organisation, so this cannot reach another
    // tenant even though it is otherwise unrestricted.
    const [t0] = await q("SELECT COUNT(*) n FROM transactions WHERE organizationId=?", [TARGET_ORG]);
    await q("DELETE FROM exceptions WHERE organizationId=?", [TARGET_ORG]);
    await q("DELETE FROM matches WHERE organizationId=?", [TARGET_ORG]);
    await q("DELETE FROM transactions WHERE organizationId=?", [TARGET_ORG]);
    await q("DELETE FROM reconciliation_jobs WHERE organizationId=?", [TARGET_ORG]);
    await q("DELETE FROM upload_batches WHERE organizationId=?", [TARGET_ORG]);
    console.log(`--replace-all: cleared ${t0.n} pre-existing transactions and their jobs/exceptions for org ${TARGET_ORG}.\n`);
  }

  if (WIPE_ONLY) { console.log("--wipe-only: stopping here."); await db.end(); process.exit(0); }

  // ── Channels ──────────────────────────────────────────────────────────────
  const chanId = {};
  for (const c of [...CHANNELS, GL]) {
    const [existing] = await q("SELECT id FROM channels WHERE code=?", [c.code]);
    if (existing) {
      await q("UPDATE channels SET name=?, channelType=?, isActive=1, organizationId=? WHERE id=?",
        [c.name, c.type, TARGET_ORG, existing.id]);
      chanId[c.code] = existing.id;
    } else {
      const r = await q(
        "INSERT INTO channels (organizationId,name,code,description,channelType,country,defaultCurrency,isActive) VALUES (?,?,?,?,?,'NGA','NGN',1)",
        [TARGET_ORG, c.name, c.code, `${c.name} — demo channel`, c.type]);
      chanId[c.code] = r.insertId;
    }
  }
  // Retire any channel this org owns that is not part of the seeded rail set —
  // NIBSS_NIP_LEGACY (84,250 rows on a switched-OFF channel that dominated every
  // per-channel view) and MOBILE_MONEY_OPAY among them. Emptied and deactivated
  // rather than deleted, so nothing referencing them dangles.
  const keep = new Set([...CHANNELS, GL].map((c) => c.code));
  const stale = await q("SELECT id, code FROM channels WHERE organizationId=? AND code NOT IN (?)",
    [TARGET_ORG, [...keep]]);
  for (const s of stale) {
    const [n] = await q("SELECT COUNT(*) n FROM transactions WHERE channelId=? AND organizationId=?", [s.id, TARGET_ORG]);
    await q("DELETE FROM transactions WHERE channelId=? AND organizationId=?", [s.id, TARGET_ORG]);
    await q("UPDATE channels SET isActive=0 WHERE id=?", [s.id]);
    console.log(`Retired stale channel ${s.code} (cleared ${n.n} rows, deactivated).`);
  }
  if (stale.length) console.log("");

  // ── Transactions ──────────────────────────────────────────────────────────
  const now = new Date();
  const startDate = new Date(now.getTime() - DAYS * 864e5);
  const mkBatch = async (channelCode, label, rows) => {
    const r = await q(
      "INSERT INTO upload_batches (userId,organizationId,channelId,fileName,fileHash,status,totalRows,validRows,invalidRows) VALUES (?,?,?,?,?,'completed',?,?,0)",
      [usr.id, TARGET_ORG, chanId[channelCode], `${label}_${SEED_MARKER}.csv`, `${SEED_MARKER}-${channelCode}-${Date.now()}`, rows, rows]);
    return r.insertId;
  };

  const glRows = [];
  let seededTxns = 0;
  const perChannel = {};

  for (const c of CHANNELS) {
    const count = Math.round(TOTAL_PER_SIDE * c.share);
    const batchId = await mkBatch(c.code, c.name.replace(/[^A-Za-z0-9]+/g, "_"), count);
    const rows = [];
    let matched = 0, exception = 0;
    // Guarantee enough exception rows for every scenario on this channel to have
    // victims. A pure per-channel rate leaves the SMALL channels empty — cheque
    // clearing (144 rows) yielded 2 and RTGS (96) yielded none, so the two newest
    // and most differentiating rails had nothing to show. The floor is applied to
    // the first rows and the rate governs the remainder, so the headline match
    // rate barely moves.
    const scenariosHere = SCENARIOS.filter((s) => s.ch === c.code).length;
    const exceptionFloor = scenariosHere * 4;
    for (let i = 1; i <= count; i++) {
      const when = new Date(startDate.getTime() + rnd() * DAYS * 864e5);
      const amount = money(c.min, c.max);
      const ref = refFor(c, i, when);
      const roll = rnd();
      // Per-channel match rate, with the residual split between an exception and
      // a plain unmatched row — an operator's queue is never all one or the other.
      let status = "matched";
      if (exception < exceptionFloor) status = "exception";
      else if (roll > c.match) status = roll > c.match + (1 - c.match) * 0.55 ? "unmatched" : "exception";
      if (status === "matched") matched++; else if (status === "exception") exception++;
      rows.push([batchId, chanId[c.code], usr.id, TARGET_ORG, ref, null, narrationFor(c), amount, "NGN", when, when,
        rnd() > 0.5 ? "debit" : "credit", person(), 0, null, status, null, null]);
      // The GL counter-entry for everything that reconciled.
      if (status === "matched") glRows.push({ ref, amount, when, desc: `${GL.prefix} POSTING ${ref}` });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await q(
        `INSERT INTO transactions (batchId,channelId,userId,organizationId,transactionRef,externalRef,description,amount,currency,transactionDate,valueDate,debitCredit,counterparty,isReversal,originalTransactionRef,status,matchId,rawData) VALUES ${chunk.map(()=>"(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
        chunk.flat());
    }
    perChannel[c.code] = { count, matched, exception };
    seededTxns += count;
    process.stdout.write(`  ${c.name.padEnd(38)} ${String(count).padStart(6)} rows\n`);
  }

  // GL counter-side
  const glBatch = await mkBatch(GL.code, "Core_Banking_GL", glRows.length);
  for (let i = 0; i < glRows.length; i += 500) {
    const chunk = glRows.slice(i, i + 500);
    await q(
      `INSERT INTO transactions (batchId,channelId,userId,organizationId,transactionRef,description,amount,currency,transactionDate,valueDate,debitCredit,counterparty,status) VALUES ${chunk.map(()=>"(?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
      chunk.flatMap((g) => [glBatch, chanId[GL.code], usr.id, TARGET_ORG, g.ref, g.desc, g.amount, "NGN", g.when, g.when, "credit", "CORE BANKING", "matched"]));
  }
  seededTxns += glRows.length;
  console.log(`  ${GL.name.padEnd(38)} ${String(glRows.length).padStart(6)} rows (counter-side)\n`);

  // ── Jobs, one per channel against the GL ──────────────────────────────────
  const jobIds = {};
  for (const c of CHANNELS) {
    const s = perChannel[c.code];
    const rate = ((s.matched / s.count) * 100).toFixed(2);
    const ranAt = new Date(now.getTime() - Math.floor(rnd() * 5) * 864e5);
    const r = await q(
      `INSERT INTO reconciliation_jobs (userId,organizationId,moduleType,name,sourceChannelId,targetChannelId,dateFrom,dateTo,currency,status,totalSourceTxns,totalTargetTxns,matchedCount,exceptionCount,unmatchedCount,matchRate,processingTimeMs,startedAt,completedAt)
       VALUES (?,?,'settlement',?,?,?,?,?,'NGN','completed',?,?,?,?,?,?,?,?,?)`,
      [usr.id, TARGET_ORG, `${c.name} vs Core Banking — ${SEED_MARKER}`, chanId[c.code], chanId[GL.code],
       startDate, now, s.count, s.matched, s.matched, s.exception, s.count - s.matched - s.exception,
       rate, 4000 + Math.floor(rnd() * 26000), ranAt, new Date(ranAt.getTime() + 30000)]);
    jobIds[c.code] = r.insertId;
  }
  console.log(`Created ${Object.keys(jobIds).length} completed reconciliation runs.\n`);

  // ── Exceptions, carrying real taxonomy keys ───────────────────────────────
  let excCount = 0;
  // Ages spread across the SLA bands so the Age Tracker has something to show.
  const ageDays = [0, 1, 2, 4, 7, 11, 16, 23];

  // Partition each channel's exception rows ACROSS that channel's scenarios, so
  // every exception belongs to exactly one transaction. Querying per scenario
  // returned the same rows each time and stacked three different exceptions onto
  // one transaction — which no engine would produce and which double-counts the
  // queue against the transaction list.
  for (const c of CHANNELS) {
    const jobId = jobIds[c.code];
    const mine = SCENARIOS.filter((s) => s.ch === c.code);
    if (!jobId || mine.length === 0) continue;
    const victims = await q(
      "SELECT id, amount, transactionRef, currency FROM transactions WHERE organizationId=? AND channelId=? AND status='exception' ORDER BY id",
      [TARGET_ORG, chanId[c.code]]);
    for (let i = 0; i < victims.length; i++) {
      const sc = mine[i % mine.length];
      const v = victims[i];
      const created = new Date(now.getTime() - ageDays[i % ageDays.length] * 864e5 - Math.floor(rnd() * 20) * 36e5);
      const roll = rnd();
      const status = roll > 0.78 ? "resolved" : roll > 0.62 ? "in_review" : "open";
      await q(
        `INSERT INTO exceptions (organizationId,jobId,transactionId,category,subCategory,severity,currency,description,suggestedResolution,status,resolvedBy,resolvedAt,resolutionNotes,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [TARGET_ORG, jobId, v.id, sc.cat, sc.sub, sc.sev, v.currency ?? "NGN",
         `${sc.desc} — ₦${Number(v.amount).toLocaleString()} (ref ${v.transactionRef})`,
         sc.res, status,
         status === "resolved" ? usr.id : null,
         status === "resolved" ? new Date(created.getTime() + 36e5 * 6) : null,
         status === "resolved" ? "Resolved per the catalogued procedure; counterparty confirmed." : null,
         created]);
      excCount++;
    }
  }
  console.log(`Created ${excCount} exceptions across ${new Set(SCENARIOS.map(s=>s.sub)).size} taxonomy categories.\n`);

  // Stats cache is per-org and TTL'd, but drop this org's row so the dashboard
  // reflects the new data on the very next load rather than up to 5 min later.
  await q("DELETE FROM dashboard_stats_cache WHERE organizationId=? OR organizationId IS NULL", [TARGET_ORG]);

  // ── After ─────────────────────────────────────────────────────────────────
  const after = await q(
    `SELECT c.name channel, COUNT(t.id) txns,
            SUM(t.status IN ('matched','manually_matched')) matched,
            SUM(t.status='exception') exceptions,
            SUM(t.status='unmatched') unmatched,
            ROUND(100*SUM(t.status IN ('matched','manually_matched'))/NULLIF(COUNT(t.id),0),1) matchRate
       FROM channels c JOIN transactions t ON t.channelId=c.id AND t.organizationId=?
      WHERE c.organizationId=? GROUP BY c.name ORDER BY txns DESC`, [TARGET_ORG, TARGET_ORG]);
  console.log("AFTER — per channel:");
  console.table(after);

  const [tot] = await q("SELECT COUNT(*) txns FROM transactions WHERE organizationId=?", [TARGET_ORG]);
  const [exc] = await q("SELECT COUNT(*) n FROM exceptions WHERE organizationId=?", [TARGET_ORG]);
  console.log(`AFTER totals — transactions=${tot.txns}  exceptions=${exc.n}  seeded=${seededTxns}`);

  // Prove nothing outside the target tenant moved.
  const others = await q("SELECT organizationId, COUNT(*) n FROM transactions WHERE organizationId <> ? OR organizationId IS NULL GROUP BY organizationId", [TARGET_ORG]);
  console.log("\nOther tenants (must be untouched):");
  console.table(others);
} finally {
  await db.end();
}
