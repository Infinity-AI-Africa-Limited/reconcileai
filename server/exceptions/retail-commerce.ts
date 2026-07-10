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
  | "cbs_ledger"
  /** Cash-on-delivery courier/3PL remittance — dominant in SHOPLINE's SEA markets. */
  | "cod_logistics";

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
    sources: ["ecommerce_gateway", "marketplace_payout", "buy_now_pay_later", "digital_wallet"],
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
    sources: ["ecommerce_gateway", "marketplace_payout", "buy_now_pay_later", "digital_wallet"],
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
    sources: ["marketplace_payout", "ecommerce_gateway", "buy_now_pay_later", "digital_wallet"],
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

  // ─── Order ↔ Payment Integrity ──────────────────────────────────────────────
  {
    key: "retail_order_payment_amount_mismatch",
    label: "Order Total vs Captured/Settled Amount Mismatch",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "digital_wallet", "cbs_ledger"],
    regulatoryContext:
      "The captured amount must equal the order total after discounts, shipping, taxes and store-credit legs — card scheme rules cap capture at the authorised amount, and consumer-protection law treats overcapture as an overcharge. Systematic mismatches indicate checkout/pricing engine drift between the storefront and the payment request.",
    recommendedResolution:
      "1) Rebuild the expected charge: items + shipping + tax − discounts − gift-card/store-credit legs, from the order record. 2) Compare with the captured and settled amounts. 3) If overcaptured, issue a partial refund for the difference immediately (consumer-protection exposure). 4) If undercaptured, post the uncollected revenue variance and determine whether to re-bill or write off per policy. 5) If mismatches cluster after a storefront release, escalate to the platform/checkout team as a pricing-engine defect.",
    aiDiagnosisHint:
      "Decompose the delta: exactly the shipping fee → shipping leg misbooked; exactly the tax amount → tax leg dropped from the payment request; equals a gift-card leg → split tender not applied at capture; small cents → FX/rounding. Cluster by order date against storefront release dates to spot checkout regressions.",
  },

  // ─── Cash on Delivery (COD) ─────────────────────────────────────────────────
  {
    key: "retail_cod_remittance_variance",
    label: "COD Courier Remittance Shortfall / Missing",
    severity: "critical",
    slaHours: 24,
    sources: ["cod_logistics", "cbs_ledger"],
    regulatoryContext:
      "Cash-on-delivery dominates Southeast Asian e-commerce (a large share of SHOPLINE merchant volume). The courier/3PL collects cash at the door and remits on a contracted cycle minus a COD fee — cash-in-transit that appears in NO gateway report. Unremitted deliveries are direct revenue leakage and the highest fraud-risk surface in the whole retail stack; logistics agreements set remittance SLAs and fee rate cards.",
    recommendedResolution:
      "1) Match the delivered-order manifest (proof-of-delivery records) against the courier's remittance report line by line. 2) Verify the COD fee deducted matches the contracted rate card. 3) Exclude failed/returned deliveries (no cash due) after verifying return status. 4) Chase every delivered-but-unremitted order past the remittance cycle with the courier, citing POD references. 5) Repeated shortfalls from the same courier/region → escalate to logistics management and consider COD suspension for that lane.",
    aiDiagnosisHint:
      "Split the gap three ways: undelivered/returned orders (no cash due — verify return status, not a courier debt), delivered-but-unremitted (chase the courier with POD evidence), and fee over-deduction (variance proportional to remittance = rate-card drift). Round-sum discrepancies suggest cash handling issues at the courier hub, not data errors.",
  },

  // ─── Refund & Dispute Lifecycle ─────────────────────────────────────────────
  {
    key: "retail_refund_duplicate",
    label: "Duplicate Refund Processed",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "digital_wallet"],
    regulatoryContext:
      "Card scheme rules permit refunds only up to the captured amount per transaction; a duplicate refund is a direct cash loss (the customer keeps both credits, or the settlement is deducted twice). Root causes are idempotency failures: double-clicked refund buttons, webhook retries triggering a second refund call, or a manual refund raised while the automatic one was pending.",
    recommendedResolution:
      "1) Locate both refund records against the same original transaction (refund IDs, timestamps, initiating user/system). 2) Confirm at the gateway whether one or two refunds actually executed. 3) If two executed, attempt gateway recovery/re-debit where supported; otherwise contact the customer for repayment per policy and record the loss if unrecoverable. 4) Fix the source: enforce idempotency keys on refund API calls and lock the refund button after first submission. 5) Add the order to the duplicate-refund watch report for the month.",
    aiDiagnosisHint:
      "Two refund deductions referencing one original transaction: same refundId twice = settlement double-count (provider-side, dispute the batch); distinct refundIds = two real refunds (check timestamps — seconds apart implies double-click/retry; days apart implies manual duplicate on top of automatic).",
  },
  {
    key: "retail_dispute_won_not_credited",
    label: "Dispute Won but Reversal Credit Missing",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "When a merchant wins representment, card scheme rules require the chargeback reversal to be credited back. In practice this is the least-monitored leg of the dispute lifecycle — gateways rarely alert on missing reversal credits, making it silent revenue leakage. Scheme timelines bound when the reversal must post after case closure.",
    recommendedResolution:
      "1) Extract all dispute cases with outcome WON in the period. 2) Match each case to a reversal credit in subsequent settlement batches (by case id / ARN). 3) Check for netting: reversals are often netted against new chargebacks within the same batch rather than shown as separate credits. 4) For any won case with no credit after the scheme posting window, raise a claim with the acquirer citing the case id and outcome notification. 5) Where the dispute fee is contractually refundable on a win, claim that too.",
    aiDiagnosisHint:
      "Join the dispute-outcome feed to settlement credits: WON cases with no matching reversal amount are the candidates. Before flagging, check same-batch netting (gross chargebacks minus reversals shown as one net line) — decompose the batch's dispute net line first. Track elapsed days since case closure vs the scheme posting window.",
  },
  {
    key: "retail_dispute_fee_error",
    label: "Dispute / Chargeback Fee Billed Incorrectly",
    severity: "medium",
    slaHours: 72,
    sources: ["ecommerce_gateway", "card_switch"],
    regulatoryContext:
      "Gateways bill a per-dispute administration fee per their schedule; many contracts waive or refund the fee when the merchant wins. Wrong fee amounts, fees on won cases where a waiver is contracted, or duplicate fee lines are recurring billing errors that compound at chargeback-heavy merchants.",
    recommendedResolution:
      "1) Count disputes opened in the billing period and compute expected fees per the contracted schedule, applying win-waivers. 2) Compare with dispute-fee lines billed in settlements. 3) For each variance, tie fee lines to case ids — flag duplicates and fees on waived cases. 4) Raise a billing query with the case-level breakdown. 5) Track recovery and adjust the fee accrual.",
    aiDiagnosisHint:
      "Fee lines exceeding the dispute count = duplicate billing. Fees present on cases with outcome WON where waiver is contracted = waiver not applied. A step-change in per-case fee mid-period = schedule update not reflected in the contract — check the gateway's fee-change notice date.",
  },

  // ─── Payout ↔ Bank (the third reconciliation leg) ──────────────────────────
  {
    key: "retail_payout_bank_variance",
    label: "Payout Report vs Bank Credit Mismatch",
    severity: "critical",
    slaHours: 24,
    sources: ["ecommerce_gateway", "marketplace_payout"],
    regulatoryContext:
      "Three-way reconciliation's final leg: the gateway's payout report must equal the credit on the merchant's bank statement. Gaps arise from receiving-bank lifting fees, intermediary charges on cross-border payouts, failed/returned payouts, or — worst case — beneficiary-account tampering. An unexplained bank-leg gap is treated as a potential security incident until explained.",
    recommendedResolution:
      "1) Match each payout reference from the gateway report to a bank statement credit. 2) If the credit is absent, verify the payout wasn't returned/failed (wrong account, compliance hold) and confirm registered bank details are unchanged. 3) If the amount differs, identify receiving-bank/intermediary charges and FX conversion at the bank leg. 4) Escalate any unexplained gap the same day — verify beneficiary details against an out-of-band record (tampering check). 5) Configure known lifting fees as expected deductions so they stop alerting.",
    aiDiagnosisHint:
      "Constant small delta on every payout = receiving-bank lifting fee (configuration, not an exception). A single payout with zero bank credit = returned/failed payout or account issue. Amount right but late = bank processing. Changed beneficiary details preceding the gap = treat as a security incident immediately.",
  },

  // ─── Platform Economics (tax + commission) ──────────────────────────────────
  {
    key: "retail_tax_deduction_variance",
    label: "Tax Withholding / VAT Deduction Variance",
    severity: "high",
    slaHours: 72,
    sources: ["ecommerce_gateway", "marketplace_payout", "cod_logistics"],
    regulatoryContext:
      "Platforms and gateways withhold VAT/GST or cross-border withholding tax on fees or payouts under marketplace deemed-supplier and WHT rules (jurisdiction-specific — SEA VAT regimes, Nigerian VAT on fees). A wrong rate or wrong base (tax on gross instead of on the fee) either leaks cash through over-withholding or builds silent tax exposure through under-withholding; withheld amounts need certificates/tax invoices to be recoverable as input credit.",
    recommendedResolution:
      "1) Determine the applicable tax type, rate and base for the merchant's jurisdiction and the platform's tax status. 2) Recompute expected tax for the period and compare with amounts withheld in settlements/payouts. 3) Verify tax invoices/withholding certificates were issued for every withheld amount — chase missing ones (they block input-credit recovery). 4) Dispute rate/base errors with the platform's tax team with the recomputation attached. 5) Reconcile the withholding account to certificates quarterly.",
    aiDiagnosisHint:
      "Check the base first: tax computed on GROSS sales instead of on the platform fee is the most common error and produces large proportional variances. Rate variances that start on a specific date = statutory rate change or platform misconfiguration on that date. Correct amounts but missing certificates is still an exception — the cash is unrecoverable without them.",
  },
  {
    key: "retail_platform_commission_variance",
    label: "Platform / Marketplace Commission Variance",
    severity: "medium",
    slaHours: 72,
    sources: ["marketplace_payout", "ecommerce_gateway"],
    regulatoryContext:
      "Platform commissions follow category-based rate cards with promotional rates and tier discounts. Misclassified product categories, expired promo rates applied (or not applied), and tier-change errors erode margin silently at volume — the merchant's platform agreement defines the rate card and adjustment process.",
    recommendedResolution:
      "1) Recompute expected commission per order from the category rate card effective for the period. 2) Compare with commission deducted in the payout statements. 3) Cluster variances by product category to find misclassifications; by date to find rate-card effective-date errors. 4) File an adjustment claim through the platform's billing process with the order-level recomputation. 5) Update the merchant's rate-card record whenever the platform notifies changes.",
    aiDiagnosisHint:
      "Single-category drift = product category misclassified on the platform. Uniform drift across all categories from a given date = tier change or promo-rate expiry on that date. Compare the commission rate implied per order (fee ÷ base) against the rate card rather than absolute amounts — it isolates rate errors from base errors.",
  },

  // ─── Settlement Batch Integrity ─────────────────────────────────────────────
  {
    key: "retail_settlement_duplicate",
    label: "Transaction Settled in Multiple Batches",
    severity: "high",
    slaHours: 48,
    sources: ["ecommerce_gateway", "marketplace_payout", "digital_wallet"],
    regulatoryContext:
      "A transaction must settle exactly once. Provider-side batch regeneration (corrections re-issuing the full file under a new batch id) or delivery retries can double-count revenue; providers claw back duplicate credits later, so unnoticed duplicates overstate revenue now and create surprise deductions later.",
    recommendedResolution:
      "1) Identify transaction references appearing in more than one settlement batch. 2) Distinguish a true duplicate credit (same amount, same sign) from a correction pair (opposite signs netting out). 3) For true duplicates, expect and track the provider clawback; adjust revenue recognition now, not when the clawback lands. 4) Confirm platform ingestion idempotency held (the ledger should already be single-counted — the exception is provider-side). 5) Ask the provider whether the batch was regenerated and which batch id is authoritative.",
    aiDiagnosisHint:
      "Same gateway reference in two batch ids: equal amounts with the same sign = duplicate credit (clawback coming); opposite signs = correction pair, net to zero and close as no-action. Regenerated files usually share a generation timestamp pattern — many refs duplicated across exactly two batches points to file regeneration, not transaction-level errors.",
  },
  {
    key: "retail_settlement_batch_missing",
    label: "Expected Settlement Batch Not Received",
    severity: "high",
    slaHours: 24,
    sources: ["ecommerce_gateway", "marketplace_payout", "digital_wallet", "buy_now_pay_later", "cod_logistics"],
    regulatoryContext:
      "Every provider owes a settlement/payout/remittance report per contracted cycle. A missing batch hides every other exception class for that period — zero-data-loss reconciliation depends on missing files being loud, not silent. Contract SLAs define the delivery calendar per provider.",
    recommendedResolution:
      "1) Confirm the provider's delivery calendar (cycle, cut-off, holiday rules). 2) Check the delivery channel (portal/SFTP/API) for the file before declaring it missing. 3) If the provider had no activity for the period (legitimate no-file day), record a justified skip. 4) Otherwise chase the provider, obtain and backfill the batch BEFORE running reconciliation for the period. 5) Consecutive misses from one provider = integration break — escalate to engineering, not the provider.",
    aiDiagnosisHint:
      "Distinguish legitimate absence (no transactions in the period, provider holiday calendar) from delivery failure (activity exists in realtime feeds but no batch arrived). One miss = provider delay; consecutive misses = broken integration on our side or credential expiry. Check the provider's file-generation status page/API first.",
  },

  // ─── Split Tender / Gift Card ───────────────────────────────────────────────
  {
    key: "retail_gift_card_split_mismatch",
    label: "Gift Card / Store Credit Split Tender Mismatch",
    severity: "medium",
    slaHours: 72,
    sources: ["ecommerce_gateway", "cbs_ledger"],
    regulatoryContext:
      "Split tenders (gift card or store credit plus card) reach the gateway only for the card leg; the gift-card leg must be booked against the gift-card liability account. Misbooked splits misstate both revenue and the gift-card liability — an audit-sensitive balance in retail accounting, and in the worst case (gift card not applied at capture) the customer is double-charged.",
    recommendedResolution:
      "1) Rebuild the tender split from the order record (card leg vs gift-card/store-credit leg). 2) Verify the card leg equals the gateway settlement amount and the gift-card leg was posted against the liability account. 3) If the settlement equals the FULL order total, the gift card was not applied at capture — refund the gift-card leg to the customer immediately. 4) If the ledger booked the full amount as card revenue, repost to relieve the liability. 5) Reconcile the gift-card liability account movement for the period end-to-end.",
    aiDiagnosisHint:
      "Compare settlement amount against order total and against (order total − gift-card leg): matching the full total means the gift card never applied (customer double-charge — critical path); matching the net means the payment is right and the error is ledger-side (liability not relieved). Cluster by gift-card program to catch program-wide booking defects.",
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

// ─── Intelligence-moat wiring (parity with server/exceptions/seed.ts) ────────
// The retail taxonomy is only a moat if it reaches the read-path: the Super
// Agent's diagnosis prompt and the resolution-template store. These mirror the
// Nigerian equivalents so retail_commerce orgs get identical treatment.

/**
 * AI prompt block for the Super Agent when diagnosing retail/e-commerce
 * settlement exceptions. Inject for retail_commerce-segment organizations.
 */
export function retailExceptionsTaxonomyPromptBlock(): string {
  return RETAIL_COMMERCE_EXCEPTIONS.map(
    (e) => `- ${e.key} (${e.severity}, SLA ${e.slaHours}h): ${e.label}. ${e.aiDiagnosisHint}`,
  ).join("\n");
}

/** Lookup a retail exception by key (null when not a retail key). */
export function retailExceptionFor(key: string): RetailCommerceException | null {
  return RETAIL_COMMERCE_EXCEPTIONS.find((e) => e.key === key) ?? null;
}

/**
 * Seed the retail taxonomy as org-scoped resolution templates (idempotent).
 * Called when a retail_commerce organization is created. Mirrors
 * seedNigerianChannelExceptionTemplates. The `resolutionTemplates`/`getDb`
 * imports are lazy so this pure taxonomy module carries no DB dependency for
 * the client bundle or unit tests.
 */
export async function seedRetailResolutionTemplates(
  organizationId: number,
): Promise<{ inserted: number; existing: number }> {
  const { and, eq } = await import("drizzle-orm");
  const { resolutionTemplates } = await import("../../drizzle/schema");
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  let inserted = 0;
  let existing = 0;
  for (const cat of RETAIL_COMMERCE_EXCEPTIONS) {
    const [already] = await db
      .select({ id: resolutionTemplates.id })
      .from(resolutionTemplates)
      .where(and(
        eq(resolutionTemplates.organizationId, organizationId),
        eq(resolutionTemplates.category, cat.key as never),
      ))
      .limit(1);
    if (already) {
      existing++;
      continue;
    }
    await db.insert(resolutionTemplates).values({
      name: cat.label,
      category: cat.key as never,
      templateText:
        `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
        `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
      isDefault: true,
      createdBy: 0, // system
      organizationId,
      dedupeKey: null,
    });
    inserted++;
  }
  return { inserted, existing };
}

/**
 * Seed the retail taxonomy as GLOBAL defaults (organizationId = null),
 * idempotent + race-proof via the dedupeKey unique index. Called on boot,
 * alongside the Nigerian defaults, so retail templates exist platform-wide.
 */
export async function seedRetailExceptionGlobalDefaults(): Promise<{ inserted: number }> {
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const { resolutionTemplates } = await import("../../drizzle/schema");
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return { inserted: 0 };

  const existing = await db
    .select({ category: resolutionTemplates.category, name: resolutionTemplates.name })
    .from(resolutionTemplates)
    .where(and(isNull(resolutionTemplates.organizationId), eq(resolutionTemplates.isDefault, true)));
  const existingKeys = new Set(existing.map((r) => `${r.category}::${r.name}`));

  const toInsert = RETAIL_COMMERCE_EXCEPTIONS.filter(
    (cat) => !existingKeys.has(`${cat.key}::${cat.label}`),
  );
  if (toInsert.length === 0) return { inserted: 0 };

  await db
    .insert(resolutionTemplates)
    .values(
      toInsert.map((cat) => ({
        name: cat.label,
        category: cat.key as never,
        templateText:
          `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
          `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
        isDefault: true,
        createdBy: 0,
        organizationId: null,
        dedupeKey: `default:${cat.key}:${cat.label}`,
      })),
    )
    .onDuplicateKeyUpdate({ set: { dedupeKey: sql`dedupe_key` } });

  return { inserted: toInsert.length };
}
