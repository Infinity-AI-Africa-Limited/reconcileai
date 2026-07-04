/**
 * Mobile Money Reconciliation Engine
 *
 * Handles reconciliation of mobile money settlement files across two
 * jurisdictions:
 *   Nigeria — NIBSS NIP, OPay, Palmpay (regulator: CBN / NIBSS, currency NGN)
 *   Uganda  — MTN MoMo, Airtel Money  (regulator: Bank of Uganda,  currency UGX)
 *
 * Architecture mirrors poc-engine.ts:
 *   Layer 1 — Balance check (settlement total vs. internal ledger total)
 *   Layer 2 — Exception classification (12 mobile-money-specific categories)
 *   Layer 3 — AI agent diagnosis with jurisdiction-specific regulatory context,
 *             enriched with per-institution learning from the POC's own
 *             resolution history (see applyInstitutionalLearning).
 *
 * Per-institution learning: POC runs are token-gated and have no tenant
 * organization, so cross-institution pattern sharing (exceptionIntelligence
 * recordLocalSignature) activates only when a POC converts to a full tenant.
 * Until then the engine learns from the institution's own resolved
 * mm_exceptions history — recommendations cite how similar exceptions were
 * previously actioned and confidence rises with corroborating resolutions.
 */

import {
  extractTransactions,
  runLayer1,
  type CanonicalRow,
  type Layer1Result,
} from "./poc-engine";
import { invokeLLM, type Message } from "./_core/llm";
import { getDb } from "./db";
import { mmRuns, mmExceptions, type MmOperator, type MmExceptionCategory } from "../drizzle/mobile_money_schema";
import { eq, desc, and, ne } from "drizzle-orm";

async function getDatabase() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

// ─── Operator metadata ────────────────────────────────────────────────────────

export type MmCountry = "NG" | "UG";

export const OPERATOR_META: Record<MmOperator, {
  label: string;
  country: MmCountry;
  currency: "NGN" | "UGX";
  regulator: string;
  settlementLabel: string;
  ledgerLabel: string;
  /**
   * Documentation of the column-name conventions seen in each operator's
   * settlement exports. NOTE: parsing is currently done by the generic
   * poc-engine extractor (extractTransactions), which auto-detects columns;
   * these patterns describe the expected shape and back the UI hints.
   */
  settlementColumns: { date: RegExp; ref: RegExp; sessionId: RegExp; amount: RegExp; direction: RegExp; desc: RegExp };
}> = {
  nip: {
    label: "NIBSS NIP",
    country: "NG",
    currency: "NGN",
    regulator: "CBN / NIBSS",
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
    country: "NG",
    currency: "NGN",
    regulator: "CBN",
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
    country: "NG",
    currency: "NGN",
    regulator: "CBN",
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
  mtn_momo_ug: {
    label: "MTN MoMo (Uganda)",
    country: "UG",
    currency: "UGX",
    regulator: "Bank of Uganda",
    settlementLabel: "MTN MoMo Settlement Statement",
    ledgerLabel: "Internal Ledger / CBS Extract",
    settlementColumns: {
      date: /\bdate\b|txn\s*date|trans(action)?\s*date|completed\s*time|initiated\s*time/i,
      ref: /financial\s*transaction\s*id|external\s*id|transaction\s*id|txn\s*id|ref(erence)?|receipt/i,
      sessionId: /financial\s*transaction\s*id|external\s*id|transaction\s*id/i,
      amount: /amount|value|principal/i,
      direction: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
      desc: /remark|narration|description|details|message|reason|type/i,
    },
  },
  airtel_money_ug: {
    label: "Airtel Money (Uganda)",
    country: "UG",
    currency: "UGX",
    regulator: "Bank of Uganda",
    settlementLabel: "Airtel Money Settlement Statement",
    ledgerLabel: "Internal Ledger / CBS Extract",
    settlementColumns: {
      date: /\bdate\b|txn\s*date|trans(action)?\s*date|completed\s*time/i,
      ref: /airtel\s*money\s*id|transaction\s*id|txn\s*id|ref(erence)?|receipt\s*no/i,
      sessionId: /airtel\s*money\s*id|transaction\s*id|txn\s*id/i,
      amount: /amount|value|principal/i,
      direction: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
      desc: /remark|narration|description|details|message|reason|service/i,
    },
  },
};

// ─── Currency-aware formatting & priority ────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { NGN: "₦", UGX: "USh " };

export function fmtMoney(n: number, currency = "NGN"): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  // UGX is not subdivided in practice — whole shillings only.
  const digits = currency === "UGX" ? 0 : 2;
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// Priority thresholds hold roughly equivalent purchasing power per currency.
const PRIORITY_THRESHOLDS: Record<string, { critical: number; high: number; medium: number }> = {
  NGN: { critical: 500_000, high: 100_000, medium: 10_000 },
  UGX: { critical: 2_000_000, high: 400_000, medium: 40_000 },
};

export function priorityFor(amount: number, currency = "NGN"): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const t = PRIORITY_THRESHOLDS[currency] ?? PRIORITY_THRESHOLDS.NGN;
  if (amount >= t.critical) return "CRITICAL";
  if (amount >= t.high) return "HIGH";
  if (amount >= t.medium) return "MEDIUM";
  return "LOW";
}

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

