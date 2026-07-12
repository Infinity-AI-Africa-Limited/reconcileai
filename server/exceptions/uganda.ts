/**
 * Uganda channel exception taxonomy (validation gap G1) — tenant-grade.
 *
 * Centred on the failure classes the Uganda market research identified:
 * trust-account backing (BoU NPS Act: e-money 1:1), suspense-account
 * integrity (the class that cost MTN Uganda millions to insider fraud),
 * the ABC shared agent rail, 24–48h inter-network float, the 0.5% withdrawal
 * excise, UNISS/ACH breaks and card-switch settlement. Complements (does not
 * duplicate) the Uganda mobile-money POC categories (mm_wallet_*): these are
 * the categories a LICENSED INSTITUTION's reconciliation desk runs on.
 *
 * Per the moat rubric: every category ships regulatory context, a resolution
 * procedure (seeded as an org template), an SLA, and an AI diagnosis hint.
 */
import type { ResolutionTemplateCategory } from "../../drizzle/schema";
import type { UgandaSourceKey } from "@shared/ugandaSources";

export interface UgandaChannelException {
  key: ResolutionTemplateCategory;
  label: string;
  severity: "critical" | "high" | "medium" | "low";
  slaHours: number;
  sources: UgandaSourceKey[] | "all";
  regulatoryContext: string;
  recommendedResolution: string;
  aiDiagnosisHint: string;
}

