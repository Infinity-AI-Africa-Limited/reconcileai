/**
 * Demo Seed Engine — ReconcileAI
 * Populates the database with realistic Nigerian FMCG transaction data
 * for investor and client demonstrations.
 *
 * All demo records are tagged with isDemoData: true (via rawData JSON field)
 * so they can be cleanly wiped when Demo Mode is deactivated.
 */

import { getDb } from "./db";
import {
  transactions,
  uploadBatches,
  reconciliationJobs,
  matches,
  exceptions,
  distributors,
  agentMemory,
  channels,
} from "../drizzle/schema";
import { eq, and, like, sql } from "drizzle-orm";

// ─── Nigerian FMCG Distributor Profiles ─────────────────────────────

const DEMO_DISTRIBUTORS = [
  {
    canonicalName: "Kola Ventures Ltd",
    registeredBusinessName: "Kola Ventures & Sons Nigeria Limited",
    taxId: "RC-0284761",
    primaryBankName: "GTBank",
    primaryBankAccount: "0123456789",
    contactPhone: "+234-803-456-7890",
    zone: "Lagos",
    nameVariants: ["Kola Ventures", "Kolade Ventures & Sons", "KV Nigeria Ltd", "KOLA VENTURES LTD"],
  },
  {
    canonicalName: "Sunrise Distribution Co.",
    registeredBusinessName: "Sunrise Distribution Company Nigeria Ltd",
    taxId: "RC-0391842",
    primaryBankName: "Access Bank",
    primaryBankAccount: "0987654321",
    contactPhone: "+234-805-678-9012",
    zone: "Abuja",
    nameVariants: ["Sunrise Dist Co", "Sunrise Distribution", "SUNRISE DIST CO NIG"],
  },
  {
    canonicalName: "Eko Traders International",
    registeredBusinessName: "Eko Traders International Nigeria Ltd",
    taxId: "RC-0472938",
    primaryBankName: "First Bank",
    primaryBankAccount: "2034567890",
    contactPhone: "+234-802-345-6789",
    zone: "Lagos",
    nameVariants: ["Eko Traders", "ETI Nigeria", "Eko Traders Intl"],
  },
  {
    canonicalName: "Northern Supplies Ltd",
    registeredBusinessName: "Northern Supplies Limited",
    taxId: "RC-0583047",
    primaryBankName: "Zenith Bank",
    primaryBankAccount: "1234567890",
    contactPhone: "+234-806-789-0123",
    zone: "Kano",
    nameVariants: ["Northern Supplies", "NS Ltd", "NORTHERN SUPPLIES NIG"],
  },
  {
    canonicalName: "Chukwu & Associates Trading",
    registeredBusinessName: "Chukwu and Associates Trading Company Ltd",
    taxId: "RC-0694156",
    primaryBankName: "UBA",
    primaryBankAccount: "3045678901",
    contactPhone: "+234-807-890-1234",
    zone: "Onitsha",
    nameVariants: ["Chukwu Associates", "C&A Trading", "Chukwu & Assoc"],
  },
  {
    canonicalName: "Ibadan Wholesale Merchants",
    registeredBusinessName: "Ibadan Wholesale Merchants Nigeria Ltd",
    taxId: "RC-0705263",
    primaryBankName: "Stanbic IBTC",
    primaryBankAccount: "4056789012",
    contactPhone: "+234-808-901-2345",
    zone: "Ibadan",
    nameVariants: ["IWM Nigeria", "Ibadan Wholesale", "IBADAN WHOLESALE MERCH"],
  },
  {
    canonicalName: "Delta Distributors Ltd",
    registeredBusinessName: "Delta Distributors Limited",
    taxId: "RC-0816374",
    primaryBankName: "Fidelity Bank",
    primaryBankAccount: "5067890123",
    contactPhone: "+234-809-012-3456",
    zone: "Warri",
    nameVariants: ["Delta Dist", "DDL Nigeria", "Delta Distributors"],
  },
  {
    canonicalName: "Abuja Metro Supplies",
    registeredBusinessName: "Abuja Metropolitan Supplies Ltd",
    taxId: "RC-0927485",
    primaryBankName: "FCMB",
    primaryBankAccount: "6078901234",
    contactPhone: "+234-810-123-4567",
    zone: "Abuja",
    nameVariants: ["Abuja Metro", "AMS Ltd", "Abuja Metropolitan Supplies"],
  },
];

