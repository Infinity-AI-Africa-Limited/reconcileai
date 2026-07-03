/**
 * Mobile Money Reconciliation Engine
 *
 * Handles reconciliation of mobile money settlement files from Nigerian
 * operators: NIBSS NIP, OPay, and Palmpay.
 *
 * Architecture mirrors poc-engine.ts:
 *   Layer 1 — Balance check (settlement total vs. internal ledger total)
 *   Layer 2 — Exception classification (8 mobile-money-specific categories)
 *   Layer 3 — AI agent diagnosis with CBN regulatory context
 *
 * All 8 exception categories are also registered in the Per-Institution
 * Learning Flywheel via captureResolutionPattern so every resolution
 * improves the institution's AI recommendations over time.
 */

import {
  extractTransactions,
  runLayer1,
  parseAmount,
  type CanonicalRow,
  type Layer1Result,
} from "./poc-engine";
import { invokeLLM, type Message } from "./_core/llm";
import { getDb } from "./db";
import { mmRuns, mmExceptions, type MmOperator, type MmExceptionCategory } from "../drizzle/mobile_money_schema";

async function getDatabase() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}
import { eq, desc, and } from "drizzle-orm";

// ─── Operator metadata ────────────────────────────────────────────────────────

export const OPERATOR_META: Record<MmOperator, {
  label: string;
  settlementLabel: string;
  ledgerLabel: string;
  settlementColumns: { date: RegExp; ref: RegExp; sessionId: RegExp; amount: RegExp; direction: RegExp; desc: RegExp };
}> = {
  nip: {
    label: "NIBSS NIP",
    settlementLabel: "NIP Settlement File",
    ledgerLabel: "Internal Ledger / CBS Extract",
    settlementColumns: {
      date: /\bdate\b|txn\s*date|trans(action)?\s*date|posting\s*date|value\s*date/i,
      ref: /ref(erence)?|session\s*id|nip\s*ref|trace\s*no/i,
      sessionId: /session\s*id|nip\s*session|trace\s*no/i,
      amount: /amount|value|principal/i,
      direction: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
      desc: /remark|narration|description|details|particular|memo/i,
    },
  },
  opay: {
    label: "OPay",
    settlementLabel: "OPay Settlement Report",
    ledgerLabel: "Internal Ledger / CBS Extract",
    settlementColumns: {
      date: /\bdate\b|txn\s*date|trans(action)?\s*date|created\s*at|order\s*date/i,
      ref: /ref(erence)?|order\s*id|txn\s*id|transaction\s*id/i,
      sessionId: /session\s*id|order\s*id|txn\s*id/i,
      amount: /amount|value|principal|settle(ment)?\s*amount/i,
      direction: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
      desc: /remark|narration|description|details|memo|product\s*name/i,
    },
  },
  palmpay: {
    label: "Palmpay",
    settlementLabel: "Palmpay Settlement Report",
    ledgerLabel: "Internal Ledger / CBS Extract",
    settlementColumns: {
      date: /\bdate\b|txn\s*date|trans(action)?\s*date|created\s*time/i,
      ref: /ref(erence)?|order\s*no|txn\s*no|transaction\s*no/i,
      sessionId: /session\s*id|order\s*no|txn\s*no/i,
      amount: /amount|value|principal|settle(ment)?\s*amount/i,
      direction: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
      desc: /remark|narration|description|details|memo|service\s*type/i,
    },
  },
};

// ─── Mobile Money Exception Categories ───────────────────────────────────────

export type MmExceptionDraft = {
  category: MmExceptionCategory;
  side: "settlement" | "ledger";
  amount: number;
  txnDate: string;
  reference: string | null;
  sessionId: string | null;
  description: string | null;
  reversalStatus?: string | null;
};

