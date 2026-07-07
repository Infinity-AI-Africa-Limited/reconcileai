import { Transaction, InsertMatch, InsertException } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";

// ─── Types ───────────────────────────────────────────────────────────

export interface MatchCandidate {
  sourceId: number;
  targetId: number;
  matchType: "exact" | "fuzzy" | "amount_tolerance" | "date_window" | "ai_suggested" | "reversal";
  confidenceScore: number;
  amountDifference: number;
  dateDifference: number;
  matchReason: string;
}

export interface ReconciliationConfig {
  amountTolerance: number; // e.g. 0.005 for ±0.5%
  dateWindowDays: number;  // e.g. 3 for ±3 days
  // When true, bank fee/charge/levy "noise" is set aside BEFORE matching so it
  // can't skew the result, and returned in `excluded` flagged with context.
  // Card-settlement fees (interchange/scheme/MDR…) are never treated as noise.
  excludeFeeNoise?: boolean;
}

export interface ExcludedFee {
  transactionId: number;
  side: "source" | "target";
  amount: number;
  reference: string | null;
  description: string | null;
  reason: string;
}

export interface ReconciliationResult {
  matches: MatchCandidate[];
  unmatchedSource: number[];
  unmatchedTarget: number[];
  duplicates: DuplicateGroup[];
  reversals: ReversalPair[];
  stats: EngineStats;
  // Fee/charge lines set aside from the reconciliation (empty unless
  // config.excludeFeeNoise). Flagged for the user, not counted as exceptions.
  excluded: ExcludedFee[];
}

interface DuplicateGroup {
  transactionIds: number[];
  reason: string;
}

interface ReversalPair {
  originalId: number;
  reversalId: number;
  reason: string;
}

interface EngineStats {
  totalSourceTxns: number;
  totalTargetTxns: number;
  pass1ExactMatches: number;
  pass2ToleranceMatches: number;
  pass3FuzzyMatches: number;
  duplicatesDetected: number;
  reversalsDetected: number;
  processingTimeMs: number;
}

// ─── Index Structures for O(1) Lookups ──────────────────────────────

interface TransactionIndex {
  byRef: Map<string, Transaction[]>;
  byAmount: Map<string, Transaction[]>;
  byAmountDate: Map<string, Transaction[]>;
}

function buildIndex(txns: Transaction[]): TransactionIndex {
  const byRef = new Map<string, Transaction[]>();
  const byAmount = new Map<string, Transaction[]>();
  const byAmountDate = new Map<string, Transaction[]>();

  for (const txn of txns) {
    // Index by normalized reference
    if (txn.transactionRef) {
      const normRef = normalizeString(txn.transactionRef);
      if (normRef) {
        const existing = byRef.get(normRef) || [];
        existing.push(txn);
        byRef.set(normRef, existing);
      }
    }

    // Index by rounded amount (for quick lookup)
    const amtKey = parseFloat(String(txn.amount)).toFixed(2);
    const existingAmt = byAmount.get(amtKey) || [];
    existingAmt.push(txn);
    byAmount.set(amtKey, existingAmt);

    // Index by amount + date (YYYY-MM-DD)
    const dateKey = new Date(txn.transactionDate).toISOString().split("T")[0];
    const compositeKey = `${amtKey}|${dateKey}`;
    const existingComposite = byAmountDate.get(compositeKey) || [];
    existingComposite.push(txn);
    byAmountDate.set(compositeKey, existingComposite);
  }

  return { byRef, byAmount, byAmountDate };
}

// ─── Utility Functions ───────────────────────────────────────────────

