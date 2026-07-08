/**
 * NIBSS Electronic Funds Transfer (NEFT) — exception taxonomy.
 *
 * NEFT is Nigeria's batch clearing system operating on a deferred net
 * settlement basis with 4 clearing sessions daily. It handles lower-value
 * interbank transfers that don't require real-time settlement. Exceptions
 * are based on the Nigeria Bankers' Clearing System Rules (Revised),
 * NIBSS NEFT operating procedures, and CBN payment system regulations.
 */
import type { NigerianChannelException } from "./types";

export const NEFT_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "neft_batch_rejection",
    label: "NEFT batch rejected — format/validation failure",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "Nigeria Bankers' Clearing System Rules: Batches must conform to NEFT Data Transfer format specifications. Invalid format, missing mandatory fields, or file corruption results in entire batch rejection. Originating bank must resubmit in next clearing session.",
    recommendedResolution:
      "1) Retrieve the NIBSS rejection report with specific error codes. 2) Identify the format violation (missing fields, invalid characters, wrong record count). 3) Correct the batch file and resubmit in the next clearing session. 4) Reconcile CBS debits — if customers were pre-debited, hold in suspense until successful resubmission. 5) If batch cannot be corrected same day, notify affected customers.",
    aiDiagnosisHint:
      "CBS shows bulk debit to NEFT suspense GL but no corresponding NIBSS settlement — check NIBSS rejection report for the batch. Common causes: record count mismatch in trailer, invalid account format, special characters in beneficiary name.",
  },
  {
    key: "neft_return_item",
    label: "NEFT return item — beneficiary account invalid",
    severity: "medium",
    slaHours: 48,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "Nigeria Bankers' Clearing System Rules: Receiving bank must return items for invalid/closed accounts at the next clearing session. Return items are settled in the subsequent NEFT cycle. Originating bank must credit customer within T+2 of receiving the return.",
    recommendedResolution:
      "1) Match the return item from NIBSS against the original outward NEFT instruction. 2) Credit the customer's account from the NEFT suspense GL. 3) Notify the customer of the failed transfer with the return reason. 4) If the return is disputed (account was valid), raise a dispute with NIBSS citing the original instruction reference.",
    aiDiagnosisHint:
      "NIBSS return file contains items that should match original outward instructions — match on reference/amount. If return reason is 'account closed' but customer insists it's valid, check if beneficiary bank made an error. Cluster returns by beneficiary bank to detect systematic issues.",
  },
  {
    key: "neft_stale_dated_item",
    label: "NEFT stale-dated item — beyond clearing window",
    severity: "medium",
    slaHours: 48,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "Nigeria Bankers' Clearing System Rules: Items older than the prescribed clearing window (typically 3 business days from instruction date) are rejected as stale. Originating bank must reverse the customer debit and re-initiate if still required.",
    recommendedResolution:
      "1) Identify the stale item in the NIBSS rejection report. 2) Reverse the customer debit from NEFT suspense. 3) Investigate why the item was not presented within the clearing window (system queue failure, batch processing delay). 4) Re-initiate the transfer with a fresh instruction date if customer still requires it. 5) Root-cause the delay to prevent recurrence.",
    aiDiagnosisHint:
      "Item in NEFT suspense older than 3 business days with no settlement confirmation — likely stale-dated rejection. Check if the batch containing this item was delayed in the outward queue. Compare instruction_date vs actual presentation_date.",
  },
  {
    key: "neft_settlement_shortfall",
    label: "NEFT net settlement shortfall — insufficient position",
    severity: "critical",
    slaHours: 24,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "Nigeria Bankers' Clearing System Rules: Banks must maintain sufficient funds in their settlement account at CBN to cover net debit positions. Insufficient funds result in items being queued or the bank being suspended from clearing. CBN monitors settlement positions in real-time.",
    recommendedResolution:
      "1) Identify the clearing session where the shortfall occurred. 2) Determine which outward items were not settled due to insufficient position. 3) Fund the settlement account and request NIBSS to process in next session. 4) For items that were rejected, reverse customer debits from suspense. 5) Escalate to Treasury for settlement account funding management.",
    aiDiagnosisHint:
      "Multiple outward NEFT items in suspense past their expected settlement session — check if the bank's net position was insufficient. If all items from one session are unsettled, it's likely a position shortfall rather than individual item failures.",
  },
  {
    key: "neft_duplicate_batch_item",
    label: "NEFT duplicate item in batch",
    severity: "medium",
    slaHours: 72,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NEFT procedures: Duplicate detection is based on reference, amount, and beneficiary within a rolling window. Duplicates that pass through create double-credit liability. Originating bank bears responsibility for duplicate submissions.",
    recommendedResolution:
      "1) Identify the duplicate by matching reference + amount + beneficiary across recent batches. 2) Confirm which submission was the original and which is the duplicate. 3) If both were settled, request return of the duplicate from beneficiary bank. 4) If only one settled, reverse the CBS debit for the unsettled duplicate. 5) Fix the batch generation process to prevent duplicate inclusion.",
    aiDiagnosisHint:
      "Same reference + amount + beneficiary appearing in multiple NEFT batches within 3 days — check if both were settled by NIBSS or if one was auto-rejected by duplicate detection. If both settled, the beneficiary bank owes a return.",
  },
  {
    key: "neft_timing_difference",
    label: "NEFT settlement timing lag (T+1 expected)",
    severity: "low",
    slaHours: 48,
    sources: ["nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NEFT operates on deferred net settlement with 4 sessions daily. Items submitted after the last session settle T+1. This is contractual timing, not an exception — but items must auto-escalate if they exceed T+2 without settlement.",
    recommendedResolution:
      "1) No action within the T+1 settlement window. 2) On T+2 without settlement, reclassify as a genuine break and investigate. 3) Check which clearing session the item was submitted to and whether it was accepted. 4) Never manually clear a timing item — let the next settlement cycle resolve it.",
    aiDiagnosisHint:
      "Outward NEFT item younger than T+1 with no settlement confirmation — suppress as timing noise. Predict expected settlement based on submission time vs clearing session schedule (sessions at 10AM, 1PM, 3PM, 5PM). Auto-escalate only after T+2.",
  },
];

export const NEFT_EXCEPTION_KEYS = NEFT_EXCEPTIONS.map((c) => c.key);