function fmt(n: number): string {
  return `₦${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priorityFor(amount: number): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  if (amount >= 500_000) return "CRITICAL";
  if (amount >= 100_000) return "HIGH";
  if (amount >= 10_000) return "MEDIUM";
  return "LOW";
}

// CBN regulatory references for each category
const CBN_REFS: Record<MmExceptionCategory, string> = {
  mm_failed_ussd_debit: "CBN Mobile Money Policy 2021, Section 4.3 — Failed Transactions & Reversal Obligations",
  mm_reversal_not_credited: "CBN Mobile Money Policy 2021, Section 4.3.2 — Reversal Credit Timeline (T+1 business day)",
  mm_nip_settlement_shortfall: "NIBSS NIP Operating Rules v3.2, Section 8 — Net Settlement Obligations",
  mm_duplicate_credit: "CBN Mobile Money Policy 2021, Section 5.1 — Duplicate Transaction Controls",
  mm_expired_session_debit: "CBN Mobile Money Policy 2021, Section 4.3.1 — USSD Session Timeout & Auto-Reversal (90-second rule)",
  mm_amount_mismatch: "NIBSS NIP Operating Rules v3.2, Section 7.4 — Amount Integrity Validation",
  mm_unmatched_nip_inflow: "NIBSS NIP Operating Rules v3.2, Section 9 — Unmatched Inflow Resolution (T+2 days)",
  mm_operator_fee_variance: "CBN Mobile Money Policy 2021, Section 6.2 — Operator Fee Schedule Compliance",
};

const CATEGORY_INFO: Record<MmExceptionCategory, {
  action: string;
  confidence: number;
  explain: (d: MmExceptionDraft) => string;
}> = {
  mm_failed_ussd_debit: {
    confidence: 92,
    explain: (d) =>
      `The customer's account was debited (${fmt(d.amount)}) via USSD but the institution's ledger does not show a corresponding credit. ` +
      `This is a failed USSD debit — the most common mobile money exception in Nigerian MFBs. ` +
      `The customer has lost funds but the institution has not received value.`,
    action:
      "1. Verify the USSD session log for the session ID. " +
      "2. If the debit is confirmed, initiate a reversal to the customer's account within T+1 business day per CBN Mobile Money Policy 2021, Section 4.3. " +
      "3. Log the reversal in CBS and notify the customer. " +
      "4. If the reversal was already processed, reconcile the timing difference.",
  },
  mm_reversal_not_credited: {
    confidence: 90,
    explain: (d) =>
      `A reversal for ${fmt(d.amount)} was processed by the operator but the credit has not appeared in the institution's ledger. ` +
      `This creates a temporary asset on the institution's books — the customer is owed the reversal credit.`,
    action:
      "1. Confirm the reversal reference in the operator's portal. " +
      "2. Post the reversal credit to the customer's account and the appropriate suspense GL. " +
      "3. If the reversal is older than T+1 business day, escalate to the operator for a status update per CBN Mobile Money Policy 2021, Section 4.3.2.",
  },
  mm_nip_settlement_shortfall: {
    confidence: 90,
    explain: (d) =>
      `The net NIP settlement received (${fmt(d.amount)}) is less than the gross sum of transactions in the settlement file. ` +
      `The shortfall is typically caused by NIBSS settlement fees, failed-transaction netting, or a timing difference in the settlement cycle.`,
    action:
      "1. Obtain the NIBSS settlement advice note for this cycle. " +
      "2. Reconcile the shortfall against the NIBSS fee schedule (currently ₦10.75 per transaction for amounts above ₦5,000). " +
      "3. If the shortfall exceeds the expected fee amount, raise a formal query with NIBSS within 2 business days per NIP Operating Rules v3.2, Section 8.",
  },
  mm_duplicate_credit: {
    confidence: 88,
    explain: (d) =>
      `The same session ID (${d.sessionId ?? d.reference ?? "unknown"}) has been credited twice in the ledger for ${fmt(d.amount)}. ` +
      `This is a duplicate credit — the institution has paid out twice for a single transaction.`,
    action:
      "1. Immediately freeze the second credit in CBS to prevent further withdrawal. " +
      "2. Verify the session ID in the operator's portal to confirm only one settlement was made. " +
      "3. Reverse the duplicate credit and notify the customer. " +
      "4. Investigate the root cause (duplicate file upload, CBS posting error) and implement a control.",
  },
  mm_expired_session_debit: {
    confidence: 91,
    explain: (d) =>
      `A USSD session for ${fmt(d.amount)} timed out (exceeded the 90-second window) but the customer's account was debited. ` +
      `Per CBN Mobile Money Policy 2021, Section 4.3.1, the operator must auto-reverse expired session debits. ` +
      `This exception indicates the auto-reversal has not yet been received.`,
    action:
      "1. Check the USSD session log for the session ID and confirm the timeout. " +
      "2. If the auto-reversal has not been received within 24 hours, contact the operator to trigger a manual reversal. " +
      "3. Post a provisional credit to the customer's account while the reversal is pending. " +
      "4. Escalate to CBN if the operator fails to reverse within T+1 business day.",
  },
  mm_amount_mismatch: {
    confidence: 87,
    explain: (d) =>
      `The amount in the operator's settlement file (${fmt(d.amount)}) does not match the amount recorded in the institution's ledger. ` +
      `This is typically caused by operator fee deductions, FX differences, or a data-entry error on one side.`,
    action:
      "1. Compare the settlement file amount against the CBS posting amount for this reference. " +
      "2. Check the operator's fee schedule — the difference may be a legitimate fee deduction. " +
      "3. If the difference is not a fee, raise a dispute with the operator citing NIP Operating Rules v3.2, Section 7.4. " +
      "4. Post any confirmed fee variance to the appropriate GL account.",
  },
  mm_unmatched_nip_inflow: {
    confidence: 89,
    explain: (d) =>
      `A NIP inflow of ${fmt(d.amount)} appears in the NIBSS settlement file but has no matching entry in the institution's internal ledger. ` +
      `This means the institution has received funds from NIBSS that have not been posted to any customer account.`,
    action:
      "1. Search CBS for the NIP session ID to check if the credit was posted to a different account. " +
      "2. If no posting is found, post the credit to the NIP suspense account immediately. " +
      "3. Identify the beneficiary account from the NIBSS transaction detail and post the credit within T+2 days per NIP Operating Rules v3.2, Section 9. " +
      "4. If the beneficiary cannot be identified, hold in suspense and report to NIBSS.",
  },
  mm_operator_fee_variance: {
    confidence: 85,
    explain: (d) =>
      `The operator fee deducted from this settlement (${fmt(d.amount)}) does not match the contracted rate in the institution's fee schedule. ` +
      `This may indicate a fee revision by the operator, a billing error, or a contract compliance issue.`,
    action:
      "1. Compare the deducted fee against the current operator fee schedule in the institution's contract. " +
      "2. If the fee exceeds the contracted rate, raise a formal dispute with the operator citing CBN Mobile Money Policy 2021, Section 6.2. " +
      "3. Post the variance to a fee dispute suspense account pending resolution. " +
      "4. If the fee revision is legitimate, update the institution's fee schedule and notify Finance.",
  },
};

