/**
 * Card scheme settlement & fees — exception taxonomy.
 *
 * Covers reconciliation between the bank's card GL and the card schemes'
 * clearing/settlement reporting: Verve (Interswitch's domestic scheme),
 * AfriGO (the CBN/NIBSS national domestic scheme, launched January 2024),
 * Visa (VisaNet clearing, VSS settlement reports), and Mastercard
 * (GCMS/IPM clearing, Mastercom). International schemes settle Nigerian
 * members in USD, adding FX exposure to every settlement break.
 *
 * Based on: Visa Core Rules and VSS reporting structure, Mastercard
 * clearing (IPM) and billing rules, Interswitch/Verve operating rules,
 * the AfriGO scheme framework, CBN Guide to Charges (2020), and CBN FX
 * market (NAFEM) settlement practice.
 */
import type { NigerianChannelException } from "./types";

export const CARD_SCHEME_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "scheme_net_settlement_variance",
    label: "Scheme net settlement advisement differs from GL position",
    severity: "critical",
    slaHours: 24,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "afrigo_scheme", "cbs_ledger"],
    regulatoryContext:
      "Scheme settlement advisements (Visa VSS settlement reports, Mastercard settlement advisement, Verve/AfriGO domestic settlement reports) are the authoritative statement of the member's daily obligation. A variance against the bank's own clearing-derived position misstates the nostro/settlement funding requirement — and for USD-settling schemes, an unfunded position risks scheme late-settlement fees and, in extremis, membership compliance action.",
    recommendedResolution:
      "1) Reconcile the scheme settlement advisement against the bank's clearing-file-derived expectation for the same settlement date, by service/transaction category. 2) Decompose the variance: interchange, scheme fees, disputes/adjustments in the cycle, or missing clearing records. 3) Fund the settlement account for the advised amount regardless — settle first, dispute after. 4) Raise unexplained components with the scheme's member support with the category breakdown. 5) Track to closure in the settlement variance log with ageing.",
    aiDiagnosisHint:
      "Break the advisement into its report sections (interchange, fees, disputes, adjustments) and diff each against the internal expectation — the variance is almost always concentrated in one section. A variance equal to a round fee amount points to a billing event; one matching a specific transaction amount points to a missed clearing record or dispute adjustment.",
  },
  {
    key: "scheme_clearing_file_gap",
    label: "Authorized transaction missing from clearing file",
    severity: "high",
    slaHours: 48,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "afrigo_scheme", "cbs_ledger"],
    regulatoryContext:
      "Every approved authorisation should be followed by a clearing record (Visa BASE II/T112, Mastercard IPM) within the presentment window. As acquirer, a missing clearing record means the merchant was paid or is owed value the scheme never settled; as issuer, the cardholder hold eventually drops off and the transaction disappears — both distort the true position.",
    recommendedResolution:
      "1) Match the authorisation log against clearing records on RRN/ARN for the cycle; list approvals with no presentment past the expected lag. 2) Acquirer-side: confirm the merchant terminal batched successfully; re-submit the capture if within the presentment window. 3) Issuer-side: release the authorisation hold per the hold-expiry policy. 4) For systematic gaps, verify the clearing file was ingested completely (record counts vs file trailer totals). 5) Escalate persistent gaps to the scheme with the ARN list.",
    aiDiagnosisHint:
      "First verify file completeness — compare ingested record count to the clearing file trailer; a truncated import mimics a scheme-side gap. Genuine gaps cluster by merchant/terminal (failed batch upload) or by day (missed file). Auth-without-clearing older than the presentment window will never settle: release holds and close.",
  },
  {
    key: "scheme_interchange_downgrade",
    label: "Interchange qualification downgrade",
    severity: "medium",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme", "cbs_ledger"],
    regulatoryContext:
      "Interchange rates depend on qualification criteria (EMV chip data, timeliness of presentment, merchant category, transaction data quality). Transactions failing criteria settle at a downgraded (more expensive for the acquirer, or lower-earning for the issuer) rate. Persistent downgrades are a silent revenue leak that scheme billing reports expose only at category level.",
    recommendedResolution:
      "1) Extract the interchange category applied per transaction from the clearing records and compare with the expected qualification. 2) Identify the downgrade driver: late presentment, missing chip/CVM data, or MCC misclassification. 3) Fix the root cause at the terminal/host (e.g. field population in the clearing message). 4) Quantify the monthly revenue impact to prioritise the fix. 5) Re-verify qualification rates in the next billing cycle.",
    aiDiagnosisHint:
      "Compare the interchange program/category code on each clearing record against the expected one for that card product + MCC + capture method. Downgrades concentrated on one terminal type = data-quality defect in that terminal's messages; downgrades spread evenly with rising presentment lag = batching delay. Quantify in basis points of settled volume for prioritisation.",
  },
  {
    key: "scheme_fee_assessment_variance",
    label: "Scheme fees / assessments differ from published schedule",
    severity: "medium",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "afrigo_scheme", "cbs_ledger"],
    regulatoryContext:
      "Schemes bill members through periodic invoices and in-settlement fee collection (Visa fee collection records, Mastercard MCBS billing). Fees follow published schedules that revise quarterly/annually. Members have a limited window to dispute billing errors; unverified scheme invoices are a classic audit finding in card operations.",
    recommendedResolution:
      "1) Map every fee line on the scheme invoice/billing report to the published fee schedule item and rate. 2) Recompute volume-based assessments from the bank's own cleared-volume figures. 3) Flag lines with no schedule mapping or rate mismatch. 4) File a billing inquiry with the scheme within the dispute window with the recomputation attached. 5) Book accepted fees to the correct GL cost lines so trend monitoring stays meaningful.",
    aiDiagnosisHint:
      "Recompute volume-driven assessments from internal cleared volumes — a variance proportional to volume means a rate mismatch (check for an unapplied schedule revision); a fixed-amount variance means a new fee line or a penalty/compliance charge worth investigating separately. Unknown fee codes should be resolved against the scheme's fee guide before booking.",
  },
  {
    key: "scheme_fx_settlement_variance",
    label: "International scheme USD settlement FX variance",
    severity: "high",
    slaHours: 48,
    sources: ["visa_scheme", "mastercard_scheme", "cbs_ledger"],
    regulatoryContext:
      "Visa and Mastercard settle Nigerian members in USD; naira transaction values convert at the scheme's designated rate, while the bank's books convert at its own or the NAFEM rate. Rate-date and rate-source differences create a structural FX variance on every settlement, which must be isolated from genuine settlement breaks and managed as FX exposure under CBN FX reporting.",
    recommendedResolution:
      "1) Recompute the settlement using the scheme's published conversion rate for the cycle date to isolate the pure-FX component. 2) Book the FX component to the designated FX gain/loss account, not the settlement suspense. 3) Investigate only the residual (non-FX) variance as a settlement break. 4) Confirm the nostro funding covers the USD obligation at the actual rate. 5) Report the exposure in the bank's FX position per CBN returns.",
    aiDiagnosisHint:
      "Always split variance into rate effect (volume × rate difference) and residual. If the residual is ~zero, the whole break is FX and no settlement investigation is needed. Rate effect grows with NAFEM volatility — a spike in variance on high-volatility days without matching residual growth confirms pure FX causation.",
  },
  {
    key: "scheme_cutover_timing_break",
    label: "Clearing-day cutover timing difference",
    severity: "low",
    slaHours: 72,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "afrigo_scheme", "cbs_ledger"],
    regulatoryContext:
      "Scheme processing days cut over at fixed times (differing from the bank's own end-of-day), so transactions near the boundary land in different settlement cycles on each side. These are expected, self-reversing timing items — but only if tracked; untracked, they accumulate in suspense and mask genuine breaks, a recurring CBN examination comment.",
    recommendedResolution:
      "1) Identify boundary transactions by comparing scheme processing date with CBS posting date. 2) Confirm each item settles in the immediately following cycle — a true timing item self-clears within one cycle. 3) Keep timing items in a dedicated, aged suspense category separate from unexplained breaks. 4) Escalate any 'timing' item older than two cycles as a real break. 5) If volume is high, align the internal cutover report to the scheme's processing-day windows.",
    aiDiagnosisHint:
      "Match unsettled items from cycle N against cycle N+1's settlement — genuine cutover items clear next cycle by definition. Anything persisting past two cycles was misclassified and is a genuine break. Items should cluster within an hour of the known cutover time; scattered timestamps indicate a different root cause.",
  },
  {
    key: "verve_domestic_settlement_break",
    label: "Verve domestic settlement mismatch",
    severity: "high",
    slaHours: 24,
    sources: ["verve_scheme", "interswitch_switch", "cbs_ledger"],
    regulatoryContext:
      "Verve is the dominant domestic scheme, operated by Interswitch, with settlement effected T+1 through NIBSS net settlement. Because Interswitch is frequently both the switch and the scheme for the same transaction, Verve breaks need the switch leg and the scheme leg reconciled separately — netting them together hides which leg failed.",
    recommendedResolution:
      "1) Reconcile the Verve scheme settlement report against the bank's Verve-cleared transactions, separately from the Interswitch switching reconciliation. 2) Identify whether the break sits in the scheme leg (clearing/settlement) or was inherited from the switch leg (routing/authorisation). 3) Raise scheme-leg items with Interswitch's Verve settlement desk with RRN evidence. 4) Verify the NIBSS net settlement entry matches the advised amount. 5) Track recovery in the dispute register.",
    aiDiagnosisHint:
      "Run the switch reconciliation first; only items clean at the switch layer but breaking at settlement are true scheme-leg breaks. Verve-on-Interswitch items appearing in both reconciliations must be deduplicated before totalling, or the variance double-counts.",
  },
  {
    key: "afrigo_settlement_break",
    label: "AfriGO national scheme settlement mismatch",
    severity: "high",
    slaHours: 24,
    sources: ["afrigo_scheme", "cbs_ledger"],
    regulatoryContext:
      "AfriGO is the CBN/NIBSS-backed national domestic card scheme (launched January 2024, operated by AfriGoPay Financial Services). CBN has directed issuance support for the national scheme, and settlement runs through NIBSS. As a newer scheme, member banks commonly encounter configuration and mapping breaks that established-scheme reconciliations have long since eliminated — catching them early avoids baking errors into the growing volume.",
    recommendedResolution:
      "1) Reconcile the AfriGO settlement report against CBS AfriGO-cleared transactions at transaction level. 2) Verify BIN routing configuration — early-stage breaks are commonly misrouted transactions settling under the wrong scheme. 3) Confirm fee and interchange application against the AfriGO published schedule. 4) Raise breaks with NIBSS/AfriGoPay member support with itemised evidence. 5) Baseline the reconciliation daily while volumes ramp.",
    aiDiagnosisHint:
      "For a young scheme, suspect configuration before fraud: check BIN-to-scheme routing tables (AfriGO BINs settling under Verve/other rails is the classic early break), then fee-table application. Transaction-level breaks that started from a specific date usually trace to a configuration change on that date.",
  },
  {
    key: "scheme_compliance_penalty_charge",
    label: "Unexpected scheme compliance or penalty charge",
    severity: "medium",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "cbs_ledger"],
    regulatoryContext:
      "Schemes levy non-transactional charges: excessive-chargeback/fraud program fees, data-integrity penalties, late-settlement charges, and mandate non-compliance assessments. These signal an underlying operational breach that will recur (and often escalate) until the root condition is fixed — the fee is the symptom, not the problem.",
    recommendedResolution:
      "1) Identify the penalty code and the scheme program it belongs to from the billing detail. 2) Obtain the underlying breach data (e.g. chargeback ratio, fraud basis points, data-quality error rates) for the measured period. 3) Verify the metric against internal numbers — miscounted metrics are appealable. 4) If valid, open a remediation plan targeting the underlying metric with the responsible team. 5) Track subsequent billing cycles to confirm the penalty stops.",
    aiDiagnosisHint:
      "Map the fee code to the scheme program first — excessive-chargeback programs (e.g. acquirer monitoring thresholds around 0.9–1% dispute ratio) and fraud-monitoring programs have published thresholds; compare the bank's actual ratio. A penalty with a metric just above threshold may be appealable on counting differences; one far above threshold needs remediation, not appeal.",
  },
];

export const CARD_SCHEME_EXCEPTION_KEYS = CARD_SCHEME_EXCEPTIONS.map((c) => c.key);
