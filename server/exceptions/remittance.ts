/**
 * International Money Transfer Operators (IMTO) / Remittance — exception taxonomy.
 *
 * IMTOs facilitate inbound international money transfers to Nigeria.
 * Based on CBN Revised Guidelines for International Money Transfer
 * Services in Nigeria (January 2024), CBN FX regulations, and
 * operational realities of remittance settlement in Nigeria.
 */
import type { NigerianChannelException } from "./types";

export const REMITTANCE_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "imto_fx_rate_variance",
    label: "IMTO FX rate differs from prevailing NAFEM rate",
    severity: "high",
    slaHours: 24,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines (Jan 2024) §11: IMTOs shall use the prevailing exchange rate at the Nigerian Foreign Exchange Market (NAFEM) on the day the transfer is received. Variance from NAFEM rate indicates either: IMTO applying own rate (non-compliant), timing difference between receipt and conversion, or rate feed error.",
    recommendedResolution:
      "1) Compare the rate applied by the IMTO against the NAFEM closing rate on the transaction date. 2) If variance exceeds acceptable spread (typically ±0.5%), flag as non-compliant. 3) Calculate the Naira impact: (NAFEM rate − applied rate) × foreign currency amount. 4) If customer was disadvantaged, compensate the differential. 5) Report systematic rate variances to CBN Trade & Exchange Department as part of daily returns.",
    aiDiagnosisHint:
      "Naira amount credited to beneficiary ÷ foreign currency amount ≠ NAFEM rate on that date — check the IMTO's rate source and timing. If consistently below NAFEM, the IMTO may be applying a spread above what's permitted. Quantify across all transactions for the day to determine if it's systematic.",
  },
  {
    key: "imto_beneficiary_not_paid",
    label: "IMTO received funds but beneficiary not credited",
    severity: "critical",
    slaHours: 24,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines §12: IMTOs must pay beneficiaries promptly upon receipt of funds. Settlement accounts are nominee-type accounts with DMBs used exclusively for customer payments. Delays in beneficiary payment constitute a breach of operating guidelines and may trigger license review.",
    recommendedResolution:
      "1) Verify the IMTO received the inbound transfer (check IMTO settlement account for the credit). 2) Confirm beneficiary details: account number, bank, name. 3) If beneficiary details are correct, check if the payout instruction was sent (NIP or manual credit). 4) If NIP failed, follow NIP exception resolution. 5) If payout not initiated, escalate to IMTO operations for immediate processing. 6) If >24 hours, report to CBN as SLA breach.",
    aiDiagnosisHint:
      "IMTO settlement account credited (inbound funds received) but no corresponding outward NIP/credit to beneficiary — check if the payout instruction was generated. Common causes: KYC hold on beneficiary (amounts >$200 require account payment), incorrect beneficiary details from sender, or IMTO system processing delay.",
  },
  {
    key: "imto_wrong_beneficiary_paid",
    label: "IMTO remittance paid to wrong beneficiary",
    severity: "critical",
    slaHours: 24,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines: IMTOs must verify beneficiary identity before payment. For amounts >$200 equivalent, payment must be to a bank account (not cash). Wrong beneficiary payment indicates either: identity verification failure, account number error in the remittance instruction, or fraud. Recovery follows the same path as NIP erroneous transfer.",
    recommendedResolution:
      "1) Identify the incorrect beneficiary from the payout records. 2) If paid via NIP, initiate reversal request per CBN erroneous transfer circular (14 working day window). 3) If paid cash (amounts ≤$200), recovery is extremely difficult — escalate to fraud team. 4) Notify the sender/originating IMTO of the error. 5) If funds are recoverable, re-route to correct beneficiary. 6) Investigate root cause: was it sender's error in providing details, or IMTO operational error?",
    aiDiagnosisHint:
      "Remittance payout to account/person that doesn't match the sender's intended beneficiary — check if the error is in the IMTO's instruction (sender provided wrong details) or in the payout execution (IMTO/bank made the error). Sender error = IMTO not liable; execution error = IMTO liable.",
  },
  {
    key: "imto_kyc_rejection_funds_held",
    label: "IMTO payout blocked — beneficiary KYC failure",
    severity: "medium",
    slaHours: 72,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines §10: For amounts exceeding $200 equivalent, payment shall not be made in cash but through an account. Qualified cash payments require acceptable means of identification. If beneficiary fails KYC verification, funds are held in the IMTO settlement account pending resolution. Extended holds (>7 days) require reporting.",
    recommendedResolution:
      "1) Identify the KYC failure reason: invalid ID, name mismatch, BVN verification failure, or PEP/sanctions flag. 2) Contact beneficiary to provide additional/corrected identification. 3) If beneficiary provides valid KYC within 7 days, process payment. 4) If KYC cannot be satisfied within 30 days, return funds to originating IMTO for refund to sender. 5) If PEP/sanctions flag, escalate to Compliance for enhanced due diligence.",
    aiDiagnosisHint:
      "Funds in IMTO settlement account with no payout and KYC hold flag — check the specific KYC failure. BVN mismatch is most common (beneficiary name doesn't match BVN records exactly). For amounts just above $200, suggest cash payout if amount can be split (but this may constitute structuring — flag for compliance review).",
  },
  {
    key: "imto_settlement_account_shortfall",
    label: "IMTO Naira settlement account insufficient for payouts",
    severity: "critical",
    slaHours: 24,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines: IMTO settlement accounts are nominee-type accounts used exclusively for customer payments. If the account lacks sufficient Naira to cover all pending payouts (due to FX conversion delays or funding gaps), beneficiaries are not paid. This is a systemic failure requiring immediate IMTO intervention.",
    recommendedResolution:
      "1) Identify the funding gap: total pending payouts vs available Naira balance in settlement account. 2) Notify the IMTO immediately of the shortfall. 3) IMTO must fund the settlement account (sell FX at NAFEM rate or transfer from other sources). 4) Process payouts in FIFO order as funds become available. 5) If shortfall persists >24 hours, report to CBN and consider suspending new inbound transfers until funded.",
    aiDiagnosisHint:
      "Multiple pending payouts with insufficient settlement account balance — this is a liquidity/funding issue at the IMTO level, not a per-transaction problem. Check if it's a timing issue (FX conversion in progress) or a structural shortfall (IMTO is underfunded). Aggregate all pending payouts to quantify the gap.",
  },
  {
    key: "imto_duplicate_payout",
    label: "IMTO duplicate payout — same remittance paid twice",
    severity: "critical",
    slaHours: 24,
    sources: ["imto_remittance", "cbs_ledger"],
    regulatoryContext:
      "CBN IMTO Guidelines: Each remittance has a unique MTCN (Money Transfer Control Number) or equivalent reference. Duplicate payouts indicate either: system retry without idempotency check, manual processing error, or fraud. Recovery from beneficiary is required but may be difficult if funds are withdrawn.",
    recommendedResolution:
      "1) Confirm duplicate: same MTCN/reference paid out twice to same or different beneficiary. 2) Immediately place PND on beneficiary account if funds still available. 3) If funds available, reverse the duplicate payout. 4) If funds withdrawn, initiate recovery process (demand letter, then legal if needed). 5) Report to IMTO for their records and potential insurance claim. 6) Root-cause: check if the payout system has idempotency controls on MTCN.",
    aiDiagnosisHint:
      "Same MTCN appearing in two payout records — check if both were successful (both credited). If yes, it's a genuine duplicate. Check timing: if within seconds, it's a system retry; if hours/days apart, it's likely a manual reprocessing error. Immediate PND is critical to prevent fund dispersal.",
  },
];

export const REMITTANCE_EXCEPTION_KEYS = REMITTANCE_EXCEPTIONS.map((c) => c.key);