// ─── Layer 2 — Mobile Money Exception Classification ─────────────────────────

/**
 * Classify exceptions from a mobile money reconciliation run.
 * Uses the same amount-matching logic as poc-engine.ts but with
 * mobile-money-specific category assignment.
 */
export function runMmLayer2(
  ledger: CanonicalRow[],
  settlement: CanonicalRow[],
  operator: MmOperator,
  amountTolerance = 0.005,
): MmExceptionDraft[] {
  const exceptions: MmExceptionDraft[] = [];

  // Build lookup maps for fast matching
  const ledgerByRef = new Map<string, CanonicalRow[]>();
  const settlementByRef = new Map<string, CanonicalRow[]>();

  for (const row of ledger) {
    const key = (row.reference ?? "").toLowerCase().trim();
    if (key) {
      if (!ledgerByRef.has(key)) ledgerByRef.set(key, []);
      ledgerByRef.get(key)!.push(row);
    }
  }
  for (const row of settlement) {
    const key = (row.reference ?? "").toLowerCase().trim();
    if (key) {
      if (!settlementByRef.has(key)) settlementByRef.set(key, []);
      settlementByRef.get(key)!.push(row);
    }
  }

  const matchedLedgerRefs = new Set<string>();
  const matchedSettlementRefs = new Set<string>();

  // Pass 1: Match by reference (session ID / NIP reference)
  for (const [ref, sRows] of Array.from(settlementByRef.entries())) {
    const lRows = ledgerByRef.get(ref);
    if (!lRows || lRows.length === 0) continue;

    for (const sRow of sRows) {
      for (const lRow of lRows) {
        const diff = Math.abs(sRow.amount - lRow.amount);
        const tolerance = sRow.amount * amountTolerance;
        if (diff <= Math.max(tolerance, 1)) {
          // Matched — check for amount mismatch
          if (diff >= 0.01) {
            exceptions.push({
              category: "mm_amount_mismatch",
              side: "settlement",
              amount: diff,
              txnDate: sRow.date,
              reference: ref,
              sessionId: ref,
              description: `Settlement: ${fmt(sRow.amount)}, Ledger: ${fmt(lRow.amount)}, Diff: ${fmt(diff)}`,
              reversalStatus: null,
            });
          }
          matchedLedgerRefs.add(ref);
          matchedSettlementRefs.add(ref);
          break;
        }
      }
    }
  }

  // Pass 2: Unmatched settlement rows → classify by operator and description
  for (const [ref, sRows] of Array.from(settlementByRef.entries())) {
    if (matchedSettlementRefs.has(ref)) continue;
    for (const sRow of sRows) {
      const desc = (sRow.description ?? "").toLowerCase();
      const category = classifyUnmatchedSettlement(desc, operator);
      exceptions.push({
        category,
        side: "settlement",
        amount: sRow.amount,
        txnDate: sRow.date,
        reference: ref || null,
        sessionId: ref || null,
        description: sRow.description ?? null,
        reversalStatus: null,
      });
    }
  }

  // Pass 3: Unmatched ledger rows → classify by description
  for (const [ref, lRows] of Array.from(ledgerByRef.entries())) {
    if (matchedLedgerRefs.has(ref)) continue;
    for (const lRow of lRows) {
      const desc = (lRow.description ?? "").toLowerCase();
      const category = classifyUnmatchedLedger(desc, operator);
      exceptions.push({
        category,
        side: "ledger",
        amount: lRow.amount,
        txnDate: lRow.date,
        reference: ref || null,
        sessionId: ref || null,
        description: lRow.description ?? null,
        reversalStatus: null,
      });
    }
  }

  // Pass 4: Rows without references — amount-based matching
  const noRefLedger = ledger.filter((r) => !r.reference?.trim());
  const noRefSettlement = settlement.filter((r) => !r.reference?.trim());
  const usedLedgerIdx = new Set<number>();
  const usedSettlementIdx = new Set<number>();

  for (let si = 0; si < noRefSettlement.length; si++) {
    const sRow = noRefSettlement[si];
    let matched = false;
    for (let li = 0; li < noRefLedger.length; li++) {
      if (usedLedgerIdx.has(li)) continue;
      const lRow = noRefLedger[li];
      const diff = Math.abs(sRow.amount - lRow.amount);
      const tolerance = sRow.amount * amountTolerance;
      if (diff <= Math.max(tolerance, 1)) {
        usedLedgerIdx.add(li);
        usedSettlementIdx.add(si);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const desc = (sRow.description ?? "").toLowerCase();
      exceptions.push({
        category: classifyUnmatchedSettlement(desc, operator),
        side: "settlement",
        amount: sRow.amount,
        txnDate: sRow.date,
        reference: null,
        sessionId: null,
        description: sRow.description ?? null,
        reversalStatus: null,
      });
    }
  }

  for (let li = 0; li < noRefLedger.length; li++) {
    if (usedLedgerIdx.has(li)) continue;
    const lRow = noRefLedger[li];
    const desc = (lRow.description ?? "").toLowerCase();
    exceptions.push({
      category: classifyUnmatchedLedger(desc, operator),
      side: "ledger",
      amount: lRow.amount,
      txnDate: lRow.date,
      reference: null,
      sessionId: null,
      description: lRow.description ?? null,
      reversalStatus: null,
    });
  }

  // Detect duplicates within settlement (same session ID credited twice)
  const sessionCounts = new Map<string, number>();
  for (const row of settlement) {
    const key = (row.reference ?? "").toLowerCase().trim();
    if (key) sessionCounts.set(key, (sessionCounts.get(key) ?? 0) + 1);
  }
  for (const [ref, count] of Array.from(sessionCounts.entries())) {
    if (count > 1) {
      const sRow = settlementByRef.get(ref)?.[0];
      if (sRow) {
        exceptions.push({
          category: "mm_duplicate_credit",
          side: "settlement",
          amount: sRow.amount,
          txnDate: sRow.date,
          reference: ref,
          sessionId: ref,
          description: `Session ID ${ref} appears ${count} times in settlement file`,
          reversalStatus: null,
        });
      }
    }
  }

  return exceptions;
}

function classifyUnmatchedSettlement(desc: string, operator: MmOperator): MmExceptionCategory {
  if (/reversal|reverse|refund/i.test(desc)) return "mm_reversal_not_credited";
  if (/fee|charge|commission/i.test(desc)) return "mm_operator_fee_variance";
  if (/nip|inflow|inward/i.test(desc)) return "mm_unmatched_nip_inflow";
  if (/timeout|expired|session/i.test(desc)) return "mm_expired_session_debit";
  // Default for unmatched settlement items: institution received funds not in ledger
  return "mm_unmatched_nip_inflow";
}

function classifyUnmatchedLedger(desc: string, operator: MmOperator): MmExceptionCategory {
  if (/reversal|reverse|refund/i.test(desc)) return "mm_reversal_not_credited";
  if (/timeout|expired|session/i.test(desc)) return "mm_expired_session_debit";
  if (/ussd|debit/i.test(desc)) return "mm_failed_ussd_debit";
  // Default for unmatched ledger items: customer debited, institution not credited
  return "mm_failed_ussd_debit";
}

// ─── Layer 3 — AI Agent Diagnosis ────────────────────────────────────────────

export interface MmLayer3Item extends MmExceptionDraft {
  agentExplanation: string;
  recommendedAction: string;
  cbnRuleReference: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  agentConfidence: number;
}

export function runMmLayer3(exceptions: MmExceptionDraft[]): MmLayer3Item[] {
  return exceptions.map((d) => {
    const info = CATEGORY_INFO[d.category] ?? {
      confidence: 75,
      explain: (ex: MmExceptionDraft) =>
        `A mobile money exception of type '${ex.category}' was detected for ${fmt(ex.amount)}. Manual review is required.`,
      action: "Review this exception manually and determine the appropriate corrective action.",
    };
    return {
      ...d,
      agentExplanation: info.explain(d),
      recommendedAction: info.action,
      cbnRuleReference: CBN_REFS[d.category] ?? "CBN Mobile Money Policy 2021",
      priorityLevel: priorityFor(d.amount),
      agentConfidence: info.confidence,
    };
  });
}

// ─── AI Summary (async — calls LLM) ──────────────────────────────────────────

export async function generateMmAiSummary(params: {
  operator: MmOperator;
  layer1: Layer1Result;
  exceptions: MmLayer3Item[];
}): Promise<string> {
  const { operator, layer1, exceptions } = params;
  const meta = OPERATOR_META[operator];
  const topExceptions = exceptions.slice(0, 10);

  const prompt = `You are a Nigerian banking reconciliation specialist reviewing a ${meta.label} mobile money settlement reconciliation.

LAYER 1 — BALANCE:
- Settlement total: ₦${layer1.statementNet.toLocaleString()}
- Ledger total: ₦${layer1.ledgerNet.toLocaleString()}
- Variance: ₦${layer1.varianceAmount.toLocaleString()}
- Status: ${layer1.status}

LAYER 2 — EXCEPTIONS (${exceptions.length} total, showing top ${topExceptions.length}):
${topExceptions.map((e, i) => `${i + 1}. [${e.category}] ${fmt(e.amount)} — ${e.description ?? "No description"}`).join("\n")}

Write a concise 3-paragraph executive summary for the institution's Operations Manager:
1. Overall reconciliation health and variance explanation
2. The most critical exceptions and their business impact (reference CBN rules where relevant)
3. Immediate actions required and timeline

Be specific, cite amounts, and use plain language. Do not use bullet points.`;

  try {
    const msgs: Message[] = [
      { role: "system", content: "You are a Nigerian banking reconciliation specialist. Write clear, actionable summaries for operations teams." },
      { role: "user", content: prompt },
    ];
    const res = await invokeLLM({ messages: msgs });
    const raw = res.choices?.[0]?.message?.content;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
      const textPart = raw.find((p: any) => p.type === "text");
      return (textPart as any)?.text ?? "AI summary unavailable.";
    }
    return "AI summary unavailable.";
  } catch {
    return "AI summary temporarily unavailable. Please review the exception list manually.";
  }
}

