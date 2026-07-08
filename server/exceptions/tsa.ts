/**
 * CBN eTreasury / Treasury Single Account (TSA) — exception taxonomy.
 *
 * The Treasury Single Account policy requires all government revenues
 * to be remitted to a single account at CBN. Banks act as collection
 * agents and must remit collected revenues daily. Based on CBN TSA
 * Guidelines, the Government Integrated Financial Management Information
 * System (GIFMIS), and Remita/SystemSpecs TSA platform operations.
 */
import type { NigerianChannelException } from "./types";

export const TSA_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "tsa_remittance_failure",
    label: "TSA remittance failure — collected revenue not remitted to CBN",
    severity: "critical",
    slaHours: 24,
    sources: ["cbn_tsa", "cbs_ledger"],
    regulatoryContext:
      "CBN TSA Guidelines: All government revenues collected by banks must be remitted to the TSA at CBN by end of business day (T+0). Failure to remit attracts penalties including: interest at MPR + 3% on unremitted amounts, and potential suspension from government revenue collection. Banks cannot use government funds for overnight lending.",
    recommendedResolution:
      "1) Identify the failed remittance: which MDA collections were not swept to TSA. 2) Determine failure cause: system error (Remita/eTreasury platform issue), insufficient processing time (collections received late in day), or operational oversight. 3) Process the remittance immediately (even if next business day). 4) Calculate and provision for the penalty: unremitted amount × (MPR + 3%) ÷ 365 × days delayed. 5) Report to CBN Banking Supervision as required. 6) Root-cause and fix the sweep automation.",
    aiDiagnosisHint:
      "Government revenue collections in CBS (MDA collection GLs) not matched by corresponding TSA remittance to CBN — check the Remita/eTreasury sweep job logs. If the sweep job failed, it's a system issue. If it ran but skipped certain collections, check the collection cut-off time vs sweep time. Collections received after sweep time roll to next day (but this still attracts penalty).",
  },
  {
    key: "tsa_wrong_sub_account",
    label: "TSA payment to wrong government sub-account/MDA",
    severity: "high",
    slaHours: 48,
    sources: ["cbn_tsa", "cbs_ledger"],
    regulatoryContext:
      "CBN TSA Structure: The TSA has sub-accounts for different MDAs (Ministries, Departments, and Agencies). Payments must be routed to the correct MDA sub-account using the correct revenue code. Misrouting creates reconciliation issues for both the paying entity and the receiving MDA. OAGF (Office of the Accountant General) monitors sub-account allocations.",
    recommendedResolution:
      "1) Identify the incorrect MDA sub-account that received the payment. 2) Determine the correct MDA sub-account based on the revenue type/code. 3) Request re-allocation via Remita/eTreasury platform (inter-MDA transfer within TSA). 4) If re-allocation requires OAGF approval, submit request with payment evidence. 5) Notify the payer that the payment has been received but is being re-routed. 6) Update the revenue code mapping if the error was systemic.",
    aiDiagnosisHint:
      "Payment to TSA confirmed but MDA reports not receiving it — check the revenue code used in the payment instruction. If revenue code maps to a different MDA, the payment was correctly processed but to the wrong sub-account. This is a mapping/classification error, not a payment failure. The funds are safe within TSA, just misallocated.",
  },
  {
    key: "tsa_collection_shortfall",
    label: "TSA collection shortfall — expected revenue not received",
    severity: "high",
    slaHours: 48,
    sources: ["cbn_tsa", "cbs_ledger"],
    regulatoryContext:
      "CBN TSA Guidelines and OAGF Revenue Monitoring: MDAs have expected revenue targets. Shortfalls between expected collections and actual TSA credits indicate either: delayed remittance by collecting banks, revenue leakage (collections not swept), or genuine reduction in revenue. OAGF reconciles expected vs actual monthly.",
    recommendedResolution:
      "1) Compare expected revenue (from MDA billing/assessment records) against actual TSA credits for the period. 2) Identify the gap: which specific payments are missing. 3) Check with collecting banks: were the payments received but not yet remitted? 4) If payments were received and remitted, check if they went to wrong sub-account (see tsa_wrong_sub_account). 5) If payments were never received by the bank, the issue is with the payer (non-payment), not the banking system. 6) Report findings to OAGF for their revenue assurance process.",
    aiDiagnosisHint:
      "MDA expected revenue > actual TSA credits — decompose the gap: payments received by bank but not remitted (bank's fault, penalty applies), payments to wrong sub-account (misallocation, recoverable), and payments never received (payer non-compliance, not a banking issue). Focus on the first two categories as they're within the bank's control.",
  },
  {
    key: "tsa_duplicate_remittance",
    label: "TSA duplicate remittance — same revenue remitted twice",
    severity: "high",
    slaHours: 48,
    sources: ["cbn_tsa", "cbs_ledger"],
    regulatoryContext:
      "CBN TSA Operations: Duplicate remittances to TSA create reconciliation issues and may result in the bank being short (remitted more than collected). Recovery of excess remittance from CBN/TSA requires formal application to OAGF with evidence. The process can take weeks, creating a temporary funding gap for the bank.",
    recommendedResolution:
      "1) Confirm the duplicate: same amount + same MDA + same reference remitted twice. 2) Immediately notify CBN/OAGF of the duplicate with full transaction evidence. 3) Submit formal recovery application to OAGF. 4) In the interim, fund the shortfall from internal sources (the bank is out-of-pocket until recovery). 5) Track the recovery application — follow up weekly. 6) Root-cause: check if the sweep automation ran twice or if manual remittance duplicated an automated one.",
    aiDiagnosisHint:
      "Same revenue reference appearing twice in TSA remittance records — check if both were debited from the bank's account (confirms duplicate remittance vs just duplicate reporting). If the bank was debited twice, it's a genuine duplicate requiring recovery from CBN. Check sweep job logs for double-execution or manual override that duplicated an automated sweep.",
  },
  {
    key: "tsa_fx_conversion_variance",
    label: "TSA FX collection — conversion rate dispute",
    severity: "high",
    slaHours: 72,
    sources: ["cbn_tsa", "cbs_ledger"],
    regulatoryContext:
      "CBN TSA Guidelines: Government revenues collected in foreign currency (customs duties, oil revenues, etc.) must be converted to Naira at the CBN official rate before remittance to TSA. Variance between the applied rate and the CBN official rate on the conversion date creates a gain/loss that must be accounted for. CBN monitors FX conversion compliance closely.",
    recommendedResolution:
      "1) Identify the FX rate applied for the TSA remittance conversion. 2) Compare against the CBN official rate on the conversion date. 3) If rate matches CBN official rate: no issue (any difference from market rate is policy, not error). 4) If rate differs from CBN official rate: investigate — was a wrong rate applied? 5) Calculate the Naira impact and determine if it favors or disadvantages the government. 6) If bank error, adjust and remit the differential. If CBN rate ambiguity, seek clarification from CBN.",
    aiDiagnosisHint:
      "FX-denominated government revenue converted at rate ≠ CBN official rate — check which CBN rate applies (there may be multiple: official, NAFEM, intervention). For customs duties, the CBN typically specifies the exact rate to use. If the wrong rate category was applied, calculate the differential and prepare adjustment.",
  },
];

export const TSA_EXCEPTION_KEYS = TSA_EXCEPTIONS.map((c) => c.key);
