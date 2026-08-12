/**
 * Non-Interest (NIFI) Banking — exception taxonomy.
 *
 * NOT a payment channel. Every other taxonomy in this directory describes a
 * RAIL — how money moves. This one describes how money is allowed to be EARNED
 * and SHARED at an institution licensed to operate on non-interest principles,
 * and it applies across all of that institution's rails at once. It is
 * therefore selected by the organisation's `bankingModel`, not by the channel a
 * transaction arrived on (see server/exceptions/channelMapping.ts, which maps
 * channels and deliberately does not map this).
 *
 * Nigeria licenses these institutions under the CBN's Guidelines for the
 * Regulation and Supervision of Institutions Offering Non-Interest Financial
 * Services, which recognises two categories: institutions offering Islamic
 * financial services, and other institutions operating on any established
 * non-interest principle. Sharīʿah governance is two-tier — the Financial
 * Regulation Advisory Council of Experts (FRACE) at the CBN, inaugurated 10
 * January 2013, and an Advisory Committee of Experts (ACE) inside each
 * institution. Accounting practice follows AAOIFI standards alongside the
 * CBN's prudential returns.
 *
 * Why a reconciliation platform should care, in one line: at a conventional
 * bank a misposting is a number in the wrong place, while here the SAME
 * misposting can make otherwise-permissible income impermissible. The
 * consequence is not only a restatement — it reaches the institution's licence
 * basis and the ACE's attestation, so several of these are `critical` at
 * amounts that would be immaterial at a conventional bank.
 *
 * Two structural facts drive most of what follows:
 *
 *   FUNDS ARE NOT THE BANK'S. Profit-sharing investment account holders (IAH)
 *   are not depositors. Their funds and the shareholders' funds must stay
 *   distinguishable, and CBN's capital guidance turns on exactly this: the
 *   Investment Risk Reserve and part of the Profit Equalisation Reserve belong
 *   to IAH equity and are NOT regulatory capital of the bank. Commingling is
 *   therefore a capital misstatement as well as an accounting one.
 *
 *   PROFIT IS NOT INTEREST. Returns arise from a real sale, lease or
 *   partnership, so they attach to a contract and a schedule rather than
 *   accruing with time. An entry that accrues purely with the passage of time
 *   is the signature of the thing the institution is licensed not to do.
 */
import type { NigerianChannelException } from "./types";