function normalizeString(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function levenshteinDistance(a: string, b: string): number {
  // Early termination: if length difference exceeds threshold, skip
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.4) {
    return Math.max(a.length, b.length);
  }
  // Limit to first 100 chars for performance on long strings
  const sa = a.substring(0, 100);
  const sb = b.substring(0, 100);
  const matrix: number[][] = [];
  for (let i = 0; i <= sb.length; i++) matrix[i] = [i];
  for (let j = 0; j <= sa.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= sb.length; i++) {
    for (let j = 1; j <= sa.length; j++) {
      if (sb.charAt(i - 1) === sa.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[sb.length][sa.length];
}

function stringSimilarity(a: string, b: string): number {
  const normA = normalizeString(a);
  const normB = normalizeString(b);
  if (normA === normB) return 1;
  if (!normA || !normB) return 0;
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(normA, normB);
  return 1 - distance / maxLen;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysDifference(d1: Date, d2: Date): number {
  return Math.abs(d1.getTime() - d2.getTime()) / MS_PER_DAY;
}

function amountDifferencePercent(a1: number, a2: number): number {
  if (a1 === 0 && a2 === 0) return 0;
  const base = Math.max(Math.abs(a1), Math.abs(a2));
  return Math.abs(a1 - a2) / base;
}

// First index `i` in a sorted ascending array where arr[i] >= target (lower bound).
function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─── Duplicate Detection ────────────────────────────────────────────

function detectDuplicates(txns: Transaction[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const seen = new Map<string, Transaction[]>();

  for (const txn of txns) {
    // Key: ref + amount + currency + date — the same numeric amount in two
    // currencies is NOT a duplicate (WS-6).
    const ref = normalizeString(txn.transactionRef);
    const amt = parseFloat(String(txn.amount)).toFixed(2);
    const date = new Date(txn.transactionDate).toISOString().split("T")[0];
    const key = `${ref}|${amt}|${txn.currency}|${date}|${txn.channelId}`;

    if (ref) { // Only check duplicates for transactions with references
      const existing = seen.get(key) || [];
      existing.push(txn);
      seen.set(key, existing);
    }
  }

  seen.forEach((txnGroup, key) => {
    if (txnGroup.length > 1) {
      groups.push({
        transactionIds: txnGroup.map((t: Transaction) => t.id),
        reason: `${txnGroup.length} transactions share the same reference, amount, and date (key: ${key.split("|").slice(0, 2).join(", ")})`,
      });
    }
  });

  return groups;
}

// ─── Reversal Detection ─────────────────────────────────────────────

function detectReversals(txns: Transaction[]): ReversalPair[] {
  const pairs: ReversalPair[] = [];
  const reversalPatterns = [
    /reversal/i, /reversed/i, /rvsl/i, /refund/i, /chargeback/i,
    /return/i, /cancel/i, /void/i, /rvs/i, /rev\//i,
  ];

  // Index by amount + currency for quick lookup — a reversal must offset an
  // original in the SAME currency (WS-6).
  const byAmount = new Map<string, Transaction[]>();
  for (const txn of txns) {
    const amt = `${parseFloat(String(txn.amount)).toFixed(2)}|${txn.currency}`;
    const existing = byAmount.get(amt) || [];
    existing.push(txn);
    byAmount.set(amt, existing);
  }

  for (const txn of txns) {
    // Check if this transaction looks like a reversal
    const isReversal = txn.isReversal ||
      reversalPatterns.some((p) => p.test(txn.description || "")) ||
      reversalPatterns.some((p) => p.test(txn.transactionRef || ""));

    if (isReversal) {
      // Look for the original transaction with same amount + currency, opposite direction
      const amt = `${parseFloat(String(txn.amount)).toFixed(2)}|${txn.currency}`;
      const candidates = byAmount.get(amt) || [];

      for (const candidate of candidates) {
        if (candidate.id === txn.id) continue;
        if (candidate.channelId !== txn.channelId) continue;
        // Opposite debit/credit direction
        if (candidate.debitCredit === txn.debitCredit) continue;
        // Original should be before the reversal
        if (new Date(candidate.transactionDate) > new Date(txn.transactionDate)) continue;

        // Check if originalTransactionRef matches
        if (txn.originalTransactionRef &&
            normalizeString(txn.originalTransactionRef) === normalizeString(candidate.transactionRef)) {
          pairs.push({
            originalId: candidate.id,
            reversalId: txn.id,
            reason: `Reversal detected: ${txn.transactionRef} reverses ${candidate.transactionRef}`,
          });
          break;
        }

        // Check if references are similar
        if (txn.transactionRef && candidate.transactionRef) {
          const sim = stringSimilarity(txn.transactionRef, candidate.transactionRef);
          if (sim > 0.7) {
            pairs.push({
              originalId: candidate.id,
              reversalId: txn.id,
              reason: `Probable reversal: ${txn.transactionRef} appears to reverse ${candidate.transactionRef} (ref similarity: ${(sim * 100).toFixed(0)}%)`,
            });
            break;
          }
        }
      }
    }
  }

  return pairs;
}

// ─── Core Matching Engine (Optimized) ───────────────────────────────

// ─── Fee/charge "noise" detection (general bank fees only) ───────────
//
// Mirrors the POC engine: in a bank-statement reconciliation, fee/charge/levy
// lines are informational and skew the result. We set them aside and flag them.
//
// CRITICAL: card-settlement fees (interchange, scheme fee, MDR, merchant
// discount, acquirer/issuer fees, settlement fees) are RELEVANT to card
// reconciliation & settlement — the guard below keeps them in the reconciliation
// even though they contain the words "fee"/"charge".
const CARD_FEE_GUARD =
  /\b(interchange|scheme fee|m\.?d\.?r\b|merchant discount|merchant service charge|card scheme|settlement fee|acquirer fee|issuer fee|chargeback fee|cashback)\b/i;

const RECON_NOISE_PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "Tax, levy or duty", re: /\b(v\.?a\.?t|w\.?h\.?t|withholding tax|stamp duty|e\.?m\.?t\.?l|electronic money transfer levy|cbn levy|levy|excise duty)\b/i },
  { reason: "Account maintenance fee", re: /\b(account maintenance|maintenance (fee|charge)|a\.?m\.?f\b|ledger fee|c\.?o\.?t\b|commission on turnover)\b/i },
  { reason: "Card / channel fee", re: /\b(sms( alert| charge| fee)?|e-?alert|alert (fee|charge)|atm (fee|charge)|hardware token|token fee|ussd (fee|charge))\b/i },
  { reason: "Bank charge / commission", re: /\b(bank charge|service (charge|fee)|processing fee|handling fee|transaction (fee|charge)|transfer (fee|charge)|nip (fee|charge)|neft (fee|charge)|rtgs (fee|charge)|management fee|commission)\b/i },
  { reason: "Bank-generated charge", re: /\bmisc\.?\s+.*\b(charge|fee|levy|duty|tax|commission)\b/i },
  { reason: "Possible fee / charge (review)", re: /\b(fees?|charges?)\b/i },
];

/** Classify a transaction as reconcilable or general-bank-fee noise (with reason). */
export function detectReconciliationNoise(
  txn: { description?: string | null; transactionRef?: string | null },
): { noise: boolean; reason: string } {
  const text = `${txn.description ?? ""} ${txn.transactionRef ?? ""}`.toLowerCase();
  if (!text.trim()) return { noise: false, reason: "" };
  // Card-settlement fees are part of card reconciliation — never set them aside.
  if (CARD_FEE_GUARD.test(text)) return { noise: false, reason: "" };
  for (const p of RECON_NOISE_PATTERNS) {
    if (p.re.test(text)) return { noise: true, reason: p.reason };
  }
  return { noise: false, reason: "" };
}

function partitionReconNoise(txns: Transaction[], side: "source" | "target"): { kept: Transaction[]; excluded: ExcludedFee[] } {
  const kept: Transaction[] = [];
  const excluded: ExcludedFee[] = [];
  for (const t of txns) {
    const { noise, reason } = detectReconciliationNoise(t);
    if (noise) {
      excluded.push({
        transactionId: t.id,
        side,
        amount: parseFloat(String(t.amount)) || 0,
        reference: t.transactionRef ?? null,
        description: t.description ?? null,
        reason,
      });
    } else {
      kept.push(t);
    }
  }
  return { kept, excluded };
}

export function runMatchingEngine(
  sourceTxns: Transaction[],
  targetTxns: Transaction[],
  config: ReconciliationConfig
): ReconciliationResult {
  const startTime = Date.now();

  // Set aside fee/charge noise BEFORE matching so it can't skew totals/matching.
  // Opt-in (default off) — the POC engine does its own partitioning and must not
  // double-exclude; the main reconciliation flow passes excludeFeeNoise: true.
  let excluded: ExcludedFee[] = [];
  if (config.excludeFeeNoise) {
    const sp = partitionReconNoise(sourceTxns, "source");
    const tp = partitionReconNoise(targetTxns, "target");
    sourceTxns = sp.kept;
    targetTxns = tp.kept;
    excluded = [...sp.excluded, ...tp.excluded];
  }
  const matchedSourceIds = new Set<number>();
  const matchedTargetIds = new Set<number>();
  const allMatches: MatchCandidate[] = [];

  // Build hash indexes for O(1) lookups
  const targetIndex = buildIndex(targetTxns);

  // Pre-parse each target's amount (number) and date (epoch ms) once.
  const tgtAmtById = new Map<number, number>();
  const tgtDateMsById = new Map<number, number>();
  for (const t of targetTxns) {
    tgtAmtById.set(t.id, parseFloat(String(t.amount)));
    tgtDateMsById.set(t.id, new Date(t.transactionDate).getTime());
  }

  // Pass 2 index: bucket targets by calendar day, and within each day keep them sorted by
  // amount. Pass 2 scans only the ±dateWindow day buckets and binary-searches the amount
  // band inside each — so it visits only targets that can match on BOTH amount and date,
  // instead of every target in the amount band across the whole period (the real Pass 2
  // cost: dense amount bands meant hundreds of same-amount candidates were visited per
  // source only to be rejected on date).
  const dayBuckets = new Map<number, Transaction[]>();
  for (const t of targetTxns) {
    const day = Math.floor((tgtDateMsById.get(t.id) as number) / MS_PER_DAY);
    let arr = dayBuckets.get(day);
    if (!arr) {
      arr = [];
      dayBuckets.set(day, arr);
    }
    arr.push(t);
  }
  const dayAmountIndex = new Map<number, { nums: number[]; txns: Transaction[] }>();
  dayBuckets.forEach((arr, day) => {
    arr.sort((a, b) => (tgtAmtById.get(a.id) as number) - (tgtAmtById.get(b.id) as number));
    dayAmountIndex.set(day, { nums: arr.map((t) => tgtAmtById.get(t.id) as number), txns: arr });
  });

  let pass1Count = 0;
  let pass2Count = 0;
  let pass3Count = 0;

  // ── Pass 1: Exact reference match (O(n) with hash index) ──────────
  for (const src of sourceTxns) {
    if (matchedSourceIds.has(src.id)) continue;
    if (!src.transactionRef) continue;

    const normRef = normalizeString(src.transactionRef);
    if (!normRef) continue;

    const candidates = targetIndex.byRef.get(normRef);
    if (!candidates) continue;

    for (const tgt of candidates) {
      if (matchedTargetIds.has(tgt.id)) continue;
      // Within-currency only (WS-6): a same-ref cross-currency pair is an FX
      // leg, not a match — leaving both sides unmatched routes them to
      // categorizeException's fx_rate_variance / currency_mismatch analysis.
      if (src.currency !== tgt.currency) continue;
      const srcAmt = parseFloat(String(src.amount));
      const tgtAmt = parseFloat(String(tgt.amount));
      if (srcAmt === tgtAmt) {
        allMatches.push({
          sourceId: src.id,
          targetId: tgt.id,
          matchType: "exact",
          confidenceScore: 100,
          amountDifference: 0,
          dateDifference: daysDifference(new Date(src.transactionDate), new Date(tgt.transactionDate)),
          matchReason: `Exact reference match: ${src.transactionRef}`,
        });
        matchedSourceIds.add(src.id);
        matchedTargetIds.add(tgt.id);
        pass1Count++;
        break;
      }
    }
  }

  // ── Pass 2: Amount tolerance + date window (hash-assisted) ────────
  for (const src of sourceTxns) {
    if (matchedSourceIds.has(src.id)) continue;
    const srcAmt = parseFloat(String(src.amount));
    const srcDateMs = new Date(src.transactionDate).getTime();
    let bestCandidate: MatchCandidate | null = null;

    // Scan only the target amounts within the tolerance band [srcAmt-band, srcAmt+band]
    // using binary search over the pre-sorted amount index. The band is widened slightly
    // (×1.5 + 0.01) so it is a strict superset of anything that can satisfy the exact
    // `amtDiffPct <= tolerance` predicate below — results are identical to a full scan,
    // but cost is O(log n + band size) instead of O(amount). Previously this enumerated
    // every 0.01 increment, which built a Set of ~srcAmt entries and threw RangeError
    // ("Set maximum size exceeded") for amounts above ~₦16.78m.
    const band = srcAmt * config.amountTolerance * 1.5 + 0.01;
    const lo = srcAmt - band;
    const hi = srcAmt + band;
    const srcDay = Math.floor(srcDateMs / MS_PER_DAY);
    // +1 covers the day-bucket boundary; the exact dateDiff check below stays authoritative,
    // so a slightly wider day sweep only adds a few candidates that get filtered — never
    // changes which pairs match.
    const dayRadius = Math.ceil(config.dateWindowDays) + 1;

    // Pick the best candidate by amount+date "base" confidence during the scan. Reference
    // similarity is a Levenshtein distance, but it only adds a ≤5-point nudge and never
    // decides whether a pair qualifies — so we defer it and compute it once, for the winner,
    // after the scan. Each target lives in exactly one day bucket and the buckets swept are
    // distinct, so no target is visited twice (no de-dup Set needed).
    let bestBase = -1;
    let bestTgt: Transaction | null = null;
    let bestAmtDiffPct = 0;
    let bestDateDiff = 0;

    for (let day = srcDay - dayRadius; day <= srcDay + dayRadius; day++) {
      const bucket = dayAmountIndex.get(day);
      if (!bucket) continue;
      const { nums, txns } = bucket;

      for (let ai = lowerBound(nums, lo); ai < nums.length && nums[ai] <= hi; ai++) {
        const tgt = txns[ai];
        if (matchedTargetIds.has(tgt.id)) continue;
        // Within-currency only (WS-6): numeric closeness across currencies is
        // meaningless — 500 USD must never tolerance-match 500 NGN.
        if (src.currency !== tgt.currency) continue;

        const amtDiffPct = amountDifferencePercent(srcAmt, nums[ai]);
        if (amtDiffPct > config.amountTolerance) continue;
        const dateDiff = Math.abs(srcDateMs - (tgtDateMsById.get(tgt.id) as number)) / MS_PER_DAY;
        if (dateDiff > config.dateWindowDays) continue;

        const base =
          70 +
          (1 - amtDiffPct / config.amountTolerance) * 15 +
          (1 - dateDiff / config.dateWindowDays) * 10;

        if (base > bestBase) {
          bestBase = base;
          bestTgt = tgt;
          bestAmtDiffPct = amtDiffPct;
          bestDateDiff = dateDiff;
        }
      }
    }

    if (bestTgt) {
      let confidence = bestBase;
      if (src.transactionRef && bestTgt.transactionRef) {
        confidence += stringSimilarity(src.transactionRef, bestTgt.transactionRef) * 5;
      }
      confidence = Math.min(99, Math.round(confidence * 100) / 100);
      const matchType = bestAmtDiffPct === 0 ? "date_window" : "amount_tolerance";
      const bestTgtAmt = tgtAmtById.get(bestTgt.id) ?? parseFloat(String(bestTgt.amount));
      bestCandidate = {
        sourceId: src.id,
        targetId: bestTgt.id,
        matchType,
        confidenceScore: confidence,
        amountDifference: Math.round((srcAmt - bestTgtAmt) * 100) / 100,
        dateDifference: Math.round(bestDateDiff * 100) / 100,
        matchReason: `${matchType === "date_window" ? "Date window" : "Amount tolerance"} match: amount diff ${(bestAmtDiffPct * 100).toFixed(2)}%, date diff ${bestDateDiff.toFixed(1)} days`,
      };
    }

    if (bestCandidate) {
      allMatches.push(bestCandidate);
      matchedSourceIds.add(bestCandidate.sourceId);
      matchedTargetIds.add(bestCandidate.targetId);
      pass2Count++;
    }
  }

  // ── Pass 3: Fuzzy matching on description/counterparty ────────────
  // Only run on remaining unmatched (typically small set)
  const unmatchedSources = sourceTxns.filter((t) => !matchedSourceIds.has(t.id));
  const unmatchedTargets = targetTxns.filter((t) => !matchedTargetIds.has(t.id));

  for (const src of unmatchedSources) {
    let bestCandidate: MatchCandidate | null = null;

    for (const tgt of unmatchedTargets) {
      if (matchedTargetIds.has(tgt.id)) continue;
      // Within-currency only (WS-6).
      if (src.currency !== tgt.currency) continue;

      const srcAmt = parseFloat(String(src.amount));
      const tgtAmt = parseFloat(String(tgt.amount));
      const amtDiffPct = amountDifferencePercent(srcAmt, tgtAmt);

      // Wider tolerance for fuzzy
      if (amtDiffPct > config.amountTolerance * 2) continue;

      const descSim = stringSimilarity(src.description || "", tgt.description || "");
      const counterSim = stringSimilarity(src.counterparty || "", tgt.counterparty || "");
      const combinedSim = Math.max(descSim, counterSim);

      if (combinedSim > 0.6) {
        let confidence = 50 + combinedSim * 30;
        confidence -= amtDiffPct * 100;
        confidence = Math.max(50, Math.min(85, Math.round(confidence * 100) / 100));

        if (!bestCandidate || confidence > bestCandidate.confidenceScore) {
          bestCandidate = {
            sourceId: src.id,
            targetId: tgt.id,
            matchType: "fuzzy",
            confidenceScore: confidence,
            amountDifference: Math.round((srcAmt - tgtAmt) * 100) / 100,
            dateDifference: daysDifference(new Date(src.transactionDate), new Date(tgt.transactionDate)),
            matchReason: `Fuzzy match: description similarity ${(combinedSim * 100).toFixed(0)}%`,
          };
        }
      }
    }

    if (bestCandidate) {
      allMatches.push(bestCandidate);
      matchedSourceIds.add(bestCandidate.sourceId);
      matchedTargetIds.add(bestCandidate.targetId);
      pass3Count++;
    }
  }

  // ── Detect duplicates and reversals ───────────────────────────────
  const allTxns = [...sourceTxns, ...targetTxns];
  const duplicates = detectDuplicates(allTxns);
  const reversals = detectReversals(allTxns);

  const unmatchedSource = sourceTxns.filter((t) => !matchedSourceIds.has(t.id)).map((t) => t.id);
  const unmatchedTarget = targetTxns.filter((t) => !matchedTargetIds.has(t.id)).map((t) => t.id);

  const processingTimeMs = Date.now() - startTime;

  return {
    matches: allMatches,
    unmatchedSource,
    unmatchedTarget,
    duplicates,
    reversals,
    stats: {
      totalSourceTxns: sourceTxns.length,
      totalTargetTxns: targetTxns.length,
      pass1ExactMatches: pass1Count,
      pass2ToleranceMatches: pass2Count,
      pass3FuzzyMatches: pass3Count,
      duplicatesDetected: duplicates.reduce((sum, g) => sum + g.transactionIds.length, 0),
      reversalsDetected: reversals.length,
      processingTimeMs,
    },
    excluded,
  };
}

// ─── Exception Categorization ────────────────────────────────────────

export function categorizeException(
  txn: Transaction,
  allTargetTxns: Transaction[],
  config: ReconciliationConfig
): {
  category: "missing_counterparty" | "amount_mismatch" | "timing_difference" | "duplicate_transaction" | "unmatched" | "reversal_unmatched" | "currency_mismatch" | "fx_rate_variance" | "format_error";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestedResolution: string;
} {
  const txnAmt = parseFloat(String(txn.amount));
  const txnDate = new Date(txn.transactionDate);

  // Check for reversal that couldn't be matched
  const reversalPatterns = [/reversal/i, /reversed/i, /rvsl/i, /refund/i, /chargeback/i];
  if (txn.isReversal || reversalPatterns.some((p) => p.test(txn.description || "") || p.test(txn.transactionRef || ""))) {
    return {
      category: "reversal_unmatched",
      severity: "high",
      description: `Reversal transaction ${txn.transactionRef || txn.id} (${txn.currency} ${txnAmt}) has no matching original transaction.`,
      suggestedResolution: `Investigate the original transaction for this reversal. Check if it was processed in a different channel or time period. Nigerian NIP reversals should be traced through the NIBSS switch.`,
    };
  }

  // Cross-currency, same reference: two legs of one FX transaction (WS-6).
  //   amounts equal   → currency_mismatch (a currency-code booking error — the
  //                     same number cannot be both currencies)
  //   amounts differ  → fx_rate_variance: cite the implied rate and the
  //                     transaction-date gap (settlement-date vs
  //                     transaction-date rate movement is the usual driver)
  for (const tgt of allTargetTxns) {
    if (txn.currency !== tgt.currency) {
      const tgtAmt = parseFloat(String(tgt.amount));
      if (txn.transactionRef && tgt.transactionRef &&
          normalizeString(txn.transactionRef) === normalizeString(tgt.transactionRef)) {
        if (Math.abs(txnAmt - tgtAmt) < 0.01) {
          return {
            category: "currency_mismatch",
            severity: "high",
            description: `Transaction ${txn.transactionRef} is booked as ${txn.currency} ${txnAmt} on one side and ${tgt.currency} ${tgtAmt} on the other — identical amounts in different currencies indicate a currency-code booking error, not a conversion.`,
            suggestedResolution: `Confirm the true transaction currency from the source document and correct the mis-booked leg. Identical numeric amounts across currencies are almost never a genuine FX conversion.`,
          };
        }
        const bigger = Math.max(txnAmt, tgtAmt);
        const smaller = Math.min(txnAmt, tgtAmt);
        const impliedRate = smaller > 0 ? bigger / smaller : 0;
        const dateGapDays = Math.round(daysDifference(txnDate, new Date(tgt.transactionDate)) * 10) / 10;
        return {
          category: "fx_rate_variance",
          severity: bigger >= 1_000_000 ? "high" : "medium",
          description:
            `FX rate variance on ${txn.transactionRef}: ${txn.currency} ${txnAmt.toLocaleString()} vs ${tgt.currency} ${tgtAmt.toLocaleString()} ` +
            `(implied rate ≈ ${impliedRate.toFixed(4)}), transaction dates ${dateGapDays} day(s) apart. ` +
            `The variance profile matches an exchange-rate movement between the transaction date and the settlement date.`,
          suggestedResolution:
            `1. Retrieve the applicable rate for BOTH dates from the rate source governing this flow (CBN/NAFEM for NGN legs; the contract or deal-slip rate for correspondent-bank settlements). ` +
            `2. If the implied rate ≈ the settlement-date rate, the difference is rate movement: post it to the FX revaluation GL and match on the converted amount. ` +
            `3. If the implied rate matches neither date's rate, dispute the conversion with the counterparty/processor. ` +
            `4. Record the confirmed rate and dates in the resolution note — it trains the recommendation for the next variance on this corridor.`,
        };
      }
    }
  }

  // Check for near-amount matches (amount mismatch)
  for (const tgt of allTargetTxns) {
    if (txn.currency !== tgt.currency) continue;
    const tgtAmt = parseFloat(String(tgt.amount));
    const amtDiffPct = amountDifferencePercent(txnAmt, tgtAmt);
    if (amtDiffPct > config.amountTolerance && amtDiffPct < config.amountTolerance * 5) {
      const dateDiff = daysDifference(txnDate, new Date(tgt.transactionDate));
      if (dateDiff <= config.dateWindowDays * 2) {
        return {
          category: "amount_mismatch",
          severity: amtDiffPct > config.amountTolerance * 3 ? "high" : "medium",
          description: `Amount mismatch of ${(amtDiffPct * 100).toFixed(2)}% with transaction ${tgt.transactionRef || tgt.id}. Source: ${txn.currency} ${txnAmt}, Target: ${tgt.currency} ${tgtAmt}`,
          suggestedResolution: `Review the amount difference of ${Math.abs(txnAmt - tgtAmt).toFixed(2)} ${txn.currency}. Common causes: bank charges, VAT, stamp duty, or rounding. For Nigerian transactions, check for CBN-mandated charges.`,
        };
      }
    }
  }

  // Check for timing differences
  for (const tgt of allTargetTxns) {
    if (txn.currency !== tgt.currency) continue;
    const tgtAmt = parseFloat(String(tgt.amount));
    if (Math.abs(txnAmt - tgtAmt) < 0.01) {
      const dateDiff = daysDifference(txnDate, new Date(tgt.transactionDate));
      if (dateDiff > config.dateWindowDays && dateDiff <= config.dateWindowDays * 3) {
        return {
          category: "timing_difference",
          severity: "low",
          description: `Timing difference of ${dateDiff.toFixed(1)} days with transaction ${tgt.transactionRef || tgt.id}. Amounts match exactly.`,
          suggestedResolution: `Settlement timing issue. The amounts match but dates differ by ${dateDiff.toFixed(1)} days. Common in Nigerian interbank transfers (T+1 to T+3 settlement). Consider extending the date window or manually matching.`,
        };
      }
    }
  }

  // Check for missing counterparty
  if (!txn.counterparty || txn.counterparty.trim() === "") {
    return {
      category: "missing_counterparty",
      severity: "medium",
      description: `Transaction ${txn.transactionRef || txn.id} has no counterparty information, making automated matching impossible.`,
      suggestedResolution: `Add counterparty information from the original source system. For NIBSS transactions, the counterparty should be available from the NIP response.`,
    };
  }

  // Default: unmatched
  return {
    category: "unmatched",
    severity: txnAmt > 1000000 ? "high" : "medium", // High severity for large amounts
    description: `No matching transaction found for ${txn.transactionRef || txn.id} (${txn.currency} ${txnAmt.toLocaleString()}) on ${txnDate.toISOString().split("T")[0]}.`,
    suggestedResolution: `Investigate whether the counterparty transaction exists in a different channel or time period. For Nigerian banking, check NIBSS Instant Payment (NIP) logs and the bank's core banking system.`,
  };
}

// ─── AI Analysis for Complex Exceptions ──────────────────────────────

export async function getAIAnalysis(
  exception: { category: string; description: string },
  transaction: Transaction,
  // Optional flywheel context woven into the prompt so recommendations reflect
  // the institution's own history and the anonymised cross-institution network.
  // Both strings are purely categorical (no PII / no org identifiers) — see
  // institutionalLearning.formatNetworkGuidance / institutionalMemoryNote.
  context?: { institutionalGuidance?: string; networkGuidance?: string }
): Promise<string> {
  try {
    const guidanceBlocks = [context?.institutionalGuidance, context?.networkGuidance]
      .filter((g): g is string => !!g && g.length > 0);
    const guidanceSection = guidanceBlocks.length > 0
      ? `\n\nUse the following prior-resolution evidence to make the recommendation more specific and consistent with how this exception has been handled before:\n${guidanceBlocks.join("\n\n")}`
      : "";

    // FX-specific diagnosis context (WS-6): rate-source knowledge per currency
    // corridor so the recommendation names WHERE to verify the rate, not just
    // "check the rate".
    const fxContext = exception.category === "fx_rate_variance"
      ? " This is an FX rate variance: two legs of one transaction in different currencies whose implied rate needs verification against the transaction-date AND settlement-date rates. Rate sources: NGN legs settle against CBN/NAFEM (Nigerian Autonomous Foreign Exchange Market) rates; UGX legs against Bank of Uganda reference rates; USD/EUR/GBP correspondent settlements against the contract or deal-slip rate. If the implied rate matches the settlement-date rate, the variance is legitimate rate movement (post to the FX revaluation GL); if it matches neither date, it is a conversion error to dispute."
      : "";

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a financial reconciliation expert specializing in African banking systems (NIBSS, NIP, POS, mobile money, RTGS, SWIFT). Analyze the following exception and provide a brief, actionable recommendation (2-3 sentences max). Reference specific Nigerian/African banking regulations or processes where relevant. Focus on practical steps the reconciliation team should take.${fxContext}${guidanceBlocks.length > 0 ? " When prior-resolution evidence is provided, prefer the approach it shows and note that it reflects established practice." : ""}`,
        },
        {
          role: "user",
          content: `Exception Category: ${exception.category}
Description: ${exception.description}
Transaction Reference: ${transaction.transactionRef || "N/A"}
Amount: ${transaction.currency} ${transaction.amount}
Date: ${transaction.transactionDate}
Channel: Channel ID ${transaction.channelId}
Counterparty: ${transaction.counterparty || "N/A"}
Direction: ${transaction.debitCredit}${guidanceSection}

Provide a brief analysis and recommended action.`,
        },
      ],
    });
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "AI analysis unavailable.";
  } catch (error) {
    console.error("[AI Analysis] Failed:", error);
    return "AI analysis temporarily unavailable. Please review manually.";
  }
}
