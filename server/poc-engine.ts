/**
 * Generic POC reconciliation engine (ledger ↔ bank statement).
 *
 * Powers the public company POC pages (e.g. Salad Africa). Mirrors the Woodcore
 * POC's 3-layer architecture but for self-service uploads:
 *   Layer 1 — Balance:    totals + net variance between the two sources.
 *   Layer 2 — Exceptions: reuses the production matching engine, then classifies
 *                         what didn't reconcile.
 *   Layer 3 — AI Agent:   plain-English explanation + recommended action +
 *                         priority for each exception.
 *
 * Extraction is AI-powered and format-agnostic: Excel (exceljs), CSV (text), and
 * PDF/scans (Claude reads the document natively) are normalized to canonical rows.
 */
import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Transaction } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { runMatchingEngine, type ReconciliationConfig } from "./reconciliationEngine";
import { getDb } from "./db";
import {
  pocUploads,
  pocRuns,
  pocExceptions,
  pocShareTokens,
} from "../drizzle/poc_schema";

export type FileType = "pdf" | "excel" | "csv";
export type Side = "ledger" | "statement";

export interface CanonicalRow {
  date: string;
  description: string;
  amount: number; // positive
  direction: "debit" | "credit";
  reference?: string;
  balance?: number | null;
}

export const MAX_POC_ROWS = 5000;

// ─── Extraction (AI-powered, any format) ─────────────────────────────

const EXTRACTION_SYSTEM =
  "You are a precise financial data extraction engine. Extract EVERY individual transaction row " +
  "from the provided bank statement or accounting ledger. Rules: (1) amount is a POSITIVE number; " +
  "set direction to 'debit' for money out and 'credit' for money in; (2) ignore headers, column " +
  "titles, page footers, subtotals, and running-balance-only lines; (3) keep any transaction " +
  "reference/cheque/instrument number if present; (4) use the date exactly as printed if you cannot " +
  "parse it. Return only real transactions.";

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    currency: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          description: { type: "string" },
          amount: { type: "number" },
          direction: { type: "string", enum: ["debit", "credit"] },
          reference: { type: "string" },
          balance: { type: "number" },
        },
        required: ["date", "amount", "direction"],
        additionalProperties: false,
      },
    },
  },
  required: ["rows"],
  additionalProperties: false,
};

