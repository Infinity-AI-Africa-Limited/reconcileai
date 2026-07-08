/**
 * ERP journal-entry export engine (gap-closure plan WS-7, Gap 8).
 *
 * Export-first, native-later: transforms a completed reconciliation job's
 * RESOLVED exceptions into balanced journal entries and renders them in the
 * native import format of each target ERP:
 *
 *   sap_b1     — SAP Business One Data Transfer Workbench (DTW): the OJDT
 *                (JournalEntries) + JDT1 (JournalEntryLines) CSV pair
 *   sage_300   — Sage 300 G/L Journal Entry import CSV (signed amounts)
 *   quickbooks — QuickBooks Online journal-entry import CSV (Debits/Credits)
 *
 * What gets exported: each RESOLVED exception becomes one balanced entry —
 * debit to the category-mapped adjustment account, credit to the
 * reconciliation control account (per DEFAULT_GL_MAPPING). Dismissed
 * exceptions post nothing (dismissal = no book impact). Account codes are
 * PLACEHOLDERS the institution remaps during ERP import or via the mapping
 * override — documented in docs/ERP_EXPORT_FORMATS.md.
 *
 * Formatters are pure functions over the canonical model (unit-tested with
 * exact column layouts). The native API push phase (SAP PartnerEdge / Sage
 * Developer Programme) builds on the same canonical model.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { reconciliationJobs, exceptions as exceptionsTable, transactions } from "../drizzle/schema";

// ─── Targets ──────────────────────────────────────────────────────────────────

export const ERP_TARGETS = ["sap_b1", "sage_300", "quickbooks"] as const;
export type ErpTarget = (typeof ERP_TARGETS)[number];

export const ERP_LABELS: Record<ErpTarget, string> = {
  sap_b1: "SAP Business One (DTW)",
  sage_300: "Sage 300 (G/L Journal Import)",
  quickbooks: "QuickBooks Online (Journal Entry CSV)",
};

// ─── Canonical journal model ──────────────────────────────────────────────────

export interface JournalLine {
  account: string;
  debit: number;  // exactly one of debit/credit is non-zero
  credit: number;
  memo: string;
}

export interface JournalEntry {
  /** 1-based sequence within the export. */
  entryNo: number;
  date: string; // YYYY-MM-DD
  currency: string;
  reference: string;
  memo: string;
  lines: JournalLine[];
}

/**
 * Category → account mapping. Placeholder codes by design: institutions remap
 * them to their own chart of accounts during ERP import (or a future org-level
 * mapping table). `debitAccount` receives the exception amount; the balancing
 * credit goes to the reconciliation control account.
 */
export interface GlMapping {
  debitAccount: string;
  memo: string;
}

export const RECON_CONTROL_ACCOUNT = "1890-RECON-CONTROL";

export const DEFAULT_GL_MAPPING: Record<string, GlMapping> = {
  amount_mismatch:      { debitAccount: "6910-BANK-CHARGES",   memo: "Reconciliation amount variance (fees/charges)" },
  fx_rate_variance:     { debitAccount: "7150-FX-REVALUATION", memo: "FX rate variance (transaction vs settlement date)" },
  currency_mismatch:    { debitAccount: "7150-FX-REVALUATION", memo: "Currency booking correction" },
  duplicate_transaction:{ debitAccount: "1895-RECON-SUSPENSE", memo: "Duplicate transaction reversal" },
  timing_difference:    { debitAccount: "1895-RECON-SUSPENSE", memo: "Timing difference carried" },
  reversal_unmatched:   { debitAccount: "1895-RECON-SUSPENSE", memo: "Unmatched reversal adjustment" },
  missing_counterparty: { debitAccount: "1895-RECON-SUSPENSE", memo: "Missing counterparty adjustment" },
  unmatched:            { debitAccount: "1895-RECON-SUSPENSE", memo: "Unmatched item adjustment" },
  format_error:         { debitAccount: "1895-RECON-SUSPENSE", memo: "Format-error correction" },
};

