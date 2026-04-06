/**
 * demoSeedFinServ.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Financial Services Demo Seed Engine
 * Entities: LapoMFB (microfinance) + Renmoney MFB (digital lending)
 * Scale: 3,000,000 transactions across 8 payment rails
 * Match rate: 95% (2,850,000 matched, 150,000 open exceptions)
 * Strategy: large bulk inserts (2,000 rows/batch) for speed
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { eq, sql } from "drizzle-orm";
import {
  transactions,
  uploadBatches,
  reconciliationJobs,
  exceptions,
  matches,
  channels,
  agentMemory,
} from "../drizzle/schema";
import { getDb } from "./db";

// ── Helpers ────────────────────────────────────────────────────────────────

const demoTag = (extra: Record<string, unknown> = {}) => ({ ...extra, _demo: true, _segment: "finserv" });
const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

// Pre-generate a pool of amounts to avoid repeated random calls
const AMOUNT_POOL = Array.from({ length: 1000 }, () =>
  (randomBetween(500, 50000000) / 100).toFixed(2)
);

// ── Payment Rails ──────────────────────────────────────────────────────────

const PAYMENT_RAILS = [
  { name: "NIBSS NIP Transfer",    code: "NIBSS_NIP",    channelType: "nibss",        description: "NIBSS Instant Payment — interbank transfers via NIP gateway",             fraction: 0.35 },
  { name: "Direct Debit (NIBSS)",  code: "DIRECT_DEBIT", channelType: "bank_transfer", description: "NIBSS Direct Debit mandate collections for loan repayments",             fraction: 0.25 },
  { name: "USSD Banking",          code: "USSD_BANKING",  channelType: "mobile_money", description: "USSD *737#/*901# mobile banking transactions",                           fraction: 0.15 },
  { name: "Mobile App Banking",    code: "MOBILE_APP",    channelType: "mobile_money", description: "In-app transfers via LapoMFB and Renmoney mobile apps",                  fraction: 0.10 },
  { name: "Core Banking (Finacle)",code: "CORE_BANKING",  channelType: "bank_core",    description: "Direct core banking system entries (Finacle/T24)",                       fraction: 0.07 },
  { name: "POS Terminal",          code: "POS_TERMINAL",  channelType: "pos",          description: "Point-of-Sale card transactions at merchant terminals",                  fraction: 0.04 },
  { name: "Card Payment (Visa/MC)",code: "CARD_PAYMENT",  channelType: "card_payments",description: "Visa and Mastercard online card payments",                              fraction: 0.02 },
  { name: "Agent Banking (MFIN)",  code: "AGENT_BANKING", channelType: "mobile_money", description: "Agent banking network collections via MFIN-licensed agents",            fraction: 0.02 },
];

// ── Borrower Name Pool (50 names cycled) ──────────────────────────────────

const BORROWER_NAMES = [
  "Adunola Fashola","Blessing Okonkwo","Chidinma Eze","Damilola Adeyemi","Esther Nwosu",
  "Fatima Musa","Grace Obi","Helen Okeke","Ifeoma Chukwu","Janet Abubakar",
  "Kemi Adebayo","Lola Balogun","Mary Okafor","Ngozi Nnaji","Oluwakemi Afolabi",
  "Patricia Igwe","Queen Osei","Rita Nwachukwu","Stella Ogundipe","Taiwo Adeleke",
  "Adebayo Ogundimu","Babatunde Fashola Jr.","Chukwuemeka Obi","David Adekunle","Emmanuel Nwachukwu",
  "Femi Adesanya","Gbenga Oluwole","Hassan Musa","Ibrahim Aliyu","James Okonkwo",
  "Kayode Adewale","Lanre Badmus","Michael Eze","Nnamdi Okafor","Olumide Afolabi",
  "Peter Igwe","Rotimi Adeyemi","Seun Balogun","Tunde Ogundele","Usman Abdullahi",
  "Victor Chukwu","Wale Adeleke","Xavier Osei","Yemi Nwosu","Zubair Suleiman",
  "Amina Yusuf","Bola Tinubu-Eze","Chibuzor Okonkwo","Dupe Adesanya","Emeka Nwosu",
];

const BORROWER_COUNT = BORROWER_NAMES.length;

// ── Exception Scenarios ────────────────────────────────────────────────────

const FINSERV_EXCEPTIONS = [
  { type: "failed_direct_debit", category: "unmatched",
    description: "NIBSS Direct Debit mandate returned — insufficient funds",
    diagnosis: JSON.stringify({ rootCause: "Direct debit mandate returned by borrower's bank due to insufficient funds.", shortfall: null, deductionType: "returned_mandate", recommendedAction: "Retry direct debit in 3 business days. Escalate to collections if second attempt fails.", confidence: 0.97, plainLanguage: "The borrower's bank rejected the automatic loan repayment because there wasn't enough money in their account. We need to try again in 3 days or call the borrower." }),
    resolution: "Retry direct debit scheduled for T+3. Borrower notified via SMS.", outcome: "resolved" },
  { type: "ussd_timeout", category: "timing_difference",
    description: "USSD session timed out — payment credited but not reflected in loan ledger",
    diagnosis: JSON.stringify({ rootCause: "USSD session timed out after borrower entered PIN. Payment processed by network before session closed.", shortfall: null, deductionType: null, recommendedAction: "Match the USSD credit to the open loan repayment schedule. Update loan ledger manually.", confidence: 0.94, plainLanguage: "The borrower paid via USSD but their phone lost connection before the app confirmed it. The money arrived — it just needs to be matched to the right loan account." }),
    resolution: "Manual match applied. Loan ledger updated. IT ticket raised.", outcome: "resolved" },
  { type: "pos_reversal", category: "duplicate_transaction",
    description: "POS transaction reversed by acquirer — original and reversal both visible",
    diagnosis: JSON.stringify({ rootCause: "POS terminal sent a reversal message after original transaction was approved. Both appear in settlement file.", shortfall: null, deductionType: "pos_reversal", recommendedAction: "Pair the original transaction with its reversal. Net impact: zero.", confidence: 0.99, plainLanguage: "The card machine processed a payment and then immediately cancelled it. Both transactions show up. They cancel each other out — no money was actually collected." }),
    resolution: "Original and reversal paired. Net impact: ₦0. Loan ledger unchanged.", outcome: "resolved" },
  { type: "duplicate_nip_credit", category: "duplicate_transaction",
    description: "Duplicate NIP credit — same session ID credited twice by sending bank",
    diagnosis: JSON.stringify({ rootCause: "Sending bank's NIP gateway timed out and retried, resulting in two credits with same session ID.", shortfall: null, deductionType: "duplicate_nip", recommendedAction: "Retain first credit as valid loan repayment. Initiate refund for second credit via NIP within 24 hours.", confidence: 0.98, plainLanguage: "The borrower's bank accidentally sent the same payment twice. We should keep one as the loan repayment and send the other one back immediately." }),
    resolution: "First credit matched to loan. Second credit refunded via NIP. NIBSS dispute logged.", outcome: "resolved" },
  { type: "partial_loan_repayment", category: "amount_mismatch",
    description: "Borrower paid partial instalment — ₦18,500 against scheduled ₦25,000",
    diagnosis: JSON.stringify({ rootCause: "Borrower made partial payment of ₦18,500 against scheduled monthly instalment of ₦25,000.", shortfall: 6500, deductionType: "partial_repayment", recommendedAction: "Apply ₦18,500 to loan account. Record ₦6,500 as outstanding arrears. Generate payment reminder.", confidence: 0.96, plainLanguage: "The borrower paid ₦18,500 but their monthly repayment is ₦25,000. They're ₦6,500 short. Apply what they paid and send a reminder for the remaining amount." }),
    resolution: "Partial payment applied. Arrears of ₦6,500 recorded. Reminder sent.", outcome: "resolved" },
  { type: "wrong_account_payment", category: "missing_counterparty",
    description: "Payment received with incorrect loan account reference — cannot auto-match",
    diagnosis: JSON.stringify({ rootCause: "Borrower used an old loan account number that has been closed and replaced.", shortfall: null, deductionType: null, recommendedAction: "Search borrower database by name and phone number to identify active loan account.", confidence: 0.89, plainLanguage: "The borrower sent money using an old account number. The payment arrived but we don't know which loan to apply it to. Look up the borrower by name or phone." }),
    resolution: "Borrower identified by phone. Payment applied to active loan LN-2024-08847.", outcome: "resolved" },
  { type: "agent_banking_float_shortfall", category: "amount_mismatch",
    description: "Agent banking collection short by ₦150 — agent float fee deducted",
    diagnosis: JSON.stringify({ rootCause: "MFIN-licensed agent deducted ₦150 float fee before remitting loan repayment.", shortfall: 150, deductionType: "agent_float_fee", recommendedAction: "Accept ₦14,850 as full repayment. Write off ₦150 to Agent Banking Charges cost centre.", confidence: 0.95, plainLanguage: "The agent who collected the borrower's payment kept ₦150 as their fee. This is normal for agent banking. Treat ₦14,850 as the full repayment." }),
    resolution: "Partial payment accepted. ₦150 written off to Agent Banking Charges.", outcome: "resolved" },
  { type: "mobile_app_pending", category: "timing_difference",
    description: "Mobile app payment in 'pending' state — bank confirmation delayed 6+ hours",
    diagnosis: JSON.stringify({ rootCause: "Mobile app payment initiated but interbank confirmation delayed beyond normal 2-hour window.", shortfall: null, deductionType: null, recommendedAction: "Wait 24 hours for bank confirmation before escalating.", confidence: 0.91, plainLanguage: "The borrower says they paid via the app but we haven't received confirmation from the bank yet. Wait until tomorrow — it will likely resolve itself." }),
    resolution: "Confirmed after 18 hours. Applied to loan ledger on T+1.", outcome: "resolved" },
];

// ── Channel Seeder ─────────────────────────────────────────────────────────

async function ensureFinServChannel(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  name: string,
  code: string,
  channelType: string
): Promise<number> {
  const existing = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  if (existing[0]) return existing[0].id;
  await db.insert(channels).values({
    name,
    code,
    channelType: channelType as "bank_core",
    description: PAYMENT_RAILS.find(r => r.code === code)?.description ?? name,
    isActive: true,
  });
  const created = await db.select().from(channels).where(eq(channels.code, code)).limit(1);
  return created[0].id;
}

// ── Fast Bulk Inserter ─────────────────────────────────────────────────────
// Inserts `count` rows in chunks of `chunkSize` (default 2000).
// Returns the IDs of the last `sampleSize` inserted rows for match linking.

async function bulkInsertTransactions(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  batchId: number,
  channelId: number,
  userId: number,
  orgId: number | null,
  count: number,
  isSource: boolean,
  refStart: number,
  railCode: string,
  loanPrefix: string,
  status: "matched" | "exception",
  chunkSize = 2000,
  sampleSize = 0
): Promise<number[]> {
  const sampledIds: number[] = [];
  const totalChunks = Math.ceil(count / chunkSize);

  for (let chunk = 0; chunk < totalChunks; chunk++) {
    const chunkStart = chunk * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize, count);
    const rows = [];

    for (let i = chunkStart; i < chunkEnd; i++) {
      const refNum = refStart + i;
      const borrower = BORROWER_NAMES[refNum % BORROWER_COUNT];
      const amount = AMOUNT_POOL[refNum % 1000];
      const txDate = daysAgo(refNum % 60);
      const loanRef = `${loanPrefix}-${String(refNum).padStart(8, "0")}`;

      rows.push({
        batchId,
        channelId,
        userId,
        organizationId: orgId,
        transactionRef: isSource ? `${railCode}-${refNum}` : loanRef,
        externalRef: loanRef,
        description: isSource
          ? `Loan repayment from ${borrower} — ${loanRef}`
          : `Repayment schedule ${loanRef} — ${borrower}`,
        amount,
        currency: "NGN",
        transactionDate: txDate,
        valueDate: txDate,
        debitCredit: (isSource ? "credit" : "debit") as "credit" | "debit",
        counterparty: borrower,
        status,
        rawData: demoTag({ rail: railCode, loanRef, refNum }),
      });
    }

    await db.insert(transactions).values(rows);

    // Only fetch IDs for the last chunk if we need samples
    if (sampleSize > 0 && chunk === totalChunks - 1) {
      const inserted = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.batchId, batchId))
        .orderBy(sql`id DESC`)
        .limit(Math.min(sampleSize, rows.length));
      sampledIds.push(...inserted.map(r => r.id).reverse());
    }
  }

  return sampledIds;
}

// ── Main Financial Services Seed Function ─────────────────────────────────

export interface FinServSeedResult {
  segment: "finserv";
  entity: "lapo" | "renmoney" | "both";
  jobId: number;
  totalTransactions: number;
  matchedCount: number;
  exceptionCount: number;
  matchRate: string;
  paymentRails: string[];
  message: string;
}

export async function seedFinServDemoData(
  userId: number,
  orgId: number | null,
  entity: "lapo" | "renmoney" | "both" = "both"
): Promise<FinServSeedResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // ── 1. Seed channels ───────────────────────────────────────────────────
  const channelIds: Record<string, number> = {};
  for (const rail of PAYMENT_RAILS) {
    channelIds[rail.code] = await ensureFinServChannel(db, rail.name, rail.code, rail.channelType);
  }

  const loanPrefix = entity === "lapo" ? "LAPO" : entity === "renmoney" ? "REN" : "MFB";

  // ── 2. Scale definition ────────────────────────────────────────────────
  // 3,000,000 total transactions across 8 rails
  // 95% matched (2,850,000), 5% open exceptions (150,000)
  const TOTAL_TRANSACTIONS = 3_000_000;
  const MATCH_RATE = 0.95;
  const MATCHED_COUNT = Math.floor(TOTAL_TRANSACTIONS * MATCH_RATE); // 2,850,000
  const EXCEPTION_COUNT = TOTAL_TRANSACTIONS - MATCHED_COUNT;        // 150,000

  let globalRefStart = 1_000_000;
  const sampleSourceIds: number[] = [];
  const sampleTargetIds: number[] = [];

  // ── 3. Insert transactions per rail ────────────────────────────────────
  for (const rail of PAYMENT_RAILS) {
    const railTotal = Math.floor(TOTAL_TRANSACTIONS * rail.fraction);
    const railMatched = Math.floor(railTotal * MATCH_RATE);
    const railExceptions = railTotal - railMatched;

    // Source batch (bank / payment rail side)
    const sourceBatchResult = await db.insert(uploadBatches).values({
      userId,
      channelId: channelIds[rail.code],
      organizationId: orgId,
      fileName: `${loanPrefix}_${rail.code}_source_demo.csv`,
      totalRows: railTotal,
      validRows: railTotal,
      invalidRows: 0,
      status: "completed",
    });
    const sourceBatchId = Number((sourceBatchResult as { insertId?: number }).insertId ?? 0);

    // Target batch (loan management system side)
    const targetBatchResult = await db.insert(uploadBatches).values({
      userId,
      channelId: channelIds[rail.code],
      organizationId: orgId,
      fileName: `${loanPrefix}_${rail.code}_lms_demo.csv`,
      totalRows: railTotal,
      validRows: railTotal,
      invalidRows: 0,
      status: "completed",
    });
    const targetBatchId = Number((targetBatchResult as { insertId?: number }).insertId ?? 0);

    const channelId = channelIds[rail.code];

    // Insert matched source transactions (collect last 50 IDs for match records)
    const srcIds = await bulkInsertTransactions(
      db, sourceBatchId, channelId, userId, orgId,
      railMatched, true, globalRefStart, rail.code, loanPrefix,
      "matched", 2000, 50
    );
    sampleSourceIds.push(...srcIds);

    // Insert matched target transactions (collect last 50 IDs)
    const tgtIds = await bulkInsertTransactions(
      db, targetBatchId, channelId, userId, orgId,
      railMatched, false, globalRefStart, rail.code, loanPrefix,
      "matched", 2000, 50
    );
    sampleTargetIds.push(...tgtIds);

    globalRefStart += railMatched;

    // Insert exception source transactions (status = "exception")
    await bulkInsertTransactions(
      db, sourceBatchId, channelId, userId, orgId,
      railExceptions, true, globalRefStart, rail.code, loanPrefix,
      "exception", 2000, 0
    );
    globalRefStart += railExceptions;
  }

  // ── 4. Create reconciliation job ───────────────────────────────────────
  const nipChannelId = channelIds["NIBSS_NIP"];
  const ddChannelId = channelIds["DIRECT_DEBIT"];
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const jobResult = await db.insert(reconciliationJobs).values({
    userId,
    organizationId: orgId,
    name: `${entity === "both" ? "LapoMFB + Renmoney" : entity === "lapo" ? "LapoMFB" : "Renmoney MFB"} — Full Portfolio Reconciliation (FinServ Demo)`,
    status: "completed",
    moduleType: "transaction_integrity",
    sourceChannelId: nipChannelId,
    targetChannelId: ddChannelId,
    dateFrom: monthAgo,
    dateTo: now,
    matchRate: (MATCH_RATE * 100).toFixed(2),
    totalSourceTxns: TOTAL_TRANSACTIONS,
    totalTargetTxns: TOTAL_TRANSACTIONS,
    matchedCount: MATCHED_COUNT,
    unmatchedCount: EXCEPTION_COUNT,
    exceptionCount: EXCEPTION_COUNT,
    processingTimeMs: 1240000,
    startedAt: monthAgo,
    completedAt: now,
  });
  const jobId = Number((jobResult as { insertId?: number }).insertId ?? 0);

  // ── 5. Create match records (sample of 400 pairs) ──────────────────────
  const sampleSize = Math.min(400, sampleSourceIds.length, sampleTargetIds.length);
  if (sampleSize > 0) {
    const matchRows = [];
    for (let i = 0; i < sampleSize; i++) {
      matchRows.push({
        jobId,
        sourceTransactionId: sampleSourceIds[i],
        targetTransactionId: sampleTargetIds[i],
        confidenceScore: (randomBetween(92, 100) / 100).toString(),
        matchType: "exact" as const,
        status: "confirmed" as const,
        matchReason: "Exact reference match — loan account number confirmed",
      });
    }
    for (let i = 0; i < matchRows.length; i += 100) {
      await db.insert(matches).values(matchRows.slice(i, i + 100));
    }
  }

  // ── 6. Create open exception records (5% of total = 150,000) ──────────
  // We create 8 detailed exception records (one per scenario) as "open"
  // representing the 150,000 unmatched transactions in the exception queue
  type ExceptionCategory = "missing_counterparty" | "amount_mismatch" | "timing_difference" | "duplicate_transaction" | "unmatched" | "reversal_unmatched" | "currency_mismatch" | "format_error";
  const exceptionRows = FINSERV_EXCEPTIONS.map((ex, idx) => ({
    jobId,
    transactionId: sampleSourceIds[idx] ?? sampleSourceIds[0],
    category: ex.category as ExceptionCategory,
    severity: (idx < 2 ? "high" : idx < 5 ? "medium" : "low") as "low" | "medium" | "high" | "critical",
    description: ex.description,
    status: "open" as const,
    suggestedResolution: ex.resolution,
    aiAnalysis: ex.diagnosis,
    resolutionNotes: null,
  }));
  await db.insert(exceptions).values(exceptionRows);

  // ── 7. Seed memory records ─────────────────────────────────────────────
  const memoryRecords = FINSERV_EXCEPTIONS.map(ex => ({
    organizationId: orgId ?? 0,
    exceptionId: null,
    exceptionCategory: ex.category,
    transactionRef: null,
    amountRange: "100k-1m" as const,
    counterpartyType: "borrower",
    deductionType: JSON.parse(ex.diagnosis).deductionType ?? null,
    resolution: ex.resolution,
    outcome: ex.outcome as "resolved" | "escalated" | "rejected",
    reasoning: ex.diagnosis,
    embeddingText: `${ex.type} ${ex.description} ${ex.resolution}`,
    resolvedBy: userId,
  }));
  await db.insert(agentMemory).values(memoryRecords);

  return {
    segment: "finserv",
    entity,
    jobId,
    totalTransactions: TOTAL_TRANSACTIONS,
    matchedCount: MATCHED_COUNT,
    exceptionCount: EXCEPTION_COUNT,
    matchRate: (MATCH_RATE * 100).toFixed(2),
    paymentRails: PAYMENT_RAILS.map(r => r.name),
    message: `Financial Services demo loaded: ${TOTAL_TRANSACTIONS.toLocaleString()} transactions across ${PAYMENT_RAILS.length} payment rails. Match rate: ${(MATCH_RATE * 100).toFixed(0)}%. Open exceptions: ${EXCEPTION_COUNT.toLocaleString()}.`,
  };
}

// ── Wipe FinServ Demo Data ─────────────────────────────────────────────────

export async function wipeFinServDemoData(userId: number, orgId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Find all upload batches with finserv demo filenames
  const { uploadBatches: ub, transactions: txns, reconciliationJobs: rj } = await import("../drizzle/schema");
  const demoBatches = await db.select({ id: ub.id })
    .from(ub)
    .where(sql`${ub.fileName} LIKE '%_demo.csv' AND ${ub.userId} = ${userId}`);
  const demoBatchIds = demoBatches.map(b => b.id);

  if (demoBatchIds.length > 0) {
    // Delete transactions in chunks to avoid query size limits
    const chunkSize = 50;
    for (let i = 0; i < demoBatchIds.length; i += chunkSize) {
      const chunk = demoBatchIds.slice(i, i + chunkSize);
      for (const batchId of chunk) {
        await db.delete(txns).where(eq(txns.batchId, batchId));
      }
      for (const batchId of chunk) {
        await db.delete(ub).where(eq(ub.id, batchId));
      }
    }
  }

  // Delete reconciliation jobs with FinServ Demo in name
  await db.delete(rj).where(sql`${rj.name} LIKE '%FinServ Demo%' AND ${rj.userId} = ${userId}`);

  // Delete agent memory seeded for finserv (no exceptionId = seeded)
  const { agentMemory: am } = await import("../drizzle/schema");
  await db.delete(am).where(
    sql`${am.organizationId} = ${orgId ?? 0} AND ${am.exceptionId} IS NULL AND ${am.counterpartyType} = 'borrower'`
  );
}
