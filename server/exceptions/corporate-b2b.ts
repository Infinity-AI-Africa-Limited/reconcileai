/**
 * Corporate B2B / FMCG distributor exception taxonomy.
 *
 * The vertical shipped without one. A corporate_b2b tenant's exceptions were
 * diagnosed by the Super Agent under a persona that describes itself as a
 * Nigerian payment-systems expert, with the NIP/POS/ATM channel catalogue
 * selected by keyword and an instruction to "reference relevant Nigerian
 * banking regulations (CBN circulars, NIBSS rules)". For an FMCG manufacturer
 * reconciling distributor receipts that is wrong twice over: a manufacturer is
 * not a CBN-supervised institution, and the first launch geography in the
 * go-live plan is UGANDA, where citing a Nigerian circular is simply incorrect.
 *
 * CLAUDE.md §9A is explicit that a new vertical must ship its own exception
 * taxonomy, resolution procedures, regulatory context and diagnosis guidance —
 * never matching alone. This is that taxonomy.
 *
 * ── What governs these exceptions ─────────────────────────────────────────
 *
 * NOT CBN prudential rules. A distributor receipt is governed by:
 *   - the trade/distributor agreement (credit terms, promotion schedule,
 *     damage-and-returns policy, deduction limits, dispute window);
 *   - revenue recognition — IFRS 15 treats trade discounts, rebates and
 *     returns as variable consideration, so an unapproved deduction left
 *     unresolved misstates revenue rather than merely delaying a receipt;
 *   - tax authorities on withholding and VAT — FIRS (Nigeria) and URA
 *     (Uganda), which is where the WHT-credit evidence obligation comes from;
 *   - the payment rail's own operator rules ONLY as evidence of a receipt:
 *     Bank of Uganda's National Payment Systems framework for MTN MoMo and
 *     Airtel Money statements, NIBSS/PSP reports in Nigeria. ReconcileAI reads
 *     those files; it does not operate on those rails.
 *
 * ── Not yet seeded as resolution templates ────────────────────────────────
 *
 * `resolution_templates.category` is a MySQL ENUM, so seeding these keys the
 * way the Nigerian and retail taxonomies are seeded requires a migration that
 * widens it. That is deliberately NOT bundled here — migration ordering has
 * broken this deployment three times (CLAUDE.md §10, §12) and a taxonomy that
 * improves diagnosis today should not wait behind it. The keys are registered
 * in EXCEPTION_REGISTRY and ALL_EXCEPTIONS (plain maps, no schema), and the
 * prompt block is live. Template seeding is the follow-up.
 */

/**
 * Evidence sources, deliberately named to match the pilot's registered source
 * contracts (`corporate_b2b_pilot_sources.sourceType`) plus the two records
 * that are not a delivered file. A taxonomy whose sources do not line up with
 * the register's sources cannot be cross-referenced by an operator.
 */
export type CorporateB2BSource =
  | "invoice_ar"
  | "bank_statement"
  | "mobile_money"
  | "psp_collection"
  | "erp_export"
  | "remittance_advice"
  | "distributor_master";

export interface CorporateB2BException {
  /** Unique key. Prefixed `b2b_` so it cannot collide with another vertical. */
  key: string;
  label: string;
  severity: "critical" | "high" | "medium" | "low";
  /** Hours before the customer's agreed daily-close/dispute SLA is breached. */
  slaHours: number;
  sources: CorporateB2BSource[] | "all";
  /** Why this matters, in the terms that actually govern it. */
  regulatoryContext: string;
  recommendedResolution: string;
  aiDiagnosisHint: string;
}