export const UGANDA_EXCEPTIONS: UgandaChannelException[] = [
  {
    key: "ug_trust_account_mismatch",
    label: "E-Money Trust Account Backing Mismatch",
    severity: "critical",
    slaHours: 24,
    sources: ["trust_account", "cbs_ledger", "mtn_momo", "airtel_money"],
    regulatoryContext:
      "BoU NPS Act 2020 and PSP licence conditions: outstanding e-money must be fully (1:1) backed by the trust/settlement account at the custodian bank. A backing shortfall is a licence-threatening breach reportable to BoU; a surplus signals unrecorded wallet liabilities or misposted funds.",
    recommendedResolution:
      "1) Compute total outstanding wallet liabilities as of cut-off. 2) Obtain the custodian trust-account statement balance for the same cut-off. 3) Reconcile the variance to in-transit items (interoperability settlements, pending reversals) with references. 4) Any unexplained shortfall: escalate to the accountable executive the same day and fund the trust account. 5) Document the daily backing check — examiners ask for the series, not one day.",
    aiDiagnosisHint:
      "Wallet liabilities vs trust balance: variance equal to a day's interop net = timing (verify next-day clearing); growing drift = unrecorded fees or leakage; a step change on one date = misposted lump — find the ledger entry on that date.",
  },
  {
    key: "ug_suspense_aged_entry",
    label: "Suspense Account Entry Aged / Irregular",
    severity: "critical",
    slaHours: 24,
    sources: "all",
    regulatoryContext:
      "The MTN Uganda internal-fraud case: absent settlement/reconciliation controls, insiders manipulated the suspense account for disputed/erroneous/incomplete transactions to mint e-money and embezzle funds. BoU examiners treat aged or reference-less suspense entries as fraud indicators, not housekeeping.",
    recommendedResolution:
      "1) Every suspense entry must carry the originating transaction reference and a reason code — flag any that don't immediately. 2) Age-track all entries; anything beyond 72h needs a named owner and resolution plan. 3) Match suspense debits/credits pairwise; unpaired entries are the fraud surface. 4) Reverse resolved items to their proper accounts with maker-checker. 5) Report the suspense aging profile weekly to the control function.",
    aiDiagnosisHint:
      "Prioritise: entries WITHOUT transaction references first (highest fraud probability), then unpaired entries, then aged pairs. Repeated same-amount entries just under approval thresholds = structuring pattern. Same user posting and clearing suspense = segregation-of-duties breach.",
  },
  {
    key: "ug_momo_debit_no_credit",
    label: "MoMo Wallet↔Bank Transfer Debited Without Credit",
    severity: "critical",
    slaHours: 24,
    sources: ["mtn_momo", "airtel_money", "cbs_ledger"],
    regulatoryContext:
      "BoU consumer-protection expectations under the NPS framework: failed wallet-to-bank / bank-to-wallet transfers must be reversed promptly. The highest-volume complaint class on Uganda's dominant payment rail.",
    recommendedResolution:
      "1) Locate the transaction on the MoMo statement by transaction_id. 2) Verify whether the counterpart leg (bank credit or wallet credit) exists. 3) If the transfer failed, reverse the debit same-day and notify the customer. 4) If value was given late, close with the settlement reference. 5) Track recurrence by service/menu — systematic failures are an integration defect, not ops workload.",
    aiDiagnosisHint:
      "Debit on one side, no matching credit within the 24–48h interop window: distinguish inter-network delay (credit arrives late — suppress if within window) from true failure (telco API timeout, invalid account). Cluster by hour — bursts indicate an outage window, singles indicate account-level issues.",
  },
  {
    key: "ug_reversal_not_credited",
    label: "Owed Reversal Not Credited to Customer",
    severity: "high",
    slaHours: 24,
    sources: "all",
    regulatoryContext:
      "A confirmed-failed transaction creates a reversal obligation; BoU consumer-protection guidelines and scheme rules time-bound it. Unfulfilled reversals are the direct complaint→examiner path.",
    recommendedResolution:
      "1) List confirmed-failed transactions with no matching reversal credit. 2) Execute the reversal on the owing rail with the original reference. 3) Notify the customer. 4) Feed the count into the monthly failed-transactions/consumer-complaints reporting. 5) Root-cause repeat offenders (channel, service, partner).",
    aiDiagnosisHint:
      "Join failed-transaction records to subsequent credits by original reference: missing = owed; partial amount = fee wrongly retained on reversal (reverse gross, not net, unless contract says otherwise).",
  },
  {
    key: "ug_agent_rail_settlement_variance",
    label: "ABC Agent Rail Settlement Variance",
    severity: "high",
    slaHours: 48,
    sources: ["abc_agent_rail", "cbs_ledger"],
    regulatoryContext:
      "Agent Banking Regulations 2017 require daily reconciliation of agent transactions; the ABC rail is SHARED across banks, so settlement-file errors propagate to every member — variances must be evidenced against the rail's daily file, not internal estimates.",
    recommendedResolution:
      "1) Reconcile the ABC daily settlement file against core postings line-by-line (agent_id + reference). 2) Classify variances: missing postings, amount differences, unknown agents. 3) Raise file-level discrepancies with ABC citing line references (other member banks likely see the same). 4) Post correcting entries with maker-checker. 5) Watch per-agent patterns for float abuse.",
    aiDiagnosisHint:
      "Whole-file variance = rail-side issue (compare row counts first); per-agent variance = local posting or agent behaviour. Same-amount recurring differences = fee/commission config drift between the rail and core.",
  },
  {
    key: "ug_agent_float_trapped",
    label: "Agent Float Trapped in Pending Settlement",
    severity: "high",
    slaHours: 24,
    sources: ["abc_agent_rail", "mtn_momo", "airtel_money"],
    regulatoryContext:
      "The #1 operational friction in Ugandan agency banking: cash-in/cash-out across MTN, Airtel and the ABC rail leaves agent float in 'pending' for 24–48h, starving agents of working capital and pushing them offline — a financial-inclusion and revenue problem BoU tracks through agent-activity statistics.",
    recommendedResolution:
      "1) Identify agent transactions pending beyond the rail's contracted settlement window. 2) Confirm rail-side status (settled/failed/queued) with the operator's report. 3) Release confirmed-settled amounts to the agent's float immediately. 4) Chase queued items with the rail operator daily. 5) Track trapped-float hours per agent as a service KPI — it predicts agent churn.",
    aiDiagnosisHint:
      "Pending beyond window: if the rail file shows settled but core hasn't released, it's an internal posting delay (fix ours); if the rail file lacks the item, it's inter-network queue (chase operator). Aggregate trapped value by rail to quantify the working-capital cost.",
  },
  {
    key: "ug_interop_transfer_lag",
    label: "Inter-Network Transfer Beyond Settlement Window",
    severity: "medium",
    slaHours: 72,
    sources: ["mtn_momo", "airtel_money", "abc_agent_rail"],
    regulatoryContext:
      "Cross-network transfers (MTN↔Airtel↔bank) settle in 24–48h by operating convention. Items inside the window are timing, not breaks — but they must auto-escalate the moment the window lapses, or the backlog silently becomes unreconciled exposure.",
    recommendedResolution:
      "1) No manual action inside the contracted window — let the next settlement cycle clear it. 2) On window expiry the item reclassifies automatically (failed transfer or settlement variance). 3) Never manually clear a timing item. 4) Report chronic lag by corridor (MTN→Airtel etc.) to the operators quarterly.",
    aiDiagnosisHint:
      "Unmatched cross-network item younger than the window: suppress and predict the clearing date. Older: reclassify and route to the failed/variance path. Corridor-level chronic lag = operator capacity issue, not per-transaction errors.",
  },
  {
    key: "ug_uniss_settlement_break",
    label: "UNISS (RTGS) Settlement Position Break",
    severity: "high",
    slaHours: 24,
    sources: ["uniss_rtgs", "cbs_ledger"],
    regulatoryContext:
      "The BoU settlement account is the institution's most scrutinised position; UNISS breaks affect the daily liquidity statement to BoU and are same-day escalation items.",
    recommendedResolution:
      "1) Reconcile UNISS statement entries against treasury/core postings by settlement reference. 2) For missing postings, verify the payment actually settled (BoU confirmation) before posting. 3) For unknown UNISS entries, confirm with the counterparty bank same-day. 4) Escalate any unresolved break to treasury before the next settlement window.",
    aiDiagnosisHint:
      "Reference-keyed matching is near-exact on RTGS; breaks are usually late postings (time-of-day analysis) or reference truncation (match on amount+counterparty+date as fallback). Never leave a UNISS break overnight without escalation.",
  },
  {
    key: "ug_ach_return_unprocessed",
    label: "Clearing Return Not Processed",
    severity: "high",
    slaHours: 48,
    sources: ["ach_eft", "cbs_ledger"],
    regulatoryContext:
      "EFT/cheque RETURNS reverse previously-applied credits. An unprocessed return means the institution has given value on a failed instrument — a silent double-credit that ages into write-off.",
    recommendedResolution:
      "1) Match every return item in the clearing file to a reversal posting by item_ref. 2) Post missing reversals same-day, with the return reason code. 3) If the customer has withdrawn against the returned credit, open recovery per policy. 4) Track return-processing latency as a control KPI.",
    aiDiagnosisHint:
      "Return items with no matching reversal within the batch's processing day. Group by return reason: unpaid-effects returns are routine; signature/fraud reasons need the fraud desk, not just a reversal.",
  },
  {
    key: "ug_excise_duty_variance",
    label: "Excise Duty (Withdrawal Levy) Variance",
    severity: "medium",
    slaHours: 72,
    sources: ["mtn_momo", "airtel_money", "abc_agent_rail", "cbs_ledger"],
    regulatoryContext:
      "Uganda levies a 0.5% excise duty on mobile-money withdrawals (plus excise on fees). Wrong rate or wrong base either overcharges customers (URA/consumer exposure) or under-remits (tax liability). The duty line must reconcile between rail statements, the ledger's duty payable account, and URA remittances.",
    recommendedResolution:
      "1) Recompute expected duty: 0.5% of withdrawal value (verify current rate) per rail per day. 2) Compare with duty collected per the rail statement and the ledger duty-payable account. 3) Investigate base errors (duty on deposits — not applicable — or on fees at the wrong rate). 4) Reconcile the payable account to URA remittances monthly. 5) Refund overcharges per consumer-protection expectations.",
    aiDiagnosisHint:
      "Variance proportional to withdrawal volume = rate misconfiguration; flat daily differences = a service class wrongly included/excluded from the duty base. Rate-change dates (national budget cycle, July) are the first thing to check.",
  },
  {
    key: "ug_card_switch_variance",
    label: "Card Switch Settlement Variance",
    severity: "high",
    slaHours: 48,
    sources: ["card_switch", "cbs_ledger"],
    regulatoryContext:
      "T+1 card-switch net settlement must equal gross less contracted interchange/fees; unexplained shortfalls compound daily across POS/ATM/e-commerce acquiring.",
    recommendedResolution:
      "1) Recompute expected net (gross − contracted fees) for the batch. 2) Compare with switch settlement received. 3) Raise variance with the switch citing RRN/STAN lists. 4) Track recovery through suspense with aging.",
    aiDiagnosisHint:
      "Batch-level fee recomputation first; then missing-transaction diff (terminal journal vs switch file). Chargeback offsets netted into the cycle are the most common 'unexplained' component.",
  },
  {
    key: "ug_wallet_liability_orphan",
    label: "Wallet Liability Without Rail Record",
    severity: "high",
    slaHours: 48,
    sources: ["cbs_ledger", "mtn_momo", "airtel_money", "trust_account"],
    regulatoryContext:
      "E-money liability recorded with no corresponding rail transaction is either a posting error or minted e-money — the exact mechanism of Uganda's largest mobile-money fraud. BoU examiners treat these as incident-report material, not reconciliation noise.",
    recommendedResolution:
      "1) Verify the liability entry's origin (user, channel, timestamp) in the audit trail. 2) Search all rail statements ±2 days for the counterpart. 3) If genuinely absent, treat as a potential integrity incident: freeze related balances pending review, notify the control function. 4) Reverse posting errors with maker-checker and evidence. 5) Review the posting user's other entries for the same pattern.",
    aiDiagnosisHint:
      "Liability entries with no rail counterpart: single occurrences near shift changes = fat-finger; repeated amounts by one user = fraud pattern (check segregation of duties); bursts after an integration deploy = software defect double-posting.",
  },

  // ─── Round 2: bill/utility, digital lending, aggregator, integrity ─────────
  {
    key: "ug_bill_payment_no_token",
    label: "Bill / Utility Debited Without Value (Yaka Token Not Issued)",
    severity: "critical",
    slaHours: 24,
    sources: ["bill_utility", "mtn_momo", "airtel_money", "aggregator_switch", "cbs_ledger"],
    regulatoryContext:
      "Yaka electricity-token failures are the single largest utility-payment complaint class in Uganda — network fluctuation between the rail and Umeme/UEDCL debits the customer without issuing a token. BoU consumer-protection expectations require prompt reversal or value delivery; a customer with no power and a debited account is the archetypal complaint.",
    recommendedResolution:
      "1) Locate the payment by payment_ref and confirm the biller/token status with the biller (Umeme/UEDCL/NWSC) or aggregator. 2) If a token was generated, re-deliver it to the customer (SMS/USSD). 3) If the biller was never credited, reverse the debit same-day. 4) If the biller was credited but no token issued, raise a biller-side dispute with the payment_ref. 5) Track the debited-without-token count per biller — spikes indicate a biller/aggregator integration outage, not customer error.",
    aiDiagnosisHint:
      "Rail debit with no biller confirmation / token: cluster by biller and by time — a burst on one biller = integration outage (chase the biller/aggregator, mass-reverse); scattered singles = per-transaction network drops (re-query token first, reverse if truly absent). Distinguish 'biller credited, token delivery failed' (re-deliver) from 'biller never credited' (reverse).",
  },
  {
    key: "ug_airtime_data_not_delivered",
    label: "Airtime / Data Purchase Debited Not Delivered",
    severity: "high",
    slaHours: 24,
    sources: ["bill_utility", "mtn_momo", "airtel_money", "aggregator_switch"],
    regulatoryContext:
      "Airtime/data top-ups debit the wallet/account instantly; non-delivery is a consumer-protection reversal obligation on the same rails as failed transfers.",
    recommendedResolution:
      "1) Confirm the top-up outcome in the telco/aggregator log by reference. 2) If not delivered, reverse the debit or re-deliver the airtime/data. 3) Notify the customer. 4) Feed recurring non-delivery by product into the failed-transactions return.",
    aiDiagnosisHint:
      "Debit with no matching successful top-up: self-top-ups vs third-party (gifting) — third-party failures often carry a wrong-MSISDN cause; verify the target number before reversing vs re-delivering.",
  },
  {
    key: "ug_digital_loan_disbursement_mismatch",
    label: "Nano-Loan Disbursed to Wallet Not Booked in Lending Ledger",
    severity: "critical",
    slaHours: 24,
    sources: ["digital_lending", "mtn_momo", "airtel_money", "cbs_ledger"],
    regulatoryContext:
      "MoKash (MTN/NCBA) and Wewole (Airtel/Jumo) disburse nano-loans to the customer wallet; the lender bank must book the corresponding loan asset. A wallet credit with no loan-ledger entry is unrecorded credit exposure (and the minting risk in reverse); a loan booked with no wallet credit means the customer never received funds but owes.",
    recommendedResolution:
      "1) Match each disbursement (loan_id) between the telco wallet-credit feed and the lender loan ledger. 2) Wallet credit without loan booking → book the loan asset and confirm CRB reporting. 3) Loan booked without wallet credit → confirm the customer received value; if not, reverse the loan and re-disburse. 4) Reconcile the daily disbursement control totals telco↔lender.",
    aiDiagnosisHint:
      "Join by loan_id: wallet-side present + ledger-side absent = unbooked asset (book it); ledger present + wallet absent = failed disbursement (reverse/re-send). Timing within the same day is normal; overnight gaps are true breaks.",
  },
  {
    key: "ug_digital_loan_repayment_unapplied",
    label: "Nano-Loan Repayment Collected Not Applied / CRB Not Updated",
    severity: "high",
    slaHours: 72,
    sources: ["digital_lending", "mtn_momo", "airtel_money", "cbs_ledger"],
    regulatoryContext:
      "MoKash repayments are collected from the wallet; NCBA must apply them and update the Credit Reference Bureau within 72h of clearance. Unapplied repayments keep a settled loan showing as outstanding — a customer-harm and CRB-accuracy breach.",
    recommendedResolution:
      "1) Match wallet-side repayment debits to loan-ledger repayment postings by loan_id. 2) Apply any collected-but-unposted repayments and recompute balances. 3) Trigger the CRB status update for cleared loans within the 72h window. 4) Where a customer was wrongly reported delinquent, file a CRB correction and notify the customer.",
    aiDiagnosisHint:
      "Wallet repayment present, ledger application absent: check whether the repayment cleared (not just initiated). Cleared-but-unapplied older than 72h risks a wrong CRB status — prioritise those for both application and CRB correction.",
  },
  {
    key: "ug_dormant_wallet_balance",
    label: "Dormant E-Money / Loan-Savings Balance Not Handled",
    severity: "medium",
    slaHours: 168,
    sources: ["digital_lending", "mtn_momo", "airtel_money", "trust_account"],
    regulatoryContext:
      "BoU and the lender's own policy (e.g. NCBA's MoKash dormant-accounts process) require dormant wallet/savings balances to be identified, flagged and handled per the dormancy schedule — not silently retained. Dormant balances must still reconcile to the trust-account backing.",
    recommendedResolution:
      "1) Identify wallet/savings balances with no activity beyond the dormancy threshold. 2) Apply the dormancy handling (customer notification, restricted status, escheatment schedule per policy/BoU). 3) Confirm dormant balances remain within the trust-account backing. 4) Maintain the dormant-account register for examination.",
    aiDiagnosisHint:
      "Balances with last-activity beyond threshold and not flagged dormant. Reconcile the dormant register total against the trust account — dormant funds not backed are a compliance and integrity flag.",
  },
  {
    key: "ug_duplicate_wallet_credit",
    label: "Duplicate Wallet Credit / Excess E-Money Created",
    severity: "critical",
    slaHours: 24,
    sources: ["mtn_momo", "airtel_money", "aggregator_switch", "trust_account", "cbs_ledger"],
    regulatoryContext:
      "A wallet credited twice for one funding event creates e-money not backed by the trust account — the exact excess-e-money mechanism behind Uganda's largest mobile-money fraud, and a direct trust-backing breach.",
    recommendedResolution:
      "1) Identify wallet credits sharing one funding reference (same bank credit / same rail event). 2) Confirm only one funding actually occurred. 3) Reverse the duplicate credit and restore the wallet-liability↔trust balance. 4) If already spent, open recovery; treat as an integrity incident and review the crediting user/process. 5) Verify ingestion idempotency held (the platform dedupes on externalRef; a true duplicate here is provider/posting-side).",
    aiDiagnosisHint:
      "Two wallet credits, one funding reference: same amount + same funding ref = duplicate (reverse one, expect trust-balance restoration); different funding refs = two real fundings. Bursts from one channel after a retry/deploy = systematic double-credit.",
  },
  {
    key: "ug_orphan_reversal",
    label: "Reversal Without Matching Original",
    severity: "high",
    slaHours: 48,
    sources: "all",
    regulatoryContext:
      "A reversal entry with no matching original debit either credits a customer/agent without cause or masks a fraudulent withdrawal — an integrity red flag BoU examiners treat as incident material, adjacent to the suspense-manipulation class.",
    recommendedResolution:
      "1) For each reversal, locate the original transaction it claims to reverse. 2) If none exists, freeze the credited balance and investigate the posting origin (user, timestamp). 3) Reverse the unjustified reversal with maker-checker. 4) Review the initiating user's other reversals for a pattern; escalate to the fraud desk if clustered.",
    aiDiagnosisHint:
      "Reversal with no original: same user posting original-less reversals repeatedly = fraud pattern (segregation-of-duties check); isolated = mispost. Round amounts and end-of-day timing raise the fraud probability.",
  },
  {
    key: "ug_aggregator_settlement_variance",
    label: "Aggregator / Switch Settlement Variance",
    severity: "high",
    slaHours: 48,
    sources: ["aggregator_switch", "cbs_ledger"],
    regulatoryContext:
      "PayWay/EzeeMoney/MCash switch high daily volumes and settle net of commission; their settlement file vs the bank position is a heavy daily reconciliation burden, and net-of-commission settlement makes commission-config drift the common silent variance.",
    recommendedResolution:
      "1) Reconcile the aggregator settlement file against bank postings by switch_ref. 2) Recompute expected net (gross − contracted commission) and compare with the settled amount. 3) Raise file-level or commission-rate variances with the aggregator citing references. 4) Track recovery through suspense with aging.",
    aiDiagnosisHint:
      "Whole-file variance = aggregator-side (compare counts first); per-transaction = local posting. Variance proportional to volume = commission-rate drift; fixed = a flat-fee misapplication.",
  },
  {
    key: "ug_agent_commission_variance",
    label: "Agent Commission Calculation Variance",
    severity: "medium",
    slaHours: 120,
    sources: ["abc_agent_rail", "mtn_momo", "airtel_money"],
    regulatoryContext:
      "Agents earn tiered commission on cash-in/cash-out; wrong tiers or rates over- or under-pay agents, distinct from float mismatches. Systematic errors erode the agent network BoU tracks for financial inclusion.",
    recommendedResolution:
      "1) Recompute expected commission per agent per the tier/rate card for the period. 2) Compare with commission credited on the rail/agent statement. 3) Correct rate-card misconfigurations and post adjustments. 4) Cluster variances by tier to find the misconfigured band.",
    aiDiagnosisHint:
      "Commission ÷ transaction value implies the applied rate — compare to the rate card rather than absolute amounts. Single-tier drift = one band misconfigured; uniform drift from a date = rate-card change not applied.",
  },
  {
    key: "ug_fx_settlement_variance",
    label: "Multi-Currency (FX) Settlement Variance",
    severity: "high",
    slaHours: 48,
    sources: ["cbs_ledger", "uniss_rtgs", "card_switch", "aggregator_switch"],
    regulatoryContext:
      "Ugandan institutions hold USD (and other) accounts alongside UGX; cross-currency settlements (card scheme USD settlement, remittance inflows, multi-currency wallets) must convert at the agreed rate. Wrong rate or wrong date is either customer harm or income leakage, and BoU FX-position reporting depends on correct conversion.",
    recommendedResolution:
      "1) Identify the transaction's original currency and the settlement currency. 2) Determine the expected rate (BoU/interbank rate on the settlement date + agreed margin). 3) Recompute expected settlement and compare with actual. 4) Dispute out-of-band rates with the counterparty; correct wrong-date conversions. 5) Reconcile the FX position daily for BoU reporting.",
    aiDiagnosisHint:
      "Settlement in base currency ≠ expected at the contracted rate: check rate date first (auth-date vs settlement-date), then margin, then double-conversion via an intermediary currency. Proportional variance = rate/margin; fixed = a mis-booked leg.",
  },
];

