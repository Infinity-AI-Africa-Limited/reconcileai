/**
 * Cheque Clearing (NIBSS NACS / Cheque Truncation) — exception taxonomy.
 *
 * The last major Nigerian rail missing from this registry. Cheque volumes are
 * falling, but a commercial or non-interest bank still runs a clearing session
 * every business day, and clearing is the one channel where the bank's exposure
 * is created by an instrument it did not issue and cannot see.
 *
 * Grounded in:
 *   - Nigeria Bankers' Clearing System Rules (Revised) — the operative rulebook
 *   - CBN Guidelines for Cheque Truncation in Nigeria (14 March 2012)
 *   - CBN Guidelines on the Treatment of Dishonoured/Dud Cheques (2016)
 *   - Dishonoured Cheques (Offences) Act 1977
 *
 * Two facts drive most of what follows:
 *
 *   TRUNCATION. Since nationwide rollout in 2013 the physical instrument never
 *   leaves the presenting bank. Only the image and MICR data reach the clearing
 *   house, so the paying bank decides on data alone. Every control that used to
 *   rest on handling the paper — duplicate detection, alteration checks — is now
 *   a reconciliation control or it does not exist.
 *
 *   T+1. The clearing cycle moved from T+2 to T+1 in Lagos in 2012 and
 *   nationwide in 2013. A cheque presented today settles tomorrow, which means
 *   an unreversed provisional credit is spendable before anyone notices.
 *
 * ⚠️ PENDING CHANGE — re-verify before quoting to a customer.
 * CBN issued an EXPOSURE DRAFT of new Guidelines on the Treatment of Dud
 * Cheques on 24 November 2025, with a three-week comment window. It proposes
 * reporting a confirmed dud cheque to the CRMS and at least two licensed credit
 * bureaux WITHIN ONE HOUR (against monthly under the 2016 guidelines), customer
 * notification within two working days, a five-year ban for a serial issuer
 * (three dud cheques across the system), five-year record retention, and
 * penalties on the BANK starting at ₦5m per incident. Reporting on the sources
 * available here is inconsistent about whether it has been finalised, so the
 * regulatory text below states the operative 2016 rule and flags the draft
 * rather than asserting either as current.
 *
 * `cheque_dud_not_reported` is nonetheless given a ONE-HOUR SLA. That is the
 * draft's number, deliberately: reporting a dud cheque quickly is not wrong
 * under the 2016 rule, so the forward-looking posture costs a bank nothing and
 * means the platform is already correct on the day the draft commences.
 */
import type { NigerianChannelException } from "./types";

