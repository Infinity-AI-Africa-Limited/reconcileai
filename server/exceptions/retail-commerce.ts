/**
 * Retail / E-Commerce Exception Taxonomy (SHOPLINE vertical)
 *
 * Defines the full exception taxonomy for e-commerce payment reconciliation.
 * These exceptions cover the complete lifecycle of online payment settlement:
 * authorisation → capture → settlement → payout, including chargebacks,
 * refunds, FX conversion, and reserve holds.
 *
 * Unlike the Nigerian banking exceptions which reference CBN/NIBSS regulations,
 * these reference the merchant's payment gateway agreement terms, card scheme
 * operating regulations (Visa Core Rules, Mastercard Standards), and PCI DSS
 * requirements where applicable.
 *
 * Architecture mirrors server/exceptions/nip.ts but for the retail vertical.
 */
import type { NigerianChannelException, NigerianChannelSource } from "./types";

// Retail channel sources — reuse the NigerianChannelSource type for structural
// compatibility but define retail-specific source identifiers.
export type RetailChannelSource =
  | "ecommerce_gateway"
  | "marketplace_payout"
  | "buy_now_pay_later"
  | "digital_wallet"
  | "card_switch"
  | "cbs_ledger";

/**
 * Retail exception interface — extends the Nigerian channel exception pattern
 * for the e-commerce vertical. Uses the same structure so the Super Admin
 * portal, resolution template engine, and AI diagnosis pipeline work
 * identically across both verticals.
 */
export interface RetailCommerceException {
  /** Unique key — also a resolution_templates.category enum value. */
  key: string;
  /** Human-readable label for the exception. */
  label: string;
  /** Severity based on financial/operational impact. */
  severity: "critical" | "high" | "medium" | "low";
  /** Hours before SLA breach per gateway agreement or card scheme rules. */
  slaHours: number;
  /** Which retail channel sources this exception applies to. */
  sources: RetailChannelSource[] | "all";
  /** Regulatory/contractual context that makes this exception urgent. */
  regulatoryContext: string;
  /** Step-by-step resolution procedure. */
  recommendedResolution: string;
  /** Guidance for the AI agent when diagnosing this exception. */
  aiDiagnosisHint: string;
}