export const UGANDA_EXCEPTION_KEYS = UGANDA_EXCEPTIONS.map((e) => e.key);

export function ugandaExceptionFor(key: string): UgandaChannelException | null {
  return UGANDA_EXCEPTIONS.find((e) => e.key === key) ?? null;
}

/** AI prompt block for the Super Agent on Uganda-market organizations. */
export function ugandaExceptionsTaxonomyPromptBlock(): string {
  return UGANDA_EXCEPTIONS.map(
    (e) => `- ${e.key} (${e.severity}, SLA ${e.slaHours}h): ${e.label}. ${e.aiDiagnosisHint}`,
  ).join("\n");
}

/**
 * Seed the Uganda taxonomy as org-scoped resolution templates (idempotent).
 * Lazy DB imports keep this module pure for client/test use.
 */
export async function seedUgandaResolutionTemplates(
  organizationId: number,
): Promise<{ inserted: number; existing: number }> {
  const { and, eq } = await import("drizzle-orm");
  const { resolutionTemplates } = await import("../../drizzle/schema");
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  let inserted = 0;
  let existing = 0;
  for (const cat of UGANDA_EXCEPTIONS) {
    const [already] = await db
      .select({ id: resolutionTemplates.id })
      .from(resolutionTemplates)
      .where(and(
        eq(resolutionTemplates.organizationId, organizationId),
        eq(resolutionTemplates.category, cat.key),
      ))
      .limit(1);
    if (already) {
      existing++;
      continue;
    }
    await db.insert(resolutionTemplates).values({
      name: cat.label,
      category: cat.key,
      templateText:
        `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
        `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
      isDefault: true,
      createdBy: 0,
      organizationId,
      dedupeKey: null,
    });
    inserted++;
  }
  return { inserted, existing };
}