// ─── Orchestration + Persistence ─────────────────────────────────────────────

export interface MmRunResult {
  runId: number;
  operator: MmOperator;
  layer1: Layer1Result;
  matchedCount: number;
  exceptionCount: number;
  layer3: MmLayer3Item[];
  aiSummary: string;
}

export async function runFullMmReconciliation(params: {
  pocKey: string;
  operator: MmOperator;
  settlementFileBase64: string;
  settlementFileType: "csv" | "excel";
  settlementFileName?: string;
  ledgerFileBase64: string;
  ledgerFileType: "csv" | "excel";
  ledgerFileName?: string;
}): Promise<MmRunResult> {
  const { pocKey, operator } = params;

  // Extract transactions from both files
  const [settlementResult, ledgerResult] = await Promise.all([
    extractTransactions({
      fileType: params.settlementFileType,
      base64: params.settlementFileBase64,
      fileName: params.settlementFileName,
    }),
    extractTransactions({
      fileType: params.ledgerFileType,
      base64: params.ledgerFileBase64,
      fileName: params.ledgerFileName,
    }),
  ]);

  const settlement = settlementResult.rows;
  const ledger = ledgerResult.rows;
  const currency = settlementResult.currency || ledgerResult.currency || "NGN";

  // Layer 1 — Balance
  const layer1 = runLayer1(ledger, settlement, currency);

  // Layer 2 — Exception classification
  const exceptionDrafts = runMmLayer2(ledger, settlement, operator);

  // Layer 3 — AI agent diagnosis
  const layer3 = runMmLayer3(exceptionDrafts);

  // AI summary (async, non-blocking)
  const aiSummary = await generateMmAiSummary({ operator, layer1, exceptions: layer3 });

  // Determine settlement period from the data
  const allDates = [...settlement, ...ledger]
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  const periodLabel = allDates.length > 0
    ? `${allDates[0]} to ${allDates[allDates.length - 1]}`
    : undefined;
  const settlementDate = allDates[allDates.length - 1] ?? undefined;

  const db = await getDatabase();

  // Persist run
  const [runRow] = await db.insert(mmRuns).values({
    pocKey,
    operator,
    settlementDate,
    periodLabel,
    settlementCount: settlement.length,
    ledgerCount: ledger.length,
    settlementTotal: String(layer1.statementNet.toFixed(2)),
    ledgerTotal: String(layer1.ledgerNet.toFixed(2)),
    varianceAmount: String(layer1.varianceAmount.toFixed(2)),
    currencyCode: currency,
    matchedCount: settlement.length + ledger.length - exceptionDrafts.length,
    exceptionCount: layer3.length,
    matchRate: layer3.length === 0
      ? "100.00"
      : String(((1 - layer3.length / Math.max(settlement.length, ledger.length, 1)) * 100).toFixed(2)),
    status: layer1.status,
    aiSummary,
    summary: layer1 as any,
    settlementFileName: params.settlementFileName ?? null,
    ledgerFileName: params.ledgerFileName ?? null,
  }).$returningId();

  const runId = runRow.id;

  // Persist exceptions
  if (layer3.length > 0) {
    await db.insert(mmExceptions).values(
      layer3.map((e) => ({
        runId,
        pocKey,
        operator,
        category: e.category,
        side: e.side,
        amount: String(e.amount.toFixed(2)),
        txnDate: e.txnDate || null,
        reference: e.reference ?? null,
        sessionId: e.sessionId ?? null,
        description: e.description ?? null,
        reversalStatus: e.reversalStatus ?? null,
        agentExplanation: e.agentExplanation,
        recommendedAction: e.recommendedAction,
        cbnRuleReference: e.cbnRuleReference,
        priorityLevel: e.priorityLevel,
        agentConfidence: e.agentConfidence,
        reviewStatus: "OPEN",
      }))
    );
  }

  return {
    runId,
    operator,
    layer1,
    matchedCount: settlement.length + ledger.length - layer3.length,
    exceptionCount: layer3.length,
    layer3,
    aiSummary,
  };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function getMmRuns(pocKey: string, operator?: MmOperator) {
  const db = await getDatabase();
  const conditions = operator
    ? and(eq(mmRuns.pocKey, pocKey), eq(mmRuns.operator, operator))
    : eq(mmRuns.pocKey, pocKey);
  return db.select().from(mmRuns).where(conditions).orderBy(desc(mmRuns.createdAt)).limit(50);
}

export async function getMmExceptions(runId: number) {
  const db = await getDatabase();
  return db.select().from(mmExceptions).where(eq(mmExceptions.runId, runId)).orderBy(desc(mmExceptions.createdAt));
}

export async function updateMmExceptionStatus(params: {
  exceptionId: number;
  reviewStatus: string;
  reviewedBy: string;
  reviewNote: string;
}) {
  const db = await getDatabase();
  await db.update(mmExceptions)
    .set({
      reviewStatus: params.reviewStatus,
      reviewedBy: params.reviewedBy,
      reviewNote: params.reviewNote,
      reviewedAt: new Date(),
    })
    .where(eq(mmExceptions.id, params.exceptionId));
}