export const CHEQUE_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "cheque_returned_credit_not_reversed",
    label: "Returned cheque — provisional credit not reversed",
    severity: "critical",
    slaHours: 4,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "Nigeria Bankers' Clearing System Rules: value given on presentment is PROVISIONAL until the clearing cycle completes. On a T+1 cycle the customer can withdraw against an uncleared effect the same day, so a return that is not reversed in the CBS becomes an unsecured, unapproved exposure the bank has not underwritten — and one it will not see again until the account is overdrawn.",
    recommendedResolution:
      "1) Pull the inward return file for the session and list every instrument with a return reason. 2) For each, confirm the contra entry exists in the CBS against the same account and value date. 3) Where the reversal is missing, post it immediately and place a lien for the amount if the balance no longer covers it. 4) Where the funds have already been withdrawn, raise it as a credit exposure to the appropriate approval level the same day — it is a lending decision now, not an operations item. 5) Reconcile the count of returns to the count of reversals for the session and evidence the match.",
    aiDiagnosisHint:
      "Look for a clearing credit with no matching contra entry after the return. The tell is a credit and a return record sharing the instrument number and amount, with no debit following. Rank by amount and by whether the balance has since fallen below the credited value — a reversal that can no longer be recovered from the balance is the urgent subset, not merely a late one.",
  },
  {
    key: "cheque_duplicate_presentment",
    label: "Same instrument cleared twice",
    severity: "critical",
    slaHours: 4,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "CBN Guidelines for Cheque Truncation (2012): the physical instrument is retained by the presenting bank and only the image and MICR data are transmitted. Nothing is physically surrendered on payment, so the control that once made double presentment self-limiting no longer exists. Detection is now a data control, and duplicate payment is a direct loss to the paying bank.",
    recommendedResolution:
      "1) Group cleared items by MICR triplet — account number, cheque serial and amount — and flag any group with more than one payment. 2) Confirm against the drawer's mandate whether two genuine instruments could share a serial (they cannot within a cheque book). 3) Recall the second payment through the clearing house within the session where possible. 4) Where the session has closed, raise an inter-bank claim against the presenting bank citing the truncation rules. 5) Retain both images — the image is the evidence, and the paper is not yours to produce.",
    aiDiagnosisHint:
      "Match on the MICR serial rather than on amount or date, which is what makes this findable at all: a re-presented item legitimately carries a different clearing date and may be re-keyed with a different narration, but the serial is printed on the instrument and cannot change. Two payments on one serial is a duplicate until proven otherwise.",
  },
  {
    key: "cheque_dud_not_reported",
    label: "Dud cheque not reported to CRMS / credit bureaux",
    severity: "critical",
    slaHours: 1,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "A cheque returned for INSUFFICIENT FUNDS is a dud cheque and a reporting obligation, not merely a failed collection. Under the CBN's 2016 guidelines the bank must report the drawer to the Credit Risk Management System and cancel the unissued cheque books of any customer with three consecutive dud cheques. The Dishonoured Cheques (Offences) Act 1977 makes issuing one a criminal offence. ⚠️ The CBN exposure draft of 24 November 2025 would tighten this sharply — reporting to the CRMS and at least two licensed credit bureaux within ONE HOUR, customer notice within two working days, a five-year ban for a serial issuer (three across the system), and penalties on the BANK from ₦5m per incident. Confirm the draft's current status before advising a customer; the SLA here anticipates it.",
    recommendedResolution:
      "1) Filter the session's returns to reason code INSUFFICIENT FUNDS only — that alone is a dud cheque, and returns for signature, date or technical defects must not be reported as one. 2) Confirm a CRMS submission exists for each, and a submission to at least two licensed credit bureaux. 3) Count prior dud cheques for the drawer across the system, not just at this bank, and cancel unissued cheque books at the third. 4) Evidence the customer notification. 5) Retain the returned-instrument record for five years.",
    aiDiagnosisHint:
      "Only the insufficient-funds reason code qualifies — over-reporting is itself a customer-conduct failure and the draft penalises it. Reconcile the count of insufficient-funds returns against the count of CRMS submissions for the same session; a non-zero difference is the finding. Then check whether the drawer already has two, because the third is what triggers the cheque-book cancellation and the ban.",
  },
  {
    key: "cheque_clearing_settlement_variance",
    label: "Clearing session net settlement variance",
    severity: "critical",
    slaHours: 8,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "NIBSS computes each bank's multilateral net position for the clearing session and settles it across accounts at the CBN. That net figure is the bank's actual obligation for the day regardless of what its own ledger expected, so a variance is a misstated settlement position — it either overdraws the CBN account or leaves the bank funding a figure it cannot explain.",
    recommendedResolution:
      "1) Rebuild the expected net from the bank's own outward presentments less inward payments less returns both ways for the session. 2) Compare against the NIBSS session net. 3) Decompose the difference by leg — outward, inward, outward returns, inward returns — as it is nearly always concentrated in one. 4) Fund the settled position regardless while the query is open; settle first, dispute after. 5) Raise unexplained residual with NIBSS with the leg breakdown, and age it in the settlement variance log until closed.",
    aiDiagnosisHint:
      "Decompose before investigating: a variance equal to a single instrument's amount is a missing or duplicated item, while one proportional to session volume points at a rule or fee change. A variance that exactly equals the return leg means returns were computed on the wrong side of the net — a sign error, and the most common cause.",
  },
  {
    key: "cheque_micr_ledger_mismatch",
    label: "MICR data disagrees with the posted entry",
    severity: "high",
    slaHours: 12,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "Under truncation the paying bank decides on the image and MICR data alone. The MICR line is therefore the authoritative record of the instrument, and any divergence between it and what was posted means the bank has debited an account, or an amount, that the instrument does not support — with no paper to fall back on.",
    recommendedResolution:
      "1) Compare the MICR account number, serial and amount against the posted entry for every cleared item. 2) Where the amount differs, retrieve the image and read the courtesy and legal amounts — the words govern where they disagree with the figures. 3) Where the account differs, reverse immediately: the debit has landed on a customer who did not write the instrument. 4) Correct and re-present, or return within the session's return window. 5) Where re-keying is the cause, check the whole batch — a keying error is rarely alone.",
    aiDiagnosisHint:
      "Treat an account-number mismatch and an amount mismatch as different severities: the wrong account is an unauthorised debit on an uninvolved customer and cannot wait, while a wrong amount on the right account is a correction. Transposed digits in the serial or amount indicate manual re-keying, so widen to the rest of the operator's batch rather than fixing the single item.",
  },
  {
    key: "cheque_value_limit_breach",
    label: "Instrument above the clearing value ceiling",
    severity: "high",
    slaHours: 24,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "The Nigeria Bankers' Clearing System Rules cap an eligible paper-based instrument at ₦10 million face value; the ceiling has stood since January 2010 and is intended to push high-value payments onto RTGS. An item above it is not eligible for clearing, so paying it puts the bank outside the rules with no clearing-house recourse if it goes wrong.",
    recommendedResolution:
      "1) Flag any cleared instrument with a face value above ₦10 million. 2) Return it as ineligible within the session return window rather than paying it. 3) Where it has already been paid, treat the exposure as unsecured and escalate the same day. 4) Direct the customer to RTGS for the payment. 5) Check the presenting bank's pattern — repeat presentment of ineligible items is a matter for the clearing house, not just for this instrument.",
    aiDiagnosisHint:
      "A pure threshold test on face value, so the value is in what it catches next: cluster breaches by drawer and by presenting bank. A single drawer repeatedly at the ceiling is usually a payment being split to stay under it, which is a structuring signal worth raising to compliance rather than a clearing exception.",
  },
  {
    key: "cheque_stale_or_postdated_paid",
    label: "Stale or post-dated instrument paid",
    severity: "high",
    slaHours: 24,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "A cheque is valid for six months from its date. Paying a stale instrument, or one dated in the future, is payment against the drawer's mandate — the debit is not authorised on the day it was made, and the drawer can require the bank to recredit it. Under truncation the date is read from the image, so this is a data control.",
    recommendedResolution:
      "1) Compare each instrument's date against the clearing date: more than six months earlier is stale, later is post-dated. 2) Return both as unpaid within the session window. 3) Where already paid, recredit the drawer and pursue the payee — the loss sits with the bank, not the customer. 4) Confirm the validity check is applied at the point of clearing rather than at review, or this recurs. 5) Report recurrences as a control failure, not as individual items.",
    aiDiagnosisHint:
      "Both directions matter and they fail differently. A post-dated instrument paid early means the drawer's funds left before they intended and is the complaint that arrives immediately. A stale one is usually a re-presented old instrument and may indicate the payee is recycling instruments already settled another way — so check it against prior payments to the same payee before returning it.",
  },
  {
    key: "cheque_outward_not_cleared",
    label: "Outward presentment with no clearing response",
    severity: "high",
    slaHours: 24,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "On a T+1 cycle every outward presentment should be answered — paid or returned — by the close of the following session. An item with no response is in limbo: the customer has been given provisional value, the bank has no settlement for it, and no clock is running on anyone to resolve it.",
    recommendedResolution:
      "1) Age outward presentments against the session in which they should have been answered. 2) List anything unanswered past T+1 and confirm it was actually transmitted rather than stuck in the truncation queue at this bank. 3) Re-present where the item was never transmitted. 4) Query the clearing house where it was transmitted and unanswered. 5) Hold the provisional credit until answered — releasing it converts an operational item into a credit exposure.",
    aiDiagnosisHint:
      "Split by where the item stopped before escalating: many are never transmitted at all, which is this bank's own queue and fixable without anyone else. Transmitted-and-unanswered is the smaller, genuinely external set. A cluster sharing a transmission window points at a failed file rather than at individual instruments.",
  },
  {
    key: "cheque_unpresented_aged",
    label: "Issued cheque outstanding beyond the reconciliation window",
    severity: "medium",
    slaHours: 72,
    sources: ["cheque_clearing", "cbs_ledger"],
    regulatoryContext:
      "A cheque the bank has issued and that has not been presented is a genuine reconciling item between the cashbook and the bank statement, and it stays legitimate until it goes stale at six months. After that it can no longer be presented, so continuing to carry it understates available funds and, left long enough, hides a stale liability in the reconciliation.",
    recommendedResolution:
      "1) Age unpresented issued cheques from their issue date. 2) Leave anything under six months as a normal reconciling item — it is not an exception yet. 3) At six months, write the item back and recognise the liability to the payee separately; it can no longer clear. 4) Confirm the payee was not paid by another route in the meantime, which is the common case for a long-outstanding item. 5) Review anything over twelve months for unclaimed-balance treatment.",
    aiDiagnosisHint:
      "The finding is the age profile, not the individual item — an unpresented cheque is ordinary until it is stale. Flag the six-month boundary, and separately flag any payee with both a long-outstanding cheque and a later payment by transfer, which usually means it was settled twice and one leg was never cancelled.",
  },
];

export const CHEQUE_EXCEPTION_KEYS = CHEQUE_EXCEPTIONS.map((e) => e.key);
