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
import { nigerianExceptionsTaxonomyPromptBlock, nonInterestTaxonomyPromptBlock } from "./exceptions/seed";
import { relevantNigerianChannels } from "./exceptions/channelMapping";
import {
  corporateB2BExceptionsTaxonomyPromptBlock,
  corporateB2BRegulatoryFrame,
} from "./exceptions/corporate-b2b";

/**
 * Who the tenant is, as far as diagnosis is concerned.
 *
 * Was a bare `bankingModel` string. Diagnosis needs two more facts that the
 * channel cannot supply, and getting them wrong is visible in the output:
 *
 *   `segment` — a corporate_b2b tenant is an FMCG manufacturer, not a bank. It
 *     was being diagnosed under a persona describing itself as a Nigerian
 *     payment-systems expert, with the NIP/POS/ATM catalogue and an instruction
 *     to cite CBN circulars. None of that governs a distributor receivable.
 *   `country` — the go-live plan's FIRST launch geography is Uganda, where a
 *     cited CBN circular is not merely irrelevant but wrong.
 */
export interface DiagnosingInstitution {
  /** `organizations.segment`. */
  segment?: string | null;
  /** `organizations.bankingModel`; omitted means conventional. */
  bankingModel?: string | null;
  /** The pilot's recorded launch country, where one exists. */
  country?: string | null;
}

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
  /**
   * The reference appears to name more invoices than `invoiceNumbers` holds,
   * because it lists or ranges them in shorthand ("INV-1001 and 1002").
   *
   * Distinct from `invoiceNumbers.length > 1`, and that is the whole point: the
   * extractor cannot see the extra legs, so the count alone reads a split
   * remittance as a single-invoice payment. See referenceMayNameMoreInvoices.
   */
  mayNameMoreInvoices: boolean;
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

/**
 * Numbers that are ACCOUNTED FOR, and so cannot be an unwritten invoice leg.
 *
 * See `referenceMayNameMoreInvoices` below for why the question is posed this way.
 * Each entry is an explanation the reference itself supplies for a number:
 *   - a literal written like money — thousands separators or a decimal part;
 *   - a number introduced by a deduction, balance or currency cue;
 *   - a date, in the two shapes that appear in remittance narrations.
 */
const ACCOUNTED_NUMBER_PATTERNS: RegExp[] = [
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g,
  /\b(?:less|minus|deduct(?:ion)?|net\s*of|amt|amount|bal(?:ance)?|NGN|UGX|USD|GHS|KES|ZAR|₦)\s*[:=]?\s*\d[\d,]*(?:\.\d+)?/gi,
  /\b(?:19|20)\d{6}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
];

/**
 * Does this reference appear to name MORE invoices than the extractor could
 * pull out of it?
 *
 * INVOICE_PATTERN requires a prefix on every identifier, so a remittance written
 * the way distributors write them — "INV-1001 and 1002", "INV-2001-2005" —
 * yields ONE identifier and reads as an ordinary single-invoice payment. That
 * defeats the split guard in `determinateCandidates` in exactly the case it
 * exists for, and the whole receipt gets diagnosed against the first leg.
 *
 * ── Why this is not a list of separators ──────────────────────────────────
 *
 * The previous attempt matched an invoice identifier followed by a KNOWN list or
 * range connector. Review then found `;`, `:` and "or"; `plus`, `|` and a
 * newline bypass it equally, and the next reader will find another. The set of
 * characters a human might put between two invoice numbers is not enumerable,
 * and every omission from that list fails OPEN — straight to a wrong shortfall.
 *
 * So the question is inverted. Instead of asking "is there a separator I
 * recognise?", it asks: **is there an invoice-length number here that nothing
 * accounts for?** That set IS bounded, because a reference only contains so
 * many kinds of number: the invoice identifiers themselves, amounts, and dates.
 * Anything left over may be an invoice leg.
 *
 * The direction of failure is the point. ACCOUNTED_NUMBER_PATTERNS is still a
 * list and still incomplete — but an omission there makes an explained number
 * look unexplained, which DECLINES a determinate receipt. Losing a shortfall we
 * could have computed is the cost; reporting one that is wrong is not on the
 * table. That is the same trade as `findSubsetSum` and the rest of this module.
 *
 * Requires at least one extracted identifier, so this reads as "more than the
 * ones I found" rather than "some digits appeared". A reference with no
 * recognisable identifier at all — a bare "1001 and 1002" — is not covered:
 * those digits are indistinguishable from an amount or an account number, and
 * the single-candidate branch that would handle it rests on a different
 * argument (one open invoice is unambiguous), not on reading the reference.
 */
