/**
 * SWIFT / Correspondent Banking — exception taxonomy.
 *
 * International transfers via SWIFT involve multiple intermediary banks,
 * creating complex reconciliation challenges. Nigerian banks face unique
 * issues around FX conversion, CBN regulations on domiciliary accounts,
 * nostro/vostro reconciliation, and sanctions screening. Based on SWIFT
 * messaging standards, CBN FX regulations, and correspondent banking
 * best practices.
 */
import type { NigerianChannelException } from "./types";

export const SWIFT_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "swift_intermediary_charges_deduction",
    label: "SWIFT intermediary bank charges — amount received less than sent",
    severity: "medium",
    slaHours: 72,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "SWIFT MT103 Field 71A (Details of Charges): Charge allocation (OUR/SHA/BEN) determines who bears intermediary fees. Nigerian banks often use SHA (shared), meaning beneficiary receives less than sent amount. CBN requires full disclosure of expected charges to customers. Unexplained deductions indicate undisclosed intermediary involvement.",
    recommendedResolution:
      "1) Compare amount sent (MT103 Field 32A) against amount received (credit advice from correspondent). 2) Identify the charge allocation instruction (Field 71A: OUR/SHA/BEN). 3) If SHA: deductions are expected — verify they are within normal range for the corridor. 4) If OUR: sender paid all charges — any deduction is an error by an intermediary. 5) Request charge breakdown from correspondent via MT199/MT195 query. 6) If charges are excessive or unauthorized, raise a claim with the intermediary bank.",
    aiDiagnosisHint:
      "Amount credited to nostro/customer account < amount in MT103 Field 32A — check Field 71A first. SHA = expected deductions (typically $15-$50 per intermediary). OUR = no deductions should occur. If OUR and still deducted, the intermediary violated the charge instruction. Track by corridor to identify expensive routes.",
  },
  {
    key: "swift_value_date_discrepancy",
    label: "SWIFT value date mismatch — FX rate impact",
    severity: "high",
    slaHours: 48,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "CBN FX regulations: Value date determines the applicable exchange rate for conversion. If a SWIFT payment is credited with a different value date than instructed (MT103 Field 32A), the FX rate applied may differ, creating a gain or loss. For large amounts, even 1-day value date difference can be material given Naira volatility.",
    recommendedResolution:
      "1) Compare instruction value date (MT103 Field 32A) against actual credit value date from correspondent. 2) Calculate FX impact: (actual rate − expected rate) × amount. 3) If value date was delayed by correspondent, raise a claim for the FX differential. 4) If delay was due to compliance screening, document but accept (regulatory requirement). 5) Adjust CBS posting to reflect actual value date for accurate P&L.",
    aiDiagnosisHint:
      "MT103 value date ≠ actual credit date on nostro statement — calculate the FX impact given Naira rate movement between the two dates. If the rate moved against the bank, quantify the loss for claim purposes. Compliance-related delays are not claimable but must be documented.",
  },
  {
    key: "swift_sanctions_screening_hold",
    label: "SWIFT payment held for sanctions/compliance screening",
    severity: "high",
    slaHours: 72,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "CBN AML/CFT Regulations and OFAC/EU sanctions requirements: Correspondent banks screen all SWIFT messages for sanctions hits. Payments involving Nigerian entities may be flagged due to country risk. Held payments create reconciliation breaks as the debit is posted but credit is delayed. Extended holds (>5 days) require escalation.",
    recommendedResolution:
      "1) Identify the held payment via MT199 notification from correspondent or SWIFT gpi tracker. 2) Determine the screening concern (name match, country, amount threshold). 3) Provide additional information to the correspondent's compliance team (KYC documents, purpose of payment, source of funds). 4) Track the hold duration — escalate if >5 business days. 5) If payment is returned, reverse the CBS debit and notify the customer with the compliance reason.",
    aiDiagnosisHint:
      "Outward SWIFT payment debited from CBS/nostro but no credit confirmation after 3+ business days — check SWIFT gpi tracker for status. 'Pending compliance review' status indicates sanctions screening hold. Nigerian names and entities have elevated screening rates; this is operational friction, not necessarily a problem with the payment itself.",
  },
  {
    key: "swift_nostro_vostro_mismatch",
    label: "Nostro/Vostro reconciliation break",
    severity: "high",
    slaHours: 48,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "CBN Prudential Guidelines: Banks must reconcile nostro accounts daily. Unreconciled items beyond 30 days must be reported to CBN. Nostro breaks indicate either: missing credits (revenue leakage), unidentified debits (potential fraud), or timing differences (legitimate float). CBN examiners review nostro reconciliation as a key control indicator.",
    recommendedResolution:
      "1) Obtain the nostro statement from the correspondent (MT940/MT950). 2) Match each entry against CBS nostro GL entries by reference, amount, and date. 3) Classify unmatched items: timing (will auto-match in next period), genuine break (requires investigation), or stale (>30 days, requires write-off or recovery). 4) For genuine breaks: trace the original instruction and determine if it's a missing credit or erroneous debit. 5) Items >30 days: escalate to Head of Operations and prepare CBN reporting.",
    aiDiagnosisHint:
      "Nostro statement entries not matching CBS nostro GL — classify by age: <3 days = timing (suppress), 3-30 days = investigate, >30 days = escalate. Direction matters: credits in nostro not in CBS = revenue leakage (urgent); debits in nostro not in CBS = potential unauthorized charges (investigate with correspondent).",
  },
  {
    key: "swift_wrong_beneficiary_details",
    label: "SWIFT payment with incorrect beneficiary details",
    severity: "high",
    slaHours: 48,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "SWIFT Operating Rules: Payments with incorrect beneficiary details (wrong account, wrong BIC, wrong name) may be rejected, returned, or credited to wrong party. MT103 Field 59 (Beneficiary) errors are the most common cause of international payment failures. Returns incur charges and FX risk on the return leg.",
    recommendedResolution:
      "1) If payment was rejected/returned: receive MT103 return with reason. Credit customer less return charges (if SHA/BEN). 2) If payment went to wrong beneficiary: initiate recall via MT199 to the beneficiary's bank. 3) Track recall — beneficiary bank has no obligation to return without beneficiary consent. 4) If recall fails after 30 days, advise customer of legal recovery options. 5) If payment is still in transit, send MT192 (cancellation request) before it's credited.",
    aiDiagnosisHint:
      "SWIFT payment returned or credited to unintended party — check MT103 Field 59 against customer's instruction. Common errors: IBAN digit transposition, wrong SWIFT BIC (similar bank names), or beneficiary name mismatch. If returned, the FX loss on the round-trip is the customer's cost unless the bank made the error.",
  },
  {
    key: "swift_fx_rate_variance",
    label: "SWIFT FX conversion rate variance",
    severity: "high",
    slaHours: 48,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "CBN FX Regulations: Nigerian banks must apply the prevailing NAFEM rate for FX conversions. For international payments, the rate applied at conversion may differ from the rate quoted to the customer due to: timing lag between quote and execution, market movement, or correspondent bank applying their own rate. Material variances require disclosure.",
    recommendedResolution:
      "1) Compare the FX rate applied (from CBS posting or correspondent advice) against the rate quoted to customer. 2) If variance is within the bank's disclosed spread, no action needed. 3) If variance exceeds disclosed spread, investigate: was it market movement (legitimate) or operational error? 4) For correspondent-applied rates (incoming payments), verify against NAFEM rate on the value date. 5) If customer was disadvantaged by bank error, compensate the differential.",
    aiDiagnosisHint:
      "FX rate in CBS posting differs from expected rate — determine which rate is 'correct': the NAFEM rate on value date, the customer's agreed rate, or the correspondent's applied rate. Variance sources: timing (rate moved between quote and execution), spread (bank's margin), or error (wrong rate applied). Quantify impact = amount × rate differential.",
  },
  {
    key: "swift_duplicate_payment",
    label: "Duplicate SWIFT payment instruction",
    severity: "critical",
    slaHours: 24,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "SWIFT gpi UETR (Unique End-to-End Transaction Reference): Each payment should have a unique UETR. Duplicate payments occur when: system retries after timeout, manual resubmission without checking status, or batch processing errors. Given international payment values, duplicates represent significant financial risk and are difficult to recover once credited.",
    recommendedResolution:
      "1) Identify duplicate: same beneficiary + same amount + same originator within 24 hours with different UETRs. 2) Immediately send MT192 (cancellation request) for the duplicate before it's credited. 3) If already credited, send recall request via MT199 to beneficiary bank. 4) Place the duplicate amount in suspense pending recovery. 5) Track recovery — international recalls can take 30+ days. 6) If unrecoverable, escalate to Legal for cross-border recovery options.",
    aiDiagnosisHint:
      "Two SWIFT debits for same beneficiary + same amount within 24 hours — check UETRs (should be different for genuine duplicate). Verify with the customer if they intended two payments. If duplicate confirmed, speed is critical — payments not yet credited to final beneficiary are much easier to recall than those already available.",
  },
  {
    key: "swift_inward_credit_not_applied",
    label: "Inward SWIFT credit not applied to customer account",
    severity: "high",
    slaHours: 24,
    sources: ["swift", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Inward remittances must be credited to beneficiary accounts promptly. CBN IMTO Guidelines (2024): All inbound transfers paid in Naira at prevailing NAFEM rate. Delays in applying inward credits create customer complaints and regulatory risk. Common causes: KYC holds, account mismatch, or FX conversion delays.",
    recommendedResolution:
      "1) Locate the inward MT103 in the SWIFT message queue. 2) Determine why it wasn't auto-posted: KYC flag, account number mismatch, amount threshold requiring manual approval, or FX conversion pending. 3) If KYC: complete enhanced due diligence and release. 4) If account mismatch: contact customer to confirm correct account. 5) If FX pending: apply NAFEM rate and post. 6) Credit with original value date to avoid interest loss to customer.",
    aiDiagnosisHint:
      "MT103 received (in nostro statement) but no corresponding customer credit in CBS — check the inward payment processing queue for holds. Common blockers: amount >$10,000 (enhanced KYC), beneficiary name doesn't match account name exactly, or the account is in a restricted status. FX conversion delays are also common during volatile market periods.",
  },
];

export const SWIFT_EXCEPTION_KEYS = SWIFT_EXCEPTIONS.map((c) => c.key);
