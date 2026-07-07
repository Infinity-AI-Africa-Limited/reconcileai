/**
 * Seed global default resolution templates (organizationId = null, isDefault =
 * true) so every exception category has useful starters out of the box.
 *
 * Idempotent and self-healing: it runs on every boot, but only inserts the
 * defaults that are missing (keyed on category + name). Deleting or editing a
 * default won't resurrect/clobber it within a run — only genuinely absent ones
 * are (re)added on the next start. createdBy = 0 is a system sentinel; the column
 * has no FK and template edit/delete key off id, so this is safe.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { resolutionTemplates, type ResolutionTemplateCategory } from "../drizzle/schema";

type ExceptionCategory = ResolutionTemplateCategory;

const SYSTEM_CREATED_BY = 0;

const DEFAULT_TEMPLATES: Array<{ category: ExceptionCategory; name: string; templateText: string }> = [
  // ── Unmatched ──────────────────────────────────────────────────────────────
  {
    category: "unmatched",
    name: "Match manually with reference",
    templateText:
      "Confirmed the transaction exists in the counterparty system. Matched manually on reference and amount — no financial variance.",
  },
  {
    category: "unmatched",
    name: "Awaiting next settlement cycle",
    templateText:
      "Transaction is valid but not yet settled by the counterparty. Re-checked after the next settlement window; it will auto-match once posted.",
  },
  {
    category: "unmatched",
    name: "Escalate to originating channel",
    templateText:
      "No corresponding entry found in the counterparty system. Escalated to the originating channel / payment processor for investigation.",
  },

  // ── Missing counterparty ─────────────────────────────────────────────────────
  {
    category: "missing_counterparty",
    name: "Confirm identity in registry",
    templateText:
      "Confirmed the counterparty in the Distributor/Customer Registry. Added a name alias to prevent recurrence, then matched on reference.",
  },
  {
    category: "missing_counterparty",
    name: "Match on reference (name abbreviated)",
    templateText:
      "Counterparty name was abbreviated or formatted differently. Verified identity via transaction reference and amount, then matched.",
  },

  // ── Amount mismatch ──────────────────────────────────────────────────────────
  {
    category: "amount_mismatch",
    name: "Variance is a fee or charge",
    templateText:
      "Variance is a bank charge/commission. Posted the difference to the appropriate charges GL account and matched on the gross amount.",
  },
  {
    category: "amount_mismatch",
    name: "Reconcile gross vs net",
    templateText:
      "Difference is gross vs net. Reconciled to the gross figure and recorded the deductions (commission, tax, charges) separately.",
  },
  {
    category: "amount_mismatch",
    name: "Within tolerance — approve",
    templateText:
      "Variance is within the agreed tolerance (rounding / minor charge). Auto-approved and documented the reason.",
  },

  // ── Timing difference ────────────────────────────────────────────────────────
  {
    category: "timing_difference",
    name: "Clears next settlement window",
    templateText:
      "Posting-date difference only. Confirmed the transaction clears in the next settlement window. Approved with a late-settlement note.",
  },
  {
    category: "timing_difference",
    name: "Match on value date",
    templateText:
      "Aligned the two entries on value date rather than posting date and re-matched. No financial variance.",
  },

  // ── Duplicate transaction ────────────────────────────────────────────────────
  {
    category: "duplicate_transaction",
    name: "Reverse the duplicate",
    templateText:
      "Confirmed a genuine duplicate repost. Reversed the duplicate entry and retained the original. Recorded the reversal reference.",
  },
  {
    category: "duplicate_transaction",
    name: "Legitimate same-amount entry",
    templateText:
      "Verified two distinct transactions of the same amount on the same day (e.g. separate invoices). Not a duplicate; matched both individually.",
  },

  // ── Reversal unmatched ───────────────────────────────────────────────────────
  {
    category: "reversal_unmatched",
    name: "Link to original transaction",
    templateText:
      "Located the original transaction the reversal offsets and linked them. Where the original fell in a prior period, noted the cross-period match.",
  },
  {
    category: "reversal_unmatched",
    name: "Post missing offsetting entry",
    templateText:
      "Reversal posted in one system only. Confirmed authorization and posted the offsetting entry in the other system to balance.",
  },

  // ── Currency mismatch ────────────────────────────────────────────────────────
  {
    category: "currency_mismatch",
    name: "Apply FX rate for value date",
    templateText:
      "Applied the agreed FX rate for the value date and re-matched on the converted amount. Posted the FX difference to the revaluation account.",
  },
  {
    category: "currency_mismatch",
    name: "Re-match on booking currency",
    templateText:
      "Confirmed the correct booking currency (base vs transaction). Re-matched on the converted amount — no underlying variance.",
  },

  // ── FX rate variance (WS-6) ──────────────────────────────────────────────────
  {
    category: "fx_rate_variance",
    name: "Rate movement — post to FX revaluation GL",
    templateText:
      "Verified the implied rate against the settlement-date rate (CBN/NAFEM for NGN legs; deal-slip rate for correspondent settlements): the variance is legitimate rate movement between transaction date and settlement date. Posted the difference to the FX revaluation GL and matched on the converted amount. Recorded both dates' rates.",
  },
  {
    category: "fx_rate_variance",
    name: "Conversion error — dispute with counterparty",
    templateText:
      "The implied rate matches neither the transaction-date nor the settlement-date rate from the governing source. Raised a conversion dispute with the counterparty/processor citing both reference rates, and parked the variance in the FX suspense GL pending their response.",
  },

  // ── Format error ─────────────────────────────────────────────────────────────
  {
    category: "format_error",
    name: "Normalize and re-import",
    templateText:
      "Normalized the reference/date format and re-imported the affected rows. Confirmed the corrected values against the source statement.",
  },
  {
    category: "format_error",
    name: "Re-export in expected format",
    templateText:
      "Upload had truncated or shifted columns. Re-exported from the source in the expected format and re-ran the reconciliation.",
  },

  // ═══ Mobile Money — Nigeria (CBN / NIBSS) ═══════════════════════════════════
  {
    category: "mm_failed_ussd_debit",
    name: "Reverse failed USSD debit (T+1)",
    templateText:
      "Confirmed the USSD debit in the session log with no corresponding institution credit. Initiated reversal to the customer's account within T+1 business day per CBN Mobile Money Framework 2021 §4.3, logged in CBS, and notified the customer.",
  },
  {
    category: "mm_failed_ussd_debit",
    name: "Reversal already processed — timing",
    templateText:
      "Operator had already auto-reversed the failed debit; the credit posted after the reconciliation cut-off. Matched the reversal to the original debit and closed with a timing note — no customer impact.",
  },
  {
    category: "mm_reversal_not_credited",
    name: "Post reversal credit from suspense",
    templateText:
      "Confirmed the reversal reference in the operator's portal. Posted the reversal credit to the customer's account against the operator settlement suspense GL and recorded the operator reference.",
  },
  {
    category: "mm_nip_settlement_shortfall",
    name: "Attribute shortfall to NIBSS fees",
    templateText:
      "Reconciled the shortfall line-by-line against the NIBSS settlement advice: entire variance attributable to NIP fees and failed-transaction netting. Posted fees to the NIP charges GL; no residual variance.",
  },
  {
    category: "mm_duplicate_credit",
    name: "Freeze and reverse duplicate credit",
    templateText:
      "Verified in the operator portal that only one settlement was made for the session ID. Froze the second credit, reversed it, notified the customer, and logged the root cause (duplicate file upload / CBS repost) for control review.",
  },
  {
    category: "mm_expired_session_debit",
    name: "Provisional credit pending auto-reversal",
    templateText:
      "Confirmed session timeout in the USSD log. Posted a provisional credit to the customer while awaiting the operator's auto-reversal; escalated to the operator when the reversal exceeded T+1 per CBN Mobile Money Framework 2021 §4.3.1.",
  },
  {
    category: "mm_amount_mismatch",
    name: "Difference is operator fee deduction",
    templateText:
      "Compared the settlement amount to the CBS posting: the difference equals the operator's contracted fee. Posted the fee to the operator charges GL and matched on the gross amount.",
  },
  {
    category: "mm_unmatched_nip_inflow",
    name: "Post to NIP suspense, then beneficiary",
    templateText:
      "No CBS posting found for the NIP session ID. Posted the credit to the NIP suspense account, identified the beneficiary from the NIBSS transaction detail, and posted to the customer within T+2 per NIP Operating Rules §9.",
  },
  {
    category: "mm_operator_fee_variance",
    name: "Dispute fee above contracted rate",
    templateText:
      "Deducted fee exceeds the contracted schedule. Raised a formal dispute with the operator, posted the variance to the fee dispute suspense GL, and diarised follow-up pending the operator's response.",
  },

  // ═══ Mobile Money — Uganda (Bank of Uganda NPS framework) ═══════════════════
  {
    category: "mm_wallet_to_bank_failed",
    name: "Credit customer from settlement suspense",
    templateText:
      "Verified the transaction ID in the operator's merchant portal: wallet debited, no bank credit posted. Credited the customer's account from the operator settlement suspense GL and logged the resolution for the BoU consumer-protection audit trail.",
  },
  {
    category: "mm_wallet_to_bank_failed",
    name: "Operator auto-refunded wallet — close",
    templateText:
      "Operator marked the transfer failed and auto-refunded the customer's wallet. Confirmed the refund in the operator statement; closed with no ledger action required.",
  },
  {
    category: "mm_bank_to_wallet_failed",
    name: "Reverse ledger debit (failed push)",
    templateText:
      "Operator has no record of the bank-to-wallet push. Reversed the ledger debit to the customer's account within T+1 and recorded the outcome per the Uganda NPS Act 2020 error-resolution requirements.",
  },
  {
    category: "mm_withdrawal_tax_variance",
    name: "Post 0.5% levy to tax GL",
    templateText:
      "Confirmed the variance equals 0.5% of the gross withdrawal amount — Uganda's mobile money excise duty, remitted by the operator. Posted to the mobile money tax GL and verified against the operator's tax remittance statement. Statutory deduction; no dispute.",
  },
  {
    category: "mm_momo_settlement_shortfall",
    name: "Itemise fees, levy, and netted reversals",
    templateText:
      "Itemised the shortfall against the operator's settlement advice: operator fees, 0.5% withdrawal levy, and netted failed transactions fully attribute the variance. Posted each to its GL and updated the daily trust-account reconciliation record per BoU E-Money Regulations 2021.",
  },
];

/** Stable dedupe key for a global default (matches the unique index column). */
const dedupeKeyFor = (category: ExceptionCategory, name: string) => `default:${category}:${name}`;

