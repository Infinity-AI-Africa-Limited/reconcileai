/**
 * Real-Time Gross Settlement (RTGS) — exception taxonomy.
 *
 * Nigeria's RTGS system (operated by CBN on SWIFT infrastructure) handles
 * high-value payments (typically ≥₦100 million) with same-day finality.
 * Exceptions are based on CBN RTGS Operating Rules, the CBN Act 2007
 * §2(d) and §47(2), and SWIFT messaging standards (MT103/MT202).
 */
import type { NigerianChannelException } from "./types";

export const RTGS_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "rtgs_insufficient_settlement_balance",
    label: "RTGS payment queued — insufficient CBN account balance",
    severity: "critical",
    slaHours: 4,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS Operating Rules: Payments are settled individually in real-time against the bank's account at CBN. Insufficient balance causes the payment to queue. Queued items are subject to priority ordering and may be cancelled at end-of-day if unfunded. High-value payment delays can trigger systemic liquidity concerns.",
    recommendedResolution:
      "1) Immediately notify Treasury/ALM desk of the queued payment and required funding amount. 2) Fund the CBN settlement account via money market borrowing or asset liquidation. 3) Once funded, confirm with CBN Operations that the queued item has been released. 4) If end-of-day approaches without funding, decide whether to cancel (requires customer notification) or arrange overnight funding. 5) Document the liquidity event for ALCO reporting.",
    aiDiagnosisHint:
      "High-value payment instruction sent but no settlement confirmation from CBN — check if the bank's RTGS position is insufficient. If multiple RTGS items are queued simultaneously, it's a liquidity event requiring Treasury escalation, not a per-transaction issue.",
  },
  {
    key: "rtgs_queue_priority_delay",
    label: "RTGS payment delayed by queue priority ordering",
    severity: "high",
    slaHours: 8,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS Operating Rules: When multiple payments are queued, they are processed by priority level (urgent/normal) and then FIFO within priority. Lower-priority items may be delayed indefinitely if higher-priority items consume available balance. CBN may invoke gridlock resolution mechanisms.",
    recommendedResolution:
      "1) Check the payment's priority level in the RTGS queue. 2) If the payment is normal priority but time-sensitive, request priority upgrade via CBN Operations (requires justification). 3) Monitor the queue position and estimated settlement time. 4) If delayed beyond customer's tolerance, notify customer and offer alternatives (split into smaller amounts, defer to next day). 5) Log for intraday liquidity management review.",
    aiDiagnosisHint:
      "RTGS instruction submitted but settling later than expected — check if higher-priority items consumed the available balance first. Compare submission time vs settlement time; delays >2 hours on normal-priority items suggest liquidity pressure.",
  },
  {
    key: "rtgs_value_date_discrepancy",
    label: "RTGS value date mismatch — instruction vs settlement",
    severity: "medium",
    slaHours: 24,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS Operating Rules: Value date must equal settlement date for same-day RTGS. If a payment is submitted with a future value date, it is warehoused. If submitted after cut-off, it settles next business day. Discrepancies between instruction value date and actual settlement date affect interest calculations and GL posting.",
    recommendedResolution:
      "1) Compare the instruction value date (from MT103/MT202) against the actual CBN settlement confirmation date. 2) If mismatch is due to cut-off time breach, adjust the CBS posting to reflect actual settlement date. 3) Calculate any interest differential for the customer (especially for large amounts). 4) If mismatch is due to warehousing, confirm the payment was intentionally future-dated.",
    aiDiagnosisHint:
      "CBS posting date differs from RTGS settlement confirmation date — check if the instruction was submitted after the daily cut-off (typically 3:30 PM) or was future-dated. Interest impact = amount × (days difference) × daily rate.",
  },
  {
    key: "rtgs_message_format_rejection",
    label: "RTGS payment rejected — SWIFT message format error",
    severity: "high",
    slaHours: 4,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS operates on SWIFT infrastructure. Non-compliant MT103/MT202 messages are rejected by the system. Common issues: invalid BIC codes, missing mandatory fields (Field 32A, 50K, 59), incorrect value date format. Rejected items must be corrected and resubmitted within the same business day to avoid T+1 settlement.",
    recommendedResolution:
      "1) Retrieve the SWIFT rejection notice with specific error field. 2) Correct the message format (BIC validation, field population, date format). 3) Resubmit before the daily cut-off time. 4) If cut-off has passed, notify the customer that settlement will be T+1. 5) Reverse the CBS debit to suspense if same-day settlement is no longer possible and customer requests cancellation.",
    aiDiagnosisHint:
      "CBS debit posted but RTGS shows rejection — check SWIFT delivery notification for the specific field error. Most common: invalid beneficiary BIC (Field 57A), missing ordering customer details (Field 50K), or value date in wrong format (YYMMDD vs YYYYMMDD).",
  },
  {
    key: "rtgs_cut_off_time_breach",
    label: "RTGS instruction after daily cut-off — deferred to T+1",
    severity: "medium",
    slaHours: 24,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS Operating Rules: Daily cut-off for RTGS submissions is typically 3:30 PM (may vary by session). Instructions received after cut-off are warehoused for next business day settlement. Customer was debited same-day but settlement occurs T+1, creating a timing mismatch.",
    recommendedResolution:
      "1) Confirm the instruction was submitted after the RTGS cut-off time. 2) Verify the payment is warehoused for next business day (not rejected). 3) Decide whether to hold the CBS debit in suspense or leave posted with a value-date adjustment. 4) Notify the customer that settlement will occur next business day. 5) Monitor next-day settlement confirmation and reconcile.",
    aiDiagnosisHint:
      "High-value CBS debit with no same-day RTGS settlement — check submission timestamp vs cut-off time. If submitted after 3:30 PM, this is expected warehousing, not a failure. Will auto-resolve next business day.",
  },
  {
    key: "rtgs_duplicate_instruction",
    label: "Duplicate RTGS payment instruction",
    severity: "critical",
    slaHours: 4,
    sources: ["cbn_rtgs", "cbs_ledger"],
    regulatoryContext:
      "CBN RTGS: Due to the high-value nature of RTGS payments (often ≥₦100M), duplicate instructions represent significant financial risk. SWIFT provides duplicate detection via UETR (Unique End-to-End Transaction Reference), but manual submissions or system retries can bypass this. Duplicate high-value payments require immediate escalation.",
    recommendedResolution:
      "1) Immediately verify if both instructions were settled by CBN (check UETR/reference). 2) If duplicate was settled, contact CBN Operations for emergency recall. 3) Simultaneously contact the beneficiary bank to place a hold on the duplicate credit. 4) If recall fails, initiate legal recovery process. 5) Root-cause: check if the duplicate originated from system retry, manual resubmission, or operational error.",
    aiDiagnosisHint:
      "Two RTGS debits for same amount + same beneficiary within same day — check UETR uniqueness. If different UETRs but same underlying instruction, it's a genuine duplicate. Given high values involved, escalate immediately rather than waiting for auto-reconciliation.",
  },
];

export const RTGS_EXCEPTION_KEYS = RTGS_EXCEPTIONS.map((c) => c.key);