function referenceMayNameMoreInvoices(raw: string, extracted: string[]): boolean {
  if (extracted.length === 0) return false;
  let masked = raw.replace(new RegExp(INVOICE_PATTERN.source, "gi"), " ");
  for (const pattern of ACCOUNTED_NUMBER_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), " ");
  }
  // Three digits is the shortest thing INVOICE_PATTERN will accept as an
  // invoice number, so a shorter leftover ("INV-2847-01") cannot be one.
  return /\b\d{3,10}\b/.test(masked);
}
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
    mayNameMoreInvoices: referenceMayNameMoreInvoices(raw, invoiceNumbers),
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

/**
 * A candidate allocation the engine refused to guess at. Carrying it in the
 * result is what stops a refusal from being indistinguishable from "nothing
 * found" — the two need different actions from a controller.
 */
export interface M2MAmbiguity {
  sourceIds: number[];
  targetIds: number[];
  reason: "ambiguous" | "indeterminate";
  detail: string;
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
): {
  m2mMatches: M2MMatch[];
  remainingSourceIds: number[];
  remainingTargetIds: number[];
  /**
   * Cases the engine could have produced a confident-looking allocation for and
   * deliberately did not. Reported rather than dropped: "several allocations
   * are equally valid, here is how many" is actionable for a controller, while
   * an item that silently stays unmatched looks like the engine found nothing.
   */
  unresolvedAmbiguities: M2MAmbiguity[];
} {
  const matchedSourceIds = new Set<number>();
  const matchedTargetIds = new Set<number>();
  const m2mMatches: M2MMatch[] = [];
  const unresolvedAmbiguities: M2MAmbiguity[] = [];

  // ── Strategy 1: One source → many targets (sum matching) ─────────
  for (const src of unmatchedSources) {
    if (matchedSourceIds.has(src.id)) continue;
    const srcAmt = parseFloat(String(src.amount));
    const srcParsed = parseReference(src.transactionRef, src.description);

    // Combinations of 2–5 unmatched targets that sum to srcAmt. `minItems` is
    // 2 on purpose: a single target within tolerance is a 1:1 near-match, which
    // the 3-pass engine already handles, and reporting it here dressed it up as
    // a "one-to-many split allocation" it was not.
    const availableTargets = unmatchedTargets.filter((t) => !matchedTargetIds.has(t.id));
    const outcome = findSubsetSum(availableTargets, srcAmt, fxTolerance, 5);
    if (outcome.kind === "ambiguous" || outcome.kind === "indeterminate") {
      unresolvedAmbiguities.push({
        sourceIds: [src.id],
        targetIds: [],
        reason: outcome.kind,
        detail: outcome.kind === "ambiguous"
          ? `More than one combination of open invoices sums to ${src.currency} ${srcAmt.toLocaleString()}. No allocation is proposed: choosing between equally valid splits would be arbitrary.`
          : `The search for a matching combination exceeded its budget for ${src.currency} ${srcAmt.toLocaleString()}. This is not evidence that no allocation exists.`,
      });
      continue;
    }
    const found = outcome.kind === "unique" ? outcome.subset : null;

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
    const outcome = findSubsetSum(availableSources, tgtAmt, fxTolerance, 5);
    if (outcome.kind === "ambiguous" || outcome.kind === "indeterminate") {
      unresolvedAmbiguities.push({
        sourceIds: [],
        targetIds: [tgt.id],
        reason: outcome.kind,
        detail: outcome.kind === "ambiguous"
          ? `More than one combination of receipts sums to invoice ${tgt.transactionRef ?? tgt.id}. No allocation is proposed.`
          : `The search for a matching combination exceeded its budget for invoice ${tgt.transactionRef ?? tgt.id}.`,
      });
      continue;
    }
    const found = outcome.kind === "unique" ? outcome.subset : null;

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

  return { m2mMatches, remainingSourceIds, remainingTargetIds, unresolvedAmbiguities };
}

/**
 * Subset-sum finder: find a combination of transactions that sums to targetAmount ± tolerance.
 * Uses dynamic programming for small sets (≤ 20), greedy for larger sets.
 * Limited to maxItems to prevent combinatorial explosion.
 */
/**
 * The outcome of looking for a set of transactions that sums to a target.
 *
 * FOUR states, not a nullable subset, and the distinction is the whole point.
 * The previous implementation returned the first subset it stumbled on and the
 * caller published it as an allocation at ~85% confidence. Two of these states
 * were being reported as `unique`:
 *
 *   `ambiguous`     — several DIFFERENT subsets of the open invoices sum to the
 *                     same receipt. Three invoices of 100 against a payment of
 *                     200 is the canonical case: any two of them "match". A
 *                     greedy search picks one by sort order, which is an
 *                     arbitrary allocation wearing a confidence score. For a
 *                     receivables ledger that is a fabricated answer, and it is
 *                     discovered later as two wrong distributor statements.
 *   `indeterminate` — the search budget was exhausted before the question could
 *                     be answered. Not the same as "no match exists", and must
 *                     not be reported as one.
 *
 * Both resolve to "propose nothing and say why". An open item a human closes is
 * cheaper than a wrong allocation a human has to discover.
 */
type SubsetSumOutcome =
  | { kind: "unique"; subset: SATransaction[] }
  | { kind: "ambiguous"; alternatives: number }
  | { kind: "indeterminate" }
  | { kind: "none" };

/**
 * Bound on combination nodes visited per search. Keeps one diagnosis from
 * turning into an unbounded scan; exceeding it yields `indeterminate` rather
 * than a partial answer presented as a complete one.
 */
const SUBSET_SEARCH_BUDGET = 200_000;

function amountOf(txn: SATransaction): number {
  return parseFloat(String(txn.amount));
}

/**
 * Find a set of `minItems`..`maxItems` transactions summing to `targetAmount`
 * within tolerance, and say whether it is the ONLY such set.
 *
 * The greedy first pass is gone. It was the source of both defects: it returned
 * on the first set that reached the lower bound (so it could never see a second
 * one), and because it accepted a single item it turned a plain 1:1 near-match
 * into a "one-to-many split allocation" — the 3-pass engine's job, reported as
 * something it is not.
 */
function findSubsetSum(
  txns: SATransaction[],
  targetAmount: number,
  tolerancePct: number,
  maxItems: number,
  minItems = 2,
): SubsetSumOutcome {
  // A non-positive target has no meaningful tolerance band and would divide by
  // zero downstream when a confidence score is computed from the difference.
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) return { kind: "none" };

  const tolerance = Math.abs(targetAmount) * tolerancePct;
  const lo = targetAmount - tolerance;
  const hi = targetAmount + tolerance;

  // Non-positive and non-finite amounts cannot contribute to a sum-match and
  // break the pruning below, which assumes adding an item only increases it.
  const sorted = txns
    .filter((t) => Number.isFinite(amountOf(t)) && amountOf(t) > 0)
    .sort((a, b) => amountOf(b) - amountOf(a));

  const found: SATransaction[][] = [];
  let budget = SUBSET_SEARCH_BUDGET;
  let exhausted = false;

  const search = (start: number, current: SATransaction[], sum: number): void => {
    // Stop at TWO hits: a second one already proves ambiguity, and enumerating
    // the rest buys nothing.
    if (found.length >= 2 || exhausted) return;
    if (current.length >= minItems && sum >= lo && sum <= hi) {
      found.push([...current]);
      if (found.length >= 2) return;
    }
    if (current.length >= maxItems) return;
    for (let i = start; i < sorted.length; i++) {
      if (budget-- <= 0) { exhausted = true; return; }
      const next = sum + amountOf(sorted[i]);
      // Amounts are positive and sorted descending, so once the running sum
      // passes the upper bound every remaining item at this level does too.
      if (next > hi) continue;
      current.push(sorted[i]);
      search(i + 1, current, next);
      current.pop();
      if (found.length >= 2 || exhausted) return;
    }
  };

  search(0, [], 0);

  if (found.length >= 2) return { kind: "ambiguous", alternatives: found.length };
  if (found.length === 1) return { kind: "unique", subset: found[0] };
  // Budget exhausted without a hit means "we do not know", not "there is none".
  return exhausted ? { kind: "indeterminate" } : { kind: "none" };
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
  memoryContext: string = "",
  /**
   * The owning tenant. An omitted `bankingModel` means conventional — see
   * isNonInterestInstitution for why an unknown value must NOT be read as
   * non-interest.
   */
  institution: DiagnosingInstitution = {},
): Promise<ExceptionDiagnosis> {
  const txnAmt = parseFloat(String(txn.amount));
  const parsedRef = parseReference(txn.transactionRef, txn.description);

  // Rule-based pre-classification (fast path)
  const ruleResult = ruleBasedClassify(txn, txnAmt, allTargets, config, parsedRef);

  // LLM diagnosis (enriches the rule result with natural language)
  const llmDiagnosis = await getLLMDiagnosis(txn, ruleResult, parsedRef, memoryContext, institution);

  return {
    ...ruleResult,
    rootCause: llmDiagnosis.rootCause || ruleResult.rootCause,
    recommendedAction: llmDiagnosis.recommendedAction || ruleResult.recommendedAction,
    headline: llmDiagnosis.headline || ruleResult.headline,
  };
}