const FALLBACK_MAPPING: GlMapping = { debitAccount: "1895-RECON-SUSPENSE", memo: "Reconciliation adjustment" };

// ─── Entry building ───────────────────────────────────────────────────────────

export interface ResolvedExceptionRow {
  id: number;
  category: string;
  currency: string;
  amount: number;
  transactionRef: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
}

function isoDate(d: Date | null | undefined, fallback: Date): string {
  const date = d ?? fallback;
  return date.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One balanced entry per resolved exception. Zero-amount exceptions post
 * nothing (nothing to book). Deterministic ordering by exception id.
 */
export function buildJournalEntries(
  rows: ResolvedExceptionRow[],
  job: { id: number; name: string; completedAt: Date | null },
  mapping: Record<string, GlMapping> = DEFAULT_GL_MAPPING,
): JournalEntry[] {
  const fallbackDate = job.completedAt ?? new Date();
  const entries: JournalEntry[] = [];
  let entryNo = 1;

  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const amount = round2(Math.abs(row.amount));
    if (amount < 0.01) continue;

    const m = mapping[row.category] ?? FALLBACK_MAPPING;
    const reference = row.transactionRef ?? `EXC-${row.id}`;
    const memo = `${m.memo} — ReconcileAI job #${job.id} (${job.name}), exception #${row.id}`
      + (row.resolutionNotes ? ` — ${row.resolutionNotes.slice(0, 120)}` : "");

    entries.push({
      entryNo: entryNo++,
      date: isoDate(row.resolvedAt, fallbackDate),
      currency: row.currency || "NGN",
      reference,
      memo,
      lines: [
        { account: m.debitAccount, debit: amount, credit: 0, memo: m.memo },
        { account: RECON_CONTROL_ACCOUNT, debit: 0, credit: amount, memo: `Contra — ${reference}` },
      ],
    });
  }
  return entries;
}

/** Every entry must balance to the cent — throws otherwise (never export junk). */
export function assertBalanced(entries: JournalEntry[]): void {
  for (const e of entries) {
    const debits = round2(e.lines.reduce((s, l) => s + l.debit, 0));
    const credits = round2(e.lines.reduce((s, l) => s + l.credit, 0));
    if (debits !== credits) {
      throw new Error(`Journal entry ${e.entryNo} is unbalanced: debits ${debits} != credits ${credits}`);
    }
  }
}

// ─── CSV rendering ────────────────────────────────────────────────────────────

export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Array<Array<string | number>>): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const money = (n: number) => (n === 0 ? "" : n.toFixed(2));

// ─── Formatter: SAP Business One (DTW OJDT + JDT1) ───────────────────────────

export interface SapB1DtwFiles {
  /** JournalEntries.csv (OJDT) */
  header: string;
  /** JournalEntryLines.csv (JDT1) */
  lines: string;
}

export function toSapB1Dtw(entries: JournalEntry[]): SapB1DtwFiles {
  const headerRows: Array<Array<string | number>> = [
    ["RecordKey", "ReferDate", "TaxDate", "Memo", "Reference"],
  ];
  const lineRows: Array<Array<string | number>> = [
    ["RecordKey", "LineNum", "AccountCode", "Debit", "Credit", "LineMemo", "Reference1"],
  ];
  for (const e of entries) {
    headerRows.push([e.entryNo, e.date, e.date, e.memo.slice(0, 254), e.reference.slice(0, 100)]);
    e.lines.forEach((l, i) => {
      lineRows.push([e.entryNo, i, l.account, money(l.debit), money(l.credit), l.memo.slice(0, 254), e.reference.slice(0, 100)]);
    });
  }
  return { header: csv(headerRows), lines: csv(lineRows) };
}

// ─── Formatter: Sage 300 (G/L Journal Entry import) ──────────────────────────