// Regulatory references per category. Nigerian categories cite CBN / NIBSS;
// Ugandan categories cite the Bank of Uganda NPS framework and tax law.
// (Persisted in the mm_exceptions.cbnRuleReference column, which predates
// Uganda support — treat that column as "regulatory rule reference".)
export const REG_REFS: Record<MmExceptionCategory, string> = {
  // Nigeria
  mm_failed_ussd_debit: "CBN Mobile Money Framework 2021, Section 4.3 — Failed Transactions & Reversal Obligations",
  mm_reversal_not_credited: "CBN Mobile Money Framework 2021, Section 4.3.2 — Reversal Credit Timeline (T+1 business day)",
  mm_nip_settlement_shortfall: "NIBSS NIP Operating Rules v3.2, Section 8 — Net Settlement Obligations",
  mm_duplicate_credit: "CBN Mobile Money Framework 2021, Section 5.1 — Duplicate Transaction Controls",
  mm_expired_session_debit: "CBN Mobile Money Framework 2021, Section 4.3.1 — USSD Session Timeout & Auto-Reversal",
  mm_amount_mismatch: "NIBSS NIP Operating Rules v3.2, Section 7.4 — Amount Integrity Validation",
  mm_unmatched_nip_inflow: "NIBSS NIP Operating Rules v3.2, Section 9 — Unmatched Inflow Resolution (T+2 days)",
  mm_operator_fee_variance: "CBN Mobile Money Framework 2021, Section 6.2 — Operator Fee Schedule Compliance",
  // Uganda
  mm_wallet_to_bank_failed: "Uganda NPS Act 2020, Part VII — Consumer Protection: Error Resolution & Refund Obligations",
  mm_bank_to_wallet_failed: "Uganda NPS Act 2020, Part VII — Failed Transfer Reversal Obligations",
  mm_withdrawal_tax_variance: "Uganda Excise Duty Act (2018 Amendment) — 0.5% Levy on Mobile Money Withdrawals",
  mm_momo_settlement_shortfall: "BoU NPS (E-Money) Regulations 2021 — Trust Account & Daily Reconciliation Requirements",
};