// ─── Demo Transaction Templates ──────────────────────────────────────

interface DemoScenario {
  label: string;
  sourceTxn: {
    transactionRef: string;
    description: string;
    amount: string;
    counterparty: string;
    debitCredit: "debit" | "credit";
    daysOffset: number;
  };
  targetTxn: {
    transactionRef: string;
    description: string;
    amount: string;
    counterparty: string;
    debitCredit: "debit" | "credit";
    daysOffset: number;
  };
  matchType: "exact" | "tolerance" | "m2m" | "unmatched";
  exceptionCategory?: string;
  exceptionSeverity?: "low" | "medium" | "high" | "critical";
  exceptionDescription?: string;
  aiAnalysis?: string;
  suggestedResolution?: string;
}

// ─── Seed Functions ──────────────────────────────────────────────────

export interface DemoSeedResult {
  distributorIds: number[];
  sourceChannelId: number;
  targetChannelId: number;
  sourceBatchId: number;
  targetBatchId: number;
  sourceTransactionIds: number[];
  targetTransactionIds: number[];
  jobId: number;
  matchIds: number[];
  exceptionIds: number[];
  memoryIds: number[];
}

function demoTag(extra?: Record<string, unknown>) {
  return { isDemoData: true, seededAt: new Date().toISOString(), ...extra };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d;
}

function randomRef(prefix: string): string {
  return `${prefix}-${Math.floor(Math.random() * 90000 + 10000)}`;
}