/**
 * Could this candidate be the counterpart leg of `txn` at all?
 *
 * The SQL in `db.getDiagnosisCandidates` narrows the pool for efficiency, and
 * every round of review so far has found a row shape it let through: a
 * different currency, an unpaired channel, another distributor's invoice, then
 * a same-direction receipt and a reversal. Each was fixed in the WHERE clause,
 * where nothing could test it — the pool's composition had no unit test at all,
 * which is why the same class of defect kept arriving.
 *
 * So the RULE lives here, in one pure function that is tested, and the caller
 * applies it to whatever the query returns. The SQL stays as a narrowing for
 * cost; correctness no longer depends on it being complete.
 *
 * A candidate is comparable only when it is:
 *   - a different row (a transaction is not its own counterpart);
 *   - the same currency — two currencies make an FX exception, not a shortfall;
 *   - the same counterparty, so the comparison is to that payer's own items;
 *   - the OPPOSITE direction. Both feeds of a reconciled pair record the
 *     counterpart in the opposite direction in this platform's model, in both
 *     verticals (demoSeedEngine writes every source row `credit` and every
 *     target row `debit`), and `detectReversals` requires the same inequality.
 *     A same-direction row is a different event on the same side of the ledger:
 *     comparing a receipt to another receipt narrates the gap between two
 *     payments as a shortfall against an invoice;
 *   - not a reversal. Reversed money is not an obligation to measure against —
 *     it is the `b2b_receipt_reversed_after_allocation` exception.
 */