export const CATEGORY_INFO: Record<MmExceptionCategory, {
  action: string;
  confidence: number;
  explain: (d: MmExceptionDraft, ccy: string) => string;
}> = {
  mm_failed_ussd_debit: {
    confidence: 92,
    explain: (d, ccy) =>
      `The customer's account was debited (${fmtMoney(d.amount, ccy)}) via USSD but the institution's ledger does not show a corresponding credit. ` +
      `This is a failed USSD debit — the most common mobile money exception in Nigerian MFBs. ` +
      `The customer has lost funds but the institution has not received value.`,
    action:
      "1. Verify the USSD session log for the session ID. " +
      "2. If the debit is confirmed, initiate a reversal to the customer's account within T+1 business day per CBN Mobile Money Framework 2021, Section 4.3. " +
      "3. Log the reversal in CBS and notify the customer. " +
      "4. If the reversal was already processed, reconcile the timing difference.",
  },
  mm_reversal_not_credited: {
    confidence: 90,
    explain: (d, ccy) =>
      `A reversal for ${fmtMoney(d.amount, ccy)} was processed by the operator but the credit has not appeared in the institution's ledger. ` +
      `This creates a temporary asset on the institution's books — the customer is owed the reversal credit.`,
    action:
      "1. Confirm the reversal reference in the operator's portal. " +
      "2. Post the reversal credit to the customer's account and the appropriate suspense GL. " +
      "3. If the reversal is older than T+1 business day, escalate to the operator for a status update.",
  },
  mm_nip_settlement_shortfall: {
    confidence: 90,
    explain: (d, ccy) =>
      `The net NIP settlement received is short by ${fmtMoney(d.amount, ccy)} against the gross sum of transactions in the settlement file. ` +
      `The shortfall is typically caused by NIBSS settlement fees, failed-transaction netting, or a timing difference in the settlement cycle.`,
    action:
      "1. Obtain the NIBSS settlement advice note for this cycle. " +
      "2. Reconcile the shortfall against the NIBSS fee schedule (currently ₦10.75 per transaction for amounts above ₦5,000). " +
      "3. If the shortfall exceeds the expected fee amount, raise a formal query with NIBSS within 2 business days per NIP Operating Rules v3.2, Section 8.",
  },
  mm_duplicate_credit: {
    confidence: 88,
    explain: (d, ccy) =>
      `The same session ID (${d.sessionId ?? d.reference ?? "unknown"}) has been credited twice in the ledger for ${fmtMoney(d.amount, ccy)}. ` +
      `This is a duplicate credit — the institution has paid out twice for a single transaction.`,
    action:
      "1. Immediately freeze the second credit in CBS to prevent further withdrawal. " +
      "2. Verify the session ID in the operator's portal to confirm only one settlement was made. " +
      "3. Reverse the duplicate credit and notify the customer. " +
      "4. Investigate the root cause (duplicate file upload, CBS posting error) and implement a control.",
  },
  mm_expired_session_debit: {
    confidence: 91,
    explain: (d, ccy) =>
      `A USSD session for ${fmtMoney(d.amount, ccy)} timed out but the customer's account was debited. ` +
      `Per CBN Mobile Money Framework 2021, Section 4.3.1, the operator must auto-reverse expired session debits. ` +
      `This exception indicates the auto-reversal has not yet been received.`,
    action:
      "1. Check the USSD session log for the session ID and confirm the timeout. " +
      "2. If the auto-reversal has not been received within 24 hours, contact the operator to trigger a manual reversal. " +
      "3. Post a provisional credit to the customer's account while the reversal is pending. " +
      "4. Escalate to CBN if the operator fails to reverse within T+1 business day.",
  },
  mm_amount_mismatch: {
    confidence: 87,
    explain: (d, ccy) =>
      `The amount in the operator's settlement file does not match the amount recorded in the institution's ledger (difference: ${fmtMoney(d.amount, ccy)}). ` +
      `This is typically caused by operator fee deductions, FX differences, or a data-entry error on one side.`,
    action:
      "1. Compare the settlement file amount against the CBS posting amount for this reference. " +
      "2. Check the operator's fee schedule — the difference may be a legitimate fee deduction. " +
      "3. If the difference is not a fee, raise a dispute with the operator. " +
      "4. Post any confirmed fee variance to the appropriate GL account.",
  },
  mm_unmatched_nip_inflow: {
    confidence: 89,
    explain: (d, ccy) =>
      `A NIP inflow of ${fmtMoney(d.amount, ccy)} appears in the NIBSS settlement file but has no matching entry in the institution's internal ledger. ` +
      `This means the institution has received funds from NIBSS that have not been posted to any customer account.`,
    action:
      "1. Search CBS for the NIP session ID to check if the credit was posted to a different account. " +
      "2. If no posting is found, post the credit to the NIP suspense account immediately. " +
      "3. Identify the beneficiary account from the NIBSS transaction detail and post the credit within T+2 days per NIP Operating Rules v3.2, Section 9. " +
      "4. If the beneficiary cannot be identified, hold in suspense and report to NIBSS.",
  },
  mm_operator_fee_variance: {
    confidence: 85,
    explain: (d, ccy) =>
      `The operator fee deducted from this settlement (${fmtMoney(d.amount, ccy)}) does not match the contracted rate in the institution's fee schedule. ` +
      `This may indicate a fee revision by the operator, a billing error, or a contract compliance issue.`,
    action:
      "1. Compare the deducted fee against the current operator fee schedule in the institution's contract. " +
      "2. If the fee exceeds the contracted rate, raise a formal dispute with the operator. " +
      "3. Post the variance to a fee dispute suspense account pending resolution. " +
      "4. If the fee revision is legitimate, update the institution's fee schedule and notify Finance.",
  },
  // ── Uganda-specific categories ──────────────────────────────────────────────
  mm_wallet_to_bank_failed: {
    confidence: 91,
    explain: (d, ccy) =>
      `The operator's settlement statement shows a wallet-to-bank transfer of ${fmtMoney(d.amount, ccy)} that has no matching credit in the institution's ledger. ` +
      `The customer's mobile money wallet was debited but the bank account was never credited — the most common mobile money exception in Ugandan institutions. ` +
      `Under the Uganda NPS Act 2020 the institution and operator share an error-resolution obligation to the customer.`,
    action:
      "1. Verify the transaction ID (MTN Financial Transaction ID / Airtel Money ID) in the operator's merchant portal. " +
      "2. If the wallet debit is confirmed and no bank credit was posted, post the credit to the customer's account from the operator settlement suspense GL. " +
      "3. If the operator marked the transaction failed, confirm the customer's wallet was auto-refunded; if not, escalate to the operator's reconciliation desk. " +
      "4. Log the resolution for the Bank of Uganda consumer-protection audit trail.",
  },
  mm_bank_to_wallet_failed: {
    confidence: 90,
    explain: (d, ccy) =>
      `The institution's ledger shows a debit of ${fmtMoney(d.amount, ccy)} for a bank-to-wallet push that does not appear in the operator's settlement statement. ` +
      `The customer's bank account was debited but the mobile money wallet was never credited. ` +
      `The institution is holding funds that belong to the customer or must be reversed.`,
    action:
      "1. Check the operator API/portal for the transfer status — pending, failed, or absent. " +
      "2. If the transfer failed at the operator, reverse the ledger debit to the customer's account within T+1 business day. " +
      "3. If the transfer is pending beyond the operator's SLA, escalate to the operator's settlement team with the transaction reference. " +
      "4. Record the outcome per the Uganda NPS Act 2020 error-resolution requirements.",
  },
  mm_withdrawal_tax_variance: {
    confidence: 88,
    explain: (d, ccy) =>
      `A settlement variance of ${fmtMoney(d.amount, ccy)} matches the profile of Uganda's 0.5% excise duty on mobile money withdrawals. ` +
      `The operator remits withdrawal amounts net of the levy, so a ledger that books gross amounts will show a persistent ~0.5% shortfall on withdrawal flows.`,
    action:
      "1. Confirm the variance equals 0.5% of the gross withdrawal amount for the affected transactions. " +
      "2. If confirmed, post the variance to the mobile money tax expense/payable GL — this is a statutory deduction, not an operator error. " +
      "3. Verify the operator's tax remittance statement matches the deductions taken. " +
      "4. If the variance does not equal the statutory rate, treat it as an operator fee dispute and escalate.",
  },
  mm_momo_settlement_shortfall: {
    confidence: 89,
    explain: (d, ccy) =>
      `The net mobile money settlement received is short by ${fmtMoney(d.amount, ccy)} against the gross sum of transactions in the operator's statement. ` +
      `Common causes are operator fees, the 0.5% withdrawal levy (Uganda), failed-transaction netting, or a settlement-cycle timing difference. ` +
      `For Ugandan e-money flows, BoU regulations require the trust account position to be reconciled against e-money liabilities daily.`,
    action:
      "1. Obtain the operator's settlement advice/invoice for this cycle and itemise fees, taxes, and netted reversals. " +
      "2. Attribute the shortfall line-by-line; post legitimate fees and levies to their GLs. " +
      "3. If a residual shortfall remains unattributed, raise a formal query with the operator's settlement team within 2 business days. " +
      "4. Update the daily trust-account reconciliation record to keep the BoU compliance position current.",
  },
};

