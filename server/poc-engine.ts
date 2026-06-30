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
 * Extraction handles structured CSV/Excel uploads: a deterministic table reader
 * parses the rows directly (instant, any row count), and an LLM fallback covers
 * unusual layouts the reader can't confidently interpret. (PDF is not supported.)
 */
import crypto from "node:crypto";
import Papa from "papaparse";
import { and, desc, eq } from "drizzle-orm";
import { Transaction } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { runMatchingEngine, type ReconciliationConfig } from "./reconciliationEngine";
import { loadExcelJS } from "./exceljsLoader";
import { getDb } from "./db";
import {
  pocUploads,
  pocRuns,
  pocExceptions,
  pocShareTokens,
} from "../drizzle/poc_schema";

export type FileType = "excel" | "csv";
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

// ─── Extraction (structured CSV/Excel; LLM fallback for unusual layouts) ───

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

/**
 * Some users upload a file whose extension lies about its real format — e.g. an
 * Excel workbook exported/renamed as "statement.xlsx (14).csv", or an xlsx saved
 * with a .csv suffix. Reading xlsx ZIP bytes as UTF-8 text yields binary gibberish
 * and the model extracts nothing. Sniff the leading magic bytes and override the
 * declared type when they disagree, so the file is parsed by its real format.
 */
export function sniffFileType(buffer: Buffer, declared: FileType): FileType {
  if (buffer.length >= 4) {
    // ZIP local-file-header "PK\x03\x04" (also empty/spanned variants) → OOXML (.xlsx).
    if (buffer[0] === 0x50 && buffer[1] === 0x4b &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
      return "excel";
    }
    // Every real .xlsx is a ZIP. If a file declared "excel" is NOT a ZIP, it cannot be
    // a workbook — it's almost always a CSV/text export misnamed .xlsx. Read it as text
    // rather than letting exceljs throw on non-zip bytes.
    if (declared === "excel") return "csv";
  }
  return declared;
}

/** True when the bytes are a PDF (`%PDF`), regardless of the file's extension. */
export function isPdfBytes(buffer: Buffer): boolean {
  return buffer.length >= 4 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

/**
 * Parse a money value into a positive number, tolerating the formats real bank
 * statements use: currency symbols (₦, $), thousands separators ("16,576,000.00"),
 * surrounding spaces, and parenthesised negatives ("(1,234.56)"). Direction is
 * tracked separately, so the sign is irrelevant here — we always return |amount|.
 * Without this, a model that returns amounts as formatted strings would yield NaN,
 * collapse to 0, and get silently filtered out, producing a "0 transactions" result.
 */
export function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.abs(raw) : 0;
  // Keep only digits and the decimal point; commas/symbols/parens are stripped.
  const cleaned = String(raw ?? "").replace(/[^0-9.]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Serialize an Excel workbook buffer to a tab-separated text the LLM can read. */
async function excelToText(buffer: Buffer): Promise<string> {
  const ExcelJS = await loadExcelJS();
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

// ─── Deterministic structured-table extraction (CSV / Excel) ─────────
//
// Real bank statements run to hundreds or thousands of rows — a single LLM call
// cannot emit that many JSON objects within the output-token budget, so it returns
// nothing. But CSV/Excel statements ARE already structured: a header row names the
// columns, and every row below is a transaction. We parse them directly — instant,
// free, and unbounded by row count. The LLM is only a fallback for CSV/Excel layouts
// we can't confidently map (e.g. a trade ledger with no debit/credit columns).

/** Stringify an exceljs cell value (handles richtext, hyperlinks, formulas, dates). */
function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t?.text ?? "").join("");
    if (typeof o.text === "string") return o.text;
    if (o.result != null) return String(o.result);
    if (o.hyperlink && o.text == null) return String(o.hyperlink);
    return "";
  }
  return String(v);
}

/** CSV text → matrix of string cells (RFC4180: quoted fields, embedded commas/newlines). */
export function csvToMatrix(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  return (parsed.data as unknown as string[][]).map((row) =>
    Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c))) : [],
  );
}

/** Excel workbook → matrix of string cells, taken from the worksheet with most rows. */
export async function excelToMatrix(buffer: Buffer): Promise<string[][]> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  let best: string[][] = [];
  wb.worksheets.forEach((ws) => {
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      // row.values is 1-based (index 0 is empty); normalise to 0-based dense cells.
      const vals = row.values as unknown[];
      for (let i = 1; i < vals.length; i++) cells.push(cellToString(vals[i]));
      matrix.push(cells);
    });
    if (matrix.length > best.length) best = matrix;
  });
  return best;
}

