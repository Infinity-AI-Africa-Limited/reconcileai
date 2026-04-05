/**
 * demoSeedFinServ.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Financial Services Demo Seed Engine
 * Entities: LapoMFB (microfinance) + Renmoney MFB (digital lending)
 * Scale: ~2,000,000 transactions across 8 payment rails
 * Match rate: 95% (1,900,000 matched, 100,000 exceptions)
 * Exception profile: healthy — 8 categories with plain-language narratives
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
  distributors,
  agentMemory,
} from "../drizzle/schema";
import { getDb } from "./db";

// ── Helpers ────────────────────────────────────────────────────────────────

const demoTag = (extra: Record<string, unknown> = {}) => ({ ...extra, _demo: true, _segment: "finserv" });
const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomAmount = (min: number, max: number) => (randomBetween(min * 100, max * 100) / 100).toFixed(2);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

// ── Payment Rails ──────────────────────────────────────────────────────────

const PAYMENT_RAILS = [
  { name: "NIBSS NIP Transfer", code: "NIBSS_NIP", channelType: "bank_core", description: "NIBSS Instant Payment — interbank transfers via NIP gateway" },
  { name: "USSD Banking", code: "USSD_BANKING", channelType: "mobile_money", description: "USSD *737#/*901# mobile banking transactions" },
  { name: "POS Terminal", code: "POS_TERMINAL", channelType: "pos", description: "Point-of-Sale card transactions at merchant terminals" },
  { name: "Mobile App Banking", code: "MOBILE_APP", channelType: "mobile_money", description: "In-app transfers via LapoMFB and Renmoney mobile apps" },
  { name: "Core Banking (Finacle)", code: "CORE_BANKING", channelType: "bank_core", description: "Direct core banking system entries (Finacle/T24)" },
  { name: "Direct Debit (NIBSS)", code: "DIRECT_DEBIT", channelType: "bank_core", description: "NIBSS Direct Debit mandate collections for loan repayments" },
  { name: "Card Payment (Visa/MC)", code: "CARD_PAYMENT", channelType: "card", description: "Visa and Mastercard online card payments" },
  { name: "Agent Banking (MFIN)", code: "AGENT_BANKING", channelType: "mobile_money", description: "Agent banking network collections via MFIN-licensed agents" },
];

// ── Borrower Profiles ──────────────────────────────────────────────────────

const LAPO_BORROWERS = [
  "Adunola Fashola", "Blessing Okonkwo", "Chidinma Eze", "Damilola Adeyemi",
  "Esther Nwosu", "Fatima Musa", "Grace Obi", "Helen Okeke", "Ifeoma Chukwu",
  "Janet Abubakar", "Kemi Adebayo", "Lola Balogun", "Mary Okafor", "Ngozi Nnaji",
  "Oluwakemi Afolabi", "Patricia Igwe", "Queen Osei", "Rita Nwachukwu",
  "Stella Ogundipe", "Taiwo Adeleke", "Uche Obiora", "Victoria Adeola",
  "Winifred Chima", "Yetunde Babatunde", "Zainab Suleiman",
];

const RENMONEY_BORROWERS = [
  "Adebayo Ogundimu", "Babatunde Fashola Jr.", "Chukwuemeka Obi", "David Adekunle",
  "Emmanuel Nwachukwu", "Femi Adesanya", "Gbenga Oluwole", "Hassan Musa",
  "Ibrahim Aliyu", "James Okonkwo", "Kayode Adewale", "Lanre Badmus",
  "Michael Eze", "Nnamdi Okafor", "Olumide Afolabi", "Peter Igwe",
  "Rotimi Adeyemi", "Seun Balogun", "Tunde Ogundele", "Usman Abdullahi",
  "Victor Chukwu", "Wale Adeleke", "Xavier Osei", "Yemi Nwosu",
  "Zubair Suleiman",
];

// ── Exception Scenarios (FinServ-specific) ─────────────────────────────────

const FINSERV_EXCEPTIONS = [
  { type: "failed_direct_debit",
    category: "unmatched",
    description: "NIBSS Direct Debit mandate returned — insufficient funds",
    diagnosis: JSON.stringify({
      rootCause: "Direct debit mandate returned by borrower's bank due to insufficient funds in the source account at the time of collection.",
      shortfall: null,
      deductionType: "returned_mandate",
      recommendedAction: "Retry direct debit in 3 business days. If second attempt fails, escalate to collections team and send SMS notification to borrower.",
      confidence: 0.97,
      plainLanguage: "The borrower's bank rejected the automatic loan repayment because there wasn't enough money in their account. The system tried to collect ₦45,000 on the due date but the bank sent it back. We need to try again in 3 days or call the borrower.",
    }),
    resolution: "Retry direct debit scheduled for T+3. Borrower notified via SMS.",
    outcome: "resolved",
  },
  { type: "ussd_timeout",
    category: "timing_difference",
    description: "USSD session timed out — payment credited but not reflected in loan ledger",
    diagnosis: JSON.stringify({
      rootCause: "USSD session timed out after borrower entered PIN, but the transaction was processed by the network before the session closed. The payment landed in the collection account but the loan management system did not receive the confirmation callback.",
      shortfall: null,
      deductionType: null,
      recommendedAction: "Match the USSD credit to the open loan repayment schedule. Update loan ledger manually and mark as resolved. Escalate USSD callback failure to IT for investigation.",
      confidence: 0.94,
      plainLanguage: "The borrower paid via USSD but their phone lost connection before the app confirmed it. The money arrived in our account but the loan system didn't know about it. We can see the payment — it just needs to be matched to the right loan account.",
    }),
    resolution: "Manual match applied. Loan ledger updated. IT ticket raised for USSD callback investigation.",
    outcome: "resolved",
  },
  { type: "pos_reversal",
    category: "duplicate_transaction",
    description: "POS transaction reversed by acquirer — original and reversal both visible",
    diagnosis: JSON.stringify({
      rootCause: "POS terminal sent a reversal message after the original transaction was approved. Both the original credit and the reversal debit appear in the settlement file, creating a net-zero pair that looks like a duplicate to the reconciliation engine.",
      shortfall: null,
      deductionType: "pos_reversal",
      recommendedAction: "Pair the original transaction with its reversal and mark both as reconciled with zero net impact. No action required on the loan ledger.",
      confidence: 0.99,
      plainLanguage: "The card machine processed a payment and then immediately cancelled it. Both transactions show up in our records. They cancel each other out — the net effect is zero. No money was actually collected, so no loan payment should be recorded.",
    }),
    resolution: "Original and reversal paired. Net impact: ₦0. Loan ledger unchanged.",
    outcome: "resolved",
  },
  { type: "duplicate_nip_credit",
    category: "duplicate_transaction",
    description: "Duplicate NIP credit — same session ID credited twice by sending bank",
    diagnosis: JSON.stringify({
      rootCause: "The sending bank's NIP gateway experienced a timeout and retried the transaction, resulting in two credits with the same session ID arriving in the collection account within 4 minutes of each other.",
      shortfall: null,
      deductionType: "duplicate_nip",
      recommendedAction: "Retain the first credit as the valid loan repayment. Flag the second credit as a duplicate and initiate a refund to the borrower's account via NIP within 24 hours. Document the session ID for NIBSS dispute resolution.",
      confidence: 0.98,
      plainLanguage: "The borrower's bank accidentally sent the same payment twice. We received ₦30,000 twice from the same transaction. We should keep one as the loan repayment and send the other one back to the borrower immediately.",
    }),
    resolution: "First credit matched to loan. Second credit refunded via NIP. NIBSS dispute logged.",
    outcome: "resolved",
  },
  { type: "partial_loan_repayment",
    category: "amount_mismatch",
    description: "Borrower paid partial instalment — ₦18,500 against scheduled ₦25,000",
    diagnosis: JSON.stringify({
      rootCause: "Borrower made a partial payment of ₦18,500 against a scheduled monthly instalment of ₦25,000. The shortfall of ₦6,500 represents an underpayment. The payment reference matches the loan account number, confirming this is an intentional partial payment.",
      shortfall: 6500,
      deductionType: "partial_repayment",
      recommendedAction: "Apply ₦18,500 to the loan account as a partial payment. Record ₦6,500 as outstanding arrears. Generate a payment reminder for the shortfall with a 7-day grace period before penalty interest accrues.",
      confidence: 0.96,
      plainLanguage: "The borrower paid ₦18,500 but their monthly repayment is ₦25,000. They're ₦6,500 short. We should apply what they paid and send them a reminder for the remaining amount before charging any late fees.",
    }),
    resolution: "Partial payment applied. Arrears of ₦6,500 recorded. Reminder sent.",
    outcome: "resolved",
  },
  { type: "wrong_account_payment",
    category: "missing_counterparty",
    description: "Payment received with incorrect loan account reference — cannot auto-match",
    diagnosis: JSON.stringify({
      rootCause: "Borrower used an old loan account number that has been closed and replaced with a new account. The payment of ₦50,000 arrived with the old reference and cannot be automatically matched to the active loan account.",
      shortfall: null,
      deductionType: null,
      recommendedAction: "Search borrower database by name and phone number to identify the active loan account. Manually apply the payment to the correct account. Contact borrower to confirm the correct reference for future payments.",
      confidence: 0.89,
      plainLanguage: "The borrower sent money using an old account number that no longer exists. The payment arrived but we don't know which loan to apply it to. We need to look up the borrower by name or phone number and match it to their current loan.",
    }),
    resolution: "Borrower identified by phone. Payment applied to active loan LN-2024-08847.",
    outcome: "resolved",
  },
  { type: "agent_banking_float_shortfall",
    category: "amount_mismatch",
    description: "Agent banking collection short by ₦150 — agent float fee deducted",
    diagnosis: JSON.stringify({
      rootCause: "The MFIN-licensed agent deducted a ₦150 float/service fee before remitting the loan repayment. The expected amount was ₦15,000 but only ₦14,850 was credited to the collection account.",
      shortfall: 150,
      deductionType: "agent_float_fee",
      recommendedAction: "Accept the ₦14,850 as a full repayment and write off the ₦150 agent fee to the 'Agent Banking Charges' cost centre. Update the agent fee schedule to reflect this deduction pattern.",
      confidence: 0.95,
      plainLanguage: "The agent who collected the borrower's payment kept ₦150 as their fee before sending us the rest. This is normal for agent banking. We should treat the ₦14,850 as the full repayment and record the ₦150 as an agent fee.",
    }),
    resolution: "₦14,850 applied as full repayment. ₦150 charged to Agent Banking Charges cost centre.",
    outcome: "resolved",
  },
  { type: "mobile_app_pending",
    category: "timing_difference",
    description: "Mobile app payment in 'pending' state — bank confirmation delayed 6+ hours",
    diagnosis: JSON.stringify({
      rootCause: "The mobile app payment was initiated by the borrower but the interbank confirmation from the receiving bank has been delayed beyond the normal 2-hour window. The transaction is in a pending state in the payment gateway but has not yet been confirmed in the collection account.",
      shortfall: null,
      deductionType: null,
      recommendedAction: "Wait 24 hours for bank confirmation before escalating. If unconfirmed after 24 hours, contact the payment gateway provider for a status update. Do not apply to loan ledger until confirmed.",
      confidence: 0.91,
      plainLanguage: "The borrower says they paid via the app but we haven't received confirmation from the bank yet. This sometimes happens when banks are slow to process. We should wait until tomorrow before doing anything — it will likely resolve itself.",
    }),
    resolution: "Confirmed after 18 hours. Applied to loan ledger on T+1.",
    outcome: "resolved",
  },
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

// ── Batch Transaction Inserter ─────────────────────────────────────────────

async function insertFinServBatch(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  batchId: number,
  channelId: number,
  userId: number,
  orgId: number | null,
  count: number,
  isSource: boolean,
  borrowerNames: string[],
  startRef: number,
  debitCredit: "credit" | "debit",
  railCode: string,
  loanPrefix: string,
  statusOverride?: string
): Promise<number[]> {
  const ids: number[] = [];
  const chunkSize = 200;
  for (let chunk = 0; chunk < Math.ceil(count / chunkSize); chunk++) {
    const chunkStart = chunk * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize, count);
    const rows = [];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const refNum = startRef + i;
      const borrower = borrowerNames[i % borrowerNames.length];
      const amount = randomAmount(5, 500); // Microfinance: ₦5K–₦500K
      const txDate = daysAgo(randomBetween(0, 60));
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
        debitCredit,
        counterparty: borrower,
        status: (statusOverride ?? "matched") as "matched" | "unmatched" | "exception" | "manually_matched" | "reversed",
        rawData: demoTag({ matchedPair: refNum, rail: railCode, loanRef }),
      });
    }
    await db.insert(transactions).values(rows);
    const inserted = await db.select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.batchId, batchId))
      .orderBy(sql`id DESC`)
      .limit(rows.length);
    ids.push(...inserted.map(r => r.id).reverse());
  }
  return ids;
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

  // ── 1. Seed channels for all payment rails ─────────────────────────────
  const channelIds: Record<string, number> = {};
  for (const rail of PAYMENT_RAILS) {
    channelIds[rail.code] = await ensureFinServChannel(db, rail.name, rail.code, rail.channelType);
  }

  // ── 2. Seed borrower distributors ──────────────────────────────────────
  const allBorrowers = entity === "lapo"
    ? LAPO_BORROWERS
    : entity === "renmoney"
    ? RENMONEY_BORROWERS
    : [...LAPO_BORROWERS, ...RENMONEY_BORROWERS];

  const loanPrefix = entity === "lapo" ? "LAPO" : entity === "renmoney" ? "REN" : "MFB";

  // ── 3. Create upload batches for each rail ─────────────────────────────
  // Scale: 2,000,000 total transactions across 8 rails
  // Distribution: NIP (35%), Direct Debit (25%), USSD (15%), Mobile App (10%),
  //               Core Banking (7%), POS (4%), Card (2%), Agent Banking (2%)
  const TOTAL_TRANSACTIONS = 2_000_000;
  const MATCH_RATE = 0.95;
  const MATCHED_COUNT = Math.floor(TOTAL_TRANSACTIONS * MATCH_RATE);
  const EXCEPTION_COUNT = TOTAL_TRANSACTIONS - MATCHED_COUNT;

  const RAIL_DISTRIBUTION: Record<string, number> = {
    NIBSS_NIP: 0.35,
    DIRECT_DEBIT: 0.25,
    USSD_BANKING: 0.15,
    MOBILE_APP: 0.10,
    CORE_BANKING: 0.07,
    POS_TERMINAL: 0.04,
    CARD_PAYMENT: 0.02,
    AGENT_BANKING: 0.02,
  };

  let globalRefStart = 1_000_000;
  const allSourceIds: number[] = [];
  const allTargetIds: number[] = [];

  for (const [railCode, fraction] of Object.entries(RAIL_DISTRIBUTION)) {
    const railTotal = Math.floor(TOTAL_TRANSACTIONS * fraction);
    const railMatched = Math.floor(railTotal * MATCH_RATE);
    const railExceptions = railTotal - railMatched;

    // Source batch (bank/payment rail side)
    const sourceBatch = await db.insert(uploadBatches).values({
      userId,
      channelId: channelIds[railCode],
      organizationId: orgId,
      fileName: `${loanPrefix}_${railCode}_source_demo.csv`,
      totalRows: railTotal,
      validRows: railTotal,
      invalidRows: 0,
      status: "completed",
    });
    const sourceBatchId = Number((sourceBatch as { insertId?: number }).insertId ?? 0);

    // Target batch (loan management system side)
    const targetBatch = await db.insert(uploadBatches).values({
      userId,
      channelId: channelIds[railCode],
      organizationId: orgId,
      fileName: `${loanPrefix}_${railCode}_lms_demo.csv`,
      totalRows: railTotal,
      validRows: railTotal,
      invalidRows: 0,
      status: "completed",
    });
    const targetBatchId = Number((targetBatch as { insertId?: number }).insertId ?? 0);

    const channelId = channelIds[railCode];

    // Insert matched transactions
    const sourceIds = await insertFinServBatch(
      db, sourceBatchId, channelId, userId, orgId,
      railMatched, true, allBorrowers, globalRefStart,
      "credit", railCode, loanPrefix, "matched"
    );
    const targetIds = await insertFinServBatch(
      db, targetBatchId, channelId, userId, orgId,
      railMatched, false, allBorrowers, globalRefStart,
      "debit", railCode, loanPrefix, "matched"
    );

    allSourceIds.push(...sourceIds);
    allTargetIds.push(...targetIds);
    globalRefStart += railMatched;

    // Insert exception transactions
    await insertFinServBatch(
      db, sourceBatchId, channelId, userId, orgId,
      railExceptions, true, allBorrowers, globalRefStart,
      "credit", railCode, loanPrefix, "exception"
    );
    globalRefStart += railExceptions;
  }

  // ── 4. Create reconciliation job ───────────────────────────────────────
  // Use the first two channel IDs for source/target (NIP and Direct Debit)
  const nipChannelId = channelIds["NIBSS_NIP"];
  const ddChannelId = channelIds["DIRECT_DEBIT"];
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const jobResult = await db.insert(reconciliationJobs).values({
    userId,
    organizationId: orgId,
    name: `${entity === "both" ? "LapoMFB + Renmoney" : entity === "lapo" ? "LapoMFB" : "Renmoney MFB"} — Full Portfolio Reconciliation (Demo)`,
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
    processingTimeMs: 847000,
    startedAt: monthAgo,
    completedAt: now,
  });
  const jobId = Number((jobResult as { insertId?: number }).insertId ?? 0);

  // ── 5. Create matches for matched transactions ─────────────────────────
  // Sample 500 pairs for match records (full 2M would be too slow for demo seeding)
  const sampleSize = Math.min(500, allSourceIds.length, allTargetIds.length);
  if (sampleSize > 0) {
    const matchRows = [];
    for (let i = 0; i < sampleSize; i++) {
      matchRows.push({
        jobId,
        sourceTransactionId: allSourceIds[i],
        targetTransactionId: allTargetIds[i],
        confidenceScore: (randomBetween(92, 100) / 100).toString(),
        matchType: "exact" as const,
        status: "confirmed" as const,
        matchReason: "Exact reference match — loan account number confirmed",
      });
    }
    // Insert in chunks of 100
    for (let i = 0; i < matchRows.length; i += 100) {
      await db.insert(matches).values(matchRows.slice(i, i + 100));
    }
  }

  // ── 6. Create exception records ────────────────────────────────────────
  type ExceptionCategory = "missing_counterparty" | "amount_mismatch" | "timing_difference" | "duplicate_transaction" | "unmatched" | "reversal_unmatched" | "currency_mismatch" | "format_error";
  const exceptionRows = FINSERV_EXCEPTIONS.map((ex, idx) => ({
    jobId,
    transactionId: allSourceIds[allSourceIds.length - 1 - idx] ?? allSourceIds[0],
    category: ex.category as ExceptionCategory,
    severity: (idx < 2 ? "high" : idx < 5 ? "medium" : "low") as "low" | "medium" | "high" | "critical",
    description: ex.description,
    status: "resolved" as const,
    suggestedResolution: ex.resolution,
    aiAnalysis: ex.diagnosis,
    resolutionNotes: ex.resolution,
  }));
  await db.insert(exceptions).values(exceptionRows);

  // ── 7. Seed memory records for FinServ ────────────────────────────────
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
    paymentRails: PAYMENT_RAILS.map((r: typeof PAYMENT_RAILS[0]) => r.name),
    message: `Financial Services demo loaded: ${TOTAL_TRANSACTIONS.toLocaleString()} transactions across ${PAYMENT_RAILS.length} payment rails. Match rate: ${(MATCH_RATE * 100).toFixed(0)}%.`,
  };
}

// ── Wipe FinServ Demo Data ─────────────────────────────────────────────────

export async function wipeFinServDemoData(userId: number, orgId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Delete all records tagged with _demo: true and _segment: finserv
  // We use the rawData JSON column to identify demo records
  await db.delete(agentMemory).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
  await db.delete(exceptions).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
  await db.delete(matches).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
  await db.delete(reconciliationJobs).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
  await db.delete(transactions).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
  await db.delete(uploadBatches).where(sql`JSON_EXTRACT(raw_data, '$._segment') = 'finserv'`);
}