export async function seedDemoData(userId: number, orgId: number | null): Promise<DemoSeedResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // ── 1. Ensure demo channels exist ──────────────────────────────────
  const allChannels = await db.select().from(channels);
  let sourceChannel = allChannels.find(c => c.code === "BANK_STATEMENT");
  let targetChannel = allChannels.find(c => c.code === "ERP_ORDERS");

  // Create ERP_ORDERS channel if it doesn't exist
  if (!targetChannel) {
    const [inserted] = await db.insert(channels).values({
      name: "ERP Orders (Demo)",
      code: "ERP_ORDERS",
      channelType: "fintech_api",
      description: "ERP order management system — demo channel",
      isActive: true,
    });
    const newChannels = await db.select().from(channels).where(eq(channels.code, "ERP_ORDERS"));
    targetChannel = newChannels[0];
  }
  if (!sourceChannel) {
    const allCh = await db.select().from(channels);
    sourceChannel = allCh.find(c =>
      c.channelType === "bank_core" ||
      c.channelType === "bank_transfer" ||
      c.channelType === "nibss"
    ) || allCh[0];
  }
  if (!sourceChannel || !targetChannel) {
    throw new Error("Could not resolve source/target channels for demo seeding");
  }

  // ── 2. Seed distributors ───────────────────────────────────────────
  const distributorIds: number[] = [];
  for (const d of DEMO_DISTRIBUTORS) {
    const [res] = await db.insert(distributors).values({
      organizationId: orgId ?? 0,
      canonicalId: `DIST-DEMO-${String(distributorIds.length + 1).padStart(4, "0")}`,
      canonicalName: d.canonicalName,
      registeredBusinessName: d.registeredBusinessName,
      taxId: d.taxId,
      primaryBankName: d.primaryBankName,
      primaryBankAccount: d.primaryBankAccount,
      contactPhone: d.contactPhone,
      zone: d.zone,
      status: "active",
      nameVariants: d.nameVariants,
      notes: "DEMO DATA — seeded by Demo Mode",
      createdBy: userId,
    });
    // Get the inserted id
    const inserted = await db.select().from(distributors)
      .where(eq(distributors.canonicalName, d.canonicalName))
      .limit(1);
    if (inserted[0]) distributorIds.push(inserted[0].id);
  }

  // ── 3. Create upload batches ───────────────────────────────────────
  const [sourceBatchRes] = await db.insert(uploadBatches).values({
    userId,
    organizationId: orgId,
    channelId: sourceChannel.id,
    fileName: "BrightGoods_Bank_Statement_Demo.csv",
    fileHash: `demo-source-${Date.now()}`,
    status: "completed",
    totalRows: 60,
    validRows: 60,
    invalidRows: 0,
  });
  const sourceBatches = await db.select().from(uploadBatches)
    .where(eq(uploadBatches.fileHash, `demo-source-${Date.now() - 1}`))
    .limit(1);
  // Use a reliable way to get the batch id
  const allSourceBatches = await db.select().from(uploadBatches)
    .where(eq(uploadBatches.userId, userId))
    .orderBy(sql`id DESC`)
    .limit(2);
  const sourceBatch = allSourceBatches[0];

  const [targetBatchRes] = await db.insert(uploadBatches).values({
    userId,
    organizationId: orgId,
    channelId: targetChannel.id,
    fileName: "BrightGoods_ERP_Orders_Demo.csv",
    fileHash: `demo-target-${Date.now()}`,
    status: "completed",
    totalRows: 60,
    validRows: 60,
    invalidRows: 0,
  });
  const allTargetBatches = await db.select().from(uploadBatches)
    .where(eq(uploadBatches.userId, userId))
    .orderBy(sql`id DESC`)
    .limit(2);
  const targetBatch = allTargetBatches[0];

  // ── 4. Seed transactions ───────────────────────────────────────────
  // 54 matched pairs + 6 exception scenarios = 60 source + 60 target

  const sourceTransactionIds: number[] = [];
  const targetTransactionIds: number[] = [];

  // 54 clean matched pairs
  const matchedDistributors = DEMO_DISTRIBUTORS.slice(0, 6);
  for (let i = 0; i < 54; i++) {
    const dist = matchedDistributors[i % matchedDistributors.length];
    const amount = (Math.floor(Math.random() * 4500 + 500) * 1000).toFixed(2); // ₦500K–₦5M
    const ref = `INV-${2800 + i}`;
    const txDate = daysAgo(Math.floor(Math.random() * 14));

    const [srcRes] = await db.insert(transactions).values({
      batchId: sourceBatch.id,
      channelId: sourceChannel!.id,
      userId,
      organizationId: orgId,
      transactionRef: `BANK-${ref}`,
      externalRef: ref,
      description: `Payment from ${dist.canonicalName} — ${ref}`,
      amount,
      currency: "NGN",
      transactionDate: txDate,
      valueDate: txDate,
      debitCredit: "credit",
      counterparty: dist.canonicalName,
      status: "matched",
      rawData: demoTag({ matchedPair: i }),
    });
    const srcTxns = await db.select().from(transactions)
      .where(eq(transactions.batchId, sourceBatch.id))
      .orderBy(sql`id DESC`).limit(1);
    sourceTransactionIds.push(srcTxns[0].id);

    const [tgtRes] = await db.insert(transactions).values({
      batchId: targetBatch.id,
      channelId: targetChannel!.id,
      userId,
      organizationId: orgId,
      transactionRef: ref,
      externalRef: `ORD-${2800 + i}`,
      description: `Order ${ref} — ${dist.canonicalName} — Lagos Zone`,
      amount,
      currency: "NGN",
      transactionDate: txDate,
      valueDate: txDate,
      debitCredit: "debit",
      counterparty: dist.canonicalName,
      status: "matched",
      rawData: demoTag({ matchedPair: i }),
    });
    const tgtTxns = await db.select().from(transactions)
      .where(eq(transactions.batchId, targetBatch.id))
      .orderBy(sql`id DESC`).limit(1);
    targetTransactionIds.push(tgtTxns[0].id);
  }

  // 6 exception scenarios
  const exceptionScenarios = [
    // 1. Partial payment — distributor paid ₦1.8M against ₦2.4M invoice
    {
      src: {
        ref: "BANK-INV-2854", extRef: "INV-2854",
        desc: "Payment Kola Ventures INV-2854 partial",
        amount: "1800000.00", cp: "Kola Ventures Ltd",
        daysOffset: 3,
      },
      tgt: {
        ref: "INV-2854", extRef: "ORD-2854",
        desc: "Order INV-2854 Kola Ventures Ltd Lagos Zone",
        amount: "2400000.00", cp: "Kola Ventures Ltd",
        daysOffset: 3,
      },
      category: "amount_mismatch" as const,
      severity: "high" as const,
      description: "Partial payment: Kola Ventures paid ₦1,800,000 against invoice INV-2854 of ₦2,400,000. Shortfall: ₦600,000.",
      aiAnalysis: "PARTIAL PAYMENT DETECTED. The distributor paid ₦1.8M against a ₦2.4M invoice. The ₦600K shortfall (25%) is consistent with a promotional deduction claimed on Order #ORD-2854. Historical pattern: Kola Ventures has claimed promotional deductions on 3 of the last 8 invoices. Recommended action: Request promotional deduction credit note from distributor or raise a query via email.",
      suggestedResolution: "Request credit note for ₦600,000 promotional deduction from Kola Ventures Ltd. Reference: INV-2854.",
    },
    // 2. FX bank fee deduction — ₦2,398,500 vs ₦2,400,000
    {
      src: {
        ref: "BANK-INV-2855", extRef: "INV-2855",
        desc: "Payment Sunrise Distribution INV-2855",
        amount: "2398500.00", cp: "Sunrise Distribution Co.",
        daysOffset: 1,
      },
      tgt: {
        ref: "INV-2855", extRef: "ORD-2855",
        desc: "Order INV-2855 Sunrise Distribution Co. Abuja Zone",
        amount: "2400000.00", cp: "Sunrise Distribution Co.",
        daysOffset: 1,
      },
      category: "amount_mismatch" as const,
      severity: "low" as const,
      description: "FX bank fee deduction: ₦2,398,500 received vs ₦2,400,000 invoiced. Variance: ₦1,500 (0.0625%).",
      aiAnalysis: "FX BANK FEE DEDUCTION. The ₦1,500 shortfall (0.0625%) is consistent with a standard GTBank inter-bank transfer fee. This is a valid match — the variance is below the 0.5% tolerance threshold. Auto-approve recommended. No action required from distributor.",
      suggestedResolution: "Auto-approve match. Post ₦1,500 bank charge to 'Bank Charges' GL account. Reference: INV-2855.",
    },
    // 3. Semantic reference — "INV-2847 less dmg"
    {
      src: {
        ref: "BANK-INV-2847-DMG", extRef: "INV-2847",
        desc: "Payment Eko Traders INV-2847 less dmg",
        amount: "1650000.00", cp: "Eko Traders International",
        daysOffset: 5,
      },
      tgt: {
        ref: "INV-2847", extRef: "ORD-2847",
        desc: "Order INV-2847 Eko Traders International Lagos Zone",
        amount: "1980000.00", cp: "Eko Traders International",
        daysOffset: 5,
      },
      category: "amount_mismatch" as const,
      severity: "high" as const,
      description: "Damage deduction claim: 'INV-2847 less dmg' — Eko Traders paid ₦1,650,000 against ₦1,980,000 invoice. Claimed damage deduction: ₦330,000.",
      aiAnalysis: "DAMAGE DEDUCTION CLAIM DETECTED. The payment reference 'INV-2847 less dmg' contains a damage claim keyword. Eko Traders is claiming a ₦330,000 (16.7%) deduction for damaged goods on delivery. This requires physical verification of the damage claim before approval. Recommended action: Request damage assessment report from logistics team and issue credit note if verified.",
      suggestedResolution: "Escalate to logistics team for damage verification. If confirmed, issue credit note for ₦330,000. Reference: INV-2847.",
    },
    // 4. Many-to-many: ₦10M split across 3 invoices
    {
      src: {
        ref: "BANK-BULK-001", extRef: "BULK-001",
        desc: "Bulk payment Northern Supplies Ltd INV-2860 INV-2861 INV-2862",
        amount: "10000000.00", cp: "Northern Supplies Ltd",
        daysOffset: 2,
      },
      tgt: {
        ref: "INV-2860", extRef: "ORD-2860",
        desc: "Order INV-2860 Northern Supplies Ltd Kano Zone",
        amount: "3300000.00", cp: "Northern Supplies Ltd",
        daysOffset: 2,
      },
      category: "amount_mismatch" as const,
      severity: "medium" as const,
      description: "Many-to-many match required: ₦10,000,000 bulk payment covers INV-2860 (₦3.3M) + INV-2861 (₦3.3M) + INV-2862 (₦3.4M).",
      aiAnalysis: "MANY-TO-MANY MATCH DETECTED. Northern Supplies Ltd sent a single ₦10M bulk payment covering three outstanding invoices: INV-2860 (₦3,300,000), INV-2861 (₦3,300,000), INV-2862 (₦3,400,000). Total: ₦10,000,000 — exact match. Split allocation: 33%/33%/34%. Confidence: 98%. Recommended action: Approve split allocation and post to three separate GL entries.",
      suggestedResolution: "Approve many-to-many split: allocate ₦3.3M to INV-2860, ₦3.3M to INV-2861, ₦3.4M to INV-2862.",
    },
    // 5. Timing difference — payment 4 days after invoice date
    {
      src: {
        ref: "BANK-INV-2863", extRef: "INV-2863",
        desc: "Late payment Chukwu Associates INV-2863",
        amount: "4750000.00", cp: "Chukwu & Associates Trading",
        daysOffset: 0,
      },
      tgt: {
        ref: "INV-2863", extRef: "ORD-2863",
        desc: "Order INV-2863 Chukwu and Associates Trading Company Ltd Onitsha Zone",
        amount: "4750000.00", cp: "Chukwu & Associates Trading",
        daysOffset: 4,
      },
      category: "timing_difference" as const,
      severity: "low" as const,
      description: "Timing difference: Payment received 4 days after invoice date. Amount matches exactly (₦4,750,000).",
      aiAnalysis: "TIMING DIFFERENCE — WITHIN TOLERANCE. The payment was received 4 days after the invoice date, which exceeds the standard 3-day window. However, the amount matches exactly (₦4,750,000) and the distributor name matches the canonical record. This is a late payment, not a mismatch. Recommended action: Auto-approve with a late payment flag. No credit note required.",
      suggestedResolution: "Auto-approve match with late payment flag. Consider issuing a late payment notice to Chukwu & Associates Trading.",
    },
    // 6. Missing counterparty — unidentified payment
    {
      src: {
        ref: "BANK-UNK-001", extRef: "UNK-001",
        desc: "NEFT CR 0123456789 IBADAN WHLSL MERCH",
        amount: "2100000.00", cp: "IBADAN WHLSL MERCH",
        daysOffset: 1,
      },
      tgt: {
        ref: "INV-2865", extRef: "ORD-2865",
        desc: "Order INV-2865 Ibadan Wholesale Merchants Nigeria Ltd Ibadan Zone",
        amount: "2100000.00", cp: "Ibadan Wholesale Merchants",
        daysOffset: 1,
      },
      category: "missing_counterparty" as const,
      severity: "medium" as const,
      description: "Counterparty name mismatch: Bank shows 'IBADAN WHLSL MERCH' — not found in distributor registry under this abbreviation.",
      aiAnalysis: "COUNTERPARTY IDENTITY RESOLUTION REQUIRED. The bank statement shows 'IBADAN WHLSL MERCH' which is an abbreviated form not yet registered in the Master Distributor File. Fuzzy match confidence: 87% — likely 'Ibadan Wholesale Merchants Nigeria Ltd'. Amount (₦2,100,000) matches INV-2865 exactly. Recommended action: Confirm identity in Distributor Registry and add 'IBADAN WHLSL MERCH' as a known alias.",
      suggestedResolution: "Confirm 'IBADAN WHLSL MERCH' = 'Ibadan Wholesale Merchants Nigeria Ltd' in Distributor Registry. Add alias. Then approve match to INV-2865.",
    },
  ];

  const exceptionTxnIds: Array<{ srcId: number; tgtId: number }> = [];
  for (const scenario of exceptionScenarios) {
    const txDate = daysAgo(scenario.src.daysOffset);
    const tgtDate = daysAgo(scenario.tgt.daysOffset);

    await db.insert(transactions).values({
      batchId: sourceBatch.id,
      channelId: sourceChannel!.id,
      userId,
      organizationId: orgId,
      transactionRef: scenario.src.ref,
      externalRef: scenario.src.extRef,
      description: scenario.src.desc,
      amount: scenario.src.amount,
      currency: "NGN",
      transactionDate: txDate,
      valueDate: txDate,
      debitCredit: "credit",
      counterparty: scenario.src.cp,
      status: "exception",
      rawData: demoTag({ exceptionScenario: scenario.category }),
    });
    const srcTxns = await db.select().from(transactions)
      .where(eq(transactions.batchId, sourceBatch.id))
      .orderBy(sql`id DESC`).limit(1);
    sourceTransactionIds.push(srcTxns[0].id);

    await db.insert(transactions).values({
      batchId: targetBatch.id,
      channelId: targetChannel!.id,
      userId,
      organizationId: orgId,
      transactionRef: scenario.tgt.ref,
      externalRef: scenario.tgt.extRef,
      description: scenario.tgt.desc,
      amount: scenario.tgt.amount,
      currency: "NGN",
      transactionDate: tgtDate,
      valueDate: tgtDate,
      debitCredit: "debit",
      counterparty: scenario.tgt.cp,
      status: "exception",
      rawData: demoTag({ exceptionScenario: scenario.category }),
    });
    const tgtTxns = await db.select().from(transactions)
      .where(eq(transactions.batchId, targetBatch.id))
      .orderBy(sql`id DESC`).limit(1);
    targetTransactionIds.push(tgtTxns[0].id);

    exceptionTxnIds.push({ srcId: srcTxns[0].id, tgtId: tgtTxns[0].id });
  }

  // ── 5. Create reconciliation job ───────────────────────────────────
  const dateFrom = daysAgo(14);
  const dateTo = new Date();

  await db.insert(reconciliationJobs).values({
    userId,
    organizationId: orgId,
    moduleType: "transaction_integrity",
    name: "BrightGoods FMCG — Demo Reconciliation (Last 14 Days)",
    sourceChannelId: sourceChannel!.id,
    targetChannelId: targetChannel!.id,
    dateFrom,
    dateTo,
    amountTolerance: "0.005",
    dateWindowDays: 3,
    status: "completed",
    totalSourceTxns: 60,
    totalTargetTxns: 60,
    matchedCount: 54,
    exceptionCount: 6,
    unmatchedCount: 0,
    matchRate: "90.00",
    processingTimeMs: 1847,
    startedAt: daysAgo(1),
    completedAt: daysAgo(1),
    engineConfig: demoTag({ version: "super-agent-v1" }),
  });
  const allJobs = await db.select().from(reconciliationJobs)
    .where(eq(reconciliationJobs.userId, userId))
    .orderBy(sql`id DESC`).limit(1);
  const job = allJobs[0];

  // ── 6. Create matches for the 54 matched pairs ─────────────────────
  const matchIds: number[] = [];
  for (let i = 0; i < 54; i++) {
    const srcId = sourceTransactionIds[i];
    const tgtId = targetTransactionIds[i];
    if (!srcId || !tgtId) continue;
    await db.insert(matches).values({
      jobId: job.id,
      sourceTransactionId: srcId,
      targetTransactionId: tgtId,
      matchType: "exact",
      confidenceScore: "98.50",
      amountDifference: "0.00",
      dateDifference: 0,
      status: "confirmed",
    });
    const allMatches = await db.select().from(matches)
      .where(eq(matches.jobId, job.id))
      .orderBy(sql`id DESC`).limit(1);
    matchIds.push(allMatches[0].id);
  }

  // ── 7. Create exceptions ───────────────────────────────────────────
  const exceptionIds: number[] = [];
  for (let i = 0; i < exceptionScenarios.length; i++) {
    const scenario = exceptionScenarios[i];
    const srcId = exceptionTxnIds[i]?.srcId;
    if (!srcId) continue;
    await db.insert(exceptions).values({
      jobId: job.id,
      transactionId: srcId,
      category: scenario.category,
      severity: scenario.severity,
      description: scenario.description,
      aiAnalysis: scenario.aiAnalysis,
      suggestedResolution: scenario.suggestedResolution,
      status: "open",
    });
    const allExceptions = await db.select().from(exceptions)
      .where(eq(exceptions.jobId, job.id))
      .orderBy(sql`id DESC`).limit(1);
    exceptionIds.push(allExceptions[0].id);
  }

  // ── 8. Seed memory layer with past resolutions ─────────────────────
  const memorySeeds = [
    {
      category: "amount_mismatch",
      transactionRef: "INV-2701",
      amountRange: "1m+" as const,
      deductionType: "promotional_deduction",
      resolution: "Issued credit note for ₦450,000 promotional deduction. Posted to Promotional Allowances GL.",
      outcome: "resolved" as const,
      reasoning: "Distributor provided promotional claim form signed by Area Sales Manager. Deduction was within approved promotional budget for Q3.",
      embeddingText: "partial payment promotional deduction kola ventures invoice amount mismatch credit note",
    },
    {
      category: "amount_mismatch",
      transactionRef: "INV-2712",
      amountRange: "1m+" as const,
      deductionType: "fx_bank_fee",
      resolution: "Auto-approved match. Posted ₦1,200 bank charge to Bank Charges GL.",
      outcome: "resolved" as const,
      reasoning: "Variance of ₦1,200 (0.05%) is consistent with standard inter-bank transfer fee. Below 0.5% tolerance threshold.",
      embeddingText: "fx bank fee deduction amount mismatch tolerance inter-bank transfer charge auto-approve",
    },
    {
      category: "amount_mismatch",
      transactionRef: "INV-2698",
      amountRange: "1m+" as const,
      deductionType: "damage_claim",
      resolution: "Escalated to logistics. Damage confirmed. Credit note issued for ₦280,000.",
      outcome: "resolved" as const,
      reasoning: "Logistics team confirmed 14 cartons damaged in transit. Damage value assessed at ₦280,000. Credit note issued and posted to Damage Claims GL.",
      embeddingText: "damage deduction less dmg payment reference invoice amount mismatch credit note logistics",
    },
    {
      category: "amount_mismatch",
      transactionRef: "BULK-0089",
      amountRange: "1m+" as const,
      deductionType: "split_payment",
      resolution: "Approved many-to-many split: ₦4.2M to INV-2698, ₦3.8M to INV-2699, ₦2.0M to INV-2700.",
      outcome: "resolved" as const,
      reasoning: "Bulk payment of ₦10M confirmed to cover three outstanding invoices. Split allocation verified against ERP order totals. All three invoices now fully settled.",
      embeddingText: "many to many bulk payment split allocation three invoices northern supplies kano",
    },
    {
      category: "timing_difference",
      transactionRef: "INV-2745",
      amountRange: "1m+" as const,
      deductionType: undefined,
      resolution: "Auto-approved with late payment flag. Late payment notice sent to distributor.",
      outcome: "resolved" as const,
      reasoning: "Payment received 5 days after invoice date — outside 3-day window but amount matches exactly. Late payment notice issued per credit policy.",
      embeddingText: "timing difference late payment 4 days window exact amount match auto-approve flag",
    },
    {
      category: "missing_counterparty",
      transactionRef: "UNK-0045",
      amountRange: "1m+" as const,
      deductionType: undefined,
      resolution: "Confirmed 'IBADAN WHLSL' = 'Ibadan Wholesale Merchants Nigeria Ltd'. Alias added to Distributor Registry. Match approved.",
      outcome: "resolved" as const,
      reasoning: "Bank statement abbreviation matched to canonical distributor record via fuzzy matching (confidence 89%). Finance team confirmed identity. Alias added to prevent future exceptions.",
      embeddingText: "missing counterparty identity resolution abbreviation alias distributor registry fuzzy match",
    },
    {
      category: "amount_mismatch",
      transactionRef: "INV-2756",
      amountRange: "100k-1m" as const,
      deductionType: "promotional_deduction",
      resolution: "Partial approval: ₦200,000 promotional deduction approved, ₦100,000 disputed and escalated.",
      outcome: "escalated" as const,
      reasoning: "Distributor claimed ₦300,000 promotional deduction but only ₦200,000 was within approved promotional budget. Remaining ₦100,000 escalated to Trade Marketing for approval.",
      embeddingText: "partial payment promotional deduction partial approval escalation trade marketing budget",
    },
    {
      category: "duplicate_transaction",
      transactionRef: "INV-2767",
      amountRange: "1m+" as const,
      deductionType: undefined,
      resolution: "Second payment reversed. Distributor notified. Original payment INV-2767 confirmed as settled.",
      outcome: "resolved" as const,
      reasoning: "Distributor accidentally sent payment twice. Second payment identified as duplicate via reference number and amount match. Reversal processed same day.",
      embeddingText: "duplicate transaction reversal double payment distributor error same reference amount",
    },
    {
      category: "amount_mismatch",
      transactionRef: "INV-2778",
      amountRange: "1m+" as const,
      deductionType: "damage_claim",
      resolution: "Damage claim rejected — no supporting documentation provided within 48 hours. Full invoice amount demanded.",
      outcome: "rejected" as const,
      reasoning: "Distributor claimed damage deduction but failed to provide damage assessment report within the 48-hour policy window. Claim rejected per credit policy.",
      embeddingText: "damage deduction rejected no documentation 48 hour policy credit policy demand full payment",
    },
    {
      category: "timing_difference",
      transactionRef: "INV-2789",
      amountRange: "1m+" as const,
      deductionType: undefined,
      resolution: "Approved. Payment was delayed due to bank system downtime on 24 Dec — confirmed via bank statement.",
      outcome: "resolved" as const,
      reasoning: "7-day delay explained by documented bank system outage on 24 December. Bank confirmation letter provided. Exception waived per force majeure clause.",
      embeddingText: "timing difference late payment bank downtime system outage force majeure waiver approved",
    },
  ];

  const memoryIds: number[] = [];
  for (const m of memorySeeds) {
    await db.insert(agentMemory).values({
      organizationId: orgId ?? 0,
      exceptionCategory: m.category,
      transactionRef: m.transactionRef,
      amountRange: m.amountRange,
      counterpartyType: "distributor",
      deductionType: m.deductionType ?? null,
      resolution: m.resolution,
      outcome: m.outcome,
      reasoning: m.reasoning,
      embeddingText: m.embeddingText,
    });
    const allMemory = await db.select().from(agentMemory)
      .where(eq(agentMemory.organizationId, orgId ?? 0))
      .orderBy(sql`id DESC`).limit(1);
    memoryIds.push(allMemory[0].id);
  }

  return {
    distributorIds,
    sourceChannelId: sourceChannel!.id,
    targetChannelId: targetChannel!.id,
    sourceBatchId: sourceBatch.id,
    targetBatchId: targetBatch.id,
    sourceTransactionIds,
    targetTransactionIds,
    jobId: job.id,
    matchIds,
    exceptionIds,
    memoryIds,
  };
}

