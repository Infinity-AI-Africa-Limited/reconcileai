/**
 * Point of Sale (POS) — exception taxonomy.
 *
 * POS terminals are the most widely deployed card acceptance channel in
 * Nigeria, with millions of transactions daily across bank-deployed and
 * agent-network terminals. Exceptions are based on CBN Guidelines on
 * Operations of Electronic Payment Channels (June 2020 revision),
 * NIBSS/Interswitch/UPSL settlement rules, and the IDRS/Arbiter
 * dispute resolution frameworks.
 */
import type { NigerianChannelException } from "./types";

export const POS_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "pos_declined_but_debited",
    label: "POS declined but customer debited",
    severity: "critical",
    slaHours: 48,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines on E-Payment Channels §4.9 (2020 revision): Refunds on disputed/failed POS transactions shall be treated within 48 hours. Switches must adjust chargeback cycle to 24 hours. The terminal displays 'declined' but the issuer has debited the customer — the most common POS complaint in Nigeria.",
    recommendedResolution:
      "1) Retrieve the transaction using RRN (Retrieval Reference Number) and STAN from the customer's receipt. 2) Check the switch response: if response code ≠ 00 (approved), the transaction failed at the switch level. 3) If issuer debited despite non-00 response, initiate immediate reversal. 4) If reversal fails technically, escalate to the switch (Interswitch/UPSL) via IDRS within 24 hours. 5) Credit customer within 48 hours maximum per CBN guidelines.",
    aiDiagnosisHint:
      "CBS debit with switch response code ≠ 00 — the issuer processed the debit but the acquirer/terminal received a decline. Check if the response code indicates timeout (68) vs explicit decline (05, 51). Timeout cases are auto-reversible; explicit declines with debits indicate switch routing issues.",
  },
  {
    key: "pos_settlement_shortfall",
    label: "POS acquirer settlement shortfall",
    severity: "high",
    slaHours: 72,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines §2.5: POS settlement is T+1 net of interchange and scheme fees. Processors must provide daily settlement reports by 8AM on T+1 basis. Unexplained shortfalls between expected net settlement and actual amount received indicate fee miscalculation, chargeback netting, or processor error.",
    recommendedResolution:
      "1) Recompute expected net settlement: gross transactions − interchange fees − scheme fees − chargebacks netted. 2) Compare against actual settlement received from acquirer/processor. 3) If variance is attributable to fees, verify against contracted fee schedule. 4) If variance includes chargebacks, match against IDRS/Arbiter dispute records. 5) Raise settlement query with processor for unexplained residual within 30 days.",
    aiDiagnosisHint:
      "Sum of POS transactions × (1 − fee%) ≠ settlement received. Decompose the variance: known fees, known chargebacks, and residual. If residual is proportional to volume, suspect fee-rate change; if fixed amount, suspect specific transaction omission.",
  },
  {
    key: "pos_chargeback",
    label: "POS chargeback — customer dispute",
    severity: "high",
    slaHours: 48,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines §3.10: Consumer protection/dispute resolution for POS. Cardholders can lodge chargeback claims within 6 months per CBN policy. Disputes are managed via IDRS (NIBSS) or Arbiter (Interswitch). Acquirer must respond within 24 hours of chargeback notification. Failure to respond results in auto-acceptance.",
    recommendedResolution:
      "1) Receive chargeback notification from IDRS/Arbiter with reason code. 2) Retrieve transaction evidence: terminal journal, merchant receipt, CCTV if available. 3) If merchant can prove service was rendered, submit representment with evidence within 24 hours. 4) If chargeback is valid (customer didn't receive value), accept and debit merchant settlement account. 5) Track chargeback ratio per merchant — excessive chargebacks trigger merchant review.",
    aiDiagnosisHint:
      "Chargeback deduction in settlement file — match against IDRS/Arbiter case reference. Check reason code: fraud (unauthorized use) vs service (goods not received) vs processing error (duplicate). Each has different evidence requirements for representment.",
  },
  {
    key: "pos_offline_batch_mismatch",
    label: "POS offline transaction batch mismatch",
    severity: "medium",
    slaHours: 72,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines on POS: Terminals may process transactions offline (store-and-forward) during network outages. When connectivity resumes, the batch is uploaded for settlement. Offline transactions carry elevated chargeback risk and may be rejected if the card has been blocked between transaction time and upload time.",
    recommendedResolution:
      "1) Identify offline transactions in the terminal batch (indicated by offline flag or delayed submission timestamp). 2) Match against switch authorization records — offline items won't have real-time auth codes. 3) For rejected offline items, debit the merchant (they accepted risk of offline processing). 4) For settled offline items, monitor for chargebacks within 45 days. 5) Review merchant's offline processing limits and terminal configuration.",
    aiDiagnosisHint:
      "Transactions in terminal batch with no corresponding real-time authorization — check submission timestamp vs transaction timestamp gap. Gap >4 hours indicates offline processing. These carry higher risk; flag merchants with frequent offline batches.",
  },
  {
    key: "pos_terminal_id_mismatch",
    label: "POS terminal ID routing error",
    severity: "medium",
    slaHours: 72,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines §2.4.2: Payment Terminal Service Providers (PTSPs) must maintain accurate terminal-to-merchant mapping. Terminal ID mismatches cause settlement to be routed to wrong merchant accounts. PTSA (Payment Terminal Service Aggregator) maintains the central terminal registry.",
    recommendedResolution:
      "1) Identify the terminal ID in the settlement file and cross-reference against the merchant registry. 2) If terminal ID maps to a different merchant than expected, check if terminal was recently reassigned. 3) Redirect the settlement to the correct merchant account. 4) Notify PTSP/PTSA of the mapping error for correction in the central registry. 5) Reconcile any historical misrouted settlements.",
    aiDiagnosisHint:
      "Settlement credited to merchant A but transaction occurred at merchant B's location — check terminal ID assignment history. Recent terminal reassignments without registry updates are the most common cause. Also check for cloned terminal IDs (fraud indicator).",
  },
  {
    key: "pos_duplicate_transaction",
    label: "POS duplicate charge (terminal retry)",
    severity: "high",
    slaHours: 48,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations: Double debits are a leading complaint category. POS terminals may retry transactions when they don't receive a response, creating duplicate charges. Each transaction should have a unique STAN; duplicate STANs from same terminal within short window indicate retry-induced duplicates.",
    recommendedResolution:
      "1) Identify potential duplicates: same card + same amount + same terminal + timestamps within 5 minutes. 2) Verify RRN/STAN — if same STAN, it's a retry duplicate. 3) Check if both were approved (response code 00) at the switch. 4) If duplicate confirmed, reverse the later transaction immediately. 5) If customer has already disputed, process via IDRS/Arbiter fast-track.",
    aiDiagnosisHint:
      "Two debits for same amount from same terminal within 5 minutes — check STAN uniqueness. Same STAN = retry duplicate (auto-reverse the second). Different STANs but same amount/card/terminal = possible legitimate separate purchases (verify with merchant before reversing).",
  },
  {
    key: "pos_merchant_not_settled",
    label: "POS merchant settlement delayed beyond T+1",
    severity: "high",
    slaHours: 48,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines §2.5: Acquirers must settle merchants within T+1 of successful transactions. Processors must provide daily settlement reports by 8AM T+1. Delayed settlement beyond T+1 without explanation constitutes a breach of the acquirer-merchant agreement and CBN guidelines.",
    recommendedResolution:
      "1) Verify the transaction was successfully processed (response code 00, in switch settlement file). 2) Check if the acquirer/processor settlement file includes the transaction. 3) If missing from settlement file, raise with processor immediately. 4) If in settlement file but not credited to merchant, check internal posting — CBS batch job failure or wrong account mapping. 5) Credit merchant with value date adjustment for the delay.",
    aiDiagnosisHint:
      "Successful POS transaction (switch confirms) but merchant account not credited after T+1 — check processor settlement file first (is the transaction included?), then internal posting (did the credit post to wrong GL or fail in batch?). Systematic delays across multiple merchants suggest processor-level issue.",
  },
  {
    key: "pos_interchange_fee_variance",
    label: "POS interchange fee differs from contracted rate",
    severity: "medium",
    slaHours: 120,
    sources: ["pos_terminal", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guide to Charges: POS interchange fees are regulated. Current cap is 0.5% of transaction value (max ₦1,000 for transactions above ₦200,000). Variance from contracted/regulated rates indicates either fee schedule update not applied, wrong MCC classification, or processor billing error.",
    recommendedResolution:
      "1) Recompute expected interchange per the CBN Guide to Charges and contracted fee schedule. 2) Compare against actual fees deducted in the settlement file. 3) If variance is due to CBN rate revision, update internal fee tables. 4) If variance is processor error, raise formal dispute with fee evidence. 5) Quantify cumulative impact across the settlement period for recovery claim.",
    aiDiagnosisHint:
      "Fee deducted per transaction differs from expected rate — check if CBN recently revised the Guide to Charges (last revision effective dates). Also check MCC (Merchant Category Code) — some categories have different fee caps. Proportional variance across all transactions = rate change; variance on specific transactions = MCC misclassification.",
  },
];

export const POS_EXCEPTION_KEYS = POS_EXCEPTIONS.map((c) => c.key);
