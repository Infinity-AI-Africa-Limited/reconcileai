/**
 * Card dispute / chargeback lifecycle — exception taxonomy.
 *
 * Covers the full dispute chain across schemes and processors: first
 * chargeback → representment (second presentment) → pre-arbitration →
 * arbitration → good-faith recovery. Grounded in Visa Claims Resolution
 * (VCR: dispute categories 10 Fraud / 11 Authorization / 12 Processing
 * Errors / 13 Consumer Disputes, worked through VROL), Mastercard dispute
 * processing via Mastercom (reason codes 4837, 4853, 4808, 4834), the
 * Interswitch Arbiter portal for domestic/Verve disputes, and CBN Consumer
 * Protection Regulations for cardholder-facing timelines.
 *
 * Deadlines are the defining property of this channel: a dispute right
 * that expires is money permanently lost, so SLA hours here are set to
 * force action well inside the scheme windows.
 */
import type { NigerianChannelException } from "./types";

export const CARD_DISPUTE_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "chargeback_inbound_acquirer",
    label: "Inbound chargeback received (acquirer side)",
    severity: "critical",
    slaHours: 72,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch", "cbs_ledger"],
    regulatoryContext:
      "As acquirer, an inbound chargeback debits the bank's settlement immediately; the loss passes to the merchant only if the merchant agreement and funds allow. Representment rights are time-boxed (Visa: response via VROL within 30 days; Mastercard: second presentment within 45 days). Missing the window converts a defensible dispute into a final loss.",
    recommendedResolution:
      "1) Log the chargeback with its reason code, amount, ARN and deadline on receipt. 2) Debit the merchant settlement/reserve per the merchant agreement and notify the merchant with the evidence checklist for the reason code. 3) Assess defensibility: valid EMV chip data, AVS/CVM results, proof of delivery, or a compelling-evidence match. 4) Represent within the scheme window with the strongest single evidence package. 5) If indefensible, accept, close, and feed the merchant's dispute ratio into acquiring risk monitoring.",
    aiDiagnosisHint:
      "Triage by reason-code family first: fraud codes (Visa 10.x / MC 4837) on chip-read transactions are usually defensible via the EMV liability shift; consumer-dispute codes (13.x / 4853) turn on delivery/service evidence from the merchant. Sort the queue by days-to-deadline, not by amount — an expiring right is worth more than a large one with time remaining.",
  },
  {
    key: "chargeback_outbound_issuer_credit_pending",
    label: "Issuer chargeback raised — cardholder credit pending",
    severity: "high",
    slaHours: 72,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "cbs_ledger"],
    regulatoryContext:
      "As issuer, once a cardholder dispute is validated, CBN Consumer Protection Regulations require prompt resolution and communication, and CBN complaint-handling timelines run independently of the scheme recovery cycle. Most Nigerian issuers credit the cardholder provisionally while the chargeback recovers through the scheme — the exception tracks the gap between the two.",
    recommendedResolution:
      "1) Verify the dispute was filed in the scheme system (VROL/Mastercom/Arbiter) with the correct reason code and full documentation. 2) Apply the provisional cardholder credit per the bank's dispute policy and notify the customer. 3) Diarise the acquirer response deadline; a non-response within the window finalises recovery automatically. 4) On recovery, clear the provisional credit against the settlement credit. 5) If representment arrives, evaluate and either accept (reverse provisional credit with customer notice) or escalate to pre-arbitration.",
    aiDiagnosisHint:
      "Match provisional credits in the cardholder GL against scheme recovery credits in settlement — the aged gap is the exposure. Items where the acquirer response window has passed with no representment should auto-finalise; flag any still open. A provisional credit with NO scheme case reference is a process failure: money out with no recovery in flight.",
  },
  {
    key: "chargeback_representment_deadline",
    label: "Representment evidence due — deadline at risk",
    severity: "critical",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch"],
    regulatoryContext:
      "Representment (Mastercard second presentment) is the acquirer's one chance to reverse a chargeback: Visa allows 30 days via VROL, Mastercard 45 days via Mastercom, and Interswitch Arbiter enforces its own domestic response windows. The right lapses silently — schemes do not chase for evidence.",
    recommendedResolution:
      "1) Maintain a deadline-sorted representment queue with days-remaining per case. 2) Chase merchant evidence with a fixed internal cutoff comfortably before the scheme deadline (e.g. deadline minus 10 days). 3) Submit the representment with reason-code-specific evidence — quality over volume. 4) If the merchant cannot evidence, accept early and release the reserve rather than letting the case expire ambiguously. 5) Report near-miss deadline statistics monthly to tighten the internal cutoff.",
    aiDiagnosisHint:
      "The signal is days-to-deadline vs evidence-readiness: cases within 10 days of the scheme deadline with no merchant evidence on file should escalate immediately. Track expiry-without-action as a distinct failure metric — every expired right is a preventable 100% loss, unlike a lost-on-merits case.",
  },
  {
    key: "chargeback_pre_arbitration",
    label: "Pre-arbitration received or required",
    severity: "high",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme"],
    regulatoryContext:
      "Pre-arbitration (Visa pre-arb under VCR; Mastercard pre-arbitration after second presentment) is the last structured negotiation before scheme arbitration. Response windows are strict (typically 30 days Visa / 45 days Mastercard), and progressing to arbitration exposes the losing member to filing and review fees in the hundreds of USD per case — often material relative to the disputed amount.",
    recommendedResolution:
      "1) Re-assess the case on the new information in the pre-arb — the counterparty is signalling confidence. 2) Compute the economics: disputed amount vs arbitration fees and win probability. 3) Accept pre-arb where economics are unfavourable — a disciplined accept is not a process failure. 4) If continuing, respond within the window with evidence addressing the pre-arb's specific assertions. 5) Require senior approval to escalate any case where fees exceed a set fraction of the disputed amount.",
    aiDiagnosisHint:
      "Compare disputed amount to the all-in arbitration cost (filing + review fees, typically several hundred USD) — below the breakeven, recommend accepting regardless of merits. Above it, weigh the evidence delta since representment: pre-arbs that merely restate the original position are weak; ones with new documentation are strong.",
  },
  {
    key: "chargeback_arbitration_case",
    label: "Arbitration case filed with the scheme",
    severity: "high",
    slaHours: 120,
    sources: ["visa_scheme", "mastercard_scheme"],
    regulatoryContext:
      "Scheme arbitration is final: the scheme rules on the documents, the loser pays the filing and administrative fees, and no further recourse exists inside the scheme. Filing windows (typically 45 days from pre-arb conclusion) and documentation completeness rules are enforced mechanically — an incomplete filing is a lost filing.",
    recommendedResolution:
      "1) Confirm the filing window and prepare the complete case file: full transaction chain, all prior dispute stages, and the specific rule citations relied on. 2) Have a second reviewer validate completeness against the scheme's arbitration checklist before submission. 3) Book a provision for the potential loss including fees. 4) On ruling, post the final outcome, release or realise the provision, and close all linked suspense entries. 5) Feed the ruling rationale back into the representment playbook.",
    aiDiagnosisHint:
      "Arbitration items need position tracking, not investigation: verify a provision exists, the ruling deadline is diarised, and linked suspense items reference the case. After the ruling, any suspense left open against the case is a bookkeeping failure — the scheme decision is terminal and everything should net to zero.",
  },
  {
    key: "chargeback_fraud_coded",
    label: "Fraud-coded chargeback (Visa 10.x / Mastercard 4837)",
    severity: "critical",
    slaHours: 48,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch", "cbs_ledger"],
    regulatoryContext:
      "Fraud-coded disputes carry obligations beyond recovery: CBN fraud-reporting and NeFF (Nigeria Electronic Fraud Forum) returns, scheme fraud-monitoring program thresholds (measured in fraud basis points), and the EMV liability shift that assigns counterfeit losses to the non-chip-compliant party. Volume trends here move the bank's standing in scheme risk programs.",
    recommendedResolution:
      "1) Verify the liability-shift position: chip-read at a chip terminal generally defends counterfeit fraud claims; key-entered or magstripe fallback usually does not. 2) File the case in the fraud register and include it in CBN/NeFF fraud returns for the period. 3) Check the PAN for related fraud activity and act on the card (block/reissue) if issuer-side. 4) Represent only where the liability shift or compelling evidence genuinely applies. 5) Monitor cumulative fraud bps against the scheme monitoring thresholds and trigger the reduction plan if trending toward them.",
    aiDiagnosisHint:
      "Read the POS entry mode on the original clearing record first: chip-read (05) defends counterfeit claims via liability shift; fallback (80) and key-entered (01) usually concede. Cluster fraud chargebacks by merchant, BIN and entry mode — a cluster at one merchant is an acquiring problem; spread across merchants on one BIN range is an issuing/compromise problem.",
  },
  {
    key: "chargeback_won_credit_not_posted",
    label: "Dispute won but recovery credit not in settlement",
    severity: "medium",
    slaHours: 72,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch", "cbs_ledger"],
    regulatoryContext:
      "A dispute ruled in the bank's favour settles as a credit in a subsequent cycle (scheme settlement or Arbiter-directed domestic settlement). Won-but-uncredited cases are pure receivables that age silently — dispute systems track case status, settlement systems track money, and this exception is the join between the two.",
    recommendedResolution:
      "1) Extract all cases marked won/recovered in the dispute system within the period. 2) Match each against a settlement credit (by ARN/case reference) in the scheme or domestic settlement reports. 3) For unmatched wins older than one settlement cycle, raise a follow-up with the scheme/processor citing the case reference and ruling date. 4) Post matched credits against the original loss/suspense entries so the case nets to zero. 5) Age-report the unmatched population weekly until cleared.",
    aiDiagnosisHint:
      "Join dispute-system outcomes to settlement credits on case reference/ARN — the unmatched won-cases are the finding. Systematic non-posting (many wins, no credits) usually means the settlement report section carrying dispute adjustments isn't being ingested; spot-check whether the credits exist in the raw report before chasing the scheme.",
  },
  {
    key: "chargeback_right_expired",
    label: "Dispute right expired before action was taken",
    severity: "medium",
    slaHours: 72,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch"],
    regulatoryContext:
      "Issuer chargeback rights generally run 120 days from the transaction (or from expected-delivery for some consumer-dispute codes); representment and pre-arb windows are shorter. An expired right converts a recoverable amount into a final loss booked entirely to process failure — schemes grant no extensions.",
    recommendedResolution:
      "1) Book the unrecoverable amount to the card losses account with the expiry documented as the cause. 2) Perform a root-cause review: late customer intake, queue backlog, or missed deadline diarisation. 3) Fix the specific pipeline stage — most expiries trace to intake-to-filing lag, not the scheme window itself. 4) If customer-facing, resolve the cardholder position per CBN Consumer Protection Regulations independently of the lost recovery. 5) Track expiry counts monthly; the target is zero.",
    aiDiagnosisHint:
      "Compute intake-to-filing lag distribution across expired cases — expiries clustered at one pipeline stage (e.g. cases sitting unassigned) identify the fix. Distinguish truly late customer notifications (unpreventable) from internal queue delays (preventable); only the second is an operations failure metric.",
  },
  {
    key: "dispute_good_faith_recovery",
    label: "Good-faith recovery attempt outside scheme windows",
    severity: "low",
    slaHours: 168,
    sources: ["visa_scheme", "mastercard_scheme", "verve_scheme", "interswitch_switch"],
    regulatoryContext:
      "When scheme dispute rights have lapsed or don't cover the scenario, members may pursue good-faith collection (Visa/Mastercard good-faith processes, or direct member-to-member letters domestically). Acceptance is entirely discretionary for the counterparty, so these are managed as low-probability receivables — never netted against firm positions.",
    recommendedResolution:
      "1) Confirm no in-scheme right remains before going good-faith — an available formal right always takes priority. 2) Send the good-faith request with the complete evidence package and a response deadline. 3) Track as a memo-item receivable at zero accounting value until accepted. 4) On acceptance, settle per the agreed method and close the loss entry. 5) After one follow-up and no response within 30 days, close as unrecovered and finalise the loss.",
    aiDiagnosisHint:
      "Good-faith items should never age indefinitely — enforce the one-follow-up-then-close rule. Monitor the acceptance rate by counterparty bank: consistently non-responding counterparties make future good-faith attempts uneconomic, which should feed the write-off decision earlier.",
  },
];

export const CARD_DISPUTE_EXCEPTION_KEYS = CARD_DISPUTE_EXCEPTIONS.map((c) => c.key);