/** Normalise a date string to ISO YYYY-MM-DD so both sides match in the date window.
 *  Assumes day-first (DD-MM-YYYY) — the standard across African bank statements. */
function normalizeDate(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // already ISO
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const dd = d.padStart(2, "0");
    const mm = mo.padStart(2, "0");
    // Guard obviously-wrong day-first reads (e.g. a real MM-DD source): if the first
    // field can't be a day (>31) but could be a month, fall through unchanged.
    if (Number(dd) >= 1 && Number(dd) <= 31 && Number(mm) >= 1 && Number(mm) <= 12) {
      return `${y}-${mm}-${dd}`;
    }
  }
  return s; // leave anything we can't confidently parse exactly as printed
}

const COL = {
  date: /\bdate\b|txn\s*date|trans(action)?\s*date|posting\s*date|value\s*date/i,
  valueDate: /\bval(ue)?\s*date\b/i,
  debit: /debit|withdraw|money\s*out|paid\s*out|\bdr\b|outflow/i,
  credit: /credit|deposit|money\s*in|paid\s*in|\bcr\b|inflow/i,
  amount: /amount|value|principal/i,
  balance: /balance|bal\b|running\s*bal/i,
  desc: /remark|narration|description|details|particular|memo|reference\s*detail/i,
  dir: /^(dir|direction|type|dr\/?cr|cr\/?dr|debit\/credit)$/i,
};

/**
 * Parse a structured statement/ledger matrix into canonical rows. Detects the header
 * row by its column names, maps debit/credit (or a single signed/typed amount) column,
 * and reads every transaction below it. Returns null when no confident header is found
 * so the caller can fall back to the LLM.
 */
