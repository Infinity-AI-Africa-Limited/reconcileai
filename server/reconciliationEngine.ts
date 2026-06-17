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
}

export interface ReconciliationResult {
  matches: MatchCandidate[];
  unmatchedSource: number[];
  unmatchedTarget: number[];
  duplicates: DuplicateGroup[];
  reversals: ReversalPair[];
  stats: EngineStats;
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

function daysDifference(d1: Date, d2: Date): number {
  const ms = Math.abs(d1.getTime() - d2.getTime());
  return ms / (1000 * 60 * 60 * 24);
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
    // Key: ref + amount + date
    const ref = normalizeString(txn.transactionRef);
    const amt = parseFloat(String(txn.amount)).toFixed(2);
    const date = new Date(txn.transactionDate).toISOString().split("T")[0];
    const key = `${ref}|${amt}|${date}|${txn.channelId}`;

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

  // Index by amount for quick lookup
  const byAmount = new Map<string, Transaction[]>();
  for (const txn of txns) {
    const amt = parseFloat(String(txn.amount)).toFixed(2);
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
      // Look for the original transaction with same amount, opposite direction
      const amt = parseFloat(String(txn.amount)).toFixed(2);
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

export function runMatchingEngine(
  sourceTxns: Transaction[],
  targetTxns: Transaction[],
  config: ReconciliationConfig
): ReconciliationResult {
  const startTime = Date.now();
  const matchedSourceIds = new Set<number>();
  const matchedTargetIds = new Set<number>();
  const allMatches: MatchCandidate[] = [];

  // Build hash indexes for O(1) lookups
  const targetIndex = buildIndex(targetTxns);

  // Sorted numeric view of the target amount index, built once, for O(log n + band)
  // tolerance-band scans in Pass 2 (replaces per-source brute-force amount enumeration).
  const sortedAmountKeys = Array.from(targetIndex.byAmount.keys())
    .map((key) => ({ key, num: parseFloat(key) }))
    .sort((a, b) => a.num - b.num);
  const sortedAmountNums = sortedAmountKeys.map((e) => e.num);

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
    const srcDate = new Date(src.transactionDate);
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

    const checkedTargets = new Set<number>();
    for (let ai = lowerBound(sortedAmountNums, lo); ai < sortedAmountNums.length && sortedAmountNums[ai] <= hi; ai++) {
      const targets = targetIndex.byAmount.get(sortedAmountKeys[ai].key);
      if (!targets) continue;

      for (const tgt of targets) {
        if (matchedTargetIds.has(tgt.id)) continue;
        if (checkedTargets.has(tgt.id)) continue;
        checkedTargets.add(tgt.id);

        const tgtAmt = parseFloat(String(tgt.amount));
        const amtDiffPct = amountDifferencePercent(srcAmt, tgtAmt);
        const tgtDate = new Date(tgt.transactionDate);
        const dateDiff = daysDifference(srcDate, tgtDate);

        if (amtDiffPct <= config.amountTolerance && dateDiff <= config.dateWindowDays) {
          let confidence = 70;
          confidence += (1 - amtDiffPct / config.amountTolerance) * 15;
          confidence += (1 - dateDiff / config.dateWindowDays) * 10;
          if (src.transactionRef && tgt.transactionRef) {
            const refSim = stringSimilarity(src.transactionRef, tgt.transactionRef);
            confidence += refSim * 5;
          }
          confidence = Math.min(99, Math.round(confidence * 100) / 100);
          const matchType = amtDiffPct === 0 ? "date_window" : "amount_tolerance";

          if (!bestCandidate || confidence > bestCandidate.confidenceScore) {
            bestCandidate = {
              sourceId: src.id,
              targetId: tgt.id,
              matchType,
              confidenceScore: confidence,
              amountDifference: Math.round((srcAmt - tgtAmt) * 100) / 100,
              dateDifference: Math.round(dateDiff * 100) / 100,
              matchReason: `${matchType === "date_window" ? "Date window" : "Amount tolerance"} match: amount diff ${(amtDiffPct * 100).toFixed(2)}%, date diff ${dateDiff.toFixed(1)} days`,
            };
          }
        }
      }
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
  };
}

// ─── Exception Categorization ────────────────────────────────────────

export function categorizeException(
  txn: Transaction,
  allTargetTxns: Transaction[],
  config: ReconciliationConfig
): {
  category: "missing_counterparty" | "amount_mismatch" | "timing_difference" | "duplicate_transaction" | "unmatched" | "reversal_unmatched" | "currency_mismatch" | "format_error";
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

  // Check for currency mismatch (pan-African scenario)
  for (const tgt of allTargetTxns) {
    if (txn.currency !== tgt.currency) {
      const tgtAmt = parseFloat(String(tgt.amount));
      if (txn.transactionRef && tgt.transactionRef &&
          normalizeString(txn.transactionRef) === normalizeString(tgt.transactionRef)) {
        return {
          category: "currency_mismatch",
          severity: "high",
          description: `Transaction ${txn.transactionRef} has currency mismatch: source ${txn.currency} ${txnAmt}, target ${tgt.currency} ${tgtAmt}.`,
          suggestedResolution: `Verify the exchange rate applied. For cross-border African transactions, check the applicable CBN/central bank rate for the transaction date.`,
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
  transaction: Transaction
): Promise<string> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a financial reconciliation expert specializing in African banking systems (NIBSS, NIP, POS, mobile money, RTGS, SWIFT). Analyze the following exception and provide a brief, actionable recommendation (2-3 sentences max). Reference specific Nigerian/African banking regulations or processes where relevant. Focus on practical steps the reconciliation team should take.`,
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
Direction: ${transaction.debitCredit}

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