// ─── Layer 2 — Mobile Money Exception Classification ─────────────────────────

/**
 * True when an amount difference matches Uganda's 0.5% mobile money
 * withdrawal levy profile (within a small tolerance).
 */
export function isWithdrawalTaxVariance(diff: number, baseAmount: number): boolean {
  if (baseAmount <= 0 || diff <= 0) return false;
  const expected = baseAmount * 0.005;
  return Math.abs(diff - expected) <= Math.max(1, baseAmount * 0.0005);
}

/**
 * Classify exceptions from a mobile money reconciliation run.
 * Uses the same amount-matching logic as poc-engine.ts but with
 * jurisdiction-aware (Nigeria/Uganda) category assignment.
 */
export function runMmLayer2(
  ledger: CanonicalRow[],
  settlement: CanonicalRow[],
  operator: MmOperator,
  amountTolerance = 0.005,
): MmExceptionDraft[] {
  const exceptions: MmExceptionDraft[] = [];
  const isUg = OPERATOR_META[operator].country === "UG";
  const ccy = OPERATOR_META[operator].currency;

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

  // Pass 1: Match by reference (session ID / transaction ID). A shared
  // reference means the same underlying transaction, so the pair is always
  // consumed here — any amount difference becomes ONE amount-level exception
  // (or Uganda's statutory withdrawal levy) instead of two phantom
  // missing-transaction exceptions.
  for (const [ref, sRows] of Array.from(settlementByRef.entries())) {
    const lRows = ledgerByRef.get(ref);
    if (!lRows || lRows.length === 0) continue;

    const sRow = sRows[0];
    let best = lRows[0];
    let bestDiff = Math.abs(sRow.amount - best.amount);
    for (const lRow of lRows) {
      const d = Math.abs(sRow.amount - lRow.amount);
      if (d < bestDiff) { best = lRow; bestDiff = d; }
    }

    if (bestDiff >= 0.01) {
      // Uganda: a ~0.5% difference is the statutory withdrawal levy, not a
      // generic mismatch — classify it so the diagnosis (and the learning
      // flywheel) treat it as a tax posting, not a dispute.
      const category: MmExceptionCategory =
        isUg && isWithdrawalTaxVariance(bestDiff, Math.max(sRow.amount, best.amount))
          ? "mm_withdrawal_tax_variance"
          : "mm_amount_mismatch";
      exceptions.push({
        category,
        side: "settlement",
        amount: bestDiff,
        txnDate: sRow.date,
        reference: ref,
        sessionId: ref,
        description: `Settlement: ${fmtMoney(sRow.amount, ccy)}, Ledger: ${fmtMoney(best.amount, ccy)}, Diff: ${fmtMoney(bestDiff, ccy)}`,
        reversalStatus: null,
      });
    }
    matchedLedgerRefs.add(ref);
    matchedSettlementRefs.add(ref);
  }

  // Pass 2: Unmatched settlement rows → classify by jurisdiction and description
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
  const isUg = OPERATOR_META[operator].country === "UG";
  if (/reversal|reverse|refund/i.test(desc)) return "mm_reversal_not_credited";
  if (/tax|levy|excise/i.test(desc)) {
    if (isUg) return "mm_withdrawal_tax_variance";
    return "mm_operator_fee_variance";
  }
  if (/fee|charge|commission/i.test(desc)) return "mm_operator_fee_variance";
  if (isUg) {
    // Operator settled a transfer the ledger never posted: the customer's
    // wallet moved but the bank side is missing.
    return "mm_wallet_to_bank_failed";
  }
  if (/nip|inflow|inward/i.test(desc)) return "mm_unmatched_nip_inflow";
  if (/timeout|expired|session/i.test(desc)) return "mm_expired_session_debit";
  // Default for unmatched settlement items: institution received funds not in ledger
  return "mm_unmatched_nip_inflow";
}