export const CORPORATE_B2B_EXCEPTIONS: CorporateB2BException[] = [
  // ─── Receipt → invoice allocation ────────────────────────────────────────
  {
    key: "b2b_unallocated_receipt",
    label: "Receipt With No Identifiable Invoice",
    severity: "high",
    slaHours: 24,
    sources: ["bank_statement", "mobile_money", "psp_collection"],
    regulatoryContext:
      "An unallocated receipt sits in a suspense account and overstates both cash-on-account and the outstanding receivable for the paying distributor. Under IFRS 15 the receivable is only extinguished when the consideration is allocated to the performance obligation it settles, so an ageing suspense balance is a reporting defect, not just an operational backlog. The distributor agreement's credit-limit test is also computed against an overstated balance, which can wrongly block or wrongly release supply.",
    recommendedResolution:
      "1) Match the payer identity against the approved distributor roster, including recorded aliases. 2) Request the remittance advice for the value date from the distributor or the sales-operations owner. 3) Where no advice exists, apply the customer's documented allocation policy — usually oldest-invoice-first within the same distributor — and record it as a PROPOSAL for the daily-close owner to approve. 4) Never post the allocation from ReconcileAI; export the proposal for the customer to post in their ERP. 5) If the payer cannot be identified at all, escalate as a potential third-party or misdirected payment.",
    aiDiagnosisHint:
      "Credit on a bank or mobile-money statement with no invoice reference that parses, and no near-amount invoice within the tolerance window. Look for the distributor identity in the narration, the originating account name, or the mobile-money subscriber name before concluding it is unidentifiable. Aggregated round amounts (e.g. exactly 5,000,000) usually indicate a lump remittance covering several invoices rather than a single unmatched one.",
  },
  {
    key: "b2b_partial_payment",
    label: "Short Payment Against a Known Invoice",
    severity: "medium",
    slaHours: 48,
    sources: ["bank_statement", "mobile_money", "invoice_ar"],
    regulatoryContext:
      "A short payment is either an agreed deduction or a collection shortfall, and the two have opposite accounting treatments: the first is variable consideration under the trade agreement, the second is an overdue receivable that ages toward the provision policy. Closing a short payment without deciding which it is is how trade-spend leakage becomes indistinguishable from bad debt.",
    recommendedResolution:
      "1) Quantify the shortfall against the invoice value. 2) Test the remittance narration for a stated deduction reason before assuming underpayment. 3) If a deduction is claimed, route to the matching deduction exception so the supporting evidence is demanded. 4) If no deduction is claimed, leave the balance open, age it, and issue the customer's standard follow-up. 5) Record the decision and its owner — a short payment closed without one is unauditable.",
    aiDiagnosisHint:
      "Receipt below the invoice value with the invoice reference intact. Quantify the shortfall precisely and state it in the currency of the invoice. Distinguish a deliberate deduction (narration contains a reason, shortfall matches a promotion, damage claim or fee) from a plain part-payment (round-number shortfall, no reason, often a cash-flow-driven instalment).",
  },
  {
    key: "b2b_overpayment_on_account",
    label: "Receipt Exceeds the Invoiced Amount",
    severity: "medium",
    slaHours: 48,
    sources: ["bank_statement", "mobile_money", "invoice_ar"],
    regulatoryContext:
      "An excess receipt is a liability to the distributor, not revenue. Recognising it against a later invoice before that invoice exists inflates the current period. Distributor agreements normally require the credit balance to be applied to the next order or refunded within a stated period.",
    recommendedResolution:
      "1) Confirm the excess is genuine and not a mis-keyed invoice value. 2) Check for a second, later invoice the payment was intended to cover in advance. 3) Record the excess as a credit on the distributor's account. 4) Propose either application to the next open invoice or refund, per the agreement, for the daily-close owner to decide. 5) Age the credit balance — an unapplied credit is as much an exception as an unpaid invoice.",
    aiDiagnosisHint:
      "Receipt exceeds a confidently matched invoice. Before calling it an overpayment, test whether the excess equals another open invoice for the same distributor — that is a two-invoice remittance, not an overpayment.",
  },
  {
    key: "b2b_split_payment_across_invoices",
    label: "One Receipt Settling Several Invoices",
    severity: "medium",
    slaHours: 48,
    sources: ["bank_statement", "mobile_money", "remittance_advice"],
    regulatoryContext:
      "Distributors commonly settle a batch of invoices with one transfer. The allocation is a judgement that changes which invoices age and therefore which fall into the provision or the credit-hold rule, so the trade agreement's approval matrix applies to it.",
    recommendedResolution:
      "1) Obtain the remittance advice and use it as the authoritative allocation. 2) Where no advice exists, propose an allocation that exactly sums to the receipt and flag it as unconfirmed. 3) Present the proposed split with each invoice, amount and residual shown. 4) Require named human approval before any allocation is treated as final. 5) If more than one combination of open invoices sums to the receipt, say so and propose none — an arbitrary choice among equally valid splits is a fabricated allocation.",
    aiDiagnosisHint:
      "Receipt equals the sum of several open invoices for one distributor. State the candidate combination explicitly. If several different combinations reach the same total, report the ambiguity rather than picking one; a confident-looking allocation that was chosen arbitrarily is worse than an open item.",
  },
  {
    key: "b2b_aggregated_remittance_no_advice",
    label: "Lump Remittance Without Remittance Advice",
    severity: "high",
    slaHours: 24,
    sources: ["bank_statement", "remittance_advice"],
    regulatoryContext:
      "The remittance advice is the distributor's own statement of what it paid for, and it is the evidence a reviewer relies on when the allocation is later disputed. Allocating a lump sum without it moves the burden of proof onto the manufacturer.",
    recommendedResolution:
      "1) Request the advice from the distributor and record the request date. 2) Hold the receipt on account rather than allocating on assumption. 3) If the advice is habitually absent for a distributor, raise it with sales operations as a master-data/process defect rather than treating each occurrence as a one-off. 4) Escalate at the agreed SLA to the daily-close owner.",
    aiDiagnosisHint:
      "Large credit, distributor identified, several invoices open, no advice ingested for the period. The right recommendation is to obtain the advice, not to guess an allocation.",
  },
  {
    key: "b2b_reference_quality_failure",
    label: "Payment Reference Unusable or Truncated",
    severity: "medium",
    slaHours: 72,
    sources: ["bank_statement", "mobile_money", "psp_collection"],
    regulatoryContext:
      "Bank and mobile-money narration fields are short and are frequently truncated in transit, so an invoice number entered by the distributor may arrive incomplete. This is a data-quality defect in the collection process, and repeated occurrences are the strongest argument for issuing distributors with a structured payment reference.",
    recommendedResolution:
      "1) Attempt reconstruction from the partial reference plus the amount and payer. 2) Confirm the reconstruction with the distributor before treating it as matched. 3) Record the occurrence against the source so the pattern is visible. 4) Recommend a structured reference format (distributor code + invoice number) in the customer's collection instructions.",
    aiDiagnosisHint:
      "Reference present but not parseable as an invoice number, or clearly cut short. Do not treat a reconstructed reference as a confirmed match — say what was inferred and what would confirm it.",
  },

  // ─── Trade deductions: the FMCG core ─────────────────────────────────────
  {
    key: "b2b_promotional_deduction_unapproved",
    label: "Promotional Deduction Outside the Approved Schedule",
    severity: "high",
    slaHours: 48,
    sources: ["bank_statement", "remittance_advice", "invoice_ar"],
    regulatoryContext:
      "Trade promotions are variable consideration under IFRS 15 and are only a legitimate reduction of revenue where they are within the agreed promotion schedule for the period and the product. A deduction taken outside that schedule is a receivable shortfall, and treating it as trade spend both understates revenue and hides unauthorised discounting from the commercial team.",
    recommendedResolution:
      "1) Identify the promotion claimed from the remittance narration or advice. 2) Test it against the approved promotion schedule for that distributor, product and period. 3) Where it matches, propose allocation to the trade-promotion account within the approved limit. 4) Where it does not, raise a dispute with sales operations and keep the residual invoice balance open. 5) Never close an unapproved deduction on the strength of the distributor's own description of it.",
    aiDiagnosisHint:
      "Shortfall with promotional keywords (promo, rebate, allowance, discount) in the narration. The diagnosis question is not what the distributor called it but whether it is on the approved schedule — say explicitly that schedule confirmation is required, and quantify the amount at risk.",
  },
  {
    key: "b2b_damage_claim_deduction",
    label: "Damage or Breakage Deduction Without Proof",
    severity: "high",
    slaHours: 48,
    sources: ["bank_statement", "remittance_advice"],
    regulatoryContext:
      "Distributor agreements normally require damage claims to be supported by a signed delivery note, photographic evidence and notification within a stated window, and to be settled by credit note rather than by unilateral deduction. A deduction taken without that evidence transfers a disputed loss to the manufacturer with no documentation trail.",
    recommendedResolution:
      "1) Quantify the deduction. 2) Request the delivery note, damage evidence and claim date. 3) Check the claim window in the trade agreement has not expired. 4) If valid, raise a credit note through the customer's own process — ReconcileAI proposes it and never issues it. 5) If unsupported or out of window, keep the balance open and escalate to the commercial owner.",
    aiDiagnosisHint:
      "Shortfall with damage keywords (dmg, damage, breakage, spoilt, expired). State the shortfall value and that a credit note is the correct instrument, not an unevidenced write-off. Flag if the same distributor shows repeated damage deductions — a pattern is a supply-chain or claims-abuse signal, not a series of unrelated exceptions.",
  },
  {
    key: "b2b_returns_deduction_no_credit_note",
    label: "Returns Deducted With No Credit Note Raised",
    severity: "high",
    slaHours: 48,
    sources: ["bank_statement", "remittance_advice", "erp_export"],
    regulatoryContext:
      "A return reverses the original sale. Deducting for it without raising the credit note leaves the revenue and the VAT output recognised on a sale that did not stand, and leaves the stock position unadjusted. Both the tax and the inventory record are wrong until the credit note exists.",
    recommendedResolution:
      "1) Identify the returned goods and the original invoice. 2) Confirm the return was authorised and physically received. 3) Propose the credit note, including the VAT reversal, for the customer to raise. 4) Confirm the stock adjustment has been made. 5) Only then allocate the deduction.",
    aiDiagnosisHint:
      "Shortfall with return/expiry keywords, or a deduction that matches a known returns document. The recommended action must name the credit note and the VAT consequence — allocating the deduction alone leaves two records wrong.",
  },
  {
    key: "b2b_rebate_deduction_period_mismatch",
    label: "Rebate Claimed in the Wrong Period",
    severity: "medium",
    slaHours: 72,
    sources: ["remittance_advice", "invoice_ar"],
    regulatoryContext:
      "Volume rebates accrue against a defined performance period. A rebate deducted before the period closes, or claimed twice across a period boundary, misstates trade spend in both periods and is a common source of duplicate claiming.",
    recommendedResolution:
      "1) Establish the rebate period and the accrual already recognised. 2) Check whether the same rebate has already been settled in an earlier period. 3) If the period is open, defer the deduction to the settlement run. 4) If already settled, treat as a duplicate claim and keep the balance open.",
    aiDiagnosisHint:
      "Rebate keywords with a value date outside the rebate settlement window, or a second rebate deduction from the same distributor within one period. Duplicate claiming across a period boundary is the specific failure to test for.",
  },
  {
    key: "b2b_listing_fee_deduction",
    label: "Listing, Shelf or Trade Fee Deducted at Source",
    severity: "medium",
    slaHours: 72,
    sources: ["bank_statement", "remittance_advice"],
    regulatoryContext:
      "Listing and shelf fees are contractual trade spend and normally require an invoice from the distributor or retailer, which carries VAT consequences. Deducting them at source without that invoice leaves an unsupported expense and an unrecoverable input tax.",
    recommendedResolution:
      "1) Identify the fee and the agreement clause permitting it. 2) Require the distributor's tax invoice for the fee. 3) Propose posting to the correct trade-spend account once the invoice exists. 4) Keep the receivable open until then.",
    aiDiagnosisHint:
      "Shortfall with listing/shelf/display/trade-fee wording. Emphasise the missing supplier invoice — this is a documentation exception more than a cash exception.",
  },
  {
    key: "b2b_deduction_exceeds_approved_limit",
    label: "Deduction Above the Approved Limit",
    severity: "critical",
    slaHours: 24,
    sources: ["bank_statement", "remittance_advice"],
    regulatoryContext:
      "The trade agreement and the customer's approval matrix set the value a deduction may reach before a higher authority must approve it. A deduction accepted above that limit bypasses the segregation of duties the matrix exists to enforce, which is the control failure most likely to be raised by an external auditor.",
    recommendedResolution:
      "1) Compare the deduction to the approved limit for its type and the distributor. 2) Escalate immediately to the approver named in the matrix — do not resolve at operator level. 3) Keep the invoice balance open pending that decision. 4) Record the escalation and the outcome against the exception.",
    aiDiagnosisHint:
      "Deduction value above the recorded threshold for its category. Severity is driven by the control breach, not only by the amount: say who must approve it, not merely that it is large.",
  },

  // ─── Tax, bank and rail costs ────────────────────────────────────────────
  {
    key: "b2b_withholding_tax_deduction",
    label: "Withholding Tax Deducted, Credit Evidence Outstanding",
    severity: "high",
    slaHours: 72,
    sources: ["bank_statement", "remittance_advice"],
    regulatoryContext:
      "Where the distributor is required to withhold tax on the payment, the shortfall is legitimate ONLY against a withholding-tax credit note or certificate from the revenue authority — FIRS in Nigeria, URA in Uganda. Without it the amount is neither collectible from the distributor nor claimable against the tax liability, so it is a real loss recorded as a receivable.",
    recommendedResolution:
      "1) Confirm the shortfall matches the applicable withholding rate on the invoice value. 2) Request the WHT credit note or certificate and record the request. 3) Track it to receipt — an unreceived certificate is an ageing exception in its own right, not a closed item. 4) On receipt, propose allocation of the shortfall against the tax asset. 5) Escalate certificates outstanding beyond the customer's stated tolerance.",
    aiDiagnosisHint:
      "Shortfall close to a standard withholding rate on the invoice value, or narration mentioning WHT/withholding. Check the arithmetic against the rate before concluding — a coincidental percentage is not evidence. The action is to obtain the certificate; allocating without it converts a tax asset into a write-off.",
  },
  {
    key: "b2b_vat_treatment_mismatch",
    label: "VAT Treatment Differs Between Invoice and Receipt",
    severity: "high",
    slaHours: 48,
    sources: ["invoice_ar", "bank_statement", "erp_export"],
    regulatoryContext:
      "A receipt computed on a different VAT basis from the invoice — exempt versus standard-rated, or an incorrect rate — produces a permanent difference between the receivable and the cash, and misstates the output tax already declared. This is a filing exposure, not a reconciliation nuisance.",
    recommendedResolution:
      "1) Recompute the expected receipt from the invoice's tax treatment. 2) Establish which treatment is correct for the product and the customer's registration status. 3) Where the invoice was wrong, propose a corrected invoice or credit note. 4) Involve the customer's tax owner before any allocation is approved.",
    aiDiagnosisHint:
      "Shortfall or excess that equals the VAT rate applied to the net or gross value. Say which of the two documents appears to carry the wrong treatment and what the tax consequence is.",
  },
  {
    key: "b2b_bank_charge_shortfall",
    label: "Transfer Charge Borne by the Receiving Party",
    severity: "low",
    slaHours: 120,
    sources: ["bank_statement"],
    regulatoryContext:
      "Whether the payer or the payee bears the transfer charge is a term of the trade agreement. A small, consistent shortfall equal to a published transfer fee is an accepted cost when the agreement says so, and an unauthorised deduction when it does not.",
    recommendedResolution:
      "1) Confirm the shortfall matches the published fee for that rail and value band. 2) Check the agreement's charge-bearer term. 3) If the payee bears it, propose posting to bank charges and close. 4) If the payer should bear it, recover the difference on the next remittance and inform the distributor.",
    aiDiagnosisHint:
      "Small shortfall consistent with a fixed or banded transfer fee. This is the most auto-resolvable exception in the taxonomy, but only where the charge-bearer term is known — do not assume it.",
  },
  {
    key: "b2b_mobile_money_fee_shortfall",
    label: "Mobile-Money Charge Deducted From the Collection",
    severity: "low",
    slaHours: 120,
    sources: ["mobile_money"],
    regulatoryContext:
      "Mobile-money tariffs are banded by value and are published by the provider under the supervisory framework of the relevant central bank — in Uganda, Bank of Uganda's National Payment Systems regime covering MTN Mobile Money and Airtel Mobile Commerce. The tariff is verifiable, so a shortfall that does not match a published band is not a fee.",
    recommendedResolution:
      "1) Identify the provider and the value band. 2) Compare the shortfall to the published tariff for that band. 3) Where it matches, propose posting to collection charges. 4) Where it does not, treat it as an unexplained shortfall and investigate rather than absorbing it.",
    aiDiagnosisHint:
      "Mobile-money collection short by a small amount. Test the shortfall against the provider's banded tariff. A shortfall that is close to but not equal to a tariff band is the interesting case — absorbing it silently is how agent-level leakage persists.",
  },

  // ─── Timing and settlement ───────────────────────────────────────────────
  {
    key: "b2b_mobile_money_settlement_delay",
    label: "Mobile-Money Collection Not Yet Settled to Bank",
    severity: "medium",
    slaHours: 48,
    sources: ["mobile_money", "bank_statement"],
    regulatoryContext:
      "A collection confirmed in the wallet statement but not yet swept to the bank account is a timing difference, not a missing payment. Reporting it as an exception at close overstates unresolved value; ignoring it hides a genuine settlement failure when the sweep never arrives.",
    recommendedResolution:
      "1) Confirm the wallet-side collection and its timestamp. 2) Check the expected sweep window for the provider. 3) Hold as a timing item within the window and report it as such. 4) Escalate to the provider once the window has passed. 5) Never net a wallet balance against a bank balance in the daily close.",
    aiDiagnosisHint:
      "Present in the mobile-money statement, absent from the bank statement, within the provider's normal sweep window. Distinguish a timing difference from a settlement failure by the age of the item, and state which one this is.",
  },
  {
    key: "b2b_cut_off_straddle",
    label: "Receipt Straddling the Close Cut-Off",
    severity: "medium",
    slaHours: 24,
    sources: ["bank_statement", "mobile_money", "invoice_ar"],
    regulatoryContext:
      "A receipt dated on one side of the agreed cut-off and ingested on the other appears twice or not at all across two closes. The cut-off rule is part of the customer-approved data contract precisely so this is decided once rather than per occurrence.",
    recommendedResolution:
      "1) Apply the cut-off rule from the approved data contract — value date or posting date, stated explicitly. 2) Assign the receipt to one period only. 3) Where the source's own dating is ambiguous, record the ambiguity against the source contract rather than resolving it silently. 4) Do not report a final match rate for a run whose sources straddle the cut-off unresolved.",
    aiDiagnosisHint:
      "Value date and posting date fall on opposite sides of the cut-off. The answer comes from the data contract, not from the transaction — say which rule applies and which period the item belongs to.",
  },
  {
    key: "b2b_receipt_reversed_after_allocation",
    label: "Receipt Reversed or Recalled After Allocation",
    severity: "critical",
    slaHours: 8,
    sources: ["bank_statement", "mobile_money"],
    regulatoryContext:
      "A recalled or bounced receipt that has already been allocated leaves the invoice showing as settled and the cash absent. Until it is reversed the credit-limit test passes on money that never arrived, which can release further supply to a distributor that has already failed to pay.",
    recommendedResolution:
      "1) Identify the original receipt and every allocation made against it. 2) Propose reversal of each allocation and reinstatement of the invoice balances. 3) Notify the credit controller immediately — the credit-limit position is wrong until this is posted. 4) Record the reversal reason from the bank or provider advice.",
    aiDiagnosisHint:
      "Debit that mirrors an earlier credit for the same counterparty and amount, or an explicit reversal/recall narration. Highest urgency in this taxonomy: the exposure is not the reconciliation break but the supply decision taken on the back of it.",
  },

  // ─── Master data and run integrity ───────────────────────────────────────
  {
    key: "b2b_unknown_distributor",
    label: "Payer Not on the Approved Distributor Roster",
    severity: "high",
    slaHours: 24,
    sources: ["bank_statement", "mobile_money", "distributor_master"],
    regulatoryContext:
      "The approved roster is the control that says whose money this is. A receipt from an identity outside it is either an unrecorded trading relationship, a third party paying on a distributor's behalf, or a misdirected payment — and each has a different owner and a different risk.",
    recommendedResolution:
      "1) Do not allocate. 2) Refer the identity to the customer's sales-operations data steward. 3) Where it is a genuine distributor, require the roster to be updated through the maker/checker process before allocation. 4) Where a third party is paying on a distributor's behalf, record the authority for it. 5) Where neither, treat as a misdirected receipt and follow the customer's refund process.",
    aiDiagnosisHint:
      "Payer identity absent from the roster and its alias list. Resist matching on a partially similar name — that is precisely how a receipt is allocated to the wrong distributor's account.",
  },
  {
    key: "b2b_distributor_alias_ambiguity",
    label: "Payer Name Matches More Than One Roster Identity",
    severity: "high",
    slaHours: 24,
    sources: ["distributor_master", "bank_statement"],
    regulatoryContext:
      "Two roster entries reachable by the same name make every allocation between them a coin toss, and the resulting misallocation is discovered later as two wrong distributor statements. This is the governance defect gate B3 exists to prevent.",
    recommendedResolution:
      "1) Hold the receipt; do not choose between the candidates. 2) Return the ambiguity to the data steward with both roster entries named. 3) Require the duplicate identity to be merged or the aliases to be disambiguated. 4) Re-run the allocation once the roster is corrected.",
    aiDiagnosisHint:
      "More than one roster identity matches the payer. Report the ambiguity and the candidates; do not rank them. A confident allocation between indistinguishable identities is a fabricated one.",
  },
  {
    key: "b2b_duplicate_receipt_ingested",
    label: "Same Receipt Ingested Twice",
    severity: "critical",
    slaHours: 8,
    sources: ["bank_statement", "mobile_money", "psp_collection", "erp_export"],
    regulatoryContext:
      "A duplicated receipt understates the receivable and overstates cash, and if allocated it closes an invoice that is still owed. The pilot acceptance test is explicit: re-sending an identical file must not create additional transaction rows or allocations, and a failure here stops the run rather than being corrected downstream.",
    recommendedResolution:
      "1) Stop the run. 2) Compare the file hash and the per-row identity of the two deliveries. 3) Quarantine the duplicate batch rather than deleting rows individually. 4) Establish whether the duplicate arose from a re-send, an overlapping export window, or a broken idempotency key, and fix the cause at the source contract. 5) Re-run only after the control totals agree.",
    aiDiagnosisHint:
      "Identical amount, value date and reference for one counterparty across two batches. Distinguish a true duplicate from two genuinely separate payments of the same round amount on the same day — the source batch and the provider's own transaction id decide it, not the amount.",
  },
  {
    key: "b2b_source_control_total_mismatch",
    label: "Ingested Control Total Does Not Agree to the Source",
    severity: "critical",
    slaHours: 8,
    sources: "all",
    regulatoryContext:
      "The control total is the only evidence that the file reconciled against is the file the customer sent. Where it does not agree, every downstream figure — match rate, unresolved value, ageing — is computed on an incomplete population, and the acceptance test requires the run to be marked incomplete rather than reported.",
    recommendedResolution:
      "1) Do not publish a match rate for the run. 2) Compare the ingested row count and value total to the customer's stated control total. 3) Quarantine the batch and raise a source-quality exception against the source contract. 4) Request a re-delivery. 5) Record the variance and its cause — truncation, encoding, a partial upload, or a changed export definition.",
    aiDiagnosisHint:
      "Row count or value total differs from the source's stated control total. The correct output is an incomplete-run declaration, never a match rate with a caveat attached.",
  },
  {
    key: "b2b_credit_limit_breach",
    label: "Distributor Exposure Beyond the Agreed Credit Limit",
    severity: "high",
    slaHours: 24,
    sources: ["invoice_ar", "erp_export", "distributor_master"],
    regulatoryContext:
      "The credit limit in the distributor agreement is the commercial control on unsecured exposure. Reconciliation is where a breach first becomes visible, because it is where unallocated receipts and ageing invoices are resolved into a true balance.",
    recommendedResolution:
      "1) Recompute the exposure using only allocated, unreversed receipts. 2) Confirm the breach is not an artefact of unallocated cash sitting in suspense. 3) Report the true exposure to the credit controller with the ageing profile. 4) Do not action a supply hold from ReconcileAI — report it for the customer to decide.",
    aiDiagnosisHint:
      "Exposure above the recorded limit. Always test whether unallocated receipts for the same distributor would clear the breach before reporting it — a false credit-hold is commercially expensive.",
  },
  {
    key: "b2b_invoice_missing_for_receipt_period",
    label: "Expected Invoice File Absent for the Period",
    severity: "critical",
    slaHours: 8,
    sources: ["invoice_ar", "erp_export"],
    regulatoryContext:
      "Reconciling receipts against a missing invoice population produces a match rate near zero and an exception queue that describes nothing. Source completeness is an acceptance test in its own right: each expected source must arrive within the agreed cut-off before a run is meaningful.",
    recommendedResolution:
      "1) Mark the run incomplete and suppress the match rate. 2) Confirm with the source owner whether the export failed or was not scheduled. 3) Re-run once the file arrives. 4) Record the miss against the source contract so recurring gaps are visible rather than absorbed.",
    aiDiagnosisHint:
      "Receipts present, invoice population absent or far smaller than the period's norm. Report a source-completeness failure — never a low match rate, which invites the reader to conclude the reconciliation performed badly rather than that it did not run.",
  },
];

