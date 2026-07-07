/**
 * LAPO-specific exception taxonomy (deliverable 4).
 *
 * Per the intelligence-moat rubric, a new integration never ships
 * matching-only: every LAPO exception category carries its regulatory
 * context (CBN/NIBSS rules that make it urgent), a recommended resolution
 * (seeded as an org resolution template the learning flywheel builds on),
 * an SLA, and an AI diagnosis hint injected into Super-Agent prompts.
 */
import { and, eq } from "drizzle-orm";
import { resolutionTemplates, type ResolutionTemplateCategory } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { LapoSourceKey } from "@shared/lapoSources";

export interface LapoExceptionCategory {
  /** Also a resolution_templates.category enum value (lapo_* family). */
  key: ResolutionTemplateCategory;
  label: string;
  severity: "critical" | "high" | "medium" | "low";
  /** Hours before breach per CBN consumer-protection/settlement rules. */
  slaHours: number;
  sources: LapoSourceKey[] | "all";
  regulatoryContext: string;
  recommendedResolution: string;
  aiDiagnosisHint: string;
}

export const LAPO_EXCEPTION_CATEGORIES: LapoExceptionCategory[] = [
  {
    key: "lapo_ussd_debit_no_value",
    label: "USSD debit without value",
    severity: "critical",
    slaHours: 24,
    sources: ["ussd", "cbs_ledger"],
    regulatoryContext:
      "CBN Consumer Protection Regulations + NIBSS NIP rules: failed digital transactions must be auto-reversed within 24 hours. The highest-volume complaint class for MFB USSD channels.",
    recommendedResolution:
      "1) Confirm session outcome in the USSD gateway log (session_id). 2) If no value was given, raise same-day reversal on the CBS ledger. 3) Notify the customer via SMS. 4) Log in the complaints register with the session_id as evidence.",
    aiDiagnosisHint:
      "Ledger debit whose session_id has no matching successful USSD completion — check for gateway timeout markers; distinguish telco session drop from switch decline.",
  },
  {
    key: "lapo_nip_inward_not_credited",
    label: "NIP inward not credited to customer",
    severity: "critical",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "NIBSS NIP operating rules: beneficiary bank must apply inward value in near-real-time; unapplied inward NIP attracts CBN sanctions and refund-with-interest obligations.",
    recommendedResolution:
      "1) Locate the NIP session_id in the settlement report. 2) Verify the CBS credit leg exists; if missing, post credit to the customer account. 3) If account is invalid, initiate return via NIBSS within the return window. 4) Evidence both legs in the exception record.",
    aiDiagnosisHint:
      "Session present in NIBSS file, absent in CBS ledger credits — commonest causes: account-number transposition, dormant/PND account block, posting-queue failure.",
  },
  {
    key: "lapo_nip_outward_debit_unsettled",
    label: "NIP outward debited but unsettled",
    severity: "critical",
    slaHours: 24,
    sources: ["nibss_nip", "cbs_ledger"],
    regulatoryContext:
      "CBN/NIBSS: failed outward NIP must auto-reverse by T+1. Customer debited + no beneficiary credit = direct CBN sanction exposure.",
    recommendedResolution:
      "1) Check NIBSS response code for the session. 2) If failed/timeout, reverse the CBS debit immediately. 3) If settled per NIBSS but disputed, raise NIBSS dispute with session evidence. 4) SMS the customer on resolution.",
    aiDiagnosisHint:
      "CBS debit with no NIBSS session or a non-00 response — separate switch timeouts (auto-reversible) from beneficiary-bank delays (dispute path).",
  },
  {
    key: "lapo_card_settlement_short",
    label: "Card settlement short-pay (processor)",
    severity: "high",
    slaHours: 72,
    sources: ["cards_interswitch", "cards_upsl", "cards_etranzact"],
    regulatoryContext:
      "Processor agreements: T+1 net settlement must equal gross less contracted interchange/scheme fees. Unexplained shortfalls compound silently across daily cycles.",
    recommendedResolution:
      "1) Recompute expected net (gross − contracted fees) for the batch. 2) Compare against processor net settlement. 3) Raise a settlement query with the processor citing RRN/STAN list. 4) Track recovery to the suspense account.",
    aiDiagnosisHint:
      "Batch-level: sum(gross) − sum(fees) ≠ net paid. Check for new fee lines, chargeback offsets netted into the cycle, or missing transactions vs the terminal journal.",
  },
  {
    key: "lapo_agent_float_mismatch",
    label: "Agent float / position mismatch",
    severity: "high",
    slaHours: 48,
    sources: ["agent_banking", "cbs_ledger"],
    regulatoryContext:
      "CBN agent-banking guidelines require daily agent reconciliation; unreconciled agent positions are examiner red flags and fraud precursors.",
    recommendedResolution:
      "1) Rebuild the agent's day: opening float + cash-in − cash-out vs closing position. 2) Identify the divergent transaction(s) by receipt_no. 3) Debit/credit the agent settlement account accordingly. 4) Repeated mismatch → flag agent for review.",
    aiDiagnosisHint:
      "Compare per-agent daily aggregates between the agent file and ledger; single-transaction gaps are posting misses, proportional gaps are fee-config drift, round-number gaps suggest cash handling.",
  },
  {
    key: "lapo_ledger_orphan",
    label: "Ledger entry with no channel record",
    severity: "high",
    slaHours: 72,
    sources: "all",
    regulatoryContext:
      "CBN examination staple: ledger entries no channel can explain age into the unreconciled-items schedule and attract provisioning per the Prudential Guidelines.",
    recommendedResolution:
      "1) Identify the originating branch/teller from the ledger narration. 2) Request source evidence. 3) Reclassify to the correct channel or reverse to suspense. 4) Anything older than 30 days escalates to the CFO with the aging report.",
    aiDiagnosisHint:
      "Ledger row with no counterpart in any of the 7 channel feeds — check narration keywords for manual/branch postings before assuming data loss.",
  },
  {
    key: "lapo_channel_orphan",
    label: "Channel record with no ledger entry",
    severity: "high",
    slaHours: 48,
    sources: "all",
    regulatoryContext:
      "A channel transaction that never hit the ledger is either lost revenue, an unposted liability, or the parallel-run's data-loss signal — the exact class the 30-day run must drive to zero.",
    recommendedResolution:
      "1) Confirm the channel record is final (not a reversal pair). 2) Check posting queues/EOD job logs for the gap window. 3) Post the missing ledger leg with maker-checker. 4) If systematic (many in one window), open an incident.",
    aiDiagnosisHint:
      "Cluster by timestamp: many channel-orphans in one window = EOD/posting outage; scattered singles = per-transaction posting rejections (check account status).",
  },
  {
    key: "lapo_cross_channel_duplicate",
    label: "Duplicate posting across channels",
    severity: "medium",
    slaHours: 72,
    sources: "all",
    regulatoryContext:
      "Double debits are a leading CBN complaint category; double credits are recoverable-asset leakage.",
    recommendedResolution:
      "1) Confirm both postings reference the same underlying event (same identity fields, ±timing window). 2) Reverse the later posting. 3) If customer-visible, notify per consumer-protection timelines.",
    aiDiagnosisHint:
      "Same amount + counterparty + near-identical timestamps across two channels (e.g. USSD retry that also completed in mobile app) — verify identity fields before calling it a duplicate; NIP retries share name_enquiry_ref.",
  },
  {
    key: "lapo_settlement_timing_lag",
    label: "In settlement window (expected timing lag)",
    severity: "low",
    slaHours: 72,
    sources: ["cards_interswitch", "cards_upsl", "cards_etranzact", "agent_banking"],
    regulatoryContext:
      "T+1/T+2 processor settlement is contractual, not an exception — but items must auto-escalate the moment they exceed the contracted lag (then they become real breaks).",
    recommendedResolution:
      "1) No action inside the source's settlementLagDays window. 2) On expiry the item auto-reclassifies (short-pay or orphan). 3) Never manually clear a timing item — let the next settlement file do it.",
    aiDiagnosisHint:
      "Unmatched card/agent item younger than the channel's settlementLagDays: suppress noise, predict the expected settlement file date instead of recommending action.",
  },
  {
    key: "lapo_fee_commission_variance",
    label: "Fee / commission variance",
    severity: "medium",
    slaHours: 120,
    sources: ["cards_interswitch", "cards_upsl", "cards_etranzact", "agent_banking", "nibss_nip"],
    regulatoryContext:
      "CBN Guide to Charges caps many channel fees; over-charging is a sanctionable consumer-protection breach, under-collection is income leakage.",
    recommendedResolution:
      "1) Recompute expected fee from the contracted/CBN-capped schedule. 2) Quantify the variance across the cycle. 3) Processor variance → settlement query; internal misconfig → fix the fee table and backfill adjustments.",
    aiDiagnosisHint:
      "Variance proportional to volume = fee-table drift; fixed-size = flat-fee misapplication; check effective-date of the latest CBN Guide to Charges revision.",
  },
];

