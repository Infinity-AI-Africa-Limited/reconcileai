/**
 * Retail Reconciliation Engine Adapter (SHOPLINE vertical)
 *
 * This adapter wraps the core reconciliation engine (reconciliationEngine.ts)
 * and adds retail-specific logic:
 *
 * 1. Retail-specific exception categorisation (chargebacks, gateway fees, FX,
 *    settlement shortfalls, refunds, voids, reserves, interchange)
 * 2. Retail-aware matching rules (order reference → settlement reference,
 *    partial captures, multi-currency DCC, marketplace payouts)
 * 3. Gateway fee validation against contracted rate schedules
 * 4. Chargeback lifecycle tracking (notification → representment → outcome)
 *
 * Architecture: This file does NOT duplicate the core matching engine. It
 * delegates to `runMatchingEngine` for the 3-pass match, then post-processes
 * the unmatched transactions through a retail-specific exception classifier.
 *
 * Phase 0 scope: Define the adapter interface and the retail exception
 * classifier. The SHOPLINE API connector (Phase 1) will feed data into this
 * adapter once the API documentation is received.
 */

import type { Transaction } from "../drizzle/schema";
import type { ReconciliationConfig, ReconciliationResult, MatchCandidate } from "./reconciliationEngine";
import { runMatchingEngine, categorizeException } from "./reconciliationEngine";
import {
  RETAIL_COMMERCE_EXCEPTIONS,
  getRetailException,
  type RetailCommerceException,
} from "./exceptions/retail-commerce";

// ─── Retail-Specific Configuration ──────────────────────────────────────────

export interface RetailReconciliationConfig extends ReconciliationConfig {
  /** Gateway fee schedule for validation (rate per card type/scheme/region) */
  feeSchedule?: GatewayFeeSchedule;
  /** Settlement cycle in business days (e.g., 1 for T+1, 2 for T+2) */
  settlementCycleDays?: number;
  /** Rolling reserve percentage (e.g., 0.05 for 5%) */
  reservePercentage?: number;
  /** FX markup tolerance above mid-market rate (e.g., 0.03 for 3%) */
  fxMarkupTolerance?: number;
  /** Whether to detect and classify chargebacks separately */
  chargebackDetection?: boolean;
  /** Merchant's base/settlement currency */
  settlementCurrency?: string;
}

export interface GatewayFeeSchedule {
  /** Fee rate by card type (e.g., { "visa_credit_domestic": 0.029, "mastercard_debit_international": 0.035 }) */
  rates: Record<string, number>;
  /** Fee tolerance for variance detection (e.g., 0.0005 for ±0.05%) */
  tolerance: number;
}

// ─── Duplicate-detection index (O(1) same-side sibling lookup) ──────────────
// Duplicate chargebacks/authorisations are two rows on the SAME feed sharing an
// ARN / order reference. Building count maps ONCE per side turns the classifier
// from O(n) scans-per-txn (O(n²) over a batch) into O(1) lookups — essential at
// the 50k-row "Scale" band where per-txn array scans would be billions of ops.
export interface RetailDupIndex {
  byArn: Map<string, number>;
  byOrderRef: Map<string, number>;
}

export function buildRetailDupIndex(txns: Transaction[]): RetailDupIndex {
  const byArn = new Map<string, number>();
  const byOrderRef = new Map<string, number>();
  for (const t of txns) {
    const raw = (t.rawData as Record<string, unknown>) ?? {};
    const arn = raw.chargebackArn;
    if (typeof arn === "string" && arn) byArn.set(arn, (byArn.get(arn) ?? 0) + 1);
    const ref = raw.originalOrderRef;
    if (typeof ref === "string" && ref) byOrderRef.set(ref, (byOrderRef.get(ref) ?? 0) + 1);
  }
  return { byArn, byOrderRef };
}

// ─── Retail Exception Classification ────────────────────────────────────────

export interface RetailExceptionResult {
  /** The retail exception category key (maps to RESOLUTION_TEMPLATE_CATEGORIES) */
  category: string;
  /** Severity level */
  severity: "critical" | "high" | "medium" | "low";
  /** Human-readable description of the exception */
  description: string;
  /** Recommended resolution steps */
  suggestedResolution: string;
  /** SLA hours from the taxonomy (for dashboard display) */
  slaHours: number;
  /** Whether this exception has a full taxonomy entry (vs fallback to core engine) */
  hasRetailTaxonomy: boolean;
}