export const CORPORATE_B2B_EXCEPTION_KEYS = CORPORATE_B2B_EXCEPTIONS.map((e) => e.key);

export function corporateB2BExceptionFor(key: string): CorporateB2BException | null {
  return CORPORATE_B2B_EXCEPTIONS.find((e) => e.key === key) ?? null;
}

/**
 * AI prompt block for a Corporate B2B tenant.
 *
 * Selected by the ORGANISATION's segment rather than by channel: an FMCG
 * manufacturer's receipts arrive on bank, mobile-money and PSP rails, and the
 * exception it is actually facing is a trade deduction, not a rail failure.
 * Returns "" for any other segment so nothing is injected and no tokens are
 * spent on a taxonomy that does not apply.
 */
export function corporateB2BExceptionsTaxonomyPromptBlock(segment: string | null | undefined): string {
  if (segment !== "corporate_b2b") return "";
  return CORPORATE_B2B_EXCEPTIONS.map(
    (e) => `- ${e.key} (${e.severity}, SLA ${e.slaHours}h): ${e.label}. ${e.aiDiagnosisHint}`,
  ).join("\n");
}

/**
 * The regulatory frame to reason within, by pilot country.
 *
 * The Super Agent's system prompt instructs it to cite CBN circulars and NIBSS
 * rules. For a Ugandan FMCG distributor — the first launch geography in the
 * go-live plan — that is a wrong citation on a document a financial controller
 * takes to a supplier meeting. Neither country's banking regulator governs a
 * manufacturer's trade receivables in any case.
 */