function classifyUnmatchedLedger(desc: string, operator: MmOperator): MmExceptionCategory {
  const isUg = OPERATOR_META[operator].country === "UG";
  if (/reversal|reverse|refund/i.test(desc)) return "mm_reversal_not_credited";
  if (isUg) {
    if (/tax|levy|excise/i.test(desc)) return "mm_withdrawal_tax_variance";
    // Ledger posted a push-to-wallet the operator never settled.
    return "mm_bank_to_wallet_failed";
  }
  if (/timeout|expired|session/i.test(desc)) return "mm_expired_session_debit";
  if (/ussd|debit/i.test(desc)) return "mm_failed_ussd_debit";
  // Default for unmatched ledger items: customer debited, institution not credited
  return "mm_failed_ussd_debit";
}

// ─── Layer 1 → Layer 2 bridge: settlement shortfall detection ────────────────

/**
 * Emit a run-level shortfall exception when the settlement net is materially
 * below the ledger net. This is the code path for mm_nip_settlement_shortfall
 * (Nigeria/NIP) and mm_momo_settlement_shortfall (all other operators);
 * for Ugandan operators a shortfall matching the 0.5% levy profile is
 * classified as mm_withdrawal_tax_variance instead.
 */
export function detectSettlementShortfall(
  layer1: Layer1Result,
  operator: MmOperator,
): MmExceptionDraft | null {
  // runLayer1: varianceAmount = ledgerNet - statementNet.
  // Positive variance beyond 1 currency unit = settlement received short.
  const shortfall = layer1.varianceAmount;
  if (shortfall < 1) return null;

  const meta = OPERATOR_META[operator];
  let category: MmExceptionCategory;
  if (meta.country === "UG" && isWithdrawalTaxVariance(shortfall, Math.abs(layer1.statementCredits))) {
    category = "mm_withdrawal_tax_variance";
  } else if (operator === "nip") {
    category = "mm_nip_settlement_shortfall";
  } else {
    category = "mm_momo_settlement_shortfall";
  }

  return {
    category,
    side: "settlement",
    amount: shortfall,
    txnDate: "",
    reference: null,
    sessionId: null,
    description:
      `Run-level shortfall: settlement net ${fmtMoney(layer1.statementNet, meta.currency)} vs ` +
      `ledger net ${fmtMoney(layer1.ledgerNet, meta.currency)} (${layer1.statementCount} settlement rows, ${layer1.ledgerCount} ledger rows)`,
    reversalStatus: null,
  };
}