export function parseStructuredStatement(
  matrix: string[][],
): { rows: CanonicalRow[]; currency?: string } | null {
  if (!matrix.length) return null;

  // Find the header row within the first 40 rows (skips any account/preamble block).
  let headerIdx = -1;
  let map: { date: number; desc: number; debit: number; credit: number; amount: number; balance: number; dir: number } | null = null;
  const scan = Math.min(matrix.length, 40);
  for (let r = 0; r < scan; r++) {
    const cells = matrix[r].map((c) => c.trim());
    const find = (re: RegExp) => cells.findIndex((c) => c && re.test(c));
    // Prefer a transaction date over a value date when both exist.
    const dateIdxs = cells.map((c, i) => ({ c, i })).filter((x) => x.c && COL.date.test(x.c));
    const txnDate = dateIdxs.find((x) => !COL.valueDate.test(x.c));
    const date = txnDate ? txnDate.i : (dateIdxs[0]?.i ?? -1);
    const debit = find(COL.debit);
    const credit = find(COL.credit);
    const amount = find(COL.amount);
    const dir = find(COL.dir);
    // Confident only when direction is unambiguous: either separate debit & credit
    // columns (the classic bank-statement layout), or an amount column paired with an
    // explicit direction/type column. A bare "amount" column with no direction signal
    // (e.g. a trade ledger: Date, Product, Supplier, Amount, …) is left to the LLM,
    // which can infer intent and a description from context. This avoids hijacking and
    // mis-parsing files the deterministic reader can't interpret correctly.
    const qualifies = date >= 0 && ((debit >= 0 && credit >= 0) || (amount >= 0 && dir >= 0));
    if (qualifies) {
      headerIdx = r;
      map = { date, desc: find(COL.desc), debit, credit, amount, balance: find(COL.balance), dir };
      break;
    }
  }
  if (headerIdx < 0 || !map) return null;

  // Optional currency from a preamble cell like "CURRENCY | NGN".
  let currency: string | undefined;
  for (let r = 0; r < headerIdx; r++) {
    const cells = matrix[r];
    const ci = cells.findIndex((c) => /^currency$/i.test(c.trim()));
    if (ci >= 0) {
      const val = cells.slice(ci + 1).find((c) => c.trim());
      if (val) currency = val.trim().toUpperCase().slice(0, 3);
      break;
    }
  }

  const at = (row: string[], idx: number) => (idx >= 0 && idx < row.length ? row[idx] : "");
  const rows: CanonicalRow[] = [];
  for (let r = headerIdx + 1; r < matrix.length && rows.length < MAX_POC_ROWS; r++) {
    const row = matrix[r];
    if (!row.some((c) => c && c.trim())) continue; // blank line

    let amount = 0;
    let direction: "debit" | "credit" = "debit";
    if (map.debit >= 0 && map.credit >= 0) {
      const debit = parseAmount(at(row, map.debit));
      const credit = parseAmount(at(row, map.credit));
      if (debit > 0) { amount = debit; direction = "debit"; }
      else if (credit > 0) { amount = credit; direction = "credit"; }
      else continue; // totals/footer/section rows carry no debit or credit
    } else {
      const rawAmt = at(row, map.amount);
      amount = parseAmount(rawAmt);
      if (amount <= 0) continue;
      const dirCell = at(row, map.dir).trim().toLowerCase();
      if (map.dir >= 0 && dirCell) {
        direction = /cr|credit|deposit|inflow|in\b/.test(dirCell) ? "credit" : "debit";
      } else {
        // No explicit direction column: treat parenthesised/negative as debit (money out).
        direction = /^\(|-/.test(rawAmt.trim()) ? "debit" : "credit";
      }
    }

    const dateStr = normalizeDate(at(row, map.date));
    if (!dateStr) continue; // a transaction must have a date
    const balRaw = at(row, map.balance);
    rows.push({
      date: dateStr,
      description: at(row, map.desc).trim(),
      amount,
      direction,
      balance: map.balance >= 0 && balRaw.trim() ? parseAmount(balRaw) : null,
    });
  }

  return rows.length > 0 ? { rows, currency } : null;
}

export interface ExtractionResult {
  rows: CanonicalRow[];
  currency: string;
  notes: string;
}

/**
 * Extract canonical transaction rows from an uploaded CSV/Excel file (base64).
 * Structured tables are parsed deterministically; unusual layouts fall back to the LLM.
 */
export async function extractTransactions(params: {
  fileType: FileType;
  base64: string;
  fileName?: string;
}): Promise<ExtractionResult> {
  const buffer = Buffer.from(params.base64, "base64");

  // PDF is not supported — both POCs ingest structured CSV/Excel only. Detect by magic
  // bytes so a PDF mislabeled .csv/.xlsx is rejected clearly instead of parsed as junk.
  if (isPdfBytes(buffer)) {
    throw new Error(
      "PDF files aren't supported. Please upload an Excel (.xlsx/.xls) or CSV export of your statement.",
    );
  }

  // Trust the bytes over the extension: a mislabeled file (e.g. xlsx saved as .csv)
  // would otherwise be read as text and extract nothing.
  const fileType = sniffFileType(buffer, params.fileType);

  // Structured formats (CSV/Excel) are parsed deterministically first. This scales to
  // the thousands of rows a real bank statement contains — which a single LLM call
  // cannot emit within the output-token budget — and is instant and free. We only fall
  // through to the LLM when no confident table header is found (unusual layouts).
  if (fileType === "excel" || fileType === "csv") {
    try {
      const matrix = fileType === "excel"
        ? await excelToMatrix(buffer)
        : csvToMatrix(buffer.toString("utf8"));
      const structured = parseStructuredStatement(matrix);
      const rows = (structured?.rows ?? []).slice(0, MAX_POC_ROWS).filter((r) => r.amount > 0);
      if (rows.length > 0) {
        return {
          rows,
          currency: (structured?.currency || "NGN").toUpperCase().slice(0, 3),
          notes: `Extracted ${rows.length} transaction(s).`,
        };
      }
      console.warn(
        `[poc extract] structured parse found no rows for "${params.fileName ?? "?"}" ` +
        `(${fileType}, ${matrix.length} lines) — falling back to LLM.`,
      );
    } catch (err) {
      console.warn("[poc extract] structured parse threw, falling back to LLM:", (err as Error).message);
    }
  }

  // Unusual CSV/Excel layouts the deterministic reader couldn't interpret fall back to
  // the LLM (e.g. a trade ledger with no debit/credit columns, like the Salad cashbook).
  const text =
    fileType === "excel" ? await excelToText(buffer) : buffer.toString("utf8");
  const userContent: any = `Extract all transactions from this ${fileType.toUpperCase()} data:\n\n${text.slice(0, 200_000)}`;

  let res;
  try {
    res = await invokeLLM({
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_schema", json_schema: { name: "extracted_transactions", schema: EXTRACTION_SCHEMA } },
      // Statements can run to hundreds of rows; a tight output cap truncates the
      // JSON mid-array, which then fails to parse. Give the model ample room.
      maxTokens: 16384,
    });
  } catch (err: any) {
    // Keep the real provider error in the server logs for operators…
    const msg = String(err?.message ?? "");
    console.error("[poc extract] LLM call failed:", msg);
    // …but never surface raw provider HTML/JSON (or API-key errors) to the prospect.
    if (/\b401\b|\b403\b|unauthorized|authentication_error|invalid x-api-key|api[- ]?key|not configured/i.test(msg)) {
      throw new Error(
        "The extraction service is temporarily unavailable due to a configuration issue on our side. " +
        "Your file is fine — please try again later or contact support.",
      );
    }
    if (/\b50\d\b|bad gateway|gateway time-?out|overloaded|temporarily|ECONN|fetch failed/i.test(msg)) {
      throw new Error("The extraction service is busy right now. Please try again in a moment.");
    }
    throw err;
  }

  const rawContent = res.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? {});
  let parsed: { currency?: string; rows?: any[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Could not read this file. Please upload a clean Excel (.xlsx/.xls) or CSV export.");
  }
  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows: CanonicalRow[] = rawRows
    .slice(0, MAX_POC_ROWS)
    .map((r): CanonicalRow => ({
      date: String(r.date ?? ""),
      description: String(r.description ?? ""),
      amount: parseAmount(r.amount),
      direction: r.direction === "credit" ? "credit" : "debit",
      reference: r.reference ? String(r.reference) : undefined,
      balance: r.balance == null ? null : (Number.isFinite(Number(r.balance)) ? Number(r.balance) : null),
    }))
    .filter((r) => r.amount > 0);

  if (rows.length === 0) {
    // Diagnostic for operators: distinguishes "model returned nothing" (rawRows=0 —
    // unreadable/gibberish input) from "rows parsed away" (rawRows>0 but amounts
    // filtered to 0 — an amount-format problem). Helps RCA a prospect's file fast.
    console.warn(
      `[poc extract] 0 usable rows — file="${params.fileName ?? "?"}" declared=${params.fileType} ` +
      `resolved=${fileType} bytes=${buffer.length} llmContentLen=${content.length} rawRows=${rawRows.length}. ` +
      `Preview: ${content.slice(0, 300).replace(/\s+/g, " ")}`,
    );
  }

  const notes =
    rows.length > 0
      ? `Extracted ${rows.length} transaction(s).`
      : "No transaction rows were found in this file. Make sure it contains dated transactions with amounts " +
        "(not just an opening/closing balance or a summary). A plain CSV or Excel export with Date, Description, " +
        "and Amount columns works best.";
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

// ─── Non-reconcilable "noise" detection (bank fees, charges, taxes, levies) ──
//
// In a ledger ↔ bank-statement reconciliation, bank-generated fee/charge/levy
// lines are informational — they are NOT transactions the two sides should match
// one-to-one, and in bulk (as seen in the Salad dataset) they skew the variance
// and flood the exception list. We detect them, set them aside from Layer 1 + 2,
// and flag every one with context so the user still sees them and can account
// for them. NOTE: this is intentionally OFF for card-settlement reconciliations
// (e.g. LAPO) where interchange/scheme fees ARE part of what is reconciled.

export interface ExcludedItem {
  side: Side;
  amount: number;
  date: string;
  reference: string | null;
  description: string | null;
  reason: string;
}

// Ordered most-specific → most-generic. The generic "possible fee" bucket is a
// heuristic catch — items land there flagged (never silently dropped) so the user
// can judge them. Tune these patterns per client as real descriptions are seen.
const NOISE_PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "Tax, levy or duty", re: /\b(v\.?a\.?t|w\.?h\.?t|withholding tax|stamp duty|e\.?m\.?t\.?l|electronic money transfer levy|cbn levy|levy|excise duty)\b/i },
  { reason: "Account maintenance fee", re: /\b(account maintenance|maintenance (fee|charge)|a\.?m\.?f\b|ledger fee|c\.?o\.?t\b|commission on turnover)\b/i },
  { reason: "Card / channel fee", re: /\b(sms( alert| charge| fee)?|e-?alert|alert (fee|charge)|atm (fee|charge)|card (fee|maintenance)|hardware token|token fee|ussd (fee|charge))\b/i },
  { reason: "Bank charge / commission", re: /\b(bank charge|service (charge|fee)|processing fee|handling fee|transaction (fee|charge)|transfer (fee|charge)|nip (fee|charge)|neft (fee|charge)|rtgs (fee|charge)|management fee|commission)\b/i },
  // Some banks prefix system-generated charges with "MISC." (e.g. real Salad
  // statement: "MISC. SMS ALERT CHARGE", "MISC. ELECTRONIC MONEY TRANSFER LEVY").
  // Catch any such line that also carries a charge/fee/levy term — the specific
  // buckets above still win for the known forms, so this only hardens new variants.
  { reason: "Bank-generated charge", re: /\bmisc\.?\s+.*\b(charge|fee|levy|duty|tax|commission)\b/i },
  { reason: "Possible fee / charge (review)", re: /\b(fees?|charges?)\b/i },
];

