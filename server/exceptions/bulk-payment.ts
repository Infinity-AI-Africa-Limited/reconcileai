/**
 * Bulk / Salary Payments — exception taxonomy.
 *
 * Bulk payments (salary, vendor, dividend disbursements) are processed
 * as batch files through NIP or NEFT. They represent high-volume,
 * high-value operations where partial failures create complex
 * reconciliation scenarios. Based on NIBSS bulk payment operating
 * procedures, CBN salary payment guidelines, and banking operations
 * best practices.
 */
import type { NigerianChannelException } from "./types";

export const BULK_PAYMENT_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "bulk_partial_batch_failure",
    label: "Bulk payment partial failure — some items failed in batch",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_nip", "nibss_neft", "cbs_ledger"],
    regulatoryContext:
      "NIBSS Bulk Payment Rules: Batch files are processed item-by-item via NIP. Individual items may fail (invalid account, beneficiary bank offline, timeout) while others succeed. The payer is debited the full batch amount upfront. Failed items must be identified and refunded or retried within 24 hours per CBN consumer protection timelines.",
    recommendedResolution:
      "1) Obtain the batch processing report from NIBSS/payment platform showing per-item status. 2) Identify failed items with their failure reasons. 3) For retryable failures (timeout, bank offline): retry in next processing window. 4) For permanent failures (invalid account, closed account): refund to payer's batch suspense account. 5) Provide payer with detailed report: successful items, retried items, permanently failed items with reasons. 6) Reconcile: total batch amount = sum(successful) + sum(retried) + sum(refunded).",
    aiDiagnosisHint:
      "Batch debit amount > sum of confirmed credits — the difference represents failed items. Match the batch processing report against CBS credits posted. Items with NIP timeout may auto-resolve (check TSQ). Items with 'invalid account' are permanent failures requiring refund. Cluster failures by beneficiary bank to identify systemic issues.",
  },
  {
    key: "bulk_duplicate_batch_upload",
    label: "Duplicate batch upload — salary/payment file processed twice",
    severity: "critical",
    slaHours: 4,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection: Mass duplicate credits from double-processed salary files are a severe operational risk. Each batch should have a unique batch reference for idempotency. If the same file is uploaded and processed twice, all beneficiaries receive double payment. Recovery from thousands of individual accounts is extremely difficult and costly.",
    recommendedResolution:
      "1) IMMEDIATELY halt any further processing of the duplicate batch. 2) Identify all beneficiaries who received double credits. 3) For internal (on-us) beneficiaries: place lien on the duplicate amount in each account. 4) For external (not-on-us) beneficiaries: send bulk reversal requests to beneficiary banks citing erroneous transfer. 5) Notify the payer (employer/company) of the incident. 6) Root-cause: check batch reference uniqueness controls — why wasn't the duplicate detected?",
    aiDiagnosisHint:
      "Same batch reference or identical file hash processed twice — check timestamps of both processing runs. If within minutes, it's likely a system retry; if hours apart, it's likely a manual re-upload. Quantify exposure: batch_amount × 2 minus any already-recovered amounts. Speed is critical — funds not yet withdrawn are recoverable; withdrawn funds require legal process.",
  },
  {
    key: "bulk_invalid_account_in_batch",
    label: "Bulk payment — invalid beneficiary accounts in batch",
    severity: "medium",
    slaHours: 48,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NIP Operating Rules: Name enquiry should be performed before payment to validate accounts. For bulk payments, pre-validation of all accounts in the batch reduces failures. Invalid accounts in the batch (closed, dormant, wrong number) result in failed items that must be reported to the payer and refunded.",
    recommendedResolution:
      "1) Run pre-validation (name enquiry) on all accounts in the batch before processing. 2) Flag invalid accounts and return to payer for correction before processing. 3) If batch was processed without pre-validation and items failed: collect all failed items with reasons. 4) Refund the total of failed items to payer's account. 5) Provide payer with a report of failed accounts for their HR/finance team to correct. 6) Recommend pre-validation for future batches.",
    aiDiagnosisHint:
      "Multiple items in a batch returned as 'invalid account' — check if pre-validation (name enquiry) was performed. If not, recommend implementing pre-validation workflow. If pre-validation passed but payment failed, the account may have been closed/restricted between validation and payment (rare but possible for large batches with processing delays).",
  },
  {
    key: "bulk_insufficient_funds_for_batch",
    label: "Bulk payment — payer account insufficient for full batch",
    severity: "high",
    slaHours: 24,
    sources: ["cbs_ledger"],
    regulatoryContext:
      "Banking operations: Bulk payment batches require the payer account to have sufficient funds to cover the entire batch amount plus fees. If insufficient, the bank must decide: reject entire batch, or process partial (up to available balance). Most Nigerian banks reject the entire batch to avoid partial salary payments which create employee relations issues.",
    recommendedResolution:
      "1) Verify payer account balance vs total batch amount (including fees). 2) If insufficient: reject the entire batch (do not process partial for salary payments). 3) Notify payer immediately with the shortfall amount. 4) Hold the batch in queue for a defined window (typically 4 hours) for payer to fund. 5) If funded within window, process the batch. 6) If not funded, cancel the batch and notify payer to resubmit when funded.",
    aiDiagnosisHint:
      "Batch submitted but not processed, payer account balance < batch total — check if it's a timing issue (funds in transit to the account) or genuine shortfall. For salary payments, partial processing is worse than full rejection (creates employee complaints). Notify payer's finance team immediately.",
  },
  {
    key: "bulk_amount_variance",
    label: "Bulk payment — batch total doesn't match sum of items",
    severity: "medium",
    slaHours: 48,
    sources: ["cbs_ledger"],
    regulatoryContext:
      "NIBSS Bulk Payment format specifications: Batch files include a control total (sum of all item amounts) in the header/trailer record. If the sum of individual items doesn't match the control total, the batch should be rejected for data integrity reasons. Processing a mismatched batch risks over/under-debiting the payer.",
    recommendedResolution:
      "1) Compare batch header/trailer control total against computed sum of all items. 2) If mismatch: reject the batch and return to payer for correction. 3) Identify the discrepancy: missing items, extra items, or amount errors in specific items. 4) Do NOT process a batch with control total mismatch — this is a data integrity safeguard. 5) If the batch was already processed despite mismatch, reconcile actual debits vs actual credits to identify the gap.",
    aiDiagnosisHint:
      "Batch control total ≠ sum of items — this should be caught at upload validation. If it wasn't caught and the batch was processed, determine which is correct: the control total (and some items are wrong) or the items (and the control total has a typo). Check item count as well — missing items often explain the total discrepancy.",
  },
  {
    key: "bulk_settlement_timing_lag",
    label: "Bulk payment credits delayed — processing backlog",
    severity: "medium",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection: Salary/bulk payment beneficiaries expect same-day credit. Large batches (>10,000 items) processed via NIP may take hours to complete due to per-item processing. During peak periods (month-end salary days), NIBSS processing queues create delays. Beneficiaries complain to their banks about delayed salary credits.",
    recommendedResolution:
      "1) Check batch processing status: how many items processed vs total items. 2) If processing is in progress (not failed), advise patience — large batches take time. 3) Estimate completion time based on current processing rate. 4) If processing appears stalled (no progress for >1 hour), escalate to NIBSS/payment platform. 5) For customer complaints about delayed salary: check if their specific item has been processed yet. 6) Consider splitting very large batches across multiple submission windows to avoid peak congestion.",
    aiDiagnosisHint:
      "Batch submitted but credits appearing slowly — check the batch size and processing start time. Month-end (25th-30th) is peak salary processing; expect delays. If the batch is progressing (items completing over time), it's normal queuing. If stuck at a specific item count, there may be a processing error on a specific item blocking the queue.",
  },
];

export const BULK_PAYMENT_EXCEPTION_KEYS = BULK_PAYMENT_EXCEPTIONS.map((c) => c.key);
