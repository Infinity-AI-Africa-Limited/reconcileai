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
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { resolutionTemplates } from "../drizzle/schema";

type ExceptionCategory =
  | "unmatched"
  | "missing_counterparty"
  | "amount_mismatch"
  | "timing_difference"
  | "duplicate_transaction"
  | "reversal_unmatched"
  | "currency_mismatch"
  | "format_error";

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
];

/**
 * Insert any missing global default templates. Returns how many were added.
 * Never throws to the caller's critical path — callers should still guard.
 */
export async function seedDefaultResolutionTemplates(): Promise<{ inserted: number }> {
  const db = await getDb();
  if (!db) return { inserted: 0 };

  const existing = await db
    .select({ category: resolutionTemplates.category, name: resolutionTemplates.name })
    .from(resolutionTemplates)
    .where(and(isNull(resolutionTemplates.organizationId), eq(resolutionTemplates.isDefault, true)));

  const have = new Set(existing.map((r) => `${r.category}::${r.name}`));
  const toInsert = DEFAULT_TEMPLATES.filter((t) => !have.has(`${t.category}::${t.name}`));
  if (toInsert.length === 0) return { inserted: 0 };

  await db.insert(resolutionTemplates).values(
    toInsert.map((t) => ({
      name: t.name,
      category: t.category,
      templateText: t.templateText,
      isDefault: true,
      createdBy: SYSTEM_CREATED_BY,
      organizationId: null,
    })),
  );
  return { inserted: toInsert.length };
}