export function corporateB2BRegulatoryFrame(country: string | null | undefined): string {
  const tax =
    country === "uganda"
      ? "Uganda Revenue Authority (URA) rules on VAT and withholding tax"
      : country === "nigeria"
        ? "Federal Inland Revenue Service (FIRS) rules on VAT and withholding tax"
        : "the applicable national revenue authority's rules on VAT and withholding tax";
  const rail =
    country === "uganda"
      ? "Mobile-money evidence comes from MTN Mobile Money and Airtel Mobile Commerce statements, whose providers are supervised under Bank of Uganda's National Payment Systems framework."
      : country === "nigeria"
        ? "Receipt evidence comes from bank statements, NIP-originated credits and PSP collection reports."
        : "Receipt evidence comes from the customer's authorised bank, mobile-money and PSP sources.";
  return [
    "This organisation is an FMCG manufacturer or distributor, NOT a licensed bank. Do not cite central-bank prudential circulars at it and do not describe it as a payment-system participant.",
    `What governs these exceptions: the distributor/trade agreement (credit terms, promotion schedule, damage-and-returns policy, deduction limits and the approval matrix); IFRS 15, under which trade discounts, rebates and returns are variable consideration; and ${tax}.`,
    rail,
    "ReconcileAI is read-only in this pilot. Every allocation, credit note, journal entry and distributor communication is a PROPOSAL for a named human to approve and to execute in the customer's own systems. Never phrase a recommendation as though the platform will carry it out.",
  ].join(" ");
}
