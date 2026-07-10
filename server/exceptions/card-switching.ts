/**
 * Card switching & domestic processor settlement — exception taxonomy.
 *
 * Covers the switch/processor layer between a bank's CBS card GL and the
 * domestic processors that route and settle Nigerian card transactions:
 * Interswitch (the dominant switch/PTSP), Unified Payments (UP), and
 * eTranzact. These exceptions arise when the processor's daily settlement
 * report disagrees with the bank's own card journals — the single most
 * time-consuming reconciliation in most Nigerian banks' card operations.
 *
 * Based on: CBN Guidelines on Operations of Electronic Payment Channels in
 * Nigeria (2020), the CBN June 2020 circular revising failed-transaction
 * reversal timelines, CBN Guide to Charges on Banks and OFIs (2020), and
 * standard switch operating agreements (Interswitch/UP/eTranzact).
 */
import type { NigerianChannelException } from "./types";

export const CARD_SWITCHING_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "card_switch_settlement_variance",
    label: "Processor net settlement differs from CBS card GL",
    severity: "critical",
    slaHours: 24,
    sources: ["interswitch_switch", "up_switch", "etranzact_switch", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines on Operations of Electronic Payment Channels in Nigeria (2020) require daily reconciliation of settlement accounts. Domestic card settlement is T+1 via NIBSS net settlement into the bank's settlement account; an unexplained variance directly misstates the bank's settlement position and, if persistent, is an examinable control failure.",
    recommendedResolution:
      "1) Pull the processor's daily settlement report (Interswitch/UP/eTranzact) and the CBS card settlement GL for the same value date. 2) Reconcile at transaction level using RRN/STAN, not just totals. 3) Classify the variance drivers: timing (late presentments), fees, reversals in flight, or missing presentments. 4) Post identified timing items to a tracked suspense with an ageing limit. 5) Escalate any residual unexplained variance to the processor's settlement desk with the itemised breakdown within 24 hours.",
    aiDiagnosisHint:
      "Compare processor settlement total vs CBS card GL movement for the same cycle. Decompose by transaction count first — equal counts with different totals points to fees or partial reversals; unequal counts points to missing/late presentments. Recurring same-direction daily variance suggests a systematic fee or cutover configuration error, not one-off breaks.",
  },
  {
    key: "card_rrn_stan_mismatch",
    label: "RRN/STAN mismatch between switch file and CBS journal",
    severity: "high",
    slaHours: 48,
    sources: ["interswitch_switch", "up_switch", "etranzact_switch", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "The Retrieval Reference Number (RRN) and System Trace Audit Number (STAN) are the primary matching keys in ISO 8583 card messaging. A mismatch breaks end-to-end traceability that CBN examiners and scheme auditors expect; unmatched items also block dispute defence, since chargeback evidence must cite the original RRN.",
    recommendedResolution:
      "1) Attempt secondary matching on PAN (masked) + amount + terminal ID + transaction time window. 2) Check for RRN truncation or padding differences between the switch file format and the CBS import mapping. 3) If the switch re-generated the STAN on retry, link the retry chain via the original auth timestamp. 4) Correct the field mapping in the import job if systematic. 5) For residual orphans, request the transaction detail from the processor's support portal citing terminal ID and time.",
    aiDiagnosisHint:
      "Single-item mismatches are usually retries that re-generated a STAN; whole-file or whole-batch mismatches are import/field-mapping defects (truncated leading zeros are the classic cause). Match on PAN+amount+terminal+time to confirm identity before treating as a genuine missing transaction.",
  },
  {
    key: "card_stip_no_advice",
    label: "Stand-in (STIP) approval with no advice in issuer log",
    severity: "high",
    slaHours: 24,
    sources: ["interswitch_switch", "verve_scheme", "visa_scheme", "mastercard_scheme", "cbs_ledger"],
    regulatoryContext:
      "When the issuer host is offline, the switch or scheme approves transactions on the issuer's behalf (stand-in processing) within agreed limits, and must deliver advices for later posting. Unposted STIP advices leave customer accounts undebited while settlement has already occurred — the bank funds the gap. Scheme rules make the issuer liable for STIP-window transactions within its configured limits.",
    recommendedResolution:
      "1) Pull the STIP advice file from the switch/scheme for the outage window. 2) Post all unposted advices to the customer accounts, applying available-balance checks. 3) For accounts now unfunded, follow the bank's overdraft/recovery procedure — the settlement obligation stands regardless. 4) Reconcile the STIP total against the settlement report for the same cycle. 5) Review STIP limits with the switch if losses recur, and file an incident report for the host outage.",
    aiDiagnosisHint:
      "Settlement file contains transactions absent from the CBS authorization log clustered in a specific time window — check host uptime logs for that window; a matching outage confirms STIP. Sum the STIP items and verify they fall within configured stand-in limits; items above limit are disputable with the switch.",
  },
  {
    key: "card_switch_timeout_reversal_missing",
    label: "Switch timeout — customer debited, reversal never arrived",
    severity: "critical",
    slaHours: 24,
    sources: ["interswitch_switch", "up_switch", "etranzact_switch", "pos_terminal", "atm", "cbs_ledger"],
    regulatoryContext:
      "CBN's June 2020 circular on Operations of Electronic Payment Channels shortened failed-transaction reversal timelines: failed 'on-us' ATM/POS debits must reverse instantly or within 24 hours, and failed 'not-on-us' transactions within 48 hours. Non-reversal beyond the window exposes the bank to CBN consumer-protection sanctions and CBN-tracked complaint escalations.",
    recommendedResolution:
      "1) Confirm final transaction status with the switch (auth log + settlement presence). 2) If the transaction never settled, post the reversal to the customer account immediately. 3) If it settled despite the timeout, treat as a dispute item and raise it with the acquirer via the switch dispute channel. 4) Notify the customer of the resolution per CBN Consumer Protection Regulations. 5) Log the item in the complaints register with switch response evidence attached.",
    aiDiagnosisHint:
      "Customer debit exists in CBS with a declined/timeout response code in the switch log and no matching settlement record — auto-reversible. If a settlement record EXISTS despite the timeout code, do not auto-reverse; route to the dispute path instead, since the merchant may have received value.",
  },
  {
    key: "card_partial_reversal_variance",
    label: "Partial reversal amount differs from expected",
    severity: "high",
    slaHours: 48,
    sources: ["interswitch_switch", "up_switch", "card_switch", "cbs_ledger"],
    regulatoryContext:
      "Partial reversals (e.g. fuel pump pre-authorisation completions, partial dispenses) must net the original authorisation to the actual transaction value. A variance between the reversal amount and the original-minus-actual leaves either the customer or the bank out of pocket, and is a recurring source of aged suspense balances flagged in CBN examinations.",
    recommendedResolution:
      "1) Retrieve the original authorisation, the completion, and the partial reversal from the switch log and compute the expected net. 2) Compare against the CBS posting chain for the same RRN. 3) Post an adjusting entry for the difference with the RRN chain as reference. 4) If the switch computed the reversal wrongly, raise a correction request with the full message chain. 5) Add the merchant category to the watch list if variances recur (pre-auth heavy MCCs: fuel, hotels, car rental).",
    aiDiagnosisHint:
      "Compute expected net = original auth − partial reversal and compare with the settled amount. Pre-auth-heavy MCCs (fuel 5541/5542, hotels, car rental) dominate this category. A reversal GREATER than the original auth is always an error — flag for immediate correction rather than netting.",
  },
  {
    key: "card_force_post_no_auth",
    label: "Force-posted transaction with no authorization record",
    severity: "high",
    slaHours: 24,
    sources: ["interswitch_switch", "up_switch", "card_switch", "pos_terminal", "cbs_ledger"],
    regulatoryContext:
      "Force-posts (completions submitted without an approved online authorisation) shift fraud liability onto the acquirer/merchant under scheme rules, and CBN AML/CFT Regulations require enhanced monitoring of offline-approved card activity. A pattern of force-posts at one merchant is a recognised fraud typology.",
    recommendedResolution:
      "1) Verify whether any offline/voice authorisation exists for the transaction. 2) Confirm the merchant is approved for offline capture in the acquiring agreement. 3) If unauthorised, dispute the presentment with the switch/scheme within the chargeback window — liability sits with the presenting party. 4) Refer repeated force-posts from the same terminal to the fraud desk and consider terminal suspension. 5) Report confirmed fraud per CBN/NeFF fraud-reporting requirements.",
    aiDiagnosisHint:
      "Settlement record with no matching authorisation in the auth log — check capture method code for offline indicator. One-off with valid offline approval is benign; clusters at a single terminal/merchant are a fraud signal. Verify EMV liability-shift position: chip-read force-posts carry different liability than key-entered ones.",
  },
  {
    key: "card_duplicate_presentment",
    label: "Duplicate presentment — same RRN settled twice",
    severity: "high",
    slaHours: 24,
    sources: ["interswitch_switch", "up_switch", "etranzact_switch", "cbs_ledger"],
    regulatoryContext:
      "Scheme and switch operating rules prohibit presenting the same transaction twice; the second presentment is recoverable in full via the duplicate-processing dispute reason (e.g. Visa 12.6.1, Mastercard POI error 4834). CBN consumer-protection rules require the double debit to be reversed to the customer without waiting for interbank recovery.",
    recommendedResolution:
      "1) Confirm both settlement records carry the same RRN/STAN/amount/terminal. 2) Reverse the duplicate debit to the customer immediately — do not wait for recovery. 3) Raise a duplicate-processing chargeback/adjustment via the switch or scheme channel within the window. 4) Track recovery to conclusion in the dispute register. 5) If the duplicate originated from the bank's own batch job re-run, fix the job idempotency and document the incident.",
    aiDiagnosisHint:
      "Exact RRN+STAN+amount+terminal match on two settlement records = true duplicate (recoverable). Same card+amount+merchant but different RRN/STAN = customer retried a genuine second purchase — NOT recoverable as a duplicate; treat as a cardholder dispute only if contested.",
  },
  {
    key: "card_late_presentment",
    label: "Presentment settled outside the allowed window",
    severity: "medium",
    slaHours: 72,
    sources: ["interswitch_switch", "up_switch", "visa_scheme", "mastercard_scheme", "cbs_ledger"],
    regulatoryContext:
      "Scheme rules require presentment within a defined window of the authorisation (typically up to 30 days, shorter for specific transaction types). Late presentments are chargeable back by the issuer (Visa reason 12.1 Late Presentment; Mastercard treats it under POI Error 4834) — especially where the account can no longer honour the debit.",
    recommendedResolution:
      "1) Compute the authorisation-to-presentment lag from the message timestamps. 2) As issuer: if the account is unfunded or closed, exercise the late-presentment chargeback right within the window. 3) As acquirer: identify why the merchant/terminal batched late (offline terminal backlog is the common cause) and clear the backlog. 4) Post any unrecoverable residual to the card losses account with approval. 5) Add persistent late-batching merchants to the acquiring risk review.",
    aiDiagnosisHint:
      "Presentment date minus authorisation date exceeds the scheme window — as issuer this is a chargeback right, not a loss. Prioritise items where the cardholder balance can no longer cover the debit. Acquirer-side clusters trace to specific terminals batching offline for days; sort by terminal ID to find them.",
  },
  {
    key: "card_ptsp_settlement_split_variance",
    label: "PTSP / aggregator settlement split variance",
    severity: "medium",
    slaHours: 72,
    sources: ["interswitch_switch", "up_switch", "pos_terminal", "cbs_ledger"],
    regulatoryContext:
      "Under the CBN agent-banking and PTSP licensing framework, POS transaction proceeds are split between merchant, agent, PTSP, and bank per contracted percentages, with the Merchant Service Charge capped by the CBN Guide to Charges (0.5% capped at ₦1,000 for most card transactions). A split computed off the wrong base or rate mispays one party and accumulates rapidly at agent-banking volumes.",
    recommendedResolution:
      "1) Recompute the expected split from the contracted schedule for a sample of affected transactions. 2) Identify whether the error is in the rate, the base (gross vs net of MSC), or a missing party in the split table. 3) Correct the split configuration with the processor. 4) Compute the cumulative mispayment since the error began and agree a recovery/true-up schedule with the affected party. 5) Document the correction for the next CBN examination cycle.",
    aiDiagnosisHint:
      "Recompute splits from first principles on a transaction sample. A constant percentage error across all items = wrong rate in the split table; errors only on high-value items = the ₦1,000 MSC cap not being applied; errors for one merchant/agent only = missing or stale split configuration for that party.",
  },
  {
    key: "card_switch_fee_variance",
    label: "Switch processing fee differs from contracted rate",
    severity: "medium",
    slaHours: 120,
    sources: ["interswitch_switch", "up_switch", "etranzact_switch", "cbs_ledger"],
    regulatoryContext:
      "Switch processing fees are contractual, and several card fees are capped by the CBN Guide to Charges on Banks and OFIs (2020). Overcharge recovery is time-limited by the billing dispute clause in most switch agreements — typically 90 days — so undetected fee drift becomes unrecoverable.",
    recommendedResolution:
      "1) Recompute expected switch fees for the billing period from the contracted schedule. 2) Compare against fees actually deducted in settlement, by transaction type. 3) Distinguish a contract repricing (verify against signed amendments) from a billing error. 4) Raise a formal billing dispute with itemised evidence within the contractual window. 5) Track the credit note to settlement and update the internal fee table if a legitimate repricing occurred.",
    aiDiagnosisHint:
      "Uniform per-transaction fee shift from a specific date = repricing event (check for a contract amendment or CBN Guide to Charges revision at that date). Variance only on a transaction subtype (e.g. not-on-us ATM) = misconfigured fee tier. Compute cumulative overcharge to size the recovery claim.",
  },
];

export const CARD_SWITCHING_EXCEPTION_KEYS = CARD_SWITCHING_EXCEPTIONS.map((c) => c.key);