/**
 * Classify an unmatched retail transaction into the retail exception taxonomy.
 *
 * This function examines the transaction's metadata (rawData field) to determine
 * which retail-specific exception category applies. If no retail-specific category
 * matches, it falls back to the core engine's `categorizeException`.
 *
 * The rawData field for retail transactions is expected to contain gateway-specific
 * metadata injected by the SHOPLINE connector (Phase 1), including:
 * - `gatewayEventType`: "payment" | "refund" | "chargeback" | "payout" | "fee" | "reserve"
 * - `originalOrderRef`: The merchant's order reference
 * - `gatewayRef`: The gateway's unique transaction reference
 * - `cardScheme`: "visa" | "mastercard" | "amex" | "unionpay" | etc.
 * - `cardType`: "credit" | "debit" | "prepaid"
 * - `cardRegion`: "domestic" | "international"
 * - `capturedAmount`: The amount actually captured (for partial capture detection)
 * - `authorisedAmount`: The amount originally authorised
 * - `feeAmount`: The gateway fee charged
 * - `settlementBatchId`: The settlement batch this transaction belongs to
 * - `chargebackArn`: Acquirer Reference Number for chargebacks
 * - `refundId`: Refund identifier
 * - `voidStatus`: Whether the transaction was voided
 */
export function classifyRetailException(
  txn: Transaction,
  relatedTxns: Transaction[],
  config: RetailReconciliationConfig,
  /**
   * Same-side duplicate index (from buildRetailDupIndex over the txn's OWN
   * feed). When supplied, duplicate detection is O(1) and semantically correct
   * (duplicates are same-feed siblings). When omitted, it falls back to scanning
   * `relatedTxns` — the behaviour the standalone unit tests rely on.
   */
  sameSideDupIndex?: RetailDupIndex,
): RetailExceptionResult {
  const rawData = (txn.rawData as Record<string, unknown>) ?? {};
  const gatewayEventType = rawData.gatewayEventType as string | undefined;
  const txnAmt = parseFloat(String(txn.amount));
  if (!Number.isFinite(txnAmt)) {
    // A non-numeric amount can't be classified financially — surface it loudly
    // rather than emitting NaN-laden descriptions into the exception record.
    return {
      category: "format_error",
      severity: "high",
      description: `Retail transaction ${txn.transactionRef ?? txn.id} has a non-numeric amount ("${String(txn.amount)}").`,
      suggestedResolution: "Verify the source data type for the amount field; re-ingest the affected row.",
      slaHours: 48,
      hasRetailTaxonomy: false,
    };
  }

  // ─── Chargeback Detection ─────────────────────────────────────────────────
  if (gatewayEventType === "chargeback") {
    const chargebackArn = rawData.chargebackArn as string | undefined;

    // Duplicate chargeback = more than one chargeback with this ARN on the SAME
    // feed. O(1) via the same-side index; fall back to scanning relatedTxns.
    const duplicateChargeback = chargebackArn
      ? sameSideDupIndex
        ? (sameSideDupIndex.byArn.get(chargebackArn) ?? 0) > 1
        : relatedTxns.some((t) => ((t.rawData as Record<string, unknown>) ?? {}).chargebackArn === chargebackArn)
      : false;

    if (duplicateChargeback) {
      const taxonomy = getRetailException("retail_chargeback_duplicate")!;
      return {
        category: "retail_chargeback_duplicate",
        severity: taxonomy.severity,
        description: `Duplicate chargeback detected: ARN ${chargebackArn ?? "unknown"} for ${txn.currency} ${txnAmt.toLocaleString()}. Both entries reference the same original transaction.`,
        suggestedResolution: taxonomy.recommendedResolution,
        slaHours: taxonomy.slaHours,
        hasRetailTaxonomy: true,
      };
    }

    // Chargeback not posted to merchant ledger
    const taxonomy = getRetailException("retail_chargeback_not_posted")!;
    return {
      category: "retail_chargeback_not_posted",
      severity: taxonomy.severity,
      description: `Chargeback (ARN: ${chargebackArn ?? "unknown"}) for ${txn.currency} ${txnAmt.toLocaleString()} not reflected in merchant ledger. Card scheme deadline applies.`,
      suggestedResolution: taxonomy.recommendedResolution,
      slaHours: taxonomy.slaHours,
      hasRetailTaxonomy: true,
    };
  }

  // ─── Refund Not Settled ───────────────────────────────────────────────────
  if (gatewayEventType === "refund") {
    const refundId = rawData.refundId as string | undefined;
    const taxonomy = getRetailException("retail_refund_not_settled")!;
    return {
      category: "retail_refund_not_settled",
      severity: taxonomy.severity,
      description: `Refund ${refundId ?? txn.transactionRef ?? "unknown"} for ${txn.currency} ${txnAmt.toLocaleString()} not reflected in settlement batch. Customer has been refunded but settlement deduction is missing.`,
      suggestedResolution: taxonomy.recommendedResolution,
      slaHours: taxonomy.slaHours,
      hasRetailTaxonomy: true,
    };
  }

  // ─── Void Not Reversed ────────────────────────────────────────────────────
  if (rawData.voidStatus === "approved" || rawData.voidStatus === "voided") {
    const taxonomy = getRetailException("retail_void_not_reversed")!;
    return {
      category: "retail_void_not_reversed",
      severity: taxonomy.severity,
      description: `Voided transaction ${txn.transactionRef ?? txn.id} for ${txn.currency} ${txnAmt.toLocaleString()} still appears in settlement. Void was approved but settlement was not adjusted.`,
      suggestedResolution: taxonomy.recommendedResolution,
      slaHours: taxonomy.slaHours,
      hasRetailTaxonomy: true,
    };
  }

  // ─── Gateway Fee Variance ─────────────────────────────────────────────────
  if (gatewayEventType === "fee" && config.feeSchedule) {
    const cardScheme = rawData.cardScheme as string | undefined;
    const cardType = rawData.cardType as string | undefined;
    const cardRegion = rawData.cardRegion as string | undefined;
    const feeKey = `${cardScheme}_${cardType}_${cardRegion}`;
    const expectedRate = config.feeSchedule.rates[feeKey];

    if (expectedRate !== undefined) {
      const originalAmount = rawData.originalAmount as number | undefined;
      if (originalAmount && originalAmount > 0) {
        const expectedFee = originalAmount * expectedRate;
        const variance = Math.abs(txnAmt - expectedFee) / expectedFee;
        if (variance > config.feeSchedule.tolerance) {
          const taxonomy = getRetailException("retail_gateway_fee_variance")!;
          return {
            category: "retail_gateway_fee_variance",
            severity: taxonomy.severity,
            description: `Gateway fee variance of ${(variance * 100).toFixed(2)}% on ${feeKey} transaction. Expected fee: ${txn.currency} ${expectedFee.toFixed(2)}, Actual: ${txn.currency} ${txnAmt.toFixed(2)}.`,
            suggestedResolution: taxonomy.recommendedResolution,
            slaHours: taxonomy.slaHours,
            hasRetailTaxonomy: true,
          };
        }
      }
    }
  }

  // ─── Partial Capture Mismatch ─────────────────────────────────────────────
  const capturedAmount = rawData.capturedAmount as number | undefined;
  const authorisedAmount = rawData.authorisedAmount as number | undefined;
  if (capturedAmount !== undefined && authorisedAmount !== undefined) {
    if (capturedAmount < authorisedAmount && Math.abs(txnAmt - capturedAmount) > 0.01) {
      const taxonomy = getRetailException("retail_partial_capture_mismatch")!;
      return {
        category: "retail_partial_capture_mismatch",
        severity: taxonomy.severity,
        description: `Partial capture mismatch: Authorised ${txn.currency} ${authorisedAmount.toLocaleString()}, Captured ${txn.currency} ${capturedAmount.toLocaleString()}, Settled ${txn.currency} ${txnAmt.toLocaleString()}.`,
        suggestedResolution: taxonomy.recommendedResolution,
        slaHours: taxonomy.slaHours,
        hasRetailTaxonomy: true,
      };
    }
  }

  // ─── Duplicate Authorisation ──────────────────────────────────────────────
  if (gatewayEventType === "payment") {
    const orderRef = rawData.originalOrderRef as string | undefined;
    if (orderRef) {
      // Same-feed count of charges for this order. O(1) via the index; fall back
      // to scanning relatedTxns for the standalone unit-test contract.
      const sameOrderCount = sameSideDupIndex
        ? sameSideDupIndex.byOrderRef.get(orderRef) ?? 0
        : relatedTxns.filter((t) => ((t.rawData as Record<string, unknown>) ?? {}).originalOrderRef === orderRef).length;
      if (sameOrderCount > 1) {
        const taxonomy = getRetailException("retail_duplicate_authorisation")!;
        return {
          category: "retail_duplicate_authorisation",
          severity: taxonomy.severity,
          description: `Duplicate authorisation detected for order ${orderRef}: ${sameOrderCount} charges of ${txn.currency} ${txnAmt.toLocaleString()} found. Customer may have been double-charged.`,
          suggestedResolution: taxonomy.recommendedResolution,
          slaHours: taxonomy.slaHours,
          hasRetailTaxonomy: true,
        };
      }
    }
  }

  // ─── FX Rate Mismatch ─────────────────────────────────────────────────────
  if (config.settlementCurrency && txn.currency !== config.settlementCurrency) {
    const expectedRate = rawData.expectedFxRate as number | undefined;
    const appliedRate = rawData.appliedFxRate as number | undefined;
    if (expectedRate && appliedRate) {
      const rateVariance = Math.abs(appliedRate - expectedRate) / expectedRate;
      if (rateVariance > (config.fxMarkupTolerance ?? 0.03)) {
        const taxonomy = getRetailException("retail_fx_rate_mismatch")!;
        return {
          category: "retail_fx_rate_mismatch",
          severity: taxonomy.severity,
          description: `FX rate variance of ${(rateVariance * 100).toFixed(2)}% between authorisation and settlement. Expected rate: ${expectedRate.toFixed(4)}, Applied rate: ${appliedRate.toFixed(4)}. Transaction: ${txn.currency} ${txnAmt.toLocaleString()}.`,
          suggestedResolution: taxonomy.recommendedResolution,
          slaHours: taxonomy.slaHours,
          hasRetailTaxonomy: true,
        };
      }
    }
  }

  // ─── Settlement Shortfall (payout-level) ──────────────────────────────────
  if (gatewayEventType === "payout") {
    const expectedPayout = rawData.expectedPayoutAmount as number | undefined;
    if (expectedPayout && Math.abs(txnAmt - expectedPayout) > 0.01) {
      const shortfall = expectedPayout - txnAmt;
      if (shortfall > 0) {
        const taxonomy = getRetailException("retail_settlement_shortfall")!;
        return {
          category: "retail_settlement_shortfall",
          severity: taxonomy.severity,
          description: `Settlement shortfall of ${txn.currency} ${shortfall.toLocaleString()} on payout. Expected: ${txn.currency} ${expectedPayout.toLocaleString()}, Received: ${txn.currency} ${txnAmt.toLocaleString()}.`,
          suggestedResolution: taxonomy.recommendedResolution,
          slaHours: taxonomy.slaHours,
          hasRetailTaxonomy: true,
        };
      }
    }
  }

  // ─── Reserve Hold ─────────────────────────────────────────────────────────
  if (gatewayEventType === "reserve") {
    const expectedReserve = rawData.expectedReserveAmount as number | undefined;
    if (expectedReserve && Math.abs(txnAmt - expectedReserve) > 0.01) {
      const taxonomy = getRetailException("retail_reserve_hold_unexplained")!;
      return {
        category: "retail_reserve_hold_unexplained",
        severity: taxonomy.severity,
        description: `Unexplained reserve deduction: Expected ${txn.currency} ${expectedReserve?.toLocaleString()}, Actual ${txn.currency} ${txnAmt.toLocaleString()}. Difference: ${txn.currency} ${Math.abs(txnAmt - (expectedReserve ?? 0)).toLocaleString()}.`,
        suggestedResolution: taxonomy.recommendedResolution,
        slaHours: taxonomy.slaHours,
        hasRetailTaxonomy: true,
      };
    }
  }

  // ─── Settlement Delay ─────────────────────────────────────────────────────
  if (config.settlementCycleDays) {
    const captureDate = rawData.captureDate as string | undefined;
    if (captureDate) {
      const capMs = new Date(captureDate).getTime();
      const txnMs = new Date(txn.transactionDate).getTime();
      // Guard unparseable/out-of-order dates: a settlement before its capture is
      // a data error, not a delay — don't emit a negative-day "delay".
      if (Number.isFinite(capMs) && Number.isFinite(txnMs) && txnMs >= capMs) {
        const elapsedDays = Math.floor((txnMs - capMs) / (1000 * 60 * 60 * 24));
        if (elapsedDays > config.settlementCycleDays + 2) {
          const taxonomy = getRetailException("retail_settlement_delay")!;
          return {
            category: "retail_settlement_delay",
            severity: taxonomy.severity,
            description: `Settlement delayed ${elapsedDays} days beyond capture (SLA: T+${config.settlementCycleDays}). Transaction ${txn.transactionRef ?? txn.id} captured on ${captureDate}.`,
            suggestedResolution: taxonomy.recommendedResolution,
            slaHours: taxonomy.slaHours,
            hasRetailTaxonomy: true,
          };
        }
      }
    }
  }

  // ─── Fallback: Use core engine categorisation ─────────────────────────────
  const coreResult = categorizeException(txn, relatedTxns, config);
  return {
    category: coreResult.category,
    severity: coreResult.severity as "critical" | "high" | "medium" | "low",
    description: coreResult.description,
    suggestedResolution: coreResult.suggestedResolution,
    slaHours: 72, // Default SLA for non-retail-specific exceptions
    hasRetailTaxonomy: false,
  };
}