export const RETAIL_COMMERCE_EXCEPTIONS: RetailCommerceException[] = [
  // ─── Chargebacks ────────────────────────────────────────────────────────────
  {
    key: "retail_chargeback_not_posted",
    label: "Chargeback Not Reflected in Merchant Ledger",
    severity: "critical",
    slaHours: 24,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Visa Core Rules §11.4 / Mastercard Chargeback Guide: Chargebacks must be reflected in merchant records within 1 business day of receipt. Failure to account for chargebacks creates phantom revenue and distorts cash-flow projections. Card scheme fines apply for unresolved disputes beyond 45 days.",
    recommendedResolution:
      "1) Match the chargeback ARN (Acquirer Reference Number) to the original transaction in the gateway settlement report. 2) Verify the chargeback amount matches the original transaction amount (partial chargebacks are possible). 3) Post the chargeback debit to the merchant ledger with the ARN as reference. 4) If the chargeback is disputed, initiate representment within the card scheme's deadline (Visa: 30 days, Mastercard: 45 days). 5) Update the exception status with the dispute outcome.",
    aiDiagnosisHint:
      "Chargeback present in gateway/acquirer report but absent from merchant ledger. Check if the gateway's chargeback notification webhook was received and processed. Common causes: webhook delivery failure, ARN format mismatch preventing auto-matching, or chargeback posted to a different merchant account in multi-store setups.",
  },
  {
    key: "retail_chargeback_duplicate",
    label: "Duplicate Chargeback Posted",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Card scheme operating regulations prohibit duplicate chargebacks for the same transaction. Duplicate postings inflate loss provisions and may trigger unnecessary representment costs. Gateway agreements typically include SLA for duplicate detection.",
    recommendedResolution:
      "1) Identify both chargeback records by ARN and transaction reference. 2) Verify they reference the same original transaction (same amount, date, card BIN). 3) Confirm with the acquirer/gateway which chargeback is the valid one (usually the first received). 4) Reverse the duplicate posting from the merchant ledger. 5) If both were forwarded to the card scheme, contact the acquirer to withdraw the duplicate.",
    aiDiagnosisHint:
      "Two chargeback entries with the same or similar ARN/transaction reference. Distinguish genuine duplicates (same ARN, same amount) from legitimate separate chargebacks on the same order (e.g., partial chargeback followed by full chargeback). Check timestamps — gateway retry logic during webhook timeouts is the most common cause.",
  },

  // ─── Gateway Fees ───────────────────────────────────────────────────────────
  {
    key: "retail_gateway_fee_variance",
    label: "Gateway Fee Discrepancy",
    severity: "medium",
    slaHours: 72,
    sources: ["ecommerce_gateway"],
    regulatoryContext:
      "Payment gateway agreements specify fee schedules by card type (credit/debit), card scheme (Visa/Mastercard/Amex), region (domestic/international), and MCC (Merchant Category Code). Fee variances indicate either a contract violation by the gateway or an MCC misclassification that changes the interchange tier.",
    recommendedResolution:
      "1) Extract the fee charged from the settlement report line item. 2) Calculate the expected fee based on the contracted rate schedule for the transaction's card type, scheme, and region. 3) If variance exceeds the tolerance threshold (typically ±0.05%), flag for review. 4) For systematic variances (same card type consistently overcharged), raise a billing dispute with the gateway. 5) For isolated variances, check if the transaction was downgraded (e.g., non-qualified rate due to missing AVS data).",
    aiDiagnosisHint:
      "Fee charged differs from expected fee based on contracted rates. Cluster by card type and scheme to identify systematic vs isolated variances. Common causes: MCC reclassification by acquirer, international card surcharge applied to domestic card (BIN lookup error), or rate schedule update not reflected in merchant's contracted terms.",
  },

  // ─── FX / Currency ──────────────────────────────────────────────────────────
  {
    key: "retail_fx_rate_mismatch",
    label: "FX Rate Variance Between Authorisation and Settlement",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Multi-currency merchant agreements specify whether FX conversion happens at authorisation time (DCC — Dynamic Currency Conversion) or settlement time. Rate variance beyond the agreed markup (typically 1–3% above mid-market) constitutes a contract breach. Visa/Mastercard mandate transparency on FX margins.",
    recommendedResolution:
      "1) Compare the FX rate applied at authorisation (from the auth response) with the rate applied at settlement (from the settlement report). 2) Calculate the variance as a percentage of the mid-market rate at both timestamps. 3) If variance exceeds the contracted markup threshold, raise a dispute with the gateway/acquirer. 4) For DCC transactions, verify the cardholder opted in (regulatory requirement). 5) Document the rate source and timestamp for audit trail.",
    aiDiagnosisHint:
      "Settlement amount in merchant's base currency differs from expected amount based on authorisation rate. Distinguish between: (a) normal rate movement between auth and settlement dates (acceptable), (b) excessive markup beyond contracted terms (dispute), (c) wrong currency pair applied (error). Check if the transaction used DCC or standard scheme conversion.",
  },

  // ─── Settlement ─────────────────────────────────────────────────────────────
  {
    key: "retail_settlement_shortfall",
    label: "Settlement Amount Shortfall",
    severity: "critical",
    slaHours: 24,
    sources: ["ecommerce_gateway", "marketplace_payout"],
    regulatoryContext:
      "Gateway agreements guarantee settlement of net transaction amounts (gross minus fees, chargebacks, and reserves) within the contracted settlement window. Shortfalls indicate either undisclosed deductions (hidden fees, reserve increases) or settlement calculation errors. Persistent shortfalls may indicate gateway financial distress.",
    recommendedResolution:
      "1) Calculate expected settlement: sum of gross transactions minus known fees, chargebacks, refunds, and reserve holds for the settlement period. 2) Compare with actual settlement received. 3) Identify the gap amount and check for: undisclosed chargebacks, reserve hold increases, fee adjustments, or missing transactions. 4) If unexplained, raise an urgent query with the gateway's merchant support team with full transaction-level reconciliation. 5) If pattern persists across multiple settlement cycles, escalate to account management.",
    aiDiagnosisHint:
      "Actual settlement received is less than calculated expected net amount. Decompose the gap: is it explained by chargebacks not yet posted, reserve hold adjustments, or fee corrections? Check if the gateway's settlement report line-item total matches the bank credit amount — if not, the issue is between gateway and bank (not merchant calculation error).",
  },
  {
    key: "retail_settlement_delay",
    label: "Settlement Delayed Beyond Contracted SLA",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "marketplace_payout", "buy_now_pay_later"],
    regulatoryContext:
      "Gateway agreements specify settlement cycles (T+1, T+2, T+3, or weekly). Delays beyond the contracted cycle constitute an SLA breach. For marketplace payouts, platform terms specify payout schedules. Persistent delays may indicate gateway liquidity issues or compliance holds.",
    recommendedResolution:
      "1) Verify the contracted settlement cycle for this merchant/gateway combination. 2) Calculate the actual settlement delay (business days between transaction capture and bank credit). 3) Check if the gateway has communicated any holds (fraud review, compliance check, reserve adjustment). 4) If no communication received, contact gateway support with the batch reference and expected settlement date. 5) If delay exceeds 5 business days beyond SLA, escalate to account management and consider contractual remedies.",
    aiDiagnosisHint:
      "Transactions captured but settlement not received within expected window. Check: (a) is the delay affecting all transactions or specific ones (fraud hold on individual orders vs systemic delay)? (b) Has the gateway's settlement report been issued but bank credit not received (bank processing delay vs gateway delay)? (c) Are there compliance flags on the merchant account?",
  },

  // ─── Refunds ────────────────────────────────────────────────────────────────
  {
    key: "retail_refund_not_settled",
    label: "Refund Not Reflected in Settlement Batch",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway"],
    regulatoryContext:
      "Refunds issued to customers must be deducted from subsequent settlement batches. If a refund is processed at the gateway level but not deducted from settlement, the merchant is effectively paying the refund twice (once from their own funds to the customer, once from the settlement that should have been reduced). Card scheme rules require refund processing within 5–10 business days.",
    recommendedResolution:
      "1) Locate the refund transaction in the gateway's refund log (by original transaction reference or refund ID). 2) Check if the refund appears in the settlement report as a deduction. 3) If absent, verify the refund status at the gateway (pending, processed, failed). 4) If refund was processed but not deducted, it may appear in the next settlement cycle (timing difference). 5) If refund is confirmed processed and more than 2 settlement cycles have passed without deduction, raise a billing query.",
    aiDiagnosisHint:
      "Refund issued at gateway level but not appearing as a deduction in settlement. Distinguish timing differences (refund will appear in next batch) from genuine omissions. Check refund status: 'pending' refunds haven't been submitted to the scheme yet; 'processed' refunds should appear within 1–2 settlement cycles.",
  },

  // ─── Duplicate / Void ───────────────────────────────────────────────────────
  {
    key: "retail_duplicate_authorisation",
    label: "Duplicate Authorisation Charge",
    severity: "critical",
    slaHours: 24,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Duplicate authorisations result in double-charging the customer, which violates card scheme rules and consumer protection regulations. Visa Core Rules §5.8 and Mastercard Standards require merchants to void duplicate authorisations within 24 hours. Failure to do so results in chargebacks with additional scheme fees.",
    recommendedResolution:
      "1) Identify both authorisation records (same card, same amount, same merchant, within a short time window — typically <60 seconds). 2) Determine which is the valid authorisation (usually the first). 3) Void the duplicate authorisation immediately via the gateway API. 4) If the duplicate has already been captured/settled, process a refund for the duplicate amount. 5) If customer has already disputed, accept the chargeback on the duplicate and document the void/refund for the scheme.",
    aiDiagnosisHint:
      "Two authorisations with identical or near-identical parameters (amount, card last-4, timestamp within 60s). Common causes: customer double-clicked payment button (frontend idempotency failure), gateway timeout triggered retry, or 3DS challenge completion sent duplicate auth request. Check if both were captured or only one.",
  },
  {
    key: "retail_void_not_reversed",
    label: "Voided Transaction Still Settled",
    severity: "critical",
    slaHours: 24,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "A voided transaction should never appear in settlement. If it does, the merchant has received funds for a transaction they cancelled, creating a liability to the customer. Card scheme rules require that voids processed before the settlement cut-off time are excluded from the batch. Voids after cut-off require a refund instead.",
    recommendedResolution:
      "1) Verify the void was successfully processed at the gateway (void status = 'approved'). 2) Check the void timestamp against the settlement batch cut-off time. 3) If void was before cut-off but transaction still settled, this is a gateway error — raise an urgent support ticket. 4) Process an immediate refund to the customer for the voided amount. 5) Request a credit from the gateway for the erroneously settled amount.",
    aiDiagnosisHint:
      "Transaction marked as voided in the gateway but appearing in the settlement batch. Check void timing: if void was after the batch cut-off, this is expected behaviour (void becomes a refund in next cycle). If void was before cut-off, this is a gateway settlement engine error. Also check if the void was actually approved — some gateways return void 'pending' which means it hasn't been processed yet.",
  },

  // ─── Partial Capture ────────────────────────────────────────────────────────
  {
    key: "retail_partial_capture_mismatch",
    label: "Partial Capture Amount Mismatch",
    severity: "medium",
    slaHours: 72,
    sources: ["ecommerce_gateway"],
    regulatoryContext:
      "Partial captures (capturing less than the authorised amount) are common in e-commerce for partial shipments or order modifications. The settled amount should equal the captured amount, not the authorised amount. Visa allows multiple partial captures up to the auth amount; Mastercard requires a single capture. Mismatches indicate capture logic errors.",
    recommendedResolution:
      "1) Compare the authorised amount, captured amount, and settled amount for the transaction. 2) If settled amount equals auth amount (not capture amount), the gateway may have auto-captured the full auth — check gateway settings for 'auto-capture' configuration. 3) If settled amount differs from both auth and capture amounts, check for fee deductions or currency conversion applied at settlement. 4) Verify the capture request was correctly submitted via the gateway API logs. 5) If gateway error, raise a support ticket with auth ID and capture request details.",
    aiDiagnosisHint:
      "Settled amount doesn't match the partial capture amount. Three common scenarios: (a) gateway auto-captured full auth amount ignoring partial capture request, (b) multiple partial captures summed incorrectly, (c) capture request failed silently and gateway fell back to full auth capture. Check the gateway's capture confirmation response.",
  },

  // ─── Currency Conversion ────────────────────────────────────────────────────
  {
    key: "retail_currency_conversion_error",
    label: "Currency Conversion Error in Settlement",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "marketplace_payout"],
    regulatoryContext:
      "Multi-currency merchants receive settlements in their base currency. The conversion rate applied should match the gateway's published rate schedule (typically mid-market + agreed markup). Errors include: wrong currency pair, rate from wrong date, or double-conversion (transaction currency → scheme currency → settlement currency with markup at each step).",
    recommendedResolution:
      "1) Identify the transaction's original currency and the settlement currency. 2) Determine the expected conversion rate (mid-market rate on the settlement date + contracted markup). 3) Calculate the expected settlement amount and compare with actual. 4) If variance exceeds threshold, check for double-conversion (common when transaction currency ≠ card currency ≠ settlement currency). 5) Raise a billing dispute with the gateway if the applied rate is outside contracted terms.",
    aiDiagnosisHint:
      "Settlement amount in base currency doesn't match expected amount after applying the contracted FX rate. Check the conversion chain: was the transaction in USD, settled via EUR intermediary, then converted to merchant's base currency? Each hop adds markup. Also check if the rate date matches — some gateways use auth-date rate, others use settlement-date rate.",
  },

  // ─── Payout / Reserve ───────────────────────────────────────────────────────
  {
    key: "retail_payout_delay",
    label: "Merchant Payout Delayed Beyond Schedule",
    severity: "medium",
    slaHours: 72,
    sources: ["marketplace_payout", "ecommerce_gateway"],
    regulatoryContext:
      "Marketplace and gateway payout schedules are contractually defined (daily, weekly, bi-weekly, or monthly). Delays beyond the contracted schedule impact merchant cash flow and may indicate platform liquidity issues, compliance holds, or bank processing delays. Some jurisdictions require platforms to hold merchant funds in segregated accounts.",
    recommendedResolution:
      "1) Verify the contracted payout schedule and calculate the expected payout date. 2) Check if the platform/gateway has communicated any holds (fraud review, identity verification, tax compliance). 3) Verify the merchant's bank account details are current and valid. 4) If no hold communicated and bank details are correct, contact platform support with the payout reference. 5) If delay exceeds 5 business days beyond schedule, escalate and consider alternative payout methods if available.",
    aiDiagnosisHint:
      "Payout not received within expected window. Distinguish between: (a) platform-side delay (payout not initiated — check platform dashboard), (b) bank-side delay (payout initiated but not credited — check bank processing), (c) compliance hold (platform has frozen payouts pending verification). Check if other merchants on the same platform are experiencing similar delays (systemic vs isolated).",
  },
  {
    key: "retail_reserve_hold_unexplained",
    label: "Unexplained Rolling Reserve Deduction",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "marketplace_payout"],
    regulatoryContext:
      "Rolling reserves (typically 5–10% of settlement held for 90–180 days) protect against chargebacks and refunds. The reserve percentage and release schedule are contractually defined. Unexplained increases in reserve deductions, or failure to release reserves on schedule, constitute a contract breach. Some gateways increase reserves unilaterally for 'high-risk' merchants without proper notification.",
    recommendedResolution:
      "1) Calculate the expected reserve deduction based on the contracted percentage and the gross settlement amount. 2) Compare with the actual reserve deducted in the settlement report. 3) If higher than expected, check for: reserve percentage increase notification, chargeback-triggered reserve adjustment, or manual hold placed by the gateway's risk team. 4) Verify reserve releases are occurring on schedule (check the reserve release report). 5) If unexplained, request a full reserve statement from the gateway showing all holds, deductions, and releases.",
    aiDiagnosisHint:
      "Reserve deduction amount doesn't match expected percentage of gross settlement. Check if the gateway has recently changed the reserve rate (common after chargeback ratio increases). Also check if previously released reserves have been re-held (clawback). Compare the reserve rate across multiple settlement periods to identify when the change occurred.",
  },

  // ─── Interchange / Classification ──────────────────────────────────────────
  {
    key: "retail_interchange_misclassification",
    label: "Interchange Fee Misclassification",
    severity: "medium",
    slaHours: 72,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Interchange fees are determined by MCC (Merchant Category Code), card type (consumer/commercial, credit/debit), card region (domestic/international), and transaction type (card-present/card-not-present). Misclassification results in higher fees. Common issues: wrong MCC assigned to merchant, card-present rate applied to e-commerce transaction, or domestic rate applied to international card. Visa and Mastercard publish interchange tables quarterly.",
    recommendedResolution:
      "1) Identify the interchange tier applied to the transaction (from the settlement detail report). 2) Determine the correct tier based on: merchant's MCC, card type (from BIN lookup), card region, and transaction channel. 3) If misclassified, calculate the overcharge amount. 4) For MCC errors, request reclassification from the acquirer (requires scheme approval, typically takes 30–60 days). 5) For systematic misclassification, negotiate a billing credit with the gateway while reclassification is pending.",
    aiDiagnosisHint:
      "Fee tier applied doesn't match expected tier for the transaction characteristics. Most common cause: MCC assigned at merchant onboarding is incorrect for the merchant's actual business category. Also check: is the gateway correctly passing the e-commerce indicator (ECI) for 3DS-authenticated transactions? Missing ECI causes downgrade to non-qualified rate. Cluster by card BIN to identify if specific card types are consistently misclassified.",
  },
];

// Export exception keys for type-safe references
export const RETAIL_COMMERCE_EXCEPTION_KEYS = RETAIL_COMMERCE_EXCEPTIONS.map((e) => e.key);

// ─── Helper: Get exception by key ────────────────────────────────────────────
export function getRetailException(key: string): RetailCommerceException | undefined {
  return RETAIL_COMMERCE_EXCEPTIONS.find((e) => e.key === key);
}

// ─── Helper: Get exceptions by severity ──────────────────────────────────────
export function getRetailExceptionsBySeverity(
  severity: "critical" | "high" | "medium" | "low"
): RetailCommerceException[] {
  return RETAIL_COMMERCE_EXCEPTIONS.filter((e) => e.severity === severity);
}

// ─── Helper: Get exceptions by source ────────────────────────────────────────
export function getRetailExceptionsBySource(
  source: RetailChannelSource
): RetailCommerceException[] {
  return RETAIL_COMMERCE_EXCEPTIONS.filter(
    (e) => e.sources === "all" || e.sources.includes(source)
  );
}
