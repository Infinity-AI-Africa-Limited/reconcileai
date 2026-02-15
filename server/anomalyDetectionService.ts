/**
 * AI-Powered Anomaly Detection Service
 * 
 * Multi-layered detection system:
 * 1. Statistical: Z-score and IQR for amount outliers
 * 2. Pattern-based: Time patterns, frequency spikes, counterparty anomalies
 * 3. LLM-based: Semantic analysis of transaction descriptions
 * 4. Ensemble: Weighted combination of all methods
 */

import { invokeLLM } from "./_core/llm";
import type { Transaction } from "../drizzle/schema";

// ─── Statistical Detection ──────────────────────────────────────────

/**
 * Calculate Z-score for amount outliers
 * Z-score > 3 indicates significant outlier (99.7% confidence)
 */
export function calculateZScore(amount: number, amounts: number[]): number {
  if (amounts.length < 3) return 0;
  
  const mean = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;
  const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;
  return Math.abs((amount - mean) / stdDev);
}

/**
 * Calculate IQR (Interquartile Range) outlier score
 * Values beyond 1.5 * IQR from Q1/Q3 are considered outliers
 */
export function calculateIQRScore(amount: number, amounts: number[]): number {
  if (amounts.length < 4) return 0;
  
  const sorted = [...amounts].sort((a, b) => a - b);
  const q1Index = Math.floor(sorted.length * 0.25);
  const q3Index = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;
  
  if (iqr === 0) return 0;
  
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  
  if (amount < lowerBound) {
    return Math.min(1, (lowerBound - amount) / iqr);
  } else if (amount > upperBound) {
    return Math.min(1, (amount - upperBound) / iqr);
  }
  return 0;
}

/**
 * Detect amount outliers using ensemble of Z-score and IQR
 */
export async function detectAmountOutliers(
  transactions: Transaction[],
  threshold: number = 0.7
): Promise<Map<number, { score: number; reason: string; method: string }>> {
  const anomalies = new Map<number, { score: number; reason: string; method: string }>();
  
  if (transactions.length < 10) return anomalies; // Need sufficient data
  
  const amounts = transactions.map(t => parseFloat(t.amount));
  
  transactions.forEach((txn, index) => {
    const amount = amounts[index];
    const zScore = calculateZScore(amount, amounts);
    const iqrScore = calculateIQRScore(amount, amounts);
    
    // Ensemble score: weighted average
    const score = (zScore / 5) * 0.6 + iqrScore * 0.4; // Normalize Z-score to 0-1 range
    
    if (score >= threshold) {
      anomalies.set(txn.id, {
        score: Math.min(1, score),
        reason: `Amount ${amount} is a statistical outlier (Z-score: ${zScore.toFixed(2)}, IQR score: ${iqrScore.toFixed(2)})`,
        method: zScore > 3 ? "statistical_zscore" : "statistical_iqr",
      });
    }
  });
  
  return anomalies;
}

// ─── Pattern-Based Detection ────────────────────────────────────────

/**
 * Detect unusual time patterns (transactions at odd hours)
 */
export async function detectTimePatternAnomalies(
  transactions: Transaction[],
  threshold: number = 0.6
): Promise<Map<number, { score: number; reason: string; method: string }>> {
  const anomalies = new Map<number, { score: number; reason: string; method: string }>();
  
  // Build hour distribution
  const hourCounts = new Array(24).fill(0);
  transactions.forEach(txn => {
    const hour = new Date(txn.transactionDate).getHours();
    hourCounts[hour]++;
  });
  
  const totalTxns = transactions.length;
  const avgPerHour = totalTxns / 24;
  
  transactions.forEach(txn => {
    const hour = new Date(txn.transactionDate).getHours();
    const hourCount = hourCounts[hour];
    const hourFreq = hourCount / totalTxns;
    
    // Flag transactions in hours with <5% of total volume (unusual hours)
    if (hourFreq < 0.05 && (hour < 6 || hour > 22)) {
      const score = 1 - (hourFreq / 0.05); // Higher score for rarer hours
      if (score >= threshold) {
        anomalies.set(txn.id, {
          score: Math.min(1, score),
          reason: `Transaction at unusual hour (${hour}:00, only ${(hourFreq * 100).toFixed(1)}% of transactions occur at this time)`,
          method: "pattern_time",
        });
      }
    }
  });
  
  return anomalies;
}

/**
 * Detect frequency spikes (sudden increase in transaction volume)
 */