// ─── Main Adapter Function ──────────────────────────────────────────────────

/**
 * Run the retail reconciliation engine.
 *
 * Delegates to the core 3-pass matching engine, then post-processes unmatched
 * transactions through the retail exception classifier.
 *
 * @param sourceTxns - Transactions from the merchant's records (orders, invoices)
 * @param targetTxns - Transactions from the gateway/acquirer (settlements, payouts)
 * @param config - Retail-specific reconciliation configuration
 * @returns Core engine result + retail exception classifications
 */
export function runRetailReconciliation(
  sourceTxns: Transaction[],
  targetTxns: Transaction[],
  config: RetailReconciliationConfig,
): RetailReconciliationResult {
  // Step 1: Run the core 3-pass matching engine
  const coreResult = runMatchingEngine(sourceTxns, targetTxns, config);

  // Pre-index each side ONCE for O(1) same-side duplicate detection, and build
  // id→txn maps so lookups are O(1) instead of Array.find per unmatched id.
  const sourceDupIndex = buildRetailDupIndex(sourceTxns);
  const targetDupIndex = buildRetailDupIndex(targetTxns);
  const sourceById = new Map(sourceTxns.map((t) => [t.id, t]));
  const targetById = new Map(targetTxns.map((t) => [t.id, t]));

  // Step 2: Classify unmatched source transactions with retail-specific logic.
  // Duplicates are same-feed siblings → pass the SOURCE index; the opposite
  // (target) side is passed only for the core-engine fallback.
  const retailExceptions: RetailExceptionClassification[] = [];

  for (const unmatchedId of coreResult.unmatchedSource) {
    const txn = sourceById.get(unmatchedId);
    if (!txn) continue;
    const classification = classifyRetailException(txn, targetTxns, config, sourceDupIndex);
    retailExceptions.push({ transactionId: unmatchedId, ...classification });
  }

  // Step 3: Classify unmatched target transactions (same-feed = TARGET index).
  for (const unmatchedId of coreResult.unmatchedTarget) {
    const txn = targetById.get(unmatchedId);
    if (!txn) continue;
    const classification = classifyRetailException(txn, sourceTxns, config, targetDupIndex);
    retailExceptions.push({ transactionId: unmatchedId, ...classification });
  }

  return {
    ...coreResult,
    retailExceptions,
    retailStats: {
      totalRetailExceptions: retailExceptions.length,
      chargebackCount: retailExceptions.filter((e) => e.category.includes("chargeback")).length,
      feeVarianceCount: retailExceptions.filter((e) => e.category === "retail_gateway_fee_variance").length,
      settlementIssueCount: retailExceptions.filter(
        (e) => e.category === "retail_settlement_shortfall" || e.category === "retail_settlement_delay"
      ).length,
      refundIssueCount: retailExceptions.filter((e) => e.category === "retail_refund_not_settled").length,
      fxIssueCount: retailExceptions.filter(
        (e) => e.category === "retail_fx_rate_mismatch" || e.category === "retail_currency_conversion_error"
      ).length,
      criticalCount: retailExceptions.filter((e) => e.severity === "critical").length,
      highCount: retailExceptions.filter((e) => e.severity === "high").length,
      taxonomyCoverage: retailExceptions.length > 0
        ? retailExceptions.filter((e) => e.hasRetailTaxonomy).length / retailExceptions.length
        : 1,
    },
  };
}

// ─── Result Types ───────────────────────────────────────────────────────────

export interface RetailExceptionClassification extends RetailExceptionResult {
  transactionId: number;
}

export interface RetailReconciliationResult extends ReconciliationResult {
  /** Retail-specific exception classifications for all unmatched transactions */
  retailExceptions: RetailExceptionClassification[];
  /** Aggregate retail exception statistics */
  retailStats: RetailReconciliationStats;
}

export interface RetailReconciliationStats {
  totalRetailExceptions: number;
  chargebackCount: number;
  feeVarianceCount: number;
  settlementIssueCount: number;
  refundIssueCount: number;
  fxIssueCount: number;
  criticalCount: number;
  highCount: number;
  /** Percentage of exceptions covered by the retail taxonomy (vs core fallback) */
  taxonomyCoverage: number;
}