export function isComparableCandidate(txn: SATransaction, candidate: SATransaction): boolean {
  if (candidate.id === txn.id) return false;
  if (candidate.currency !== txn.currency) return false;
  if (candidate.isReversal) return false;

  const payer = normalizeStr(txn.counterparty);
  // No counterparty is not a wildcard. The classifier's `missing_counterparty`
  // branch is the right diagnosis; inventing a comparison is the fabricated
  // figure this filter exists to prevent.
  if (!payer || normalizeStr(candidate.counterparty) !== payer) return false;

  // Unrecognised directions compare to nothing rather than to everything.
  const directions = new Set(["debit", "credit"]);
  if (!directions.has(txn.debitCredit) || !directions.has(candidate.debitCredit)) return false;
  return candidate.debitCredit !== txn.debitCredit;
}

/**
 * Which candidates may a single-transaction diagnosis actually compare against?
 *
 * `findNearestTarget` picks by NUMERIC PROXIMITY. Given several of one
 * distributor's open invoices it will choose the closest by amount, which is a
 * guess dressed as a finding: a receipt of 950,000 lands on whichever invoice
 * is nearest rather than the one it settles, and the resulting shortfall is
 * narrated and persisted onto a credit-note or journal-entry draft. Narrowing
 * the pool by currency, channel pairing and counterparty removed the grossly
 * unrelated comparisons; it cannot remove this one, because every remaining
 * candidate is a genuinely plausible invoice for that payer.
 *
 * So the pool is reduced to what is DETERMINED rather than merely nearest:
 *
 *   1. If the payment reference names invoice numbers, those pin the target.
 *      "INV-2847 less promo" is not a guess — it is the distributor telling us
 *      which invoice it paid and why it paid less.
 *   2. Otherwise a single remaining candidate is unambiguous and is used.
 *   3. Otherwise NOTHING is returned. Several open invoices and no reference
 *      is exactly the case the taxonomy calls `b2b_unallocated_receipt` /
 *      `b2b_aggregated_remittance_no_advice`, whose recommended action is to
 *      obtain the remittance advice — not to pick one and quantify against it.
 *
 * The same discipline as `findSubsetSum`: when the evidence does not determine
 * an answer, produce none. An open item a controller closes is cheaper than a
 * wrong figure a controller has to discover.
 */