// ─── Layer 3 — AI Agent Diagnosis ────────────────────────────────────────────

export interface MmLayer3Item extends MmExceptionDraft {
  agentExplanation: string;
  recommendedAction: string;
  cbnRuleReference: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  agentConfidence: number;
}

export function runMmLayer3(exceptions: MmExceptionDraft[], operator: MmOperator): MmLayer3Item[] {
  const ccy = OPERATOR_META[operator].currency;
  return exceptions.map((d) => {
    const info = CATEGORY_INFO[d.category] ?? {
      confidence: 75,
      explain: (ex: MmExceptionDraft, c: string) =>
        `A mobile money exception of type '${ex.category}' was detected for ${fmtMoney(ex.amount, c)}. Manual review is required.`,
      action: "Review this exception manually and determine the appropriate corrective action.",
    };
    return {
      ...d,
      agentExplanation: info.explain(d, ccy),
      recommendedAction: info.action,
      cbnRuleReference: REG_REFS[d.category] ?? (OPERATOR_META[operator].country === "UG" ? "Uganda NPS Act 2020" : "CBN Mobile Money Framework 2021"),
      priorityLevel: priorityFor(d.amount, ccy),
      agentConfidence: info.confidence,
    };
  });
}

// ─── Per-Institution Learning (POC-scoped flywheel) ──────────────────────────