/** Classify a single row as reconcilable or fee/charge noise (with a reason). */
export function detectNoise(row: CanonicalRow): { noise: boolean; reason: string } {
  const text = `${row.description ?? ""} ${row.reference ?? ""}`.toLowerCase();
  if (!text.trim()) return { noise: false, reason: "" };
  for (const p of NOISE_PATTERNS) {
    if (p.re.test(text)) return { noise: true, reason: p.reason };
  }
  return { noise: false, reason: "" };
}

function partitionNoise(rows: CanonicalRow[], side: Side): { keep: CanonicalRow[]; excluded: ExcludedItem[] } {
  const keep: CanonicalRow[] = [];
  const excluded: ExcludedItem[] = [];
  for (const r of rows) {
    const { noise, reason } = detectNoise(r);
    if (noise) excluded.push({ side, amount: r.amount, date: r.date, reference: r.reference ?? null, description: r.description ?? null, reason });
    else keep.push(r);
  }
  return { keep, excluded };
}

// ─── Orchestration + persistence ─────────────────────────────────────

export interface PocRunResult {
  runId: number;
  layer1: Layer1Result;
  matchedCount: number;
  layer3: Layer3Item[];
  excluded: ExcludedItem[];
  excludedTotal: number;
  excludedByReason: Record<string, { count: number; total: number }>;
}