export function determinateCandidates(
  txn: SATransaction,
  candidates: SATransaction[],
): SATransaction[] {
  if (candidates.length === 0) return [];

  // The reference is read FIRST, before any short-circuit on pool size. A
  // `candidates.length <= 1 -> return candidates` fast path sat above this and
  // handed back the single open invoice even when the receipt named two,
  // re-opening the split-remittance hole one line above the guard for it.
  const parsed = parseReference(txn.transactionRef, txn.description);

  // Deduplicated by identifier, because the same invoice number routinely
  // appears in BOTH the reference and the description ("INV-2847" /
  // "payment for INV-2847") and counting the raw hits would read one invoice
  // as two.
  const wanted = new Set(parsed.invoiceNumbers.map((n) => normalizeStr(n)).filter(Boolean));

  // A reference naming SEVERAL invoices is a split remittance, and that is an
  // allocation question rather than a shortfall one. It stays unresolved here
  // however many of them are currently open: finding one leg does not make the
  // receipt a payment against that leg, and diagnosing the whole amount
  // against it produces exactly the wrong shortfall and a single-invoice
  // action draft. Splits are what runM2MMatching is for.
  //
  // `mayNameMoreInvoices` is checked alongside the count, not instead of it,
  // because a shorthand list defeats the count itself: only the first leg of
  // "INV-1001 and 1002" carries a prefix, so the extractor returns ONE
  // identifier and the size test reads a two-invoice remittance as an ordinary
  // single-invoice payment. Counting what was extracted cannot see what the
  // extractor could not extract.
  if (wanted.size > 1 || parsed.mayNameMoreInvoices) return [];

  if (wanted.size === 1) {
    // Compare EXTRACTED IDENTIFIERS, not substrings. A normalised substring
    // test makes `INV-2847` match `INV-28470`, so a receipt whose real invoice
    // is not in the open pool silently attaches to a longer one and quantifies
    // a shortfall against it. Both sides go through the same extractor, so the
    // comparison is identifier-to-identifier.
    const named = candidates.filter((candidate) => {
      const theirs = parseReference(candidate.transactionRef, candidate.description).invoiceNumbers;
      return theirs.some((n) => wanted.has(normalizeStr(n)));
    });
    // Exactly one open invoice carries the named identifier: determined. Two
    // carrying it is a duplicated invoice — a governance defect, not a target.
    // None carrying it means the named invoice is not open, and the nearest
    // other invoice is not a substitute for it.
    return named.length === 1 ? named : [];
  }

  // No usable reference. One candidate is unambiguous by definition; several
  // are a choice this function is not entitled to make.
  return candidates.length === 1 ? candidates : [];
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
  memoryContext: string,
  institution: DiagnosingInstitution = {},
): Promise<{ headline: string; rootCause: string; recommendedAction: string }> {
  const { bankingModel, segment, country } = institution;
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

  // Corporate B2B is an FMCG manufacturer or distributor, not a bank, so it
  // gets its own taxonomy INSTEAD OF the Nigerian channel catalogue rather than
  // on top of it. Injecting NIP/POS/ATM failure modes alongside a trade
  // deduction does not add context — it invites the model to explain a
  // distributor's promotional claw-back as a switch failure, and to cite a
  // regulator that does not supervise the tenant.
  const isCorporateB2B = segment === "corporate_b2b";
  const corporateB2BBlock = corporateB2BExceptionsTaxonomyPromptBlock(segment);
  const taxonomyBlock = isCorporateB2B
    ? ""
    : channels.length > 0
      ? nigerianExceptionsTaxonomyPromptBlock(channels)
      : "";

  // Non-interest (NIFI) institutions additionally get the profit-and-sharing
  // taxonomy, which is keyed on the ORGANISATION rather than the channel: it
  // applies across every rail the institution runs. Empty string for a
  // conventional bank, so nothing is injected and no tokens are spent.
  const nonInterestBlock = nonInterestTaxonomyPromptBlock(bankingModel);

  // The persona and the regulatory instruction are BOTH wrong for this vertical
  // by default: "specialising in Nigerian … payment systems (NIBSS, NIP, POS …)"
  // and "reference relevant Nigerian banking regulations (CBN circulars, NIBSS
  // rules)". The go-live plan's first launch geography is Uganda.
  const persona = isCorporateB2B
    ? `You are ReconcileAI's Super Agent — a senior receivables and trade-spend controller for FMCG manufacturers and distributors in Africa. You reconcile distributor receipts, remittance advices and trade deductions against approved invoices.

Your job is to diagnose receivable exceptions with the precision of a Big 4 forensic accountant and the clarity of a CFO briefing. You always:
1. State the root cause in plain English (no jargon)
2. Quantify the shortfall or variance precisely, in the invoice currency
3. Recommend a single, specific next action, naming who must approve it
4. Say what evidence would close the item — a remittance advice, a credit note, a withholding-tax certificate, an approved promotion schedule

${corporateB2BRegulatoryFrame(country)}`
    : `You are ReconcileAI's Super Agent — a senior financial reconciliation expert specialising in Nigerian and African FMCG payment systems (NIBSS, NIP, POS, mobile money, RTGS, SWIFT, trade finance).

Your job is to diagnose payment exceptions with the precision of a Big 4 forensic accountant and the clarity of a CFO briefing. You always:
1. State the root cause in plain English (no jargon)
2. Quantify the shortfall or variance precisely
3. Recommend a single, specific next action
4. Reference relevant Nigerian banking regulations (CBN circulars, NIBSS rules) where applicable`;

  try {
    const response = await invokeLLM({
      // Agentic: multi-step diagnosis of a case, the work CLAUDE.md §4 reserves
      // the stronger model for.
      modelTier: "agent",
      messages: [
        {
          role: "system",
          content: `${persona}

${corporateB2BBlock ? `CATALOGUED FMCG DISTRIBUTOR EXCEPTION PATTERNS:\n${corporateB2BBlock}\n\nWhen the exception matches one of these catalogued patterns, ground your root cause and recommended action in that pattern's diagnosis guidance.\n` : ""}${taxonomyBlock ? `CATALOGUED NIGERIAN CHANNEL EXCEPTION PATTERNS (relevant to this transaction):\n${taxonomyBlock}\n\nWhen the exception matches one of these catalogued patterns, ground your root cause and recommended action in that pattern's diagnosis guidance and regulatory context.\n` : ""}${nonInterestBlock ? `THIS INSTITUTION IS LICENSED ON NON-INTEREST (NIFI) PRINCIPLES.\nIt runs the same payment rails as any other bank, but income may only arise from a real sale, lease or partnership — never from the passage of time — and investment account holders' funds must stay segregated from shareholders' funds. Treat an entry that accrues purely with time, or a return credited to the wrong pool, as a compliance finding rather than a posting error: it reaches the institution's licence basis and its Advisory Committee of Experts' attestation, so it can be material at an amount that would be immaterial at a conventional bank.\n\nNON-INTEREST EXCEPTION PATTERNS:\n${nonInterestBlock}\n` : ""}${memoryContext ? `RELEVANT PAST CASES:\n${memoryContext}\n` : ""}`,
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
