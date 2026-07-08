/**
 * Direct Debit / Standing Order — exception taxonomy.
 *
 * Nigeria's Direct Debit scheme operates under CBN Guidelines on the
 * Nigeria Direct Debit Scheme (2010). It enables creditors to collect
 * payments from debtors' accounts based on pre-authorized mandates.
 * Exceptions cover mandate lifecycle issues, unauthorized debits,
 * and the indemnity framework that protects payers.
 */
import type { NigerianChannelException } from "./types";

export const DIRECT_DEBIT_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "dd_mandate_expired_debit",
    label: "Direct debit on expired mandate",
    severity: "high",
    slaHours: 24,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §5.3: Mandates have defined validity periods. Debits attempted on expired mandates are unauthorized and must be reversed immediately. The payer's bank (paying bank) is responsible for mandate validation before honoring debit instructions.",
    recommendedResolution:
      "1) Verify mandate expiry date against the debit instruction date. 2) If mandate expired, reject the debit instruction (if not yet processed) or reverse immediately (if already processed). 3) Notify the originator (creditor) that the mandate has expired. 4) Credit the payer's account with value date of the unauthorized debit. 5) Log as a mandate management failure for the originator.",
    aiDiagnosisHint:
      "Debit instruction with mandate reference where mandate_expiry_date < debit_date — the paying bank's mandate validation failed. Check if the mandate registry is being checked in real-time or if there's a batch validation gap.",
  },
  {
    key: "dd_insufficient_funds",
    label: "Direct debit unpaid — insufficient funds",
    severity: "medium",
    slaHours: 48,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §6.2: If the payer's account has insufficient funds on the collection date, the item is returned unpaid. The paying bank must notify the originator of the unpaid item. Repeated unpaid items may trigger mandate cancellation. CBN reporting required for systemic unpaid patterns.",
    recommendedResolution:
      "1) Confirm insufficient funds at the time of debit attempt. 2) Return the item unpaid to the originator via NIBSS with reason code 'insufficient funds'. 3) Notify the payer that the direct debit was not honored. 4) If this is the 3rd consecutive unpaid item, flag for mandate review. 5) Report to originator for their own collections follow-up.",
    aiDiagnosisHint:
      "Direct debit instruction received but payer account balance < debit amount — check if there's a partial payment option or if the full amount must be rejected. In Nigeria, direct debits are all-or-nothing (no partial collection). Track frequency of unpaid items per mandate.",
  },
  {
    key: "dd_disputed_unauthorized_debit",
    label: "Direct debit disputed — payer claims unauthorized",
    severity: "critical",
    slaHours: 24,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §7: The Direct Debit Guarantee (Indemnity) provides that payers can claim immediate refund for unauthorized debits. The paying bank must refund first and investigate later. The originator bears the burden of proving authorization. Refund must be processed within 24 hours of dispute.",
    recommendedResolution:
      "1) Receive dispute from payer (written or verbal complaint). 2) Immediately refund the disputed amount per the Direct Debit Guarantee — do not wait for investigation. 3) Notify the originator of the dispute and debit their collection account. 4) Request mandate evidence from originator (signed mandate, proof of advance notice). 5) If originator provides valid mandate evidence, re-debit payer (with notice). If not, the refund stands.",
    aiDiagnosisHint:
      "Payer disputes a direct debit — under the DD Guarantee, refund first, investigate later. Check if the mandate exists in the registry, if advance notice was given (14 days for variable amounts), and if the debited amount matches the mandate terms. The originator must prove authorization.",
  },
  {
    key: "dd_amount_exceeds_mandate",
    label: "Direct debit amount exceeds mandate limit",
    severity: "high",
    slaHours: 24,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §5.4: Variable direct debits must not exceed the maximum amount specified in the mandate. If the debit amount exceeds the mandate ceiling, the paying bank must reject the instruction. If processed in error, the excess must be refunded immediately.",
    recommendedResolution:
      "1) Compare debit amount against mandate maximum amount. 2) If exceeds mandate limit, reject the instruction (if not yet processed). 3) If already processed, reverse the full amount and notify originator of the breach. 4) Alternatively, if payer agrees to the higher amount, obtain updated mandate authorization. 5) Log the mandate breach for regulatory reporting.",
    aiDiagnosisHint:
      "Debit amount > mandate.max_amount — check if the mandate is fixed-amount (exact match required) or variable (up to maximum). For variable mandates, any amount up to the max is valid; amounts exceeding max are always invalid regardless of mandate type.",
  },
  {
    key: "dd_advance_notice_not_given",
    label: "Direct debit without required advance notice",
    severity: "medium",
    slaHours: 48,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §5.5: For variable direct debits, the originator must give the payer at least 14 calendar days advance notice of the amount and date of collection. Failure to provide advance notice gives the payer grounds to dispute under the DD Guarantee.",
    recommendedResolution:
      "1) Check if advance notice was sent to payer (originator's responsibility to prove). 2) If payer disputes citing no advance notice, process refund under DD Guarantee. 3) Notify originator of the advance notice failure. 4) If originator can prove notice was sent (delivery receipt), the dispute may be rejected. 5) Advise originator to maintain proof of advance notice delivery for all variable DDs.",
    aiDiagnosisHint:
      "Payer disputes a variable direct debit citing no advance notice — this is a valid dispute ground under CBN rules. Check if the debit was for a fixed amount (no notice required) or variable (14 days notice required). The originator bears the burden of proving notice delivery.",
  },
  {
    key: "dd_cancelled_mandate_debit",
    label: "Direct debit on cancelled mandate",
    severity: "critical",
    slaHours: 24,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines §8: Payers can cancel mandates at any time by notifying their bank. Once cancelled, no further debits should be honored. Debits on cancelled mandates are unauthorized and must be reversed immediately. The paying bank is liable if it honors a debit on a cancelled mandate.",
    recommendedResolution:
      "1) Verify mandate status in the mandate registry — confirmed cancelled. 2) Immediately reverse the unauthorized debit. 3) Notify the originator that the mandate has been cancelled and no further instructions will be honored. 4) If the paying bank's system failed to flag the cancelled mandate, investigate the mandate registry update process. 5) Compensate payer for any consequential loss (e.g., overdraft charges).",
    aiDiagnosisHint:
      "Debit processed on a mandate with status='cancelled' in the registry — the paying bank's real-time mandate check failed. Check if the cancellation was recent (registry propagation delay) or old (systematic validation failure). Either way, immediate reversal required.",
  },
  {
    key: "dd_wrong_account_debited",
    label: "Direct debit from wrong payer account",
    severity: "critical",
    slaHours: 24,
    sources: ["direct_debit", "cbs_ledger"],
    regulatoryContext:
      "CBN Direct Debit Scheme Guidelines: Mandates specify the exact account to be debited. Debiting a different account (even if owned by the same customer) without authorization is a breach. Immediate reversal required plus investigation into how the wrong account was targeted.",
    recommendedResolution:
      "1) Compare the debited account against the mandate's specified account. 2) If mismatch, reverse immediately regardless of whether the account holder is the same person. 3) If the debit should have gone to the mandate account, re-process against the correct account (with fresh authorization if needed). 4) Investigate root cause: originator error in instruction, or system routing error. 5) Compensate affected account holder for any consequential loss.",
    aiDiagnosisHint:
      "Debit account number ≠ mandate.payer_account — check if it's a digit transposition (originator error) or if the customer has multiple accounts and the wrong one was targeted. Either way, the debit is unauthorized against that specific account.",
  },
];

export const DIRECT_DEBIT_EXCEPTION_KEYS = DIRECT_DEBIT_EXCEPTIONS.map((c) => c.key);