export async function runFullPoc(params: {
  pocSlug: string;
  ledgerUploadId: number;
  statementUploadId: number;
  config?: ReconciliationConfig;
  // Set aside bank fee/charge/levy "noise" from the reconciliation and flag it.
  // Default ON for ledger↔bank reconciliation; pass false for card settlement.
  excludeFeeNoise?: boolean;
}): Promise<PocRunResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [ledgerUp] = await db.select().from(pocUploads).where(eq(pocUploads.id, params.ledgerUploadId)).limit(1);
  const [stmtUp] = await db.select().from(pocUploads).where(eq(pocUploads.id, params.statementUploadId)).limit(1);
  if (!ledgerUp || !stmtUp) throw new Error("Upload(s) not found — please re-upload the files");

  const ledgerAll = (ledgerUp.rows as CanonicalRow[]) ?? [];
  const statementAll = (stmtUp.rows as CanonicalRow[]) ?? [];
  const currency = "NGN";

  // Set aside fee/charge noise BEFORE reconciling so it can't skew totals/matching.
  const excludeFeeNoise = params.excludeFeeNoise ?? true;
  let ledger = ledgerAll;
  let statement = statementAll;
  let excluded: ExcludedItem[] = [];
  if (excludeFeeNoise) {
    const lp = partitionNoise(ledgerAll, "ledger");
    const sp = partitionNoise(statementAll, "statement");
    ledger = lp.keep;
    statement = sp.keep;
    excluded = [...lp.excluded, ...sp.excluded];
  }

  const layer1 = runLayer1(ledger, statement, currency);
  const layer2 = runLayer2(ledger, statement, params.config);
  const layer3 = runLayer3(layer2.exceptions);

  const excludedTotal = Math.round(excluded.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const excludedByReason: Record<string, { count: number; total: number }> = {};
  for (const e of excluded) {
    const b = (excludedByReason[e.reason] ??= { count: 0, total: 0 });
    b.count += 1;
    b.total = Math.round((b.total + e.amount) * 100) / 100;
  }

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
    // Persist excluded items + tallies alongside the Layer-1 detail so the run
    // history can show what was set aside and why.
    summary: { ...layer1, excludedItems: excluded, excludedTotal, excludedByReason },
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

  return { runId, layer1, matchedCount: layer2.matchedCount, layer3, excluded, excludedTotal, excludedByReason };
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
