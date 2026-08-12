/**
 * SuperAgentEngine — Layer 2–5 of the ReconcileAI Super Agent Architecture
 *
 * This module extends (not replaces) the existing reconciliationEngine.ts with:
 *   Layer 2: Many-to-Many Matching (Pass 4 — runs after the existing 3-pass engine)
 *   Layer 2b: Semantic Reference Parser (understands "INV-2847 less dmg" etc.)
 *   Layer 2c: FX Variance Handler (bank fee deductions as valid matches)
 *   Layer 3: Categorical Exception Classifier (12 categories + LLM diagnosis)
 *   Layer 4: Action Draft Generator (vendor email / credit note / journal entry / payment allocation)
 *   Layer 5: Semantic Memory Layer (text-similarity retrieval of past reasoning)
 *
 * The existing runMatchingEngine() in reconciliationEngine.ts is called first.
 * This module then processes the remaining unmatched transactions.
 */

import { invokeLLM } from "./_core/llm";
import { nigerianExceptionsTaxonomyPromptBlock } from "./exceptions/seed";
import { relevantNigerianChannels } from "./exceptions/channelMapping";

// ─── Shared Transaction type (mirrors drizzle schema) ────────────────

export interface SATransaction {
  id: number;
  transactionRef: string | null;
  description: string | null;
  counterparty: string | null;
  amount: string | number;
  currency: string;
  transactionDate: string | Date;
  channelId: number;
  /**
   * `channels.channelType` for `channelId`, when the caller has it.
   *
   * Optional so existing callers keep working, but supplying it is what lets the
   * Super Agent pick its exception-taxonomy slice from the channel a transaction
   * actually arrived on instead of guessing from the description. Bank
   * settlement files rarely say "POS" or "NIP" in prose, so the text heuristic
   * alone matched nothing and the catalogue silently went uninjected. See
   * server/exceptions/channelMapping.ts.
   */
  channelType?: string | null;
  debitCredit: string;
  isReversal?: boolean | null;
  originalTransactionRef?: string | null;
}

// ─── Layer 2: Semantic Reference Parser ──────────────────────────────

export interface ParsedReference {
  invoiceNumbers: string[];           // ["INV-2847", "ORD-2847"]
  deductionType: "damage" | "promotional" | "bank_fee" | "tax" | "discount" | "none";
  deductionKeywords: string[];        // ["dmg", "promo", "bank charge"]
  deductionAmount: number | null;     // explicit deduction amount if stated
  isPartialPayment: boolean;
  isSplitPayment: boolean;
  rawRef: string;
}

const DEDUCTION_PATTERNS: Array<{ pattern: RegExp; type: ParsedReference["deductionType"]; keywords: string[] }> = [
  { pattern: /\b(dmg|damage|damaged|dam)\b/i, type: "damage", keywords: ["damage"] },
  { pattern: /\b(promo|promotional|disc|discount|rebate|allowance)\b/i, type: "promotional", keywords: ["promo"] },
  { pattern: /\b(bank\s*ch?arge|bank\s*fee|chg|chrg|transfer\s*fee|wire\s*fee)\b/i, type: "bank_fee", keywords: ["bank fee"] },
  { pattern: /\b(vat|tax|withholding|wht|stamp\s*duty)\b/i, type: "tax", keywords: ["tax"] },
  { pattern: /\b(less|minus|deduct|net\s*of)\b/i, type: "discount", keywords: ["deduction"] },
];