/**
 * Reconcile the global default templates: insert any that are missing and
 * backfill the dedupe_key on any already-seeded rows that predate the column.
 * Returns how many were inserted. Never throws to the caller's critical path —
 * callers should still guard.
 *
 * Race-proof: inserts carry a unique dedupe_key, so two instances seeding at once
 * (e.g. overlapping rolling deploy) can't create duplicates — the second insert
 * is absorbed by ON DUPLICATE KEY as a no-op rather than throwing.
 */
export async function seedDefaultResolutionTemplates(): Promise<{ inserted: number }> {
  const db = await getDb();
  if (!db) return { inserted: 0 };

  const existing = await db
    .select({
      id: resolutionTemplates.id,
      category: resolutionTemplates.category,
      name: resolutionTemplates.name,
      dedupeKey: resolutionTemplates.dedupeKey,
    })
    .from(resolutionTemplates)
    .where(and(isNull(resolutionTemplates.organizationId), eq(resolutionTemplates.isDefault, true)));

  // Last-wins map: if a pre-existing race left duplicate rows for the same key,
  // only one is referenced here, so backfill assigns each unique key to one row.
  const byKey = new Map(existing.map((r) => [`${r.category}::${r.name}`, r]));

  const toInsert: typeof DEFAULT_TEMPLATES = [];
  const toBackfill: Array<{ id: number; dedupeKey: string }> = [];
  for (const t of DEFAULT_TEMPLATES) {
    const row = byKey.get(`${t.category}::${t.name}`);
    if (!row) toInsert.push(t);
    else if (row.dedupeKey == null) toBackfill.push({ id: row.id, dedupeKey: dedupeKeyFor(t.category, t.name) });
  }

  // Backfill rows seeded before the dedupe_key column existed (each key distinct →
  // no unique-index conflict). Runs once; later boots find the key already set.
  for (const b of toBackfill) {
    await db.update(resolutionTemplates).set({ dedupeKey: b.dedupeKey }).where(eq(resolutionTemplates.id, b.id));
  }

  if (toInsert.length === 0) return { inserted: 0 };

  await db
    .insert(resolutionTemplates)
    .values(
      toInsert.map((t) => ({
        name: t.name,
        category: t.category,
        templateText: t.templateText,
        isDefault: true,
        createdBy: SYSTEM_CREATED_BY,
        organizationId: null,
        dedupeKey: dedupeKeyFor(t.category, t.name),
      })),
    )
    .onDuplicateKeyUpdate({ set: { dedupeKey: sql`dedupe_key` } });
  return { inserted: toInsert.length };
}