/** Category keys (for engine/classifier wiring). */
export const LAPO_EXCEPTION_KEYS = LAPO_EXCEPTION_CATEGORIES.map((c) => c.key);

export function lapoCategoryFor(key: string): LapoExceptionCategory | null {
  return LAPO_EXCEPTION_CATEGORIES.find((c) => c.key === key) ?? null;
}

/**
 * AI prompt block for the Super Agent when diagnosing exceptions for a
 * LAPO-integrated org — the taxonomy is the moat, so feed it to the model.
 */
export function lapoTaxonomyPromptBlock(): string {
  return LAPO_EXCEPTION_CATEGORIES.map(
    (c) =>
      `- ${c.key} (${c.severity}, SLA ${c.slaHours}h): ${c.label}. ${c.aiDiagnosisHint}`,
  ).join("\n");
}

/**
 * Seed the LAPO taxonomy as org-scoped resolution templates (idempotent).
 * Called at LAPO provisioning; safe to re-run.
 */
export async function seedLapoResolutionTemplates(
  organizationId: number,
): Promise<{ inserted: number; existing: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  let inserted = 0;
  let existing = 0;
  for (const cat of LAPO_EXCEPTION_CATEGORIES) {
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
      createdBy: 0, // system
      organizationId,
      dedupeKey: null,
    });
    inserted++;
  }
  return { inserted, existing };
}