const INVOICE_PATTERN = /\b(INV|ORD|PO|REF|TXN|PMT|REC|SIN|SINV|PINV)[-\s]?(\d{3,10})\b/gi;
const SPLIT_KEYWORDS = /\b(split|part|partial|installment|instalment|tranche|1\s*of\s*\d|2\s*of\s*\d)\b/i;
const AMOUNT_IN_REF = /\b(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/g;

export function parseReference(ref: string | null | undefined, description: string | null | undefined): ParsedReference {
  const raw = `${ref || ""} ${description || ""}`.trim();

  // Extract invoice numbers
  const invoiceNumbers: string[] = [];
  let m: RegExpExecArray | null;
  const invRe = new RegExp(INVOICE_PATTERN.source, "gi");
  while ((m = invRe.exec(raw)) !== null) {
    invoiceNumbers.push(m[0].toUpperCase().replace(/\s/, "-"));
  }

  // Detect deduction type
  let deductionType: ParsedReference["deductionType"] = "none";
  const deductionKeywords: string[] = [];
  for (const dp of DEDUCTION_PATTERNS) {
    if (dp.pattern.test(raw)) {
      deductionType = dp.type;
      deductionKeywords.push(...dp.keywords);
    }
  }

  // Try to extract explicit deduction amount (e.g. "less 1,500" or "minus 2500.00")
  let deductionAmount: number | null = null;
  const lessMatch = raw.match(/(?:less|minus|deduct(?:ion)?|net\s*of)\s+(?:NGN|USD|GHS|KES|ZAR|₦)?\s*([\d,]+(?:\.\d{2})?)/i);
  if (lessMatch) {
    deductionAmount = parseFloat(lessMatch[1].replace(/,/g, ""));
  }

  const isPartialPayment = /\b(partial|part\s*pay|instalment|installment|balance)\b/i.test(raw);
  const isSplitPayment = SPLIT_KEYWORDS.test(raw);

  return {
    invoiceNumbers,
    deductionType,
    deductionKeywords,
    deductionAmount,
    isPartialPayment,
    isSplitPayment,
    rawRef: raw,
  };
}

// ─── Layer 2c: FX Variance / Bank Fee Handler ─────────────────────────

export interface FXVarianceResult {
  isValidMatch: boolean;
  varianceType: "bank_fee_flat" | "bank_fee_percentage" | "fx_rounding" | "vat_deduction" | "none";
  varianceAmount: number;
  variancePercent: number;
  explanation: string;
}

// Common Nigerian/African bank fee structures
const BANK_FEE_FLAT_AMOUNTS = [50, 100, 150, 200, 250, 500, 750, 1000, 1500, 2000]; // NGN
const BANK_FEE_MAX_PERCENT = 0.015; // 1.5% — CBN cap on transfer fees
const FX_ROUNDING_MAX_PERCENT = 0.001; // 0.1% — pure rounding

export function checkFXVariance(
  sourceAmount: number,
  targetAmount: number,
  currency: string
): FXVarianceResult {
  const diff = Math.abs(sourceAmount - targetAmount);
  const diffPct = diff / Math.max(sourceAmount, targetAmount);

  if (diff === 0) {
    return { isValidMatch: true, varianceType: "none", varianceAmount: 0, variancePercent: 0, explanation: "Exact match" };
  }

  // Check FX rounding (< 0.1%)
  if (diffPct <= FX_ROUNDING_MAX_PERCENT) {
    return {
      isValidMatch: true,
      varianceType: "fx_rounding",
      varianceAmount: diff,
      variancePercent: diffPct * 100,
      explanation: `FX rounding difference of ${currency} ${diff.toFixed(2)} (${(diffPct * 100).toFixed(3)}%) — within rounding tolerance`,
    };
  }

  // Check flat bank fee (NGN-denominated)
  if (currency === "NGN" || currency === "₦") {
    for (const fee of BANK_FEE_FLAT_AMOUNTS) {
      if (Math.abs(diff - fee) < 1) {
        return {
          isValidMatch: true,
          varianceType: "bank_fee_flat",
          varianceAmount: diff,
          variancePercent: diffPct * 100,
          explanation: `Bank transfer fee of ₦${fee.toLocaleString()} deducted — consistent with CBN-regulated NIP/NIBSS transfer charges`,
        };
      }
    }
  }

  // Check percentage-based bank fee (≤ 1.5%)
  if (diffPct <= BANK_FEE_MAX_PERCENT) {
    return {
      isValidMatch: true,
      varianceType: "bank_fee_percentage",
      varianceAmount: diff,
      variancePercent: diffPct * 100,
      explanation: `Bank fee deduction of ${currency} ${diff.toFixed(2)} (${(diffPct * 100).toFixed(2)}%) — within CBN-regulated transfer fee cap of 1.5%`,
    };
  }

  // Check VAT on bank fee (7.5% of a flat fee)
  const vatOnFee = diff * (1 + 0.075);
  for (const fee of BANK_FEE_FLAT_AMOUNTS) {
    if (Math.abs(vatOnFee - fee) < 5) {
      return {
        isValidMatch: true,
        varianceType: "vat_deduction",
        varianceAmount: diff,
        variancePercent: diffPct * 100,
        explanation: `Bank fee + VAT deduction of ${currency} ${diff.toFixed(2)} — consistent with 7.5% VAT on NIP transfer charge`,
      };
    }
  }

  return {
    isValidMatch: false,
    varianceType: "none",
    varianceAmount: diff,
    variancePercent: diffPct * 100,
    explanation: `Amount variance of ${currency} ${diff.toFixed(2)} (${(diffPct * 100).toFixed(2)}%) exceeds all known bank fee and FX rounding thresholds`,
  };
}

// ─── Layer 2: Many-to-Many Matching ──────────────────────────────────

export interface M2MMatch {
  sourceIds: number[];          // one or more source transactions
  targetIds: number[];          // one or more target transactions
  matchType: "one_to_many" | "many_to_one" | "many_to_many";
  confidenceScore: number;
  totalSourceAmount: number;
  totalTargetAmount: number;
  amountDifference: number;
  fxVariance: FXVarianceResult | null;
  parsedRef: ParsedReference | null;
  matchReason: string;
  splitAllocation: SplitAllocation[];
}

export interface SplitAllocation {
  sourceId: number;
  targetId: number;
  allocatedAmount: number;
  allocationPercent: number;
  invoiceRef: string | null;
}

function normalizeStr(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function amtKey(n: number): string {
  return n.toFixed(2);
}

/**
 * Pass 4: Many-to-Many Matching
 *
 * Strategy:
 * 1. One-to-many: one source payment that equals the sum of N target invoices
 * 2. Many-to-one: N source payments that sum to one target invoice
 * 3. Semantic grouping: group by shared invoice number in reference
 *
 * This runs AFTER the existing 3-pass engine, on the remaining unmatched transactions.
 */
export function runM2MMatching(
  unmatchedSources: SATransaction[],
  unmatchedTargets: SATransaction[],
  fxTolerance: number = 0.015
): { m2mMatches: M2MMatch[]; remainingSourceIds: number[]; remainingTargetIds: number[] } {
  const matchedSourceIds = new Set<number>();
  const matchedTargetIds = new Set<number>();
  const m2mMatches: M2MMatch[] = [];

  // ── Strategy 1: One source → many targets (sum matching) ─────────
  for (const src of unmatchedSources) {
    if (matchedSourceIds.has(src.id)) continue;
    const srcAmt = parseFloat(String(src.amount));
    const srcParsed = parseReference(src.transactionRef, src.description);

    // Try all combinations of 2–5 unmatched targets that sum to srcAmt
    const availableTargets = unmatchedTargets.filter((t) => !matchedTargetIds.has(t.id));
    const found = findSubsetSum(availableTargets, srcAmt, fxTolerance, 5);

    if (found) {
      const targetAmtTotal = found.reduce((s, t) => s + parseFloat(String(t.amount)), 0);
      const diff = Math.abs(srcAmt - targetAmtTotal);
      const diffPct = diff / srcAmt;
      const fxCheck = checkFXVariance(srcAmt, targetAmtTotal, src.currency);

      const allocation: SplitAllocation[] = found.map((t, i) => ({
        sourceId: src.id,
        targetId: t.id,
        allocatedAmount: parseFloat(String(t.amount)),
        allocationPercent: Math.round((parseFloat(String(t.amount)) / srcAmt) * 10000) / 100,
        invoiceRef: t.transactionRef,
      }));

      m2mMatches.push({
        sourceIds: [src.id],
        targetIds: found.map((t) => t.id),
        matchType: "one_to_many",
        confidenceScore: Math.round((1 - diffPct) * 85 + (srcParsed.invoiceNumbers.length > 0 ? 10 : 0)),
        totalSourceAmount: srcAmt,
        totalTargetAmount: targetAmtTotal,
        amountDifference: diff,
        fxVariance: fxCheck.varianceType !== "none" ? fxCheck : null,
        parsedRef: srcParsed,
        matchReason: `One-to-many: single payment of ${src.currency} ${srcAmt.toLocaleString()} matches ${found.length} invoices totalling ${src.currency} ${targetAmtTotal.toLocaleString()}${fxCheck.isValidMatch && diff > 0 ? ` (${fxCheck.explanation})` : ""}`,
        splitAllocation: allocation,
      });

      matchedSourceIds.add(src.id);
      found.forEach((t) => matchedTargetIds.add(t.id));
    }
  }

  // ── Strategy 2: Many sources → one target (aggregation matching) ──
  for (const tgt of unmatchedTargets) {
    if (matchedTargetIds.has(tgt.id)) continue;
    const tgtAmt = parseFloat(String(tgt.amount));

    const availableSources = unmatchedSources.filter((s) => !matchedSourceIds.has(s.id));
    const found = findSubsetSum(availableSources, tgtAmt, fxTolerance, 5);

    if (found && found.length > 1) {
      const sourceAmtTotal = found.reduce((s, t) => s + parseFloat(String(t.amount)), 0);
      const diff = Math.abs(tgtAmt - sourceAmtTotal);
      const diffPct = diff / tgtAmt;
      const fxCheck = checkFXVariance(sourceAmtTotal, tgtAmt, tgt.currency);

      const allocation: SplitAllocation[] = found.map((s) => ({
        sourceId: s.id,
        targetId: tgt.id,
        allocatedAmount: parseFloat(String(s.amount)),
        allocationPercent: Math.round((parseFloat(String(s.amount)) / tgtAmt) * 10000) / 100,
        invoiceRef: s.transactionRef,
      }));

      m2mMatches.push({
        sourceIds: found.map((s) => s.id),
        targetIds: [tgt.id],
        matchType: "many_to_one",
        confidenceScore: Math.round((1 - diffPct) * 82),
        totalSourceAmount: sourceAmtTotal,
        totalTargetAmount: tgtAmt,
        amountDifference: diff,
        fxVariance: fxCheck.varianceType !== "none" ? fxCheck : null,
        parsedRef: null,
        matchReason: `Many-to-one: ${found.length} payments totalling ${tgt.currency} ${sourceAmtTotal.toLocaleString()} match invoice of ${tgt.currency} ${tgtAmt.toLocaleString()}`,
        splitAllocation: allocation,
      });

      found.forEach((s) => matchedSourceIds.add(s.id));
      matchedTargetIds.add(tgt.id);
    }
  }

  // ── Strategy 3: Invoice-number grouping ───────────────────────────
  // Group sources and targets by shared invoice number in reference
  const invoiceGroups = new Map<string, { sources: SATransaction[]; targets: SATransaction[] }>();

  for (const src of unmatchedSources) {
    if (matchedSourceIds.has(src.id)) continue;
    const parsed = parseReference(src.transactionRef, src.description);
    for (const inv of parsed.invoiceNumbers) {
      const g = invoiceGroups.get(inv) || { sources: [], targets: [] };
      g.sources.push(src);
      invoiceGroups.set(inv, g);
    }
  }

  for (const tgt of unmatchedTargets) {
    if (matchedTargetIds.has(tgt.id)) continue;
    const parsed = parseReference(tgt.transactionRef, tgt.description);
    for (const inv of parsed.invoiceNumbers) {
      const g = invoiceGroups.get(inv) || { sources: [], targets: [] };
      g.targets.push(tgt);
      invoiceGroups.set(inv, g);
    }
  }

  invoiceGroups.forEach((group, invNum) => {
    if (group.sources.length === 0 || group.targets.length === 0) return;
    const srcIds: number[] = group.sources.map((s: SATransaction) => s.id).filter((id: number) => !matchedSourceIds.has(id));
    const tgtIds: number[] = group.targets.map((t: SATransaction) => t.id).filter((id: number) => !matchedTargetIds.has(id));
    if (srcIds.length === 0 || tgtIds.length === 0) return;

    const srcTotal = group.sources.filter((s: SATransaction) => srcIds.includes(s.id)).reduce((sum: number, s: SATransaction) => sum + parseFloat(String(s.amount)), 0);
    const tgtTotal = group.targets.filter((t: SATransaction) => tgtIds.includes(t.id)).reduce((sum: number, t: SATransaction) => sum + parseFloat(String(t.amount)), 0);
    const diff = Math.abs(srcTotal - tgtTotal);
    const diffPct = diff / Math.max(srcTotal, tgtTotal);

    if (diffPct <= fxTolerance * 2) {
      const allocation: SplitAllocation[] = srcIds.map((sid: number) => ({
        sourceId: sid,
        targetId: tgtIds[0],
        allocatedAmount: parseFloat(String(group.sources.find((s: SATransaction) => s.id === sid)?.amount || 0)),
        allocationPercent: Math.round((parseFloat(String(group.sources.find((s: SATransaction) => s.id === sid)?.amount || 0)) / srcTotal) * 10000) / 100,
        invoiceRef: invNum,
      }));

      m2mMatches.push({
        sourceIds: srcIds,
        targetIds: tgtIds,
        matchType: "many_to_many",
        confidenceScore: Math.round(88 - diffPct * 100),
        totalSourceAmount: srcTotal,
        totalTargetAmount: tgtTotal,
        amountDifference: diff,
        fxVariance: null,
        parsedRef: parseReference(group.sources[0].transactionRef, group.sources[0].description),
        matchReason: `Invoice grouping: ${srcIds.length} source(s) and ${tgtIds.length} target(s) share invoice reference ${invNum}`,
        splitAllocation: allocation,
      });

      srcIds.forEach((id: number) => matchedSourceIds.add(id));
      tgtIds.forEach((id: number) => matchedTargetIds.add(id));
    }
  });

  const remainingSourceIds = unmatchedSources.filter((s) => !matchedSourceIds.has(s.id)).map((s) => s.id);
  const remainingTargetIds = unmatchedTargets.filter((t) => !matchedTargetIds.has(t.id)).map((t) => t.id);

  return { m2mMatches, remainingSourceIds, remainingTargetIds };
}

/**
 * Subset-sum finder: find a combination of transactions that sums to targetAmount ± tolerance.
 * Uses dynamic programming for small sets (≤ 20), greedy for larger sets.
 * Limited to maxItems to prevent combinatorial explosion.
 */
function findSubsetSum(
  txns: SATransaction[],
  targetAmount: number,
  tolerancePct: number,
  maxItems: number
): SATransaction[] | null {
  const tolerance = targetAmount * tolerancePct;
  const lo = targetAmount - tolerance;
  const hi = targetAmount + tolerance;

  // Sort by amount descending for greedy efficiency
  const sorted = [...txns].sort((a, b) => parseFloat(String(b.amount)) - parseFloat(String(a.amount)));

  // Greedy first pass: try largest items first
  let greedySum = 0;
  const greedySet: SATransaction[] = [];
  for (const t of sorted) {
    const amt = parseFloat(String(t.amount));
    if (greedySum + amt <= hi && greedySet.length < maxItems) {
      greedySum += amt;
      greedySet.push(t);
      if (greedySum >= lo) return greedySet;
    }
  }

  // Exhaustive search for small sets (≤ 15 items, ≤ 4 combinations)
  if (txns.length <= 15) {
    for (let size = 2; size <= Math.min(maxItems, 4); size++) {
      const result = combinationSearch(sorted, targetAmount, lo, hi, size);
      if (result) return result;
    }
  }

  return null;
}

function combinationSearch(
  txns: SATransaction[],
  target: number,
  lo: number,
  hi: number,
  size: number
): SATransaction[] | null {
  function search(start: number, current: SATransaction[], currentSum: number): SATransaction[] | null {
    if (current.length === size) {
      return currentSum >= lo && currentSum <= hi ? [...current] : null;
    }
    for (let i = start; i < txns.length; i++) {
      const amt = parseFloat(String(txns[i].amount));
      const newSum = currentSum + amt;
      if (newSum > hi) continue; // pruning
      current.push(txns[i]);
      const result = search(i + 1, current, newSum);
      if (result) return result;
      current.pop();
    }
    return null;
  }
  return search(0, [], 0);
}

// ─── Layer 3: Categorical Exception Classifier ────────────────────────

export type ExceptionCategory =
  | "partial_payment"
  | "promotional_deduction"
  | "damage_deduction"
  | "bank_fee_deduction"
  | "tax_deduction"
  | "split_payment"
  | "fx_variance"
  | "timing_difference"
  | "missing_counterparty"
  | "duplicate_invoice"
  | "contra_entry"
  | "unmatched_reversal"
  | "currency_mismatch"
  | "unmatched";

export interface ExceptionDiagnosis {
  category: ExceptionCategory;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;                  // 0–100
  headline: string;                    // one-line summary for the queue
  rootCause: string;                   // 2-3 sentence explanation
  shortfall: number | null;            // amount difference if applicable
  deductionType: string | null;
  recommendedAction: string;           // what the finance team should do
  autoResolvable: boolean;             // can the agent resolve without human?
  suggestedActionType: AgentActionType;
  parsedRef: ParsedReference | null;
  fxVariance: FXVarianceResult | null;
}

export type AgentActionType =
  | "vendor_email"
  | "credit_note_request"
  | "journal_entry"
  | "payment_allocation"
  | "escalate_to_manager"
  | "no_action";

export async function diagnoseException(
  txn: SATransaction,
  allTargets: SATransaction[],
  config: { amountTolerance: number; dateWindowDays: number },
  memoryContext: string = ""
): Promise<ExceptionDiagnosis> {
  const txnAmt = parseFloat(String(txn.amount));
  const parsedRef = parseReference(txn.transactionRef, txn.description);

  // Rule-based pre-classification (fast path)
  const ruleResult = ruleBasedClassify(txn, txnAmt, allTargets, config, parsedRef);

  // LLM diagnosis (enriches the rule result with natural language)
  const llmDiagnosis = await getLLMDiagnosis(txn, ruleResult, parsedRef, memoryContext);

  return {
    ...ruleResult,
    rootCause: llmDiagnosis.rootCause || ruleResult.rootCause,
    recommendedAction: llmDiagnosis.recommendedAction || ruleResult.recommendedAction,
    headline: llmDiagnosis.headline || ruleResult.headline,
  };
}

function ruleBasedClassify(
  txn: SATransaction,
  txnAmt: number,
  allTargets: SATransaction[],
  config: { amountTolerance: number; dateWindowDays: number },
  parsedRef: ParsedReference
): ExceptionDiagnosis {
  // Deduction-based categories (from parsed reference)
  if (parsedRef.deductionType === "damage") {
    const nearMatch = findNearestTarget(txnAmt, allTargets, 0.3);
    return {
      category: "damage_deduction",
      severity: "medium",
      confidence: 78,
      headline: `Damage deduction claimed on ${txn.transactionRef || "payment"}`,
      rootCause: `The payment reference contains damage-related keywords (${parsedRef.deductionKeywords.join(", ")}), indicating the distributor has deducted a damage claim from the invoice amount. The shortfall of ${txn.currency} ${nearMatch ? Math.abs(txnAmt - parseFloat(String(nearMatch.amount))).toLocaleString() : "unknown"} represents the claimed damage value.`,
      shortfall: nearMatch ? Math.abs(txnAmt - parseFloat(String(nearMatch.amount))) : null,
      deductionType: "damage",
      recommendedAction: "Request proof of damage (photos, delivery note) from distributor. If valid, raise a credit note for the deducted amount.",
      autoResolvable: false,
      suggestedActionType: "credit_note_request",
      parsedRef,
      fxVariance: null,
    };
  }

  if (parsedRef.deductionType === "promotional") {
    const nearMatch = findNearestTarget(txnAmt, allTargets, 0.3);
    return {
      category: "promotional_deduction",
      severity: "low",
      confidence: 82,
      headline: `Promotional deduction claimed on ${txn.transactionRef || "payment"}`,
      rootCause: `The distributor has applied a promotional deduction (${parsedRef.deductionKeywords.join(", ")}). This is consistent with trade promotion agreements where distributors deduct approved promotional allowances from their remittances.`,
      shortfall: nearMatch ? Math.abs(txnAmt - parseFloat(String(nearMatch.amount))) : null,
      deductionType: "promotional",
      recommendedAction: "Verify against the approved trade promotion schedule. If within approved limits, allocate the deduction to the promotions account and close the exception.",
      autoResolvable: false,
      suggestedActionType: "journal_entry",
      parsedRef,
      fxVariance: null,
    };
  }

  if (parsedRef.deductionType === "bank_fee") {
    const fxCheck = findNearestTargetFX(txnAmt, allTargets, txn.currency);
    if (fxCheck) {
      return {
        category: "bank_fee_deduction",
        severity: "low",
        confidence: 91,
        headline: `Bank fee deduction — ${fxCheck.fxResult.explanation}`,
        rootCause: `The payment amount is short by ${txn.currency} ${fxCheck.fxResult.varianceAmount.toFixed(2)}, which is consistent with a standard bank transfer fee. ${fxCheck.fxResult.explanation}.`,
        shortfall: fxCheck.fxResult.varianceAmount,
        deductionType: "bank_fee",
        recommendedAction: "Auto-match with bank fee adjustment. Post the fee difference to the bank charges account. No distributor action required.",
        autoResolvable: true,
        suggestedActionType: "journal_entry",
        parsedRef,
        fxVariance: fxCheck.fxResult,
      };
    }
  }

  // Partial payment
  if (parsedRef.isPartialPayment) {
    const nearMatch = findNearestTarget(txnAmt, allTargets, 0.5);
    return {
      category: "partial_payment",
      severity: "medium",
      confidence: 75,
      headline: `Partial payment — ${txn.currency} ${txnAmt.toLocaleString()} against invoice`,
      rootCause: `The payment reference indicates a partial payment. The distributor has paid ${txn.currency} ${txnAmt.toLocaleString()} against an invoice of approximately ${txn.currency} ${nearMatch ? parseFloat(String(nearMatch.amount)).toLocaleString() : "unknown"}. The outstanding balance requires follow-up.`,
      shortfall: nearMatch ? Math.abs(txnAmt - parseFloat(String(nearMatch.amount))) : null,
      deductionType: null,
      recommendedAction: "Send a payment reminder for the outstanding balance. Allocate the received amount to the invoice and leave the balance open.",
      autoResolvable: false,
      suggestedActionType: "vendor_email",
      parsedRef,
      fxVariance: null,
    };
  }

  // FX variance check (even without explicit keywords)
  const fxCheck = findNearestTargetFX(txnAmt, allTargets, txn.currency);
  if (fxCheck && fxCheck.fxResult.isValidMatch) {
    return {
      category: "fx_variance",
      severity: "low",
      confidence: 88,
      headline: `FX/bank fee variance — ${fxCheck.fxResult.explanation}`,
      rootCause: `The payment amount differs from the invoice by ${txn.currency} ${fxCheck.fxResult.varianceAmount.toFixed(2)} (${fxCheck.fxResult.variancePercent.toFixed(2)}%). ${fxCheck.fxResult.explanation}.`,
      shortfall: fxCheck.fxResult.varianceAmount,
      deductionType: fxCheck.fxResult.varianceType,
      recommendedAction: "Accept as valid match with bank fee adjustment. Post the variance to the bank charges account.",
      autoResolvable: true,
      suggestedActionType: "journal_entry",
      parsedRef,
      fxVariance: fxCheck.fxResult,
    };
  }

  // Missing counterparty
  if (!txn.counterparty || txn.counterparty.trim() === "") {
    return {
      category: "missing_counterparty",
      severity: "medium",
      confidence: 95,
      headline: `No counterparty — ${txn.transactionRef || `TXN-${txn.id}`}`,
      rootCause: `Transaction ${txn.transactionRef || txn.id} has no counterparty information. Automated matching is impossible without a counterparty identifier. This is common in bulk NIBSS uploads where the originating bank omits the beneficiary name.`,
      shortfall: null,
      deductionType: null,
      recommendedAction: "Retrieve counterparty information from the NIBSS switch log or the originating bank's NIP response. Update the transaction record and re-run matching.",
      autoResolvable: false,
      suggestedActionType: "vendor_email",
      parsedRef,
      fxVariance: null,
    };
  }

  // Default: unmatched
  return {
    category: "unmatched",
    severity: txnAmt > 1_000_000 ? "high" : "medium",
    confidence: 60,
    headline: `Unmatched — ${txn.currency} ${txnAmt.toLocaleString()} on ${new Date(txn.transactionDate).toISOString().split("T")[0]}`,
    rootCause: `No matching transaction found for ${txn.transactionRef || txn.id} (${txn.currency} ${txnAmt.toLocaleString()}). The payment may exist in a different channel, a different time window, or may not yet have been recorded in the ERP.`,
    shortfall: null,
    deductionType: null,
    recommendedAction: "Check NIBSS switch logs, the distributor's remittance advice, and the ERP for the corresponding invoice. If the payment is confirmed, create a manual match.",
    autoResolvable: false,
    suggestedActionType: "escalate_to_manager",
    parsedRef,
    fxVariance: null,
  };
}

function findNearestTarget(txnAmt: number, targets: SATransaction[], maxDiffPct: number): SATransaction | null {
  let best: SATransaction | null = null;
  let bestDiff = Infinity;
  for (const t of targets) {
    const tAmt = parseFloat(String(t.amount));
    const diff = Math.abs(txnAmt - tAmt) / Math.max(txnAmt, tAmt);
    if (diff < maxDiffPct && diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return best;
}

function findNearestTargetFX(txnAmt: number, targets: SATransaction[], currency: string): { target: SATransaction; fxResult: FXVarianceResult } | null {
  for (const t of targets) {
    const tAmt = parseFloat(String(t.amount));
    const fxResult = checkFXVariance(txnAmt, tAmt, currency);
    if (fxResult.isValidMatch && fxResult.varianceType !== "none") {
      return { target: t, fxResult };
    }
  }
  return null;
}

async function getLLMDiagnosis(
  txn: SATransaction,
  ruleResult: ExceptionDiagnosis,
  parsedRef: ParsedReference,
  memoryContext: string
): Promise<{ headline: string; rootCause: string; recommendedAction: string }> {
  // Inject only the taxonomy channels relevant to this transaction — the
  // catalogued failure modes, regulatory context and diagnosis guidance for the
  // rails it actually touches. An FMCG deduction still gets no channel block.
  //
  // The transaction's OWN channel decides first; its text only adds specificity.
  // Text alone was the whole rule before, which meant a POS settlement row
  // reading "SETTLEMENT 20260812 BATCH 4471" matched no pattern and was
  // diagnosed with no knowledge of MSC netting or T+1 windows.
  const channelText = [txn.description, txn.transactionRef, txn.counterparty]
    .filter(Boolean)
    .join(" ");
  const channels = relevantNigerianChannels({ channelType: txn.channelType, text: channelText });
  const taxonomyBlock = channels.length > 0 ? nigerianExceptionsTaxonomyPromptBlock(channels) : "";

  try {
    const response = await invokeLLM({
      // Agentic: multi-step diagnosis of a case, the work CLAUDE.md §4 reserves
      // the stronger model for.
      modelTier: "agent",
      messages: [
        {
          role: "system",
          content: `You are ReconcileAI's Super Agent — a senior financial reconciliation expert specialising in Nigerian and African FMCG payment systems (NIBSS, NIP, POS, mobile money, RTGS, SWIFT, trade finance).

Your job is to diagnose payment exceptions with the precision of a Big 4 forensic accountant and the clarity of a CFO briefing. You always:
1. State the root cause in plain English (no jargon)
2. Quantify the shortfall or variance precisely
3. Recommend a single, specific next action
4. Reference relevant Nigerian banking regulations (CBN circulars, NIBSS rules) where applicable

${taxonomyBlock ? `CATALOGUED NIGERIAN CHANNEL EXCEPTION PATTERNS (relevant to this transaction):\n${taxonomyBlock}\n\nWhen the exception matches one of these catalogued patterns, ground your root cause and recommended action in that pattern's diagnosis guidance and regulatory context.\n` : ""}${memoryContext ? `RELEVANT PAST CASES:\n${memoryContext}\n` : ""}`,
        },
        {
          role: "user",
          content: `EXCEPTION TO DIAGNOSE:
Transaction Ref: ${txn.transactionRef || "N/A"}
Description: ${txn.description || "N/A"}
Amount: ${txn.currency} ${parseFloat(String(txn.amount)).toLocaleString()}
Date: ${new Date(txn.transactionDate).toISOString().split("T")[0]}
Counterparty: ${txn.counterparty || "N/A"}
Direction: ${txn.debitCredit}

RULE-BASED PRE-CLASSIFICATION:
Category: ${ruleResult.category}
Parsed Invoice Numbers: ${parsedRef.invoiceNumbers.join(", ") || "none"}
Deduction Keywords: ${parsedRef.deductionKeywords.join(", ") || "none"}
Deduction Type: ${parsedRef.deductionType}

Provide a JSON response with exactly these fields:
{
  "headline": "one-line summary (max 80 chars)",
  "rootCause": "2-3 sentence plain English explanation of why this exception exists",
  "recommendedAction": "single specific action the finance team should take next"
}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "exception_diagnosis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              headline: { type: "string" },
              rootCause: { type: "string" },
              recommendedAction: { type: "string" },
            },
            required: ["headline", "rootCause", "recommendedAction"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const parsed = JSON.parse(content);
      return {
        headline: parsed.headline || ruleResult.headline,
        rootCause: parsed.rootCause || ruleResult.rootCause,
        recommendedAction: parsed.recommendedAction || ruleResult.recommendedAction,
      };
    }
  } catch (e) {
    console.error("[SuperAgent] LLM diagnosis failed:", e);
  }
  return { headline: ruleResult.headline, rootCause: ruleResult.rootCause, recommendedAction: ruleResult.recommendedAction };
}

// ─── Layer 4: Action Draft Generator ─────────────────────────────────

export interface ActionDraft {
  actionType: AgentActionType;
  subject: string;
  body: string;
  metadata: Record<string, string | number>;
}

export async function generateActionDraft(
  txn: SATransaction,
  diagnosis: ExceptionDiagnosis,
  companyName: string = "your company"
): Promise<ActionDraft> {
  switch (diagnosis.suggestedActionType) {
    case "vendor_email":
      return generateVendorEmail(txn, diagnosis, companyName);
    case "credit_note_request":
      return generateCreditNoteRequest(txn, diagnosis, companyName);
    case "journal_entry":
      return generateJournalEntry(txn, diagnosis);
    case "payment_allocation":
      return generatePaymentAllocation(txn, diagnosis);
    default:
      return {
        actionType: "no_action",
        subject: "Exception requires manual review",
        body: `Exception for transaction ${txn.transactionRef || txn.id} requires manual review by the finance team.\n\nDiagnosis: ${diagnosis.rootCause}\n\nRecommended action: ${diagnosis.recommendedAction}`,
        metadata: { transactionId: txn.id, category: diagnosis.category },
      };
  }
}

async function generateVendorEmail(txn: SATransaction, diagnosis: ExceptionDiagnosis, companyName: string): Promise<ActionDraft> {
  const txnAmt = parseFloat(String(txn.amount));
  const shortfall = diagnosis.shortfall;

  try {
    const response = await invokeLLM({
      // Agentic: drafts an action the user will send on their own letterhead,
      // reasoning from the diagnosis rather than summarising it.
      modelTier: "agent",
      messages: [
        {
          role: "system",
          content: `You are a professional accounts receivable officer at ${companyName}. Write a polite but firm payment follow-up email to a distributor. The email should be professional, specific about the amounts, and include a clear call to action. Keep it under 200 words.`,
        },
        {
          role: "user",
          content: `Write a payment follow-up email for:
Distributor: ${txn.counterparty || "Distributor"}
Transaction Ref: ${txn.transactionRef || "N/A"}
Amount Received: ${txn.currency} ${txnAmt.toLocaleString()}
${shortfall ? `Outstanding Balance: ${txn.currency} ${shortfall.toLocaleString()}` : ""}
Issue: ${diagnosis.headline}
Context: ${diagnosis.rootCause}

Return JSON: { "subject": "email subject", "body": "full email body" }`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "vendor_email",
          strict: true,
          schema: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" } },
            required: ["subject", "body"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const parsed = JSON.parse(content);
      return {
        actionType: "vendor_email",
        subject: parsed.subject,
        body: parsed.body,
        metadata: { transactionId: txn.id, distributorName: txn.counterparty || "", amountReceived: txnAmt, shortfall: shortfall || 0 },
      };
    }
  } catch (e) {
    console.error("[SuperAgent] Vendor email generation failed:", e);
  }

  // Fallback template
  return {
    actionType: "vendor_email",
    subject: `Payment Query — ${txn.transactionRef || `TXN-${txn.id}`} — ${txn.currency} ${txnAmt.toLocaleString()}`,
    body: `Dear ${txn.counterparty || "Valued Distributor"},\n\nWe are writing regarding payment reference ${txn.transactionRef || txn.id} received on ${new Date(txn.transactionDate).toISOString().split("T")[0]} for ${txn.currency} ${txnAmt.toLocaleString()}.\n\n${diagnosis.rootCause}\n\nKindly ${diagnosis.recommendedAction.toLowerCase()}.\n\nPlease respond within 3 business days.\n\nBest regards,\nAccounts Receivable Team\n${companyName}`,
    metadata: { transactionId: txn.id, distributorName: txn.counterparty || "", amountReceived: txnAmt, shortfall: shortfall || 0 },
  };
}

async function generateCreditNoteRequest(txn: SATransaction, diagnosis: ExceptionDiagnosis, companyName: string): Promise<ActionDraft> {
  const txnAmt = parseFloat(String(txn.amount));
  const deductionAmt = diagnosis.shortfall || 0;

  return {
    actionType: "credit_note_request",
    subject: `Credit Note Request — ${diagnosis.deductionType?.toUpperCase()} Deduction — ${txn.transactionRef || `TXN-${txn.id}`}`,
    body: `CREDIT NOTE REQUEST\n${"─".repeat(50)}\n\nDate: ${new Date().toISOString().split("T")[0]}\nRequested by: ReconcileAI Super Agent\nApproval required: Finance Manager\n\nDISTRIBUTOR: ${txn.counterparty || "Unknown"}\nTRANSACTION REF: ${txn.transactionRef || txn.id}\nINVOICE AMOUNT: ${txn.currency} ${(txnAmt + deductionAmt).toLocaleString()}\nAMOUNT RECEIVED: ${txn.currency} ${txnAmt.toLocaleString()}\nDEDUCTION CLAIMED: ${txn.currency} ${deductionAmt.toLocaleString()}\nDEDUCTION TYPE: ${diagnosis.deductionType || "Unknown"}\n\nDIAGNOSIS:\n${diagnosis.rootCause}\n\nREQUIRED DOCUMENTATION:\n• ${diagnosis.deductionType === "damage" ? "Delivery note with damage annotation\n• Photographic evidence of damaged goods\n• Distributor's written claim" : "Approved promotional agreement\n• Trade promotion schedule\n• Distributor's claim form"}\n\nACTION REQUIRED:\n${diagnosis.recommendedAction}\n\n${"─".repeat(50)}\nGenerated by ReconcileAI Super Agent — Pending Human Approval`,
    metadata: { transactionId: txn.id, deductionType: diagnosis.deductionType || "", deductionAmount: deductionAmt, invoiceAmount: txnAmt + deductionAmt },
  };
}

function generateJournalEntry(txn: SATransaction, diagnosis: ExceptionDiagnosis): ActionDraft {
  const txnAmt = parseFloat(String(txn.amount));
  const variance = diagnosis.shortfall || diagnosis.fxVariance?.varianceAmount || 0;
  const date = new Date(txn.transactionDate).toISOString().split("T")[0];

  return {
    actionType: "journal_entry",
    subject: `Journal Entry — ${diagnosis.category.replace(/_/g, " ").toUpperCase()} — ${txn.transactionRef || `TXN-${txn.id}`}`,
    body: `DRAFT JOURNAL ENTRY\n${"─".repeat(50)}\n\nDate: ${date}\nPrepared by: ReconcileAI Super Agent\nApproval required: Finance Controller\n\nREFERENCE: ${txn.transactionRef || txn.id}\nDESCRIPTION: ${diagnosis.headline}\n\nDR  Accounts Receivable (${txn.counterparty || "Distributor"})    ${txn.currency} ${txnAmt.toLocaleString()}\nDR  ${diagnosis.deductionType === "bank_fee" ? "Bank Charges" : diagnosis.deductionType === "tax" ? "Tax Expense" : "Deductions Account"}    ${txn.currency} ${variance.toLocaleString()}\n    CR  Revenue / Invoice Account    ${txn.currency} ${(txnAmt + variance).toLocaleString()}\n\nNARRATION: ${diagnosis.rootCause}\n\nSUPPORTING EVIDENCE:\n• Transaction ID: ${txn.id}\n• Channel: ${txn.channelId}\n• Diagnosis confidence: ${diagnosis.confidence}%\n\n${"─".repeat(50)}\nGenerated by ReconcileAI Super Agent — Pending Finance Controller Approval`,
    metadata: { transactionId: txn.id, debitAmount: txnAmt, creditAmount: txnAmt + variance, varianceAmount: variance },
  };
}

function generatePaymentAllocation(txn: SATransaction, diagnosis: ExceptionDiagnosis): ActionDraft {
  const txnAmt = parseFloat(String(txn.amount));
  const invoices = diagnosis.parsedRef?.invoiceNumbers || [];

  return {
    actionType: "payment_allocation",
    subject: `Payment Allocation Instruction — ${txn.transactionRef || `TXN-${txn.id}`}`,
    body: `PAYMENT ALLOCATION INSTRUCTION\n${"─".repeat(50)}\n\nDate: ${new Date().toISOString().split("T")[0]}\nPrepared by: ReconcileAI Super Agent\nApproval required: Accounts Receivable Officer\n\nPAYMENT DETAILS:\nReference: ${txn.transactionRef || txn.id}\nPayer: ${txn.counterparty || "Unknown"}\nAmount: ${txn.currency} ${txnAmt.toLocaleString()}\nDate: ${new Date(txn.transactionDate).toISOString().split("T")[0]}\n\nALLOCATION INSTRUCTION:\n${invoices.length > 0 ? invoices.map((inv, i) => `${i + 1}. Allocate to Invoice ${inv}`).join("\n") : "1. Allocate to oldest outstanding invoice"}\n\nDIAGNOSIS:\n${diagnosis.rootCause}\n\nNOTES:\n${diagnosis.recommendedAction}\n\n${"─".repeat(50)}\nGenerated by ReconcileAI Super Agent — Pending AR Officer Approval`,
    metadata: { transactionId: txn.id, payerName: txn.counterparty || "", allocationAmount: txnAmt, invoiceCount: invoices.length },
  };
}

// ─── Layer 5: Semantic Memory Layer ──────────────────────────────────

export interface MemoryRecord {
  id: number;
  exceptionCategory: string;
  transactionRef: string;
  amountRange: string;          // "0-100k" | "100k-1m" | "1m+"
  counterpartyType: string;     // "distributor" | "bank" | "unknown"
  deductionType: string | null;
  resolution: string;
  outcome: "resolved" | "escalated" | "rejected";
  reasoning: string;
  embeddingText: string;        // the text used for similarity search
  createdAt: Date;
}

/**
 * Build the embedding text for a transaction + diagnosis pair.
 * This is the text that will be stored and searched for similarity.
 */
export function buildMemoryEmbeddingText(
  txn: SATransaction,
  diagnosis: ExceptionDiagnosis,
  resolution: string
): string {
  const amt = parseFloat(String(txn.amount));
  const amountRange = amt < 100_000 ? "0-100k" : amt < 1_000_000 ? "100k-1m" : "1m+";

  return [
    `category:${diagnosis.category}`,
    `deduction:${diagnosis.deductionType || "none"}`,
    `amount_range:${amountRange}`,
    `currency:${txn.currency}`,
    `ref_keywords:${(txn.transactionRef || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim()}`,
    `desc_keywords:${(txn.description || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim()}`,
    `counterparty:${(txn.counterparty || "unknown").toLowerCase()}`,
    `resolution:${resolution}`,
    `outcome:resolved`,
  ].join(" | ");
}

/**
 * Simple text-similarity search over memory records.
 * Uses token overlap (Jaccard similarity) as a lightweight alternative to vector embeddings.
 * This is sufficient for the prototype; production would use a proper vector DB.
 */
export function retrieveSimilarMemories(
  txn: SATransaction,
  diagnosis: ExceptionDiagnosis,
  memories: MemoryRecord[],
  topK: number = 3
): Array<{ memory: MemoryRecord; similarity: number }> {
  const queryText = buildMemoryEmbeddingText(txn, diagnosis, "").toLowerCase();
  const queryTokens = new Set(queryText.split(/[\s|:]+/).filter((t) => t.length > 2));

  const queryTokensArr = Array.from(queryTokens);
  const scored = memories.map((mem) => {
    const memTokens = new Set(mem.embeddingText.toLowerCase().split(/[\s|:]+/).filter((t) => t.length > 2));
    const memTokensArr = Array.from(memTokens);
    const intersectionArr = queryTokensArr.filter((t) => memTokens.has(t));
    const unionArr = Array.from(new Set(queryTokensArr.concat(memTokensArr)));
    const similarity = unionArr.length > 0 ? intersectionArr.length / unionArr.length : 0;
    return { memory: mem, similarity };
  });

  return scored
    .filter((s) => s.similarity > 0.2)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Format retrieved memories as context for the LLM diagnosis prompt.
 */
export function formatMemoryContext(memories: Array<{ memory: MemoryRecord; similarity: number }>): string {
  if (memories.length === 0) return "";

  return memories
    .map((m, i) => `Case ${i + 1} (${(m.similarity * 100).toFixed(0)}% similar):\n  Category: ${m.memory.exceptionCategory}\n  Resolution: ${m.memory.resolution}\n  Reasoning: ${m.memory.reasoning}\n  Outcome: ${m.memory.outcome}`)
    .join("\n\n");
}
