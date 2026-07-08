/**
 * Fintech Payment Gateways — exception taxonomy.
 *
 * Covers reconciliation exceptions for merchants/banks integrating with
 * Nigerian fintech payment gateways (Paystack, Flutterwave, Interswitch
 * Webpay, Squad, Korapay, Monnify, etc.). Based on CBN Payment Service
 * Provider regulations, gateway merchant service agreements, and the
 * IDRS/Arbiter dispute resolution frameworks.
 */
import type { NigerianChannelException } from "./types";

export const FINTECH_GATEWAY_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "gateway_settlement_vs_transaction_mismatch",
    label: "Gateway settlement amount differs from transaction total",
    severity: "high",
    slaHours: 72,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN PSP Regulations: Payment processors must provide daily settlement reports by 8AM on T+1 basis. Gateway settlement is net of fees, chargebacks, and refunds. Merchants often expect gross amounts but receive net. Unexplained variance beyond known deductions indicates a settlement error or undisclosed charges.",
    recommendedResolution:
      "1) Recompute expected net settlement: gross transactions − gateway fees − chargebacks − refunds − reserves (if applicable). 2) Obtain the gateway's settlement breakdown report (available via API or dashboard). 3) Match each deduction against known items: fees per contracted rate, chargebacks per IDRS/Arbiter records, refunds per merchant-initiated records. 4) If residual variance exists after accounting for all known deductions, raise formal settlement query with gateway within 30 days. 5) For recurring variances, audit the fee schedule against contract terms.",
    aiDiagnosisHint:
      "Bank account credit from gateway ≠ sum of successful transactions × (1 − fee rate). Decompose: known fees (rate × volume), known chargebacks (match against dispute records), known refunds (match against refund log), and rolling reserve (if applicable). Residual after all known deductions = the actual break to investigate.",
  },
  {
    key: "gateway_delayed_settlement",
    label: "Gateway settlement delayed beyond contractual T+1",
    severity: "high",
    slaHours: 48,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines on E-Payment Channels: Processors must provide daily settlement reports by 8AM on T+1 basis. Gateway merchant agreements typically specify T+1 settlement (some offer T+0 or express settlement for additional fees). Delays beyond contractual window constitute a breach and may indicate gateway liquidity issues.",
    recommendedResolution:
      "1) Verify the contractual settlement window (T+0, T+1, or T+2 depending on agreement). 2) Check if the delay is gateway-wide (systemic issue) or merchant-specific (possible hold/review). 3) Contact gateway support with transaction references for the unsettled batch. 4) If gateway-wide, monitor for resolution and document for potential SLA penalty claim. 5) If merchant-specific hold, determine reason (fraud review, KYC update required, chargeback threshold exceeded).",
    aiDiagnosisHint:
      "Successful transactions confirmed by gateway API but no settlement credit in bank account after T+1 — check gateway dashboard for settlement status. 'Processing' = normal delay; 'On hold' = merchant-specific issue; 'Failed' = bank account details error. Systemic delays across multiple merchants suggest gateway-level liquidity or operational issues.",
  },
  {
    key: "gateway_fee_discrepancy",
    label: "Gateway fee charged differs from contracted rate",
    severity: "medium",
    slaHours: 120,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN Guide to Charges and PSP Regulations: Gateway fees must be transparent and as contracted. Common Nigerian gateway fee structure: 1.5% + ₦100 (capped at ₦2,000) for local cards. International cards: 3.9%. Bank transfers: flat fee. Variance from contracted rates requires investigation and potential recovery.",
    recommendedResolution:
      "1) Calculate expected fees per the merchant agreement: rate × transaction amount, subject to cap. 2) Compare against actual fees deducted per the gateway settlement report. 3) If variance is due to transaction type misclassification (local vs international card), verify card BIN. 4) If variance is due to rate change, check if gateway notified per contract terms (typically 30 days notice). 5) For systematic overcharging, compile evidence and raise formal dispute with gateway for recovery of excess fees.",
    aiDiagnosisHint:
      "Fee per transaction differs from expected rate — check transaction type classification (local card, international card, bank transfer, USSD) as each has different rates. Also check for cap application: fees should be capped at ₦2,000 for local transactions. If fees exceed cap, it's a billing error.",
  },
  {
    key: "gateway_chargeback_deduction",
    label: "Gateway chargeback deducted from merchant settlement",
    severity: "high",
    slaHours: 48,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations and IDRS/Arbiter rules: Chargebacks are deducted from merchant settlement by the gateway. Merchants have a response window (typically 24-72 hours depending on gateway) to provide evidence for representment. Auto-acceptance occurs if merchant doesn't respond within SLA. Excessive chargeback ratio (>1%) may trigger merchant account review or termination.",
    recommendedResolution:
      "1) Receive chargeback notification from gateway (email, webhook, or dashboard). 2) Identify the disputed transaction and reason code. 3) Gather evidence: delivery proof, service rendered confirmation, customer communication, IP/device logs. 4) Submit representment within the gateway's response window. 5) If representment succeeds, the chargeback amount is returned to next settlement. 6) If representment fails, accept the loss and review merchant's fraud prevention controls.",
    aiDiagnosisHint:
      "Settlement amount reduced by chargeback deduction — match against gateway's dispute notifications. Check if the merchant was notified and given opportunity to respond. If no notification was sent (gateway error), the chargeback deduction may be invalid. Track chargeback ratio: chargebacks ÷ total transactions for the period.",
  },
  {
    key: "gateway_split_payment_variance",
    label: "Gateway split/sub-account payment allocation error",
    severity: "medium",
    slaHours: 72,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "Nigerian fintech gateways offer split payment features (Paystack Split, Flutterwave SubAccounts) for marketplace models. Splits are configured as percentages or fixed amounts. Variance in split allocation indicates either: configuration error, rounding differences, or fee deduction methodology disagreement (fee before split vs fee after split).",
    recommendedResolution:
      "1) Review the split configuration: percentage splits, fixed splits, or hybrid. 2) Recalculate expected allocation per the configuration rules. 3) Determine fee deduction methodology: is the gateway fee deducted before splitting (from gross) or after (from each sub-account's share)? 4) If variance is due to rounding, verify the gateway's rounding rules (typically round down to kobo). 5) If configuration error, update the split rules and reconcile historical variance.",
    aiDiagnosisHint:
      "Sub-account received different amount than expected from split configuration — check if fees are deducted before or after split (this is the #1 cause of split variances). Also check for transaction-level split overrides vs default configuration. Rounding on percentages can accumulate over many transactions.",
  },
  {
    key: "gateway_webhook_notification_failure",
    label: "Gateway payment successful but webhook/notification not received",
    severity: "medium",
    slaHours: 24,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN PSP Regulations: Payment confirmation must be reliable. Gateway webhooks are the primary mechanism for merchants to know about successful payments. If webhooks fail (merchant server down, timeout, network issue), the merchant may not fulfill the order despite successful payment. This creates a reconciliation gap between gateway records and merchant records.",
    recommendedResolution:
      "1) Verify the payment status via gateway API (GET /transactions/:reference) — confirm it's actually successful. 2) Check webhook delivery logs on the gateway dashboard for failed delivery attempts. 3) If webhook failed due to merchant server issues, fix the endpoint and request webhook replay/resend. 4) Manually reconcile: pull all successful transactions from gateway API and compare against merchant's received webhooks. 5) Fulfill any unfulfilled orders for confirmed successful payments.",
    aiDiagnosisHint:
      "Gateway shows payment as successful but merchant system has no record — check webhook delivery logs first. If webhooks were sent but merchant returned non-2xx, it's a merchant-side issue. If webhooks were never sent, it's a gateway issue. Either way, the payment is valid and the customer should receive their value.",
  },
  {
    key: "gateway_refund_not_reflected",
    label: "Gateway refund processed but not reflected in settlement",
    severity: "medium",
    slaHours: 72,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection: Refunds must be processed within stipulated timelines. Gateway refunds are typically deducted from the next settlement cycle rather than processed as separate credits. If a refund is processed but doesn't appear as a deduction in the next settlement, it may be deferred to a subsequent cycle or lost.",
    recommendedResolution:
      "1) Verify the refund status on the gateway (confirmed processed, not just initiated). 2) Check which settlement cycle the refund should be netted against. 3) If not in the expected cycle, check subsequent cycles (some gateways batch refunds weekly). 4) If refund is confirmed but never appears in settlement, raise with gateway — the merchant may have been double-charged (original transaction settled + refund not deducted). 5) Verify the customer actually received the refund (check with issuing bank if needed).",
    aiDiagnosisHint:
      "Refund marked as 'processed' in gateway but settlement amounts don't reflect the deduction — check the refund processing date vs settlement cycle dates. Refunds processed after the settlement cut-off roll to the next cycle. If multiple cycles pass without the deduction appearing, it's a genuine break.",
  },
  {
    key: "gateway_currency_conversion_variance",
    label: "Gateway multi-currency settlement at unexpected rate",
    severity: "high",
    slaHours: 72,
    sources: ["fintech_gateway", "cbs_ledger"],
    regulatoryContext:
      "CBN FX Regulations: International card payments collected in foreign currency must be settled to merchants in Naira at a disclosed rate. Gateways typically apply their own FX rate (which includes a margin above NAFEM). Variance beyond the disclosed margin indicates either: rate feed error, undisclosed margin increase, or timing difference between transaction and settlement conversion.",
    recommendedResolution:
      "1) Identify the FX rate applied by the gateway for each international transaction. 2) Compare against: NAFEM rate on transaction date, gateway's disclosed margin, and contracted rate terms. 3) If rate is within disclosed margin, no action (this is the gateway's revenue model). 4) If rate exceeds disclosed margin, raise dispute with evidence of contracted terms. 5) For systematic overcharging, compile transaction-level evidence for bulk recovery claim.",
    aiDiagnosisHint:
      "International transaction settled at rate different from expected — gateways typically apply NAFEM + 1-3% margin. Check if the variance is within the contracted margin or exceeds it. Also check timing: was the rate applied at transaction time or settlement time? Market-volatile days amplify this difference.",
  },
];

export const FINTECH_GATEWAY_EXCEPTION_KEYS = FINTECH_GATEWAY_EXCEPTIONS.map((c) => c.key);