/** Seed as GLOBAL defaults on boot (idempotent, race-proof via dedupeKey). */
export async function seedUgandaExceptionGlobalDefaults(): Promise<{ inserted: number }> {
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const { resolutionTemplates } = await import("../../drizzle/schema");
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return { inserted: 0 };

  const existing = await db
    .select({ category: resolutionTemplates.category, name: resolutionTemplates.name })
    .from(resolutionTemplates)
    .where(and(isNull(resolutionTemplates.organizationId), eq(resolutionTemplates.isDefault, true)));
  const existingKeys = new Set(existing.map((r) => `${r.category}::${r.name}`));

  const toInsert = UGANDA_EXCEPTIONS.filter((cat) => !existingKeys.has(`${cat.key}::${cat.label}`));
  if (toInsert.length === 0) return { inserted: 0 };

  await db
    .insert(resolutionTemplates)
    .values(
      toInsert.map((cat) => ({
        name: cat.label,
        category: cat.key,
        templateText:
          `${cat.recommendedResolution}\n\nRegulatory context: ${cat.regulatoryContext}\n` +
          `Severity: ${cat.severity.toUpperCase()} · SLA: ${cat.slaHours}h`,
        isDefault: true,
        createdBy: 0,
        organizationId: null,
        dedupeKey: `default:${cat.key}:${cat.label}`,
      })),
    )
    .onDuplicateKeyUpdate({ set: { dedupeKey: sql`dedupe_key` } });

  return { inserted: toInsert.length };
}