export async function detectFrequencySpikes(
  transactions: Transaction[],
  threshold: number = 0.7
): Promise<Map<number, { score: number; reason: string; method: string }>> {
  const anomalies = new Map<number, { score: number; reason: string; method: string }>();
  
  if (transactions.length < 20) return anomalies;
  
  // Group by counterparty and calculate frequency
  const counterpartyFreq = new Map<string, number>();
  transactions.forEach(txn => {
    const cp = txn.counterparty || "UNKNOWN";
    counterpartyFreq.set(cp, (counterpartyFreq.get(cp) || 0) + 1);
  });
  
  const frequencies = Array.from(counterpartyFreq.values());
  const avgFreq = frequencies.reduce((sum, f) => sum + f, 0) / frequencies.length;
  const stdDev = Math.sqrt(
    frequencies.reduce((sum, f) => sum + Math.pow(f - avgFreq, 2), 0) / frequencies.length
  );
  
  transactions.forEach(txn => {
    const cp = txn.counterparty || "UNKNOWN";
    const freq = counterpartyFreq.get(cp) || 0;
    
    // Flag if frequency is > 2 std deviations above mean
    if (stdDev > 0 && freq > avgFreq + 2 * stdDev) {
      const zScore = (freq - avgFreq) / stdDev;
      const score = Math.min(1, zScore / 5);
      
      if (score >= threshold) {
        anomalies.set(txn.id, {
          score,
          reason: `Counterparty "${cp}" has unusually high transaction frequency (${freq} transactions, ${zScore.toFixed(1)}σ above mean)`,
          method: "pattern_frequency",
        });
      }
    }
  });
  
  return anomalies;
}

/**
 * Detect counterparty anomalies (new or rare counterparties with large amounts)
 */
export async function detectCounterpartyAnomalies(
  transactions: Transaction[],
  historicalTransactions: Transaction[],
  threshold: number = 0.65
): Promise<Map<number, { score: number; reason: string; method: string }>> {
  const anomalies = new Map<number, { score: number; reason: string; method: string }>();
  
  // Build historical counterparty set
  const knownCounterparties = new Set(
    historicalTransactions.map(t => t.counterparty || "UNKNOWN")
  );
  
  const amounts = transactions.map(t => parseFloat(t.amount));
  const medianAmount = amounts.sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
  
  transactions.forEach(txn => {
    const cp = txn.counterparty || "UNKNOWN";
    const amount = parseFloat(txn.amount);
    
    // Flag new counterparties with above-median amounts
    if (!knownCounterparties.has(cp) && amount > medianAmount) {
      const amountRatio = amount / medianAmount;
      const score = Math.min(1, 0.5 + (amountRatio - 1) * 0.2); // Base 0.5 for new CP, +0.2 per 1x median
      
      if (score >= threshold) {
        anomalies.set(txn.id, {
          score,
          reason: `New counterparty "${cp}" with large amount (${amount.toFixed(2)}, ${amountRatio.toFixed(1)}x median)`,
          method: "pattern_counterparty",
        });
      }
    }
  });
  
  return anomalies;
}

// ─── LLM-Based Semantic Detection ───────────────────────────────────

/**
 * Use LLM to analyze transaction descriptions for suspicious patterns
 */
export async function detectSuspiciousDescriptions(
  transactions: Transaction[],
  threshold: number = 0.7
): Promise<Map<number, { score: number; reason: string; method: string }>> {
  const anomalies = new Map<number, { score: number; reason: string; method: string }>();
  
  // Filter transactions with descriptions
  const txnsWithDesc = transactions.filter(t => t.description && t.description.trim().length > 5);
  
  if (txnsWithDesc.length === 0) return anomalies;
  
  // Batch process in groups of 20 to avoid token limits
  const batchSize = 20;
  for (let i = 0; i < txnsWithDesc.length; i += batchSize) {
    const batch = txnsWithDesc.slice(i, i + batchSize);
    
    const prompt = `You are a financial fraud detection AI. Analyze these transaction descriptions and identify any that seem suspicious, fraudulent, or unusual for a legitimate banking reconciliation system.

For each transaction, assign a suspicion score from 0.0 (normal) to 1.0 (highly suspicious).

Suspicious patterns include:
- Test transactions or dummy data
- Unusual payment purposes (gambling, crypto, money laundering keywords)
- Vague or generic descriptions
- Typos or formatting that suggests automation/scripts
- Round amounts with suspicious descriptions
- References to cash, bearer instruments, or anonymous transfers

Transactions:
${batch.map((t, idx) => `${idx + 1}. ID: ${t.id}, Amount: ${t.amount} ${t.currency}, Description: "${t.description}"`).join("\n")}

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "results": [
    { "id": <transaction_id>, "score": <0.0-1.0>, "reason": "<brief explanation>" }
  ]
}`;

    try {
      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a financial fraud detection expert. Respond only with valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "anomaly_detection",
            strict: true,
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      score: { type: "number" },
                      reason: { type: "string" },
                    },
                    required: ["id", "score", "reason"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["results"],
              additionalProperties: false,
            },
          },
        },
      });
      
      const content = response.choices[0].message.content;
      if (!content || typeof content !== 'string') continue;
      
      const parsed = JSON.parse(content);
      parsed.results.forEach((result: { id: number; score: number; reason: string }) => {
        if (result.score >= threshold) {
          anomalies.set(result.id, {
            score: result.score,
            reason: result.reason,
            method: "llm_semantic",
          });
        }
      });
    } catch (error) {
      console.error("LLM anomaly detection error:", error);
      // Continue with other batches
    }
  }
  
  return anomalies;
}