export const NON_INTEREST_EXCEPTIONS: NigerianChannelException[] = [
  {
    key: "nifi_interest_bearing_entry",
    label: "Interest-bearing entry posted at a non-interest institution",
    severity: "critical",
    slaHours: 4,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "A non-interest institution is licensed on the basis that it does not earn or pay interest. An entry that accrues with the passage of time rather than against a sale, lease or partnership contract is the one thing the licence excludes — and it most often arrives not by intent but through a shared core banking system where a conventional product template, a default overdraft rule or an interbank placement was applied to a non-interest account.",
    recommendedResolution:
      "1) Isolate the entry and stop the accrual rule that generated it before reversing anything, or it re-posts overnight. 2) Trace it to its product template or GL rule — a single entry is almost never alone if the cause is configuration. 3) Reverse the accrual and route any amount already recognised to the charity/purification account, not to income. 4) Report it to the Advisory Committee of Experts; this is a matter for their attestation, not an operations correction. 5) Where a shared CBS with a conventional parent is the cause, evidence the segregation of product templates to the CBN.",
    aiDiagnosisHint:
      "The signature is time-proportionality: an amount that is a clean function of principal × rate × days, with no delivery, lease period or partnership event behind it. Check whether the account sits under a non-interest product code while the posting rule came from a conventional template — a window or subsidiary sharing a CBS with a conventional parent is where this nearly always originates, and one template affects every account using it.",
  },
  {
    key: "nifi_commingling_breach",
    label: "IAH funds not segregated from shareholders' funds",
    severity: "critical",
    slaHours: 8,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Profit-sharing investment account holders bear the risk of the assets their funds are deployed into, so their funds must remain distinguishable from shareholders' funds throughout. CBN's capital guidance depends on the distinction: the Investment Risk Reserve and part of the Profit Equalisation Reserve belong to IAH equity and must NOT be counted as the bank's regulatory capital. Once the two pools are mixed, neither the profit calculation nor the capital position can be stated correctly.",
    recommendedResolution:
      "1) Reconcile the IAH pool balance to the assets recorded as funded by it, and the shareholders' pool to its own. 2) Identify any asset funded from the wrong pool, or any return credited to the wrong pool. 3) Restate the allocation from the contract, not from the ledger — the ledger is what is wrong. 4) Recompute the capital position, since IRR and part of PER must come out of regulatory capital. 5) Report to the ACE and, where the capital position moves, to the CBN.",
    aiDiagnosisHint:
      "Look for an asset whose funding source and whose return destination disagree, which is the observable form of commingling: the return of an IAH-funded asset landing in shareholder income, or the reverse. Quantify the effect on regulatory capital as well as on profit — an amount immaterial to the income statement can still be material to capital, because IRR and part of PER are excluded from it.",
  },
  {
    key: "nifi_non_permissible_income_unsegregated",
    label: "Non-permissible income not routed to purification",
    severity: "critical",
    slaHours: 24,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Income from a source the institution's principles do not permit must be segregated and disposed of to charity — purification — rather than recognised as earnings or distributed to shareholders or investment account holders. Left in income it contaminates the whole distribution: every party downstream receives a share of it, which is why this is treated as critical at amounts that would be immaterial elsewhere.",
    recommendedResolution:
      "1) Identify income by source, not by amount — correspondent-bank interest on nostro balances, penalties, and returns from a counterparty screened out are the usual entries. 2) Move each to the purification account in the period it arose, not at year end. 3) Where it has already been distributed, quantify the contaminated share per holder; it cannot be recovered from customers, so it is disposed of from the institution's own funds. 4) Obtain ACE direction on disposal — the institution does not choose the beneficiary unilaterally. 5) Disclose the amount purified.",
    aiDiagnosisHint:
      "Nostro interest from correspondent banks is the single most common source and the easiest to miss, because it arrives as an ordinary credit on a foreign-currency account and looks like any other. Reconcile every credit on correspondent accounts to a permissible source, and check the purification account has a movement in any period where such credits exist — a period with nostro credits and a static purification balance is the finding.",
  },
  {
    key: "nifi_late_payment_charge_to_income",
    label: "Late-payment charge recognised as income",
    severity: "critical",
    slaHours: 24,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "A charge on a late-paying customer is permitted as a deterrent against wilful default, but the institution may not profit from it: compensation for actual, demonstrable loss may be retained, while the penal element must go to charity. Recognising the whole charge as income turns a deterrent into a return on delay — economically the same as the interest the institution is licensed not to earn.",
    recommendedResolution:
      "1) Split every late-payment charge into its compensation and penal components on the ACE-approved basis. 2) Recognise only demonstrable actual loss as income and route the penal element to the charity account. 3) Where the whole charge was taken to income, reverse the penal portion for every affected contract, not only the one raised. 4) Confirm the split is applied by the system rather than by period-end journal, or it recurs. 5) Disclose the amounts retained and disposed of.",
    aiDiagnosisHint:
      "The tell is that the charge is a clean percentage of the overdue amount and time, because a genuine compensation figure tracks demonstrable cost and does not scale that way. If the charity account shows no corresponding movement in the period, the whole charge was almost certainly taken to income — check the posting rule rather than sampling contracts.",
  },
  {
    key: "nifi_profit_distribution_variance",
    label: "IAH profit distribution differs from the calculated pool share",
    severity: "critical",
    slaHours: 24,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Returns to profit-sharing investment account holders are a share of what the underlying pool actually earned, computed on the agreed Mudarabah or Wakala ratio — not a rate the institution sets. Paying more than the pool earned is the institution funding a return out of its own assets to defend a headline rate; paying less appropriates the holders' share. Both misstate the relationship the licence rests on.",
    recommendedResolution:
      "1) Recompute the pool's realised profit for the period and apply the contracted ratio and weightings by tenor and product. 2) Compare against what was actually credited to each holder class. 3) Where a shortfall was smoothed from PER, confirm the movement was approved rather than inferred from the outcome. 4) Where the institution funded the difference itself, disclose it as such — it is a transfer, not a distribution. 5) Take the recomputation to the ACE with the variance by holder class.",
    aiDiagnosisHint:
      "Compare the distributed rate against the pool's realised return before looking at anything else. A distributed rate that is suspiciously stable across periods while pool income moves is the signature of undisclosed smoothing — and check whether PER moved to fund it, because smoothing through PER is legitimate and smoothing from shareholders' funds without disclosure is not.",
  },
  {
    key: "nifi_per_irr_movement_unapproved",
    label: "PER or IRR movement without approval",
    severity: "high",
    slaHours: 48,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "The Profit Equalisation Reserve smooths payouts and the Investment Risk Reserve absorbs losses on investment assets; both are funded out of amounts that would otherwise reach investment account holders. CBN's capital guidance excludes IRR and the IAH portion of PER from the bank's regulatory capital. An unapproved movement therefore both takes value from holders without authority and moves the reported capital position.",
    recommendedResolution:
      "1) List every PER and IRR movement in the period with its approval reference. 2) Confirm each against ACE minutes and the disclosed policy — PER smooths payouts and may not be used to cover losses, which is the IRR's role, and the two are not interchangeable. 3) Reverse any unapproved movement to the holder pool. 4) Recompute regulatory capital, excluding IRR and the IAH share of PER. 5) Report movements and their basis in the period's disclosure.",
    aiDiagnosisHint:
      "A movement that exactly offsets a shortfall in distributable profit is the one to examine — it indicates the reserve was moved to reach a target payout and the approval was written afterwards, if at all. Confirm the direction is right for the reserve used: PER covering an investment LOSS rather than smoothing a payout is a misuse even when it is approved.",
  },
  {
    key: "nifi_murabaha_profit_accrual_mismatch",
    label: "Murabaha profit recognised out of step with the contract",
    severity: "high",
    slaHours: 24,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Murabaha profit is a fixed mark-up agreed at the point of a real sale and recognised across the deferred payment period per the contract schedule. It is not a rate that accrues on an outstanding balance. Recognition that tracks a balance rather than the schedule reproduces interest accounting on a compliant contract — the form is correct and the substance is not, which is precisely what the ACE and the CBN examine.",
    recommendedResolution:
      "1) Compare recognised profit per contract against the agreed schedule for the period. 2) Confirm the underlying sale actually occurred and the asset was owned by the institution before onward sale — no sale means no valid Murabaha, whatever the profit line says. 3) Correct recognition to the schedule. 4) Where early settlement occurred, confirm any rebate was granted per policy rather than as an undisclosed discretion. 5) Confirm the recognition rule is contract-driven in the system.",
    aiDiagnosisHint:
      "Recompute expected recognition from the schedule and difference it against what was posted. A difference that varies with the outstanding balance rather than with elapsed schedule periods means the system is accruing on balance — a configuration finding affecting every contract on that product, not a per-contract correction, so check the product template before listing individual deals.",
  },
  {
    key: "nifi_ijara_rental_unmatched",
    label: "Ijara rental unmatched or ownership cost misallocated",
    severity: "high",
    slaHours: 24,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Under Ijara the institution owns the asset and leases its usufruct, so it must bear the ownership-related costs — major maintenance, insurance (takaful) and ownership taxes — while the lessee bears operating costs. Rentals accrue only while the asset is available for use. Passing ownership costs to the lessee, or continuing to charge rental on an asset that cannot be used, converts the lease into a financing arrangement the institution is not licensed to provide.",
    recommendedResolution:
      "1) Match rentals received against the lease schedule per contract. 2) Confirm no rental accrued for a period in which the asset was unavailable — suspend and credit where it did. 3) Review costs charged to the lessee and reclassify any ownership-related cost back to the institution. 4) Confirm takaful on leased assets is carried by the institution. 5) Reconcile the leased-asset register to the contracts; a rental with no asset is the more serious finding.",
    aiDiagnosisHint:
      "Two distinct failures share this key and need separating before diagnosis. A rental/schedule mismatch is an ordinary reconciliation break. A maintenance, insurance or tax charge recovered from the lessee is a structural finding that recurs across every contract on the product, so check the fee configuration rather than the individual lease.",
  },
  {
    key: "nifi_salam_istisna_milestone_mismatch",
    label: "Salam or Istisna advance without the matching delivery milestone",
    severity: "high",
    slaHours: 48,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Salam pays in full in advance for a commodity delivered later; Istisna funds manufacture or construction against progress. In both, the institution's exposure is to a real deliverable, and the payment is what makes them permissible. An advance with no corresponding delivery or certified progress is economically a loan with a return attached — the substance the structure exists to avoid.",
    recommendedResolution:
      "1) Reconcile every disbursement to its delivery record or certified progress milestone. 2) Age advances with no matching milestone; the exposure is to non-delivery, not to a late payment. 3) Confirm the specification, quantity and delivery date are fixed in the contract, as an unspecified Salam is invalid rather than merely unsecured. 4) For Istisna, confirm certification is independent of the counterparty. 5) Escalate long-unmatched advances as credit exposures with the ACE informed.",
    aiDiagnosisHint:
      "Age from the disbursement date against the contractual delivery date rather than treating it as a payment break. The pattern worth escalating is repeated advances to one counterparty with milestones consistently certified late or in arrears — that is a counterparty that is being financed rather than supplied, which is the finding the structure exists to prevent.",
  },
  {
    key: "nifi_wakala_fee_variance",
    label: "Wakala agency fee differs from the agreed terms",
    severity: "medium",
    slaHours: 48,
    sources: ["nifi_ledger", "cbs_ledger"],
    regulatoryContext:
      "Under Wakala the institution acts as agent for a fee that is fixed and disclosed in advance. Any return above the agreed anticipated profit may be retained as an incentive only where the contract says so. Charging above the agreed fee, or retaining an unagreed surplus, takes the principal's return without authority and undermines the agency basis of the contract.",
    recommendedResolution:
      "1) Recompute the fee charged per Wakala contract against the agreed fixed fee. 2) Identify any surplus above anticipated profit that was retained, and confirm the contract permits it. 3) Return unagreed amounts to the principal. 4) Confirm the fee is fixed rather than expressed as a share of the return, which would make it a profit share and not an agency fee. 5) Confirm disclosure to the principal for the period.",
    aiDiagnosisHint:
      "A fee that moves with the return earned rather than staying fixed is the finding, and it is a contract-design issue rather than a posting error — it makes the arrangement a profit share dressed as agency. Separate that from simple fee miscalculation, which is a correction; the first needs ACE review of the product, the second does not.",
  },
];

export const NON_INTEREST_EXCEPTION_KEYS = NON_INTEREST_EXCEPTIONS.map((e) => e.key);