export interface CategoryResolutionStats {
  category: string;
  actioned: number;                       // resolutions with any terminal status
  resolved: number;
  escalated: number;
  topActionClass: string | null;          // most common resolution action class
}

/**
 * Pure aggregation of an institution's past exception reviews, grouped by
 * category. Exported separately so the learning logic is unit-testable
 * without a database.
 */
export function summarizeResolutionHistory(
  rows: Array<{ category: string; reviewStatus: string; reviewNote: string | null }>,
  classifyAction: (note: string | null | undefined) => string,
): Map<string, CategoryResolutionStats> {
  const stats = new Map<string, CategoryResolutionStats>();
  const actionCounts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.reviewStatus === "OPEN") continue;
    let s = stats.get(row.category);
    if (!s) {
      s = { category: row.category, actioned: 0, resolved: 0, escalated: 0, topActionClass: null };
      stats.set(row.category, s);
    }
    s.actioned += 1;
    if (row.reviewStatus === "RESOLVED") s.resolved += 1;
    if (row.reviewStatus === "ESCALATED") s.escalated += 1;

    const cls = classifyAction(row.reviewNote);
    let counts = actionCounts.get(row.category);
    if (!counts) {
      counts = new Map();
      actionCounts.set(row.category, counts);
    }
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }

  for (const [category, counts] of Array.from(actionCounts.entries())) {
    let top: string | null = null;
    let topCount = 0;
    for (const [cls, count] of Array.from(counts.entries())) {
      if (count > topCount) { top = cls; topCount = count; }
    }
    const s = stats.get(category);
    if (s) s.topActionClass = top;
  }

  return stats;
}

/**
 * Enrich Layer-3 diagnoses with the institution's own resolution history:
 * cite how many similar exceptions were previously actioned, the dominant
 * resolution approach, and raise confidence with corroborating history.
 * This is the per-institution learning flywheel for POC-scoped runs.
 */
export async function applyInstitutionalLearning(
  pocKey: string,
  items: MmLayer3Item[],
): Promise<{ items: MmLayer3Item[]; learningApplied: number }> {
  if (items.length === 0) return { items, learningApplied: 0 };

  let history: Array<{ category: string; reviewStatus: string; reviewNote: string | null }> = [];
  try {
    const db = await getDatabase();
    history = await db
      .select({
        category: mmExceptions.category,
        reviewStatus: mmExceptions.reviewStatus,
        reviewNote: mmExceptions.reviewNote,
      })
      .from(mmExceptions)
      .where(and(eq(mmExceptions.pocKey, pocKey), ne(mmExceptions.reviewStatus, "OPEN")))
      .orderBy(desc(mmExceptions.createdAt))
      .limit(500);
  } catch {
    return { items, learningApplied: 0 }; // learning is best-effort, never fails the run
  }
  if (history.length === 0) return { items, learningApplied: 0 };

  const ei = await import("./exceptionIntelligence");
  const stats = summarizeResolutionHistory(history, ei.classifyResolutionAction);

  let learningApplied = 0;
  const enriched = items.map((item) => {
    const s = stats.get(item.category);
    if (!s || s.actioned === 0) return item;
    learningApplied += 1;
    const approach = s.topActionClass && s.topActionClass !== "other"
      ? ` Most common resolution approach: ${s.topActionClass.replace(/_/g, " ")}.`
      : "";
    return {
      ...item,
      agentExplanation:
        item.agentExplanation +
        `\n\nInstitutional memory: this institution has previously actioned ${s.actioned} similar ` +
        `exception${s.actioned === 1 ? "" : "s"} in this category (${s.resolved} resolved, ${s.escalated} escalated).${approach}`,
      agentConfidence: Math.min(98, item.agentConfidence + Math.min(6, s.actioned)),
    };
  });

  return { items: enriched, learningApplied };
}

// ─── AI Summary (async — calls LLM) ──────────────────────────────────────────

