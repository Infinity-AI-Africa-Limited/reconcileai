/**
 * Automated Teller Machine (ATM) — exception taxonomy.
 *
 * ATM reconciliation in Nigeria requires 3-way matching: Core Banking
 * System (CBS) vs Switch vs Electronic Journal (EJ). Exceptions are
 * based on CBN Guidelines on Operations of ATMs in Nigeria (March 2026
 * revision), the CBN Act 2007, and standard ATM reconciliation practices
 * for the Nigerian banking environment.
 */
import type { NigerianChannelException } from "./types";

export const ATM_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "atm_dispense_error_on_us",
    label: "ATM dispense error (on-us) — debited, cash not dispensed",
    severity: "critical",
    slaHours: 24,
    sources: ["atm", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines (March 2026): Failed on-us ATM transactions must be reversed instantly. Where instant reversal fails due to technical issues, manual reversal must be completed within 24 hours. Automated reversals should occur in less than 5 minutes. Non-compliance attracts monetary penalties and/or suspension of acquiring service.",
    recommendedResolution:
      "1) Check Electronic Journal (EJ) for the transaction — confirm cash was not dispensed (EJ shows 'notes not taken' or 'dispense failed'). 2) Verify switch shows the transaction as successful (response code 00). 3) If EJ confirms no dispense, initiate immediate auto-reversal. 4) If auto-reversal fails, process manual reversal within 24 hours. 5) SMS customer on reversal completion. 6) Log the dispense error for ATM maintenance review.",
    aiDiagnosisHint:
      "CBS debit + switch approval (code 00) + EJ shows no dispense or partial dispense — classic dispense error. Check EJ status codes: 'notes presented but not taken' (customer walked away) vs 'mechanical failure' (notes jammed). The former may require investigation; the latter is auto-reversible.",
  },
  {
    key: "atm_dispense_error_not_on_us",
    label: "ATM dispense error (not-on-us) — interbank failed withdrawal",
    severity: "critical",
    slaHours: 48,
    sources: ["atm", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines (March 2026): Failed not-on-us ATM transactions must be refunded within 48 hours maximum. Automated reversals should occur in less than 15 minutes where systems function properly. Involves coordination between issuer (customer's bank) and acquirer (ATM owner bank) via the switch.",
    recommendedResolution:
      "1) As issuer: receive the failed transaction notification from the switch. 2) Verify with acquirer's EJ that cash was not dispensed. 3) If acquirer confirms no dispense, reverse the customer debit within 48 hours. 4) If acquirer disputes (claims cash was dispensed), escalate to IDRS with EJ evidence request. 5) As acquirer: provide EJ evidence to issuer within 24 hours of request.",
    aiDiagnosisHint:
      "Customer's bank (issuer) debited but ATM owner's bank (acquirer) EJ shows no dispense — this requires inter-bank coordination via the switch. If acquirer doesn't respond within 24 hours, auto-reverse per CBN guidelines and recover via settlement.",
  },
  {
    key: "atm_short_dispense",
    label: "ATM short dispense — less cash than debited amount",
    severity: "high",
    slaHours: 48,
    sources: ["atm", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines: ATM operators must maintain monitoring systems to identify causes of failed transactions. Short dispensing occurs when the ATM dispenses fewer notes than instructed due to mechanical issues. The EJ records actual notes dispensed vs requested. Customer is debited full amount but receives less.",
    recommendedResolution:
      "1) Pull EJ for the specific transaction — compare 'notes requested' vs 'notes dispensed' counts. 2) Cross-reference with ATM cash count/balancing records for the cassette. 3) If short dispense confirmed, credit customer the difference (full amount minus actual dispensed). 4) Flag the ATM for maintenance (cassette calibration, note feeder inspection). 5) If pattern repeats on same ATM, take offline for repair.",
    aiDiagnosisHint:
      "EJ shows fewer notes dispensed than requested for the debit amount — verify by checking if the ATM's cash count shows a surplus (more cash than expected = notes were retained). Short dispense patterns on same ATM indicate mechanical issues; on same denomination indicate cassette problems.",
  },
  {
    key: "atm_journal_switch_mismatch",
    label: "ATM 3-way reconciliation break (CBS vs Switch vs EJ)",
    severity: "high",
    slaHours: 48,
    sources: ["atm", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines: Banks must maintain monitoring systems for ATM transactions. 3-way reconciliation (CBS vs Switch vs EJ) is the standard for identifying discrepancies. Mismatches indicate either lost transactions, phantom debits, or unrecorded dispensing — all requiring investigation.",
    recommendedResolution:
      "1) Perform 3-way match: CBS ledger entry ↔ Switch transaction record ↔ EJ entry. 2) Identify which leg is missing or different. 3) CBS+Switch but no EJ: possible EJ recording failure — check ATM connectivity logs. 4) Switch+EJ but no CBS: posting failure — check CBS batch job. 5) CBS+EJ but no Switch: local transaction (balance inquiry posted as withdrawal?) — investigate. 6) Resolve based on EJ as ground truth for physical cash movement.",
    aiDiagnosisHint:
      "3-way reconciliation break — EJ is the source of truth for whether cash physically moved. If EJ says dispensed but CBS has no debit, it's a revenue loss (cash went out without debit). If CBS has debit but EJ says no dispense, it's a customer refund case. Switch record determines the authorization path.",
  },
  {
    key: "atm_card_captured_transaction",
    label: "ATM card captured after failed transaction",
    severity: "medium",
    slaHours: 72,
    sources: ["atm", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines: ATM operators must provide helpdesk contacts at terminals. Card capture can occur due to: wrong PIN (3 attempts), suspected fraud, expired card, or mechanical malfunction. If transaction was in progress when card was captured, the financial leg must be reconciled separately from the card retrieval process.",
    recommendedResolution:
      "1) Check if a financial transaction was in progress when the card was captured. 2) If yes, determine transaction outcome: was customer debited? Was cash dispensed? 3) If debited without dispense, process reversal per standard dispense-error procedure. 4) For the card itself: if captured at own ATM, arrange customer collection within 48 hours. 5) If captured at another bank's ATM, coordinate card return via the acquiring bank.",
    aiDiagnosisHint:
      "Card capture event in EJ — check if there's an associated financial transaction. If the capture happened mid-transaction (after PIN entry, during dispense), there may be a pending debit without completed dispense. Treat the financial leg separately from the physical card recovery.",
  },
  {
    key: "atm_cash_count_variance",
    label: "ATM cash count variance — physical vs system balance",
    severity: "high",
    slaHours: 48,
    sources: ["atm", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines: Banks must maintain monitoring systems to track cash levels within ATM vaults. Machines must be replenished regularly. Variance between physical cash count and system-expected balance indicates either unrecorded dispensing, short-loading by CIT, or theft. All variances must be investigated and resolved.",
    recommendedResolution:
      "1) Compare physical cash count (from CIT or branch) against system expected balance (opening + replenishment − dispensed per EJ). 2) If physical > system: possible reversed transactions where cash wasn't actually returned (phantom reversals). 3) If physical < system: possible unrecorded dispensing, CIT short-loading, or theft. 4) Reconcile against all EJ entries for the period. 5) If unexplained, escalate to Internal Audit with full EJ and CIT loading records.",
    aiDiagnosisHint:
      "ATM cash balance discrepancy — direction matters: surplus (physical > system) suggests phantom reversals or test transactions; shortage (physical < system) suggests unrecorded dispenses or CIT issues. Cross-reference with EJ transaction count and CIT loading slips for the period.",
  },
  {
    key: "atm_biometric_fallback_debit",
    label: "ATM biometric mismatch — transaction via fallback method",
    severity: "medium",
    slaHours: 72,
    sources: ["atm", "cbs_ledger"],
    regulatoryContext:
      "CBN ATM Guidelines (March 2026): In cases where transaction failures arise from biometric mismatch or device errors, ATM operators must provide immediate fallback to non-biometric verification where safe. Such events must be logged for diagnostics. Minimum authentication success rate: 98% monthly.",
    recommendedResolution:
      "1) Verify the transaction was processed via fallback (non-biometric) after biometric failure. 2) Confirm the fallback method was appropriate (PIN verification as alternative). 3) Check if the biometric failure was device-related (sensor malfunction) or customer-related (finger injury, dry skin). 4) If device-related, log for ATM maintenance. 5) If pattern of biometric failures on same customer, flag for BVN data quality review.",
    aiDiagnosisHint:
      "Transaction flagged as biometric-fallback in EJ — not necessarily an exception unless the fallback was unauthorized or the biometric failure rate on the ATM exceeds 2% (CBN threshold). Cluster by ATM to identify device issues vs cluster by customer to identify BVN data quality issues.",
  },
];

export const ATM_EXCEPTION_KEYS = ATM_EXCEPTIONS.map((c) => c.key);