// ─── Wipe Demo Data ──────────────────────────────────────────────────

export async function wipeDemoData(userId: number, orgId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Delete in dependency order:
  // 1. agent_memory (no FK deps on demo data)
  // 2. exceptions
  // 3. matches
  // 4. transactions (source + target)
  // 5. upload_batches
  // 6. reconciliation_jobs
  // 7. distributors

  // Find demo batches for this user
  const demoBatches = await db.select().from(uploadBatches)
    .where(eq(uploadBatches.userId, userId));
  const demoBatchIds = demoBatches
    .filter(b => b.fileName?.includes("Demo"))
    .map(b => b.id);

  // Find demo jobs for this user
  const demoJobs = await db.select().from(reconciliationJobs)
    .where(eq(reconciliationJobs.userId, userId));
  const demoJobIds = demoJobs
    .filter(j => {
      const raw = j.engineConfig as Record<string, unknown> | null;
      return raw?.isDemoData === true || j.name?.includes("Demo");
    })
    .map(j => j.id);

  // Delete agent memory seeded for this org
  if (orgId !== null) {
    // Only delete memory records that were seeded (no exceptionId = seeded directly)
    const memoryRecords = await db.select().from(agentMemory)
      .where(eq(agentMemory.organizationId, orgId));
    for (const m of memoryRecords) {
      if (!m.exceptionId) {
        // Seeded directly — safe to delete
        await db.delete(agentMemory).where(eq(agentMemory.id, m.id));
      }
    }
  }

  // Delete exceptions for demo jobs
  for (const jobId of demoJobIds) {
    await db.delete(exceptions).where(eq(exceptions.jobId, jobId));
    await db.delete(matches).where(eq(matches.jobId, jobId));
    await db.delete(reconciliationJobs).where(eq(reconciliationJobs.id, jobId));
  }

  // Delete transactions from demo batches
  for (const batchId of demoBatchIds) {
    await db.delete(transactions).where(eq(transactions.batchId, batchId));
    await db.delete(uploadBatches).where(eq(uploadBatches.id, batchId));
  }

  // Delete demo distributors (those with notes containing DEMO DATA)
  const allDistributors = await db.select().from(distributors);
  for (const d of allDistributors) {
    if (d.notes?.includes("DEMO DATA")) {
      await db.delete(distributors).where(eq(distributors.id, d.id));
    }
  }
}