// ─── Ensemble Detection ─────────────────────────────────────────────

export interface AnomalyDetectionConfig {
  enableStatistical?: boolean;
  enableTimePattern?: boolean;
  enableFrequency?: boolean;
  enableCounterparty?: boolean;
  enableLLM?: boolean;
  thresholds?: {
    statistical?: number;
    timePattern?: number;
    frequency?: number;
    counterparty?: number;
    llm?: number;
    ensemble?: number;
  };
  weights?: {
    statistical?: number;
    timePattern?: number;
    frequency?: number;
    counterparty?: number;
    llm?: number;
  };
}

export interface AnomalyResult {
  transactionId: number;
  anomalyScore: number;
  detectionMethod: string;
  detectionReason: string;
  detectionMetadata: {
    methods: Array<{ method: string; score: number; reason: string }>;
  };
}

/**
 * Run ensemble anomaly detection combining all methods
 */
export async function detectAnomalies(
  transactions: Transaction[],
  historicalTransactions: Transaction[] = [],
  config: AnomalyDetectionConfig = {}
): Promise<AnomalyResult[]> {
  const {
    enableStatistical = true,
    enableTimePattern = true,
    enableFrequency = true,
    enableCounterparty = true,
    enableLLM = true,
    thresholds = {
      statistical: 0.7,
      timePattern: 0.6,
      frequency: 0.7,
      counterparty: 0.65,
      llm: 0.7,
      ensemble: 0.6,
    },
    weights = {
      statistical: 0.3,
      timePattern: 0.15,
      frequency: 0.2,
      counterparty: 0.15,
      llm: 0.2,
    },
  } = config;
  
  // Run all detection methods in parallel
  const [
    amountAnomalies,
    timeAnomalies,
    frequencyAnomalies,
    counterpartyAnomalies,
    llmAnomalies,
  ] = await Promise.all([
    enableStatistical ? detectAmountOutliers(transactions, thresholds.statistical!) : Promise.resolve(new Map()),
    enableTimePattern ? detectTimePatternAnomalies(transactions, thresholds.timePattern!) : Promise.resolve(new Map()),
    enableFrequency ? detectFrequencySpikes(transactions, thresholds.frequency!) : Promise.resolve(new Map()),
    enableCounterparty ? detectCounterpartyAnomalies(transactions, historicalTransactions, thresholds.counterparty!) : Promise.resolve(new Map()),
    enableLLM ? detectSuspiciousDescriptions(transactions, thresholds.llm!) : Promise.resolve(new Map()),
  ]);
  
  // Combine results with ensemble scoring
  const ensembleScores = new Map<number, AnomalyResult>();
  
  transactions.forEach(txn => {
    const methods: Array<{ method: string; score: number; reason: string }> = [];
    let weightedScore = 0;
    let totalWeight = 0;
    
    // Collect all detections for this transaction
    if (amountAnomalies.has(txn.id)) {
      const detection = amountAnomalies.get(txn.id)!;
      methods.push(detection);
      weightedScore += detection.score * weights.statistical!;
      totalWeight += weights.statistical!;
    }
    
    if (timeAnomalies.has(txn.id)) {
      const detection = timeAnomalies.get(txn.id)!;
      methods.push(detection);
      weightedScore += detection.score * weights.timePattern!;
      totalWeight += weights.timePattern!;
    }
    
    if (frequencyAnomalies.has(txn.id)) {
      const detection = frequencyAnomalies.get(txn.id)!;
      methods.push(detection);
      weightedScore += detection.score * weights.frequency!;
      totalWeight += weights.frequency!;
    }
    
    if (counterpartyAnomalies.has(txn.id)) {
      const detection = counterpartyAnomalies.get(txn.id)!;
      methods.push(detection);
      weightedScore += detection.score * weights.counterparty!;
      totalWeight += weights.counterparty!;
    }
    
    if (llmAnomalies.has(txn.id)) {
      const detection = llmAnomalies.get(txn.id)!;
      methods.push(detection);
      weightedScore += detection.score * weights.llm!;
      totalWeight += weights.llm!;
    }
    
    // Calculate ensemble score
    if (methods.length > 0) {
      const ensembleScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
      
      if (ensembleScore >= thresholds.ensemble!) {
        // Sort methods by score descending
        methods.sort((a, b) => b.score - a.score);
        
        ensembleScores.set(txn.id, {
          transactionId: txn.id,
          anomalyScore: ensembleScore,
          detectionMethod: methods.length > 1 ? "ensemble" : methods[0].method,
          detectionReason: methods.map(m => m.reason).join("; "),
          detectionMetadata: { methods },
        });
      }
    }
  });
  
  return Array.from(ensembleScores.values());
}
