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
  /** Refund id occurrences — duplicate refund detection. */
  byRefundId: Map<string, number>;
  /** Gateway reference occurrences — same txn settled in multiple batches. */
  byGatewayRef: Map<string, number>;
}

export function buildRetailDupIndex(txns: Transaction[]): RetailDupIndex {
  const byArn = new Map<string, number>();
  const byOrderRef = new Map<string, number>();
  const byRefundId = new Map<string, number>();
  const byGatewayRef = new Map<string, number>();
  for (const t of txns) {
    const raw = (t.rawData as Record<string, unknown>) ?? {};
    const arn = raw.chargebackArn;
    if (typeof arn === "string" && arn) byArn.set(arn, (byArn.get(arn) ?? 0) + 1);
    const ref = raw.originalOrderRef;
    if (typeof ref === "string" && ref) byOrderRef.set(ref, (byOrderRef.get(ref) ?? 0) + 1);
    const refund = raw.refundId;
    if (typeof refund === "string" && refund) byRefundId.set(refund, (byRefundId.get(refund) ?? 0) + 1);
    const gref = raw.gatewayRef;
    if (typeof gref === "string" && gref) byGatewayRef.set(gref, (byGatewayRef.get(gref) ?? 0) + 1);
  }
  return { byArn, byOrderRef, byRefundId, byGatewayRef };
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

  /** Build a classification straight from the taxonomy entry for `key`. */
  const fromTaxonomy = (key: string, description: string): RetailExceptionResult => {
    const t = getRetailException(key)!;
    return {
      category: key,
      severity: t.severity,
      description,
      suggestedResolution: t.recommendedResolution,
      slaHours: t.slaHours,
      hasRetailTaxonomy: true,
    };
  };

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

  // ─── Refunds: duplicate first (same-feed refundId siblings), then unsettled ──
  if (gatewayEventType === "refund") {
    const refundId = rawData.refundId as string | undefined;
    const duplicateRefund = refundId
      ? sameSideDupIndex
        ? (sameSideDupIndex.byRefundId.get(refundId) ?? 0) > 1
        : relatedTxns.some((t) => ((t.rawData as Record<string, unknown>) ?? {}).refundId === refundId)
      : false;
    if (duplicateRefund) {
      return fromTaxonomy(
        "retail_refund_duplicate",
        `Duplicate refund detected: refund ${refundId} for ${txn.currency} ${txnAmt.toLocaleString()} appears more than once. Customer may be double-credited or settlement double-deducted.`,
      );
    }
    return fromTaxonomy(
      "retail_refund_not_settled",
      `Refund ${refundId ?? txn.transactionRef ?? "unknown"} for ${txn.currency} ${txnAmt.toLocaleString()} not reflected in settlement batch. Customer has been refunded but settlement deduction is missing.`,
    );
  }

  // ─── Dispute lifecycle: won-but-not-credited + fee errors ───────────────────
  if (gatewayEventType === "chargeback_reversal") {
    // A reversal (merchant WON representment) that the matcher could not pair
    // with a settlement credit — the classic silent leakage leg.
    const caseId = (rawData.disputeCaseId as string | undefined) ?? (rawData.chargebackArn as string | undefined);
    return fromTaxonomy(
      "retail_dispute_won_not_credited",
      `Dispute ${caseId ?? txn.transactionRef ?? "unknown"} was WON but the ${txn.currency} ${txnAmt.toLocaleString()} reversal credit has no matching settlement entry. Check same-batch netting before claiming with the acquirer.`,
    );
  }
  if (gatewayEventType === "dispute_fee") {
    const expectedFee = rawData.expectedDisputeFee as number | undefined;
    if (expectedFee !== undefined && Math.abs(txnAmt - expectedFee) > 0.01) {
      return fromTaxonomy(
        "retail_dispute_fee_error",
        `Dispute fee billed ${txn.currency} ${txnAmt.toLocaleString()} vs contracted ${txn.currency} ${expectedFee.toLocaleString()} (case ${(rawData.disputeCaseId as string | undefined) ?? "unknown"}).`,
      );
    }
  }

  // ─── COD courier remittance (SEA lifeline channel) ─────────────────────────
  if (gatewayEventType === "cod_remittance") {
    const expectedRemittance = rawData.expectedRemittanceAmount as number | undefined;
    if (expectedRemittance !== undefined && expectedRemittance - txnAmt > 0.01) {
      const gap = expectedRemittance - txnAmt;
      return fromTaxonomy(
        "retail_cod_remittance_variance",
        `COD remittance shortfall of ${txn.currency} ${gap.toLocaleString()} from courier ${(rawData.courierId as string | undefined) ?? "unknown"}: expected ${txn.currency} ${expectedRemittance.toLocaleString()} for delivered orders, received ${txn.currency} ${txnAmt.toLocaleString()}.`,
      );
    }
  }

  // ─── Platform economics: tax withholding + commission ───────────────────────
  if (gatewayEventType === "tax_deduction") {
    const expectedTax = rawData.expectedTaxAmount as number | undefined;
    if (expectedTax !== undefined && Math.abs(txnAmt - expectedTax) > 0.01) {
      return fromTaxonomy(
        "retail_tax_deduction_variance",
        `Tax withheld ${txn.currency} ${txnAmt.toLocaleString()} vs expected ${txn.currency} ${expectedTax.toLocaleString()} (${(rawData.taxType as string | undefined) ?? "tax"}). Verify rate, base, and that a withholding certificate was issued.`,
      );
    }
  }
  if (gatewayEventType === "commission") {
    const expectedCommission = rawData.expectedCommissionAmount as number | undefined;
    if (expectedCommission !== undefined && Math.abs(txnAmt - expectedCommission) > 0.01) {
      return fromTaxonomy(
        "retail_platform_commission_variance",
        `Platform commission ${txn.currency} ${txnAmt.toLocaleString()} vs rate-card expectation ${txn.currency} ${expectedCommission.toLocaleString()}. Cluster by category to find misclassified rates.`,
      );
    }
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

  // ─── Payment integrity: settled-twice, duplicate auth, order↔amount ─────────
  if (gatewayEventType === "payment") {
    // Same gateway reference appearing more than once on this feed = the
    // transaction settled in multiple batches (provider re-delivery/regeneration).
    const gatewayRef = rawData.gatewayRef as string | undefined;
    const settledTwice = gatewayRef
      ? sameSideDupIndex
        ? (sameSideDupIndex.byGatewayRef.get(gatewayRef) ?? 0) > 1
        : relatedTxns.some((t) => ((t.rawData as Record<string, unknown>) ?? {}).gatewayRef === gatewayRef)
      : false;
    if (settledTwice) {
      return fromTaxonomy(
        "retail_settlement_duplicate",
        `Transaction ${gatewayRef} appears in more than one settlement batch for ${txn.currency} ${txnAmt.toLocaleString()}. Same-sign = duplicate credit (expect clawback); opposite-sign = correction pair.`,
      );
    }
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
    // Order total vs captured/settled amount (discounts/shipping/tax/gift-card
    // legs drifting between storefront and payment request). Uses the job's
    // amount tolerance so FX/rounding noise doesn't alert.
    const orderTotal = rawData.orderTotal as number | undefined;
    if (orderTotal !== undefined && orderTotal > 0) {
      const variance = Math.abs(txnAmt - orderTotal) / orderTotal;
      const tolerance = config.amountTolerance ?? 0.005;
      if (variance > tolerance) {
        return fromTaxonomy(
          "retail_order_payment_amount_mismatch",
          `Order ${orderRef ?? txn.transactionRef ?? "unknown"} total is ${txn.currency} ${orderTotal.toLocaleString()} but captured/settled amount is ${txn.currency} ${txnAmt.toLocaleString()} (${(variance * 100).toFixed(2)}% variance). Decompose: shipping, tax, discount, or gift-card leg.`,
        );
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

  // ─── Payout: bank leg first, then gateway-report shortfall ──────────────────
  if (gatewayEventType === "payout") {
    // Third reconciliation leg: gateway payout report vs actual bank credit.
    const bankCredited = rawData.bankCreditedAmount as number | undefined;
    if (bankCredited !== undefined && Math.abs(txnAmt - bankCredited) > 0.01) {
      const gap = txnAmt - bankCredited;
      return fromTaxonomy(
        "retail_payout_bank_variance",
        `Payout report says ${txn.currency} ${txnAmt.toLocaleString()} but bank credit is ${txn.currency} ${bankCredited.toLocaleString()} (gap ${txn.currency} ${gap.toLocaleString()}). Constant small gaps = lifting fees (configure); unexplained gaps = same-day escalation + beneficiary-tampering check.`,
      );
    }
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

// ─── Settlement-batch completeness watchdog ──────────────────────────────────

/**
 * Is a provider's settlement batch overdue? Backs the
 * `retail_settlement_batch_missing` category: a missing batch hides every
 * other exception class for the period, so zero-data-loss reconciliation
 * requires missing files to be loud. Pure — the Phase 1 SHOPLINE connector
 * calls this per provider (gateway, wallet, BNPL, COD courier) on its
 * completeness tick, with each provider's contracted cycle.
 *
 * @param lastBatchAt  when the provider's most recent batch was received
 * @param cycleDays    contracted delivery cycle in days (1 = daily)
 * @param graceDays    delay tolerated before alerting (default 1)
 */
export function isSettlementBatchOverdue(
  lastBatchAt: Date | null,
  cycleDays: number,
  graceDays = 1,
  now: Date = new Date(),
): boolean {
  if (cycleDays <= 0) return false;
  if (!lastBatchAt) return true; // never received anything — loudest case
  const lastMs = lastBatchAt.getTime();
  if (!Number.isFinite(lastMs)) return true;
  const dueMs = lastMs + (cycleDays + graceDays) * 24 * 60 * 60 * 1000;
  return now.getTime() > dueMs;
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
