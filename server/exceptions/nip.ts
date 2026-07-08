/**
 * NIBSS Instant Payment (NIP) — exception taxonomy.
 *
 * NIP is the backbone of real-time interbank transfers in Nigeria,
 * processing quadrillions of naira annually. These exceptions cover
 * the full spectrum of NIP failure modes from timeout scenarios to
 * erroneous transfers, based on NIBSS NIP Operating Rules, CBN
 * Consumer Protection Regulations, and the CBN Circular on Regulation
 * of Instant Inter-Bank EFT Services (September 2018).
 */
import type { NigerianChannelException } from "./types";

export const NIP_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "nip_timeout_debit_no_credit",
    label: "NIP timeout — sender debited, beneficiary not credited",
    severity: "critical",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Circular BPS/DIR/GEN/CIR/04/014 (Sept 2018): Failed NIP transactions must be reversed within 24 hours. Penalty of ₦10,000 per item for non-compliance. NIBSS NIP Operating Rules require TSQ within 40 seconds of no response, with up to 3 retries at 5-second intervals.",
    recommendedResolution:
      "1) Query NIBSS Transaction Status Query (TSQ) for the session_id to determine final status. 2) If TSQ returns failed/timeout, reverse the CBS debit immediately. 3) If TSQ returns successful but beneficiary bank has not credited, raise a dispute via NIBSS DRS. 4) SMS the customer with resolution status. 5) Log in complaints register with session_id and TSQ response as evidence.",
    aiDiagnosisHint:
      "CBS debit with no corresponding NIBSS settlement confirmation — check TSQ response code; distinguish switch timeout (auto-reversible) from beneficiary-bank delay (dispute path). Cluster by time window to identify systemic NIBSS outages vs isolated failures.",
  },
  {
    key: "nip_inward_credit_not_applied",
    label: "NIP inward credit not applied to beneficiary",
    severity: "critical",
    slaHours: 4,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Circular BPS/DIR/GEN/CIR/04/014: Delayed application of inward NIP beyond 4 minutes attracts ₦10,000 penalty per item. NIBSS NIP Operating Rules §9: Beneficiary bank must credit customer account in near-real-time upon receiving valid credit instruction.",
    recommendedResolution:
      "1) Locate the NIP session_id in the NIBSS settlement report. 2) Verify the beneficiary account status (active, dormant, PND, closed). 3) If account is valid, post credit immediately. 4) If account is invalid/closed, initiate return via NIBSS within the return window. 5) If posting queue failure, investigate CBS batch job logs for the gap window.",
    aiDiagnosisHint:
      "Session present in NIBSS inward file but absent in CBS credits — commonest causes: account-number transposition, dormant/PND block, CBS posting-queue failure, or account name mismatch rejection. Check account status first.",
  },
  {
    key: "nip_duplicate_transfer",
    label: "Duplicate NIP transfer (retry-induced)",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Double debits are a leading complaint category. NIBSS NIP Operating Rules: name_enquiry_ref and session_id should prevent duplicates, but retry logic during timeouts can create genuine duplicates.",
    recommendedResolution:
      "1) Confirm both transactions share the same name_enquiry_ref or identical parameters (amount, beneficiary, timestamp within 60s). 2) Verify via TSQ that both sessions were settled. 3) If duplicate confirmed, reverse the later transaction. 4) If customer-visible, notify per CBN consumer-protection timelines. 5) Root-cause: check if originating channel lacks idempotency controls.",
    aiDiagnosisHint:
      "Same amount + same beneficiary + timestamps within 60 seconds — verify name_enquiry_ref; NIP retries share this reference. If both have distinct session_ids but same name_enquiry_ref, the second is a retry duplicate.",
  },
  {
    key: "nip_wrong_account_credit",
    label: "NIP credit to wrong account (erroneous transfer)",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Circular BPS/DIR/GEN/CIR/04/014: Sending entity may request reversal within 14 working days. Receiving entity must oblige within 1 business day if funds are available. If funds unavailable, receiving entity must notify customer within 24 hours with consequences including watch-listing.",
    recommendedResolution:
      "1) Receive written reversal request from sending entity with transaction evidence. 2) Check if funds are available in the beneficiary account. 3) If available, execute reversal within 1 business day without recourse to beneficiary. 4) If unavailable, notify beneficiary of consequences (watch-listing within 7 days, credit bureau reporting). 5) Place lien on available balance. 6) Document the indemnity from sending entity.",
    aiDiagnosisHint:
      "Reversal request from another bank for a credited NIP — check fund availability in beneficiary account; if balance covers the amount, auto-flag for same-day reversal. If insufficient, escalate to operations for customer notification workflow.",
  },
  {
    key: "nip_name_enquiry_mismatch",
    label: "NIP name enquiry mismatch (stale cache)",
    severity: "medium",
    slaHours: 48,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NIP Operating Rules: Name enquiry responses are cached by NIBSS. If beneficiary updates account information, cached data becomes stale. Receiving bank should reject mismatched transactions to trigger cache refresh. Non-rejection leads to reconciliation complications.",
    recommendedResolution:
      "1) Compare the name in the NIP instruction against the current account name in CBS. 2) If mismatch is due to name change (marriage, legal), verify with account holder and accept. 3) If mismatch indicates wrong account, reject the transaction to trigger NIBSS cache refresh. 4) Log the mismatch for pattern analysis — repeated mismatches on same account suggest cache staleness.",
    aiDiagnosisHint:
      "NIP credit where the name in the NIBSS message doesn't match CBS account name — check if it's a minor variation (abbreviation, middle name) vs completely different person. High-risk if completely different; low-risk if partial match.",
  },
  {
    key: "nip_settlement_reconciliation_break",
    label: "NIP settlement report vs CBS ledger mismatch",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NIP Operating Rules: Daily settlement reports must be reconciled by T+1. Unreconciled items indicate either lost transactions (revenue leakage) or unposted liabilities. CBN examination requires zero unreconciled NIP items beyond T+2.",
    recommendedResolution:
      "1) Download NIBSS daily settlement report and compare against CBS NIP GL movements. 2) Identify sessions in NIBSS not in CBS (missing credits/debits) and sessions in CBS not in NIBSS (orphan postings). 3) For missing CBS entries, check posting queue failures and re-post. 4) For orphan CBS entries, verify if they are manual adjustments or system errors. 5) Escalate items unresolved beyond T+1 to Head of Operations.",
    aiDiagnosisHint:
      "Aggregate-level: sum of NIBSS settlement ≠ CBS NIP GL net movement. Drill down by session_id to find the specific breaks. Cluster by time window — bulk mismatches in one window suggest CBS outage; scattered singles suggest per-transaction posting failures.",
  },
  {
    key: "nip_beneficiary_bank_offline",
    label: "NIP failed — beneficiary bank system offline",
    severity: "high",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN Circular BPS/DIR/GEN/CIR/04/014: Failed NIP must be reversed within 24 hours regardless of cause. NIBSS response code indicates beneficiary bank unavailable. Sending bank must not hold customer funds pending beneficiary bank recovery.",
    recommendedResolution:
      "1) Check NIBSS response code — if it indicates beneficiary bank offline/timeout. 2) Reverse the CBS debit immediately (do not wait for beneficiary bank recovery). 3) If customer requests retry, advise to wait until beneficiary bank is confirmed online. 4) Log the failed session for the daily reconciliation report.",
    aiDiagnosisHint:
      "NIBSS response code 91 (issuer/switch inoperative) or 96 (system malfunction) — these are auto-reversible. If multiple transactions to the same beneficiary bank fail in a window, it's a systemic outage; flag for bulk reversal processing.",
  },
  {
    key: "nip_dry_posting",
    label: "NIP dry posting — credit without matching debit",
    severity: "critical",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "NIBSS Incident (Sept 2024): Technical accounting logic error caused credits without corresponding debits. This creates unjust enrichment liability. CBN requires immediate identification and lien placement on unearned credits. Recovery requires judicial authorization if funds have been moved.",
    recommendedResolution:
      "1) Identify all credit postings in the affected window that lack corresponding debit legs in the NIBSS settlement. 2) Place immediate Post-No-Debit (PND) on affected accounts to prevent fund dispersal. 3) Raise reversal requests — if funds available, reverse immediately. 4) If funds moved, escalate to Legal for judicial recovery (BVN-linked PND across all banks). 5) Report to NIBSS and CBN per incident management protocols.",
    aiDiagnosisHint:
      "Credits in CBS with no matching debit in NIBSS settlement report — distinguish from legitimate inward NIP (which should have NIBSS session) vs system error (no session). Cluster by timestamp to identify the error window. Check if affected accounts show immediate outward transfers (fund dispersal indicator).",
  },
];

export const NIP_EXCEPTION_KEYS = NIP_EXCEPTIONS.map((c) => c.key);