/** Serialize an Excel workbook buffer to a tab-separated text the LLM can read. */
async function excelToText(buffer: Buffer): Promise<string> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const lines: string[] = [];
  wb.worksheets.forEach((ws) => {
    lines.push(`# Sheet: ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        cells.push(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
      });
      lines.push(cells.join(" | "));
    });
  });
  return lines.join("\n");
}

export interface ExtractionResult {
  rows: CanonicalRow[];
  currency: string;
  notes: string;
}

/**
 * Extract canonical transaction rows from an uploaded file (base64). PDFs are
 * read by Claude directly (handles scans); Excel/CSV are serialized to text first.
 */
export async function extractTransactions(params: {
  fileType: FileType;
  base64: string;
  fileName?: string;
}): Promise<ExtractionResult> {
  const buffer = Buffer.from(params.base64, "base64");
  let userContent: any;

  if (params.fileType === "pdf") {
    userContent = [
      { type: "text", text: "Extract all transactions from this statement/ledger PDF." },
      { type: "file_url", file_url: { url: `data:application/pdf;base64,${params.base64}`, mime_type: "application/pdf" } },
    ];
  } else {
    const text =
      params.fileType === "excel" ? await excelToText(buffer) : buffer.toString("utf8");
    userContent = `Extract all transactions from this ${params.fileType.toUpperCase()} data:\n\n${text.slice(0, 200_000)}`;
  }

  const res = await invokeLLM({
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_schema", json_schema: { name: "extracted_transactions", schema: EXTRACTION_SCHEMA } },
    maxTokens: 8192,
  });

  const rawContent = res.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? {});
  let parsed: { currency?: string; rows?: any[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Could not read this file. If it is a scanned image, try a clearer copy or an Excel/CSV export.");
  }
  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows: CanonicalRow[] = rawRows
    .slice(0, MAX_POC_ROWS)
    .map((r): CanonicalRow => ({
      date: String(r.date ?? ""),
      description: String(r.description ?? ""),
      amount: Math.abs(Number(r.amount) || 0),
      direction: r.direction === "credit" ? "credit" : "debit",
      reference: r.reference ? String(r.reference) : undefined,
      balance: r.balance == null ? null : Number(r.balance),
    }))
    .filter((r) => r.amount > 0);

  const notes =
    rows.length === 0
      ? "No transactions could be extracted. If this is a scanned image, try a clearer scan or an Excel/CSV export."
      : `Extracted ${rows.length} transaction(s).`;
  return { rows, currency: (parsed.currency || "NGN").toUpperCase().slice(0, 3), notes };
}

// ─── Build synthetic Transactions for the matching engine ────────────

function toTxns(rows: CanonicalRow[], channelId: number, startId: number): Transaction[] {
  return rows.map((r, i) => {
    const parsed = new Date(r.date);
    const date = isNaN(parsed.getTime()) ? new Date() : parsed;
    return {
      id: startId + i,
      batchId: 0,
      channelId,
      userId: 0,
      organizationId: null,
      transactionRef: r.reference ?? null,
      externalRef: null,
      description: r.description ?? null,
      amount: r.amount.toFixed(2),
      currency: "NGN",
      transactionDate: date,
      valueDate: null,
      debitCredit: r.direction,
      counterparty: null,
      originalTransactionRef: null,
      isReversal: false,
      status: "unmatched",
      matchId: null,
      rawData: null,
      createdAt: new Date(),
    } as unknown as Transaction;
  });
}

// ─── Layer 1 — Balance ───────────────────────────────────────────────

export interface Layer1Result {
  currency: string;
  ledgerCount: number;
  statementCount: number;
  ledgerCredits: number;
  ledgerDebits: number;
  statementCredits: number;
  statementDebits: number;
  ledgerNet: number;
  statementNet: number;
  varianceAmount: number;
  status: "BALANCED" | "VARIANCE_DETECTED";
}

function sumBy(rows: CanonicalRow[], dir: "debit" | "credit"): number {
  return rows.filter((r) => r.direction === dir).reduce((s, r) => s + r.amount, 0);
}

export function runLayer1(ledger: CanonicalRow[], statement: CanonicalRow[], currency = "NGN"): Layer1Result {
  const ledgerCredits = sumBy(ledger, "credit");
  const ledgerDebits = sumBy(ledger, "debit");
  const statementCredits = sumBy(statement, "credit");
  const statementDebits = sumBy(statement, "debit");
  const ledgerNet = ledgerCredits - ledgerDebits;
  const statementNet = statementCredits - statementDebits;
  const varianceAmount = Math.round((ledgerNet - statementNet) * 100) / 100;
  return {
    currency,
    ledgerCount: ledger.length,
    statementCount: statement.length,
    ledgerCredits,
    ledgerDebits,
    statementCredits,
    statementDebits,
    ledgerNet,
    statementNet,
    varianceAmount,
    status: Math.abs(varianceAmount) < 0.01 ? "BALANCED" : "VARIANCE_DETECTED",
  };
}

// ─── Layer 2 — Exceptions ────────────────────────────────────────────

export type ExceptionCategory =
  // Generic
  | "IN_LEDGER_NOT_IN_BANK"
  | "IN_BANK_NOT_IN_LEDGER"
  | "AMOUNT_MISMATCH"
  | "DUPLICATE"
  | "REVERSAL"
  // Card-specific (Interswitch / card scheme settlement)
  | "CHARGEBACK"
  | "SETTLEMENT_SHORTFALL"
  | "LATE_PRESENTMENT"
  | "INTERCHANGE_DISPUTE"
  | "SCHEME_FEE_VARIANCE"
  | "FORCE_POST"
  | "PARTIAL_REVERSAL";

export interface ExceptionDraft {
  category: ExceptionCategory;
  side: Side;
  amount: number;
  txnDate: string;
  reference: string | null;
  description: string | null;
}

const LEDGER_CHANNEL = 1;
const STATEMENT_CHANNEL = 2;

export interface Layer2Result {
  matchedCount: number;
  exceptions: ExceptionDraft[];
}

export function runLayer2(
  ledger: CanonicalRow[],
  statement: CanonicalRow[],
  config: ReconciliationConfig = { amountTolerance: 0.005, dateWindowDays: 3 },
): Layer2Result {
  const ledgerTxns = toTxns(ledger, LEDGER_CHANNEL, 1);
  const statementTxns = toTxns(statement, STATEMENT_CHANNEL, 1_000_000);
  const byId = new Map<number, { row: CanonicalRow; side: Side }>();
  ledgerTxns.forEach((t, i) => byId.set(t.id, { row: ledger[i], side: "ledger" }));
  statementTxns.forEach((t, i) => byId.set(t.id, { row: statement[i], side: "statement" }));

  const result = runMatchingEngine(ledgerTxns, statementTxns, config);
  const exceptions: ExceptionDraft[] = [];

  const draftFrom = (id: number, category: ExceptionCategory): ExceptionDraft => {
    const e = byId.get(id);
    const row = e?.row;
    return {
      category,
      side: e?.side ?? "ledger",
      amount: row?.amount ?? 0,
      txnDate: row?.date ?? "",
      reference: row?.reference ?? null,
      description: row?.description ?? null,
    };
  };

  for (const id of result.unmatchedSource) exceptions.push(draftFrom(id, "IN_LEDGER_NOT_IN_BANK"));
  for (const id of result.unmatchedTarget) exceptions.push(draftFrom(id, "IN_BANK_NOT_IN_LEDGER"));
  // Matches with a non-zero amount difference are flagged for review.
  for (const m of result.matches) {
    if (Math.abs(m.amountDifference) >= 0.01) {
      const d = draftFrom(m.sourceId, "AMOUNT_MISMATCH");
      d.description = `${d.description ?? ""} (bank differs by ${m.amountDifference.toFixed(2)})`.trim();
      exceptions.push(d);
    }
  }
  for (const dup of result.duplicates) {
    for (const id of dup.transactionIds.slice(1)) exceptions.push(draftFrom(id, "DUPLICATE"));
  }
  for (const rev of result.reversals) exceptions.push(draftFrom(rev.reversalId, "REVERSAL"));

  return { matchedCount: result.matches.length, exceptions };
}

// ─── Layer 3 — AI Agent ──────────────────────────────────────────────

const CATEGORY_INFO: Record<ExceptionCategory, { action: string; confidence: number; explain: (d: ExceptionDraft) => string }> = {
  IN_LEDGER_NOT_IN_BANK: {
    action: "Confirm whether this item has cleared the bank. If it is an outstanding/uncleared entry, carry it forward; if it should have cleared, investigate with the bank.",
    confidence: 90,
    explain: (d) => `This entry appears in the ledger but has no matching item on the bank statement (${fmt(d.amount)}). It is typically an uncleared/outstanding transaction or a recording timing difference.`,
  },
  IN_BANK_NOT_IN_LEDGER: {
    action: "Record this item in the ledger. Common causes: bank charges, interest, direct debits, or transfers not yet captured.",
    confidence: 90,
    explain: (d) => `The bank statement shows this item (${fmt(d.amount)}) but it is missing from the ledger — often a bank charge, fee, interest credit, or an unrecorded receipt/payment.`,
  },
  AMOUNT_MISMATCH: {
    action: "Reconcile the amount difference — check for fees deducted, FX, or a data-entry error on one side.",
    confidence: 85,
    explain: (d) => `A matching transaction was found but the amounts differ${d.description ? ` ${d.description}` : ""}. This usually indicates a deducted fee, an FX difference, or a keying error.`,
  },
  DUPLICATE: {
    action: "Remove or void the duplicate so the item is only counted once.",
    confidence: 88,
    explain: (d) => `This transaction (${fmt(d.amount)}) appears more than once on the ${d.side} side and looks like a duplicate.`,
  },
  REVERSAL: {
    action: "Confirm the reversal nets off the original entry; ensure both legs are recorded.",
    confidence: 85,
    explain: (d) => `This looks like a reversal/chargeback (${fmt(d.amount)}). Confirm the original entry and the reversal both appear and net to zero.`,
  },
  // ── Card-specific categories ──────────────────────────────────────
  CHARGEBACK: {
    action: "Verify the chargeback is valid. Ensure the debit reversal is posted in CBS and the dispute is logged with Interswitch within the scheme deadline (typically 45 days).",
    confidence: 92,
    explain: (d) => `A chargeback (${fmt(d.amount)}) has been raised — CBS shows a debit reversal but the Interswitch settlement file does not yet reflect it. This is a customer or issuer dispute in progress.`,
  },
  SETTLEMENT_SHORTFALL: {
    action: "Reconcile the shortfall against the Interswitch interchange/scheme fee schedule. If the deduction exceeds the contracted rate, raise a dispute with Interswitch within 30 days.",
    confidence: 90,
    explain: (d) => `Interswitch settled less than the CBS-posted amount (${fmt(d.amount)}). The difference is likely an interchange or scheme fee deduction. Verify against the contracted fee schedule.`,
  },
  LATE_PRESENTMENT: {
    action: "Check whether the late presentment incurs a penalty fee per the Interswitch agreement. Post any penalty to the appropriate GL and monitor for chargeback risk.",
    confidence: 88,
    explain: (d) => `This transaction (${fmt(d.amount)}) was presented for settlement outside the standard window (>3 days). Late presentment increases chargeback risk and may attract penalty fees.`,
  },
  INTERCHANGE_DISPUTE: {
    action: "Compare the applied interchange rate against the Interswitch fee schedule for this card type and MCC. Raise a formal dispute via the Interswitch portal if the rate is incorrect.",
    confidence: 85,
    explain: (d) => `The interchange fee applied by Interswitch for this transaction (${fmt(d.amount)}) does not match the expected rate for the card type or merchant category code.`,
  },
  SCHEME_FEE_VARIANCE: {
    action: "Verify the scheme fee against the Visa/Mastercard/Verve quarterly fee schedule. Escalate to Interswitch if the variance exceeds the tolerance threshold.",
    confidence: 83,
    explain: (d) => `The Visa/Mastercard/Verve scheme fee deducted from this settlement (${fmt(d.amount)}) differs from the contracted rate. This may indicate a scheme fee revision or a billing error.`,
  },
  FORCE_POST: {
    action: "Validate that the force-post was authorised offline by a supervisor. Flag for fraud review if the merchant is not on the approved offline list. Monitor for chargeback.",
    confidence: 80,
    explain: (d) => `This transaction (${fmt(d.amount)}) was force-posted (approved offline without authorisation). Force-posts carry elevated chargeback and fraud risk and require supervisory sign-off.`,
  },
  PARTIAL_REVERSAL: {
    action: "Confirm the partial reversal amount is correctly reflected in CBS. Post the net (original minus reversal) to the card settlement GL and document the reason for the partial reversal.",
    confidence: 87,
    explain: (d) => `Only part of the original transaction (${fmt(d.amount)}) was reversed. Ensure the net amount is correctly posted in CBS and that both the original and partial reversal legs are documented.`,
  },
};

function fmt(n: number): string {
  return `₦${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priorityFor(amount: number): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  if (amount >= 500_000) return "CRITICAL";
  if (amount >= 100_000) return "HIGH";
  if (amount >= 10_000) return "MEDIUM";
  return "LOW";
}

export interface Layer3Item extends ExceptionDraft {
  agentExplanation: string;
  recommendedAction: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  agentConfidence: number;
}

export function runLayer3(exceptions: ExceptionDraft[]): Layer3Item[] {
  return exceptions.map((d) => {
    const info = CATEGORY_INFO[d.category] ?? {
      action: "Review this exception manually and determine the appropriate corrective action.",
      confidence: 75,
      explain: (ex: ExceptionDraft) => `An exception of type '${ex.category}' was detected for ${fmt(ex.amount)}. Manual review is required.`,
    };
    return {
      ...d,
      agentExplanation: info.explain(d),
      recommendedAction: info.action,
      priorityLevel: priorityFor(d.amount),
      agentConfidence: info.confidence,
    };
  });
}

// ─── Orchestration + persistence ─────────────────────────────────────

export interface PocRunResult {
  runId: number;
  layer1: Layer1Result;
  matchedCount: number;
  layer3: Layer3Item[];
}

export async function runFullPoc(params: {
  pocSlug: string;
  ledgerUploadId: number;
  statementUploadId: number;
  config?: ReconciliationConfig;
}): Promise<PocRunResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [ledgerUp] = await db.select().from(pocUploads).where(eq(pocUploads.id, params.ledgerUploadId)).limit(1);
  const [stmtUp] = await db.select().from(pocUploads).where(eq(pocUploads.id, params.statementUploadId)).limit(1);
  if (!ledgerUp || !stmtUp) throw new Error("Upload(s) not found — please re-upload the files");

  const ledger = (ledgerUp.rows as CanonicalRow[]) ?? [];
  const statement = (stmtUp.rows as CanonicalRow[]) ?? [];
  const currency = "NGN";

  const layer1 = runLayer1(ledger, statement, currency);
  const layer2 = runLayer2(ledger, statement, params.config);
  const layer3 = runLayer3(layer2.exceptions);

  const denom = layer2.matchedCount + layer2.exceptions.length;
  const matchRate = denom > 0 ? Math.round((layer2.matchedCount / denom) * 10000) / 100 : 0;

  const insertRun = await db.insert(pocRuns).values({
    pocSlug: params.pocSlug,
    ledgerUploadId: params.ledgerUploadId,
    statementUploadId: params.statementUploadId,
    currencyCode: currency,
    ledgerCount: layer1.ledgerCount,
    statementCount: layer1.statementCount,
    ledgerTotal: layer1.ledgerNet.toFixed(2),
    statementTotal: layer1.statementNet.toFixed(2),
    varianceAmount: layer1.varianceAmount.toFixed(2),
    status: layer1.status,
    matchedCount: layer2.matchedCount,
    exceptionCount: layer2.exceptions.length,
    matchRate: String(matchRate),
    summary: layer1,
  });
  const runId = (insertRun as any)[0].insertId as number;

  if (layer3.length > 0) {
    await db.insert(pocExceptions).values(
      layer3.map((e) => ({
        runId,
        pocSlug: params.pocSlug,
        category: e.category,
        side: e.side,
        amount: e.amount.toFixed(2),
        txnDate: e.txnDate.slice(0, 32),
        reference: e.reference ?? null,
        description: (e.description ?? "").slice(0, 500),
        agentExplanation: e.agentExplanation,
        recommendedAction: e.recommendedAction,
        priorityLevel: e.priorityLevel,
        agentConfidence: e.agentConfidence,
      })),
    );
  }

  return { runId, layer1, matchedCount: layer2.matchedCount, layer3 };
}

// ─── Queries + share tokens ──────────────────────────────────────────

export async function getRun(runId: number, pocSlug: string) {
  const db = await getDb();
  if (!db) return null;
  const [run] = await db.select().from(pocRuns).where(and(eq(pocRuns.id, runId), eq(pocRuns.pocSlug, pocSlug))).limit(1);
  return run ?? null;
}

export async function getRunExceptions(runId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pocExceptions).where(eq(pocExceptions.runId, runId)).orderBy(desc(pocExceptions.amount));
}

export async function listRuns(pocSlug: string, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pocRuns).where(eq(pocRuns.pocSlug, pocSlug)).orderBy(desc(pocRuns.createdAt)).limit(limit);
}

export async function createShareToken(runId: number, pocSlug: string, createdBy?: string, expiresInDays = 30) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  await db.insert(pocShareTokens).values({ token, runId, pocSlug, createdBy: createdBy ?? null, expiresAt });
  return { token, expiresAt };
}

export async function getSharedReport(token: string) {
  const db = await getDb();
  if (!db) return null;
  const [share] = await db.select().from(pocShareTokens).where(eq(pocShareTokens.token, token)).limit(1);
  if (!share) return null;
  if (share.expiresAt && share.expiresAt < new Date()) return null;
  const run = await getRun(share.runId, share.pocSlug);
  if (!run) return null;
  const exceptions = await getRunExceptions(share.runId);
  return { run, exceptions, pocSlug: share.pocSlug, expiresAt: share.expiresAt };
}