export function toSage300Csv(entries: JournalEntry[]): string {
  const rows: Array<Array<string | number>> = [
    ["ENTRYNUMBER", "LINENUMBER", "ACCOUNTID", "TRANSAMOUNT", "JOURNALDATE", "SOURCECODE", "REFERENCE", "DESCRIPTION", "CURRENCY"],
  ];
  for (const e of entries) {
    e.lines.forEach((l, i) => {
      // Sage 300 G/L imports use signed amounts: debit positive, credit negative.
      const amount = l.debit > 0 ? l.debit : -l.credit;
      rows.push([
        e.entryNo,
        (i + 1) * 20, // Sage line numbers conventionally step by 20
        l.account,
        amount.toFixed(2),
        e.date.replace(/-/g, ""), // YYYYMMDD
        "GL-JE",
        e.reference.slice(0, 60),
        `${l.memo} — ${e.memo}`.slice(0, 250),
        e.currency,
      ]);
    });
  }
  return csv(rows);
}

// ─── Formatter: QuickBooks Online (journal entry CSV) ────────────────────────

export function toQuickBooksCsv(entries: JournalEntry[]): string {
  const rows: Array<Array<string | number>> = [
    ["JournalNo", "JournalDate", "Currency", "Memo", "AccountName", "Debits", "Credits", "Description"],
  ];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        e.entryNo,
        e.date,
        e.currency,
        e.memo.slice(0, 200),
        l.account,
        money(l.debit),
        money(l.credit),
        `${l.memo} (${e.reference})`.slice(0, 200),
      ]);
    }
  }
  return csv(rows);
}

// ─── Job loading + orchestration ─────────────────────────────────────────────

export interface ErpExportFile {
  filename: string;
  content: string;
}

export function renderErpExport(
  target: ErpTarget,
  entries: JournalEntry[],
  jobId: number,
): ErpExportFile[] {
  assertBalanced(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  switch (target) {
    case "sap_b1": {
      const { header, lines } = toSapB1Dtw(entries);
      return [
        { filename: `reconcileai-job${jobId}-sapb1-JournalEntries-${stamp}.csv`, content: header },
        { filename: `reconcileai-job${jobId}-sapb1-JournalEntryLines-${stamp}.csv`, content: lines },
      ];
    }
    case "sage_300":
      return [{ filename: `reconcileai-job${jobId}-sage300-gl-journal-${stamp}.csv`, content: toSage300Csv(entries) }];
    case "quickbooks":
      return [{ filename: `reconcileai-job${jobId}-quickbooks-journal-${stamp}.csv`, content: toQuickBooksCsv(entries) }];
  }
}

/**
 * Load a completed job's resolved exceptions (org-scoped through the job) and
 * build the canonical entries. Returns null when the job doesn't exist or
 * belongs to another organization.
 */
export async function loadJournalEntriesForJob(
  jobId: number,
  organizationId: number | null,
): Promise<{ job: { id: number; name: string }; entries: JournalEntry[] } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [job] = await db
    .select()
    .from(reconciliationJobs)
    .where(eq(reconciliationJobs.id, jobId))
    .limit(1);
  if (!job) return null;
  // Org scoping: exceptions are "derived" (RLS audit) — enforce through the job.
  if (organizationId !== null && job.organizationId !== null && job.organizationId !== organizationId) {
    return null;
  }

  const rows = await db
    .select({
      id: exceptionsTable.id,
      category: exceptionsTable.category,
      currency: exceptionsTable.currency,
      amount: transactions.amount,
      transactionRef: transactions.transactionRef,
      resolvedAt: exceptionsTable.resolvedAt,
      resolutionNotes: exceptionsTable.resolutionNotes,
    })
    .from(exceptionsTable)
    .innerJoin(transactions, eq(exceptionsTable.transactionId, transactions.id))
    .where(and(eq(exceptionsTable.jobId, jobId), eq(exceptionsTable.status, "resolved")));

  const entries = buildJournalEntries(
    rows.map((r) => ({ ...r, amount: parseFloat(String(r.amount)) || 0 })),
    { id: job.id, name: job.name, completedAt: job.completedAt },
  );
  return { job: { id: job.id, name: job.name }, entries };
}
