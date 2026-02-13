import { Transaction, InsertMatch, InsertException } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";

// ─── Types ───────────────────────────────────────────────────────────

interface MatchCandidate {
  sourceId: number;
  targetId: number;
  matchType: "exact" | "fuzzy" | "amount_tolerance" | "date_window" | "ai_suggested";
  confidenceScore: number;
  amountDifference: number;
  dateDifference: number;
  matchReason: string;
}

interface ReconciliationConfig {
  amountTolerance: number; // e.g. 0.005 for ±0.5%
  dateWindowDays: number;  // e.g. 3 for ±3 days
}

// ─── Utility Functions ───────────────────────────────────────────────

function normalizeString(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
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
  return matrix[b.length][a.length];
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

// ─── Core Matching Engine ────────────────────────────────────────────

export function runMatchingEngine(
  sourceTxns: Transaction[],
  targetTxns: Transaction[],
  config: ReconciliationConfig
): { matches: MatchCandidate[]; unmatchedSource: number[]; unmatchedTarget: number[] } {
  const matchedSourceIds = new Set<number>();
  const matchedTargetIds = new Set<number>();
  const allMatches: MatchCandidate[] = [];

  // Pass 1: Exact reference match
  for (const src of sourceTxns) {
    if (matchedSourceIds.has(src.id)) continue;
    for (const tgt of targetTxns) {
      if (matchedTargetIds.has(tgt.id)) continue;
      if (src.transactionRef && tgt.transactionRef &&
          normalizeString(src.transactionRef) === normalizeString(tgt.transactionRef)) {
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
          break;
        }
      }
    }
  }

  // Pass 2: Amount tolerance + date window matching
  for (const src of sourceTxns) {
    if (matchedSourceIds.has(src.id)) continue;
    let bestCandidate: MatchCandidate | null = null;

    for (const tgt of targetTxns) {
      if (matchedTargetIds.has(tgt.id)) continue;

      const srcAmt = parseFloat(String(src.amount));
      const tgtAmt = parseFloat(String(tgt.amount));
      const amtDiffPct = amountDifferencePercent(srcAmt, tgtAmt);
      const srcDate = new Date(src.transactionDate);
      const tgtDate = new Date(tgt.transactionDate);
      const dateDiff = daysDifference(srcDate, tgtDate);

      if (amtDiffPct <= config.amountTolerance && dateDiff <= config.dateWindowDays) {
        // Calculate confidence score
        let confidence = 70;

        // Amount closeness bonus (up to 15 points)
        confidence += (1 - amtDiffPct / config.amountTolerance) * 15;

        // Date closeness bonus (up to 10 points)
        confidence += (1 - dateDiff / config.dateWindowDays) * 10;

        // Reference similarity bonus (up to 5 points)
        if (src.transactionRef && tgt.transactionRef) {
          const refSim = stringSimilarity(src.transactionRef, tgt.transactionRef);
          confidence += refSim * 5;
        }

        // Debit/credit direction match
        if (src.debitCredit !== tgt.debitCredit) {
          confidence += 0; // Expected for reconciliation (debit vs credit)
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

    if (bestCandidate) {
      allMatches.push(bestCandidate);
      matchedSourceIds.add(bestCandidate.sourceId);
      matchedTargetIds.add(bestCandidate.targetId);
    }
  }

  // Pass 3: Fuzzy matching on description/counterparty
  for (const src of sourceTxns) {
    if (matchedSourceIds.has(src.id)) continue;
    let bestCandidate: MatchCandidate | null = null;

    for (const tgt of targetTxns) {
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
    }
  }

  const unmatchedSource = sourceTxns.filter(t => !matchedSourceIds.has(t.id)).map(t => t.id);
  const unmatchedTarget = targetTxns.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);

  return { matches: allMatches, unmatchedSource, unmatchedTarget };
}

// ─── Exception Categorization ────────────────────────────────────────

export function categorizeException(
  txn: Transaction,
  allTargetTxns: Transaction[],
  config: ReconciliationConfig
): { category: InsertException["category"]; severity: InsertException["severity"]; description: string; suggestedResolution: string } {
  const txnAmt = parseFloat(String(txn.amount));
  const txnDate = new Date(txn.transactionDate);

  // Check for near-amount matches (amount mismatch)
  for (const tgt of allTargetTxns) {
    const tgtAmt = parseFloat(String(tgt.amount));
    const amtDiffPct = amountDifferencePercent(txnAmt, tgtAmt);
    if (amtDiffPct > config.amountTolerance && amtDiffPct < config.amountTolerance * 5) {
      const dateDiff = daysDifference(txnDate, new Date(tgt.transactionDate));
      if (dateDiff <= config.dateWindowDays * 2) {
        return {
          category: "amount_mismatch",
          severity: amtDiffPct > config.amountTolerance * 3 ? "high" : "medium",
          description: `Amount mismatch of ${(amtDiffPct * 100).toFixed(2)}% with transaction ${tgt.transactionRef || tgt.id}. Source: ${txnAmt}, Target: ${tgtAmt}`,
          suggestedResolution: `Review the amount difference of ${Math.abs(txnAmt - tgtAmt).toFixed(2)} ${txn.currency}. This may be due to fees, charges, or rounding differences.`,
        };
      }
    }
  }

  // Check for timing differences
  for (const tgt of allTargetTxns) {
    const tgtAmt = parseFloat(String(tgt.amount));
    if (Math.abs(txnAmt - tgtAmt) < 0.01) {
      const dateDiff = daysDifference(txnDate, new Date(tgt.transactionDate));
      if (dateDiff > config.dateWindowDays && dateDiff <= config.dateWindowDays * 3) {
        return {
          category: "timing_difference",
          severity: "low",
          description: `Timing difference of ${dateDiff.toFixed(1)} days with transaction ${tgt.transactionRef || tgt.id}. Amounts match exactly.`,
          suggestedResolution: `This appears to be a settlement timing issue. The amounts match but the dates differ by ${dateDiff.toFixed(1)} days. Consider extending the date window or manually matching.`,
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
      suggestedResolution: `Add counterparty information to this transaction. Check the original source system for the missing data.`,
    };
  }

  // Default: unmatched
  return {
    category: "unmatched",
    severity: "medium",
    description: `No matching transaction found for ${txn.transactionRef || txn.id} (${txn.currency} ${txnAmt}) on ${txnDate.toISOString().split("T")[0]}.`,
    suggestedResolution: `Investigate whether the counterparty transaction exists in a different channel or time period. Consider manual reconciliation.`,
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
          content: `You are a financial reconciliation expert for African banking. Analyze the following exception and provide a brief, actionable recommendation (2-3 sentences max). Focus on practical steps the reconciliation team should take.`,
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
