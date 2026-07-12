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