export async function generateMmAiSummary(params: {
  operator: MmOperator;
  layer1: Layer1Result;
  exceptions: MmLayer3Item[];
}): Promise<string> {
  const { operator, layer1, exceptions } = params;
  const meta = OPERATOR_META[operator];
  const ccy = meta.currency;
  const topExceptions = exceptions.slice(0, 10);

  const jurisdictionContext = meta.country === "UG"
    ? `You are a Ugandan banking reconciliation specialist reviewing a ${meta.label} mobile money settlement reconciliation. ` +
      `Reference the Bank of Uganda National Payment Systems Act 2020, the NPS (E-Money) Regulations 2021 trust-account reconciliation requirement, ` +
      `and the 0.5% excise duty on mobile money withdrawals where relevant.`
    : `You are a Nigerian banking reconciliation specialist reviewing a ${meta.label} mobile money settlement reconciliation. ` +
      `Reference CBN Mobile Money Framework 2021 and NIBSS NIP Operating Rules where relevant.`;

  const prompt = `${jurisdictionContext}

LAYER 1 — BALANCE:
- Settlement total: ${fmtMoney(layer1.statementNet, ccy)}
- Ledger total: ${fmtMoney(layer1.ledgerNet, ccy)}
- Variance: ${fmtMoney(layer1.varianceAmount, ccy)}
- Status: ${layer1.status}

LAYER 2 — EXCEPTIONS (${exceptions.length} total, showing top ${topExceptions.length}):
${topExceptions.map((e, i) => `${i + 1}. [${e.category}] ${fmtMoney(e.amount, ccy)} — ${e.description ?? "No description"}`).join("\n")}

Write a concise 3-paragraph executive summary for the institution's Operations Manager:
1. Overall reconciliation health and variance explanation
2. The most critical exceptions and their business impact (reference the applicable regulations)
3. Immediate actions required and timeline

Be specific, cite amounts, and use plain language. Do not use bullet points.`;

  try {
    const msgs: Message[] = [
      {
        role: "system",
        content: meta.country === "UG"
          ? "You are a Ugandan banking reconciliation specialist. Write clear, actionable summaries for operations teams."
          : "You are a Nigerian banking reconciliation specialist. Write clear, actionable summaries for operations teams.",
      },
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
  currency: string;
  layer1: Layer1Result;
  matchedCount: number;
  exceptionCount: number;
  layer3: MmLayer3Item[];
  aiSummary: string;
  learningApplied: number;
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
  // Currency: file-detected first, else the operator's jurisdiction default.
  const currency = settlementResult.currency || ledgerResult.currency || OPERATOR_META[operator].currency;

  // Layer 1 — Balance
  const layer1 = runLayer1(ledger, settlement, currency);

  // Layer 2 — Exception classification (+ run-level shortfall from Layer 1)
  const exceptionDrafts = runMmLayer2(ledger, settlement, operator);
  const shortfall = detectSettlementShortfall(layer1, operator);
  if (shortfall) exceptionDrafts.push(shortfall);

  // Layer 3 — AI agent diagnosis, enriched with per-institution learning
  const baseLayer3 = runMmLayer3(exceptionDrafts, operator);
  const { items: layer3, learningApplied } = await applyInstitutionalLearning(pocKey, baseLayer3);

  // AI summary
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

  const matchedCount = Math.max(0, settlement.length + ledger.length - layer3.length);

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
    matchedCount,
    exceptionCount: layer3.length,
    matchRate: layer3.length === 0
      ? "100.00"
      : String(((1 - Math.min(1, layer3.length / Math.max(settlement.length, ledger.length, 1))) * 100).toFixed(2)),
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
    currency,
    layer1,
    matchedCount,
    exceptionCount: layer3.length,
    layer3,
    aiSummary,
    learningApplied,
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

/**
 * Update an exception's review status. Every non-OPEN status becomes part of
 * the institution's resolution history, which applyInstitutionalLearning
 * feeds back into future diagnoses — resolving exceptions here IS the
 * flywheel write-path for POC-scoped runs.
 */
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
