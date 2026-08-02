/**
 * Generic tabular-file ingestion core — shared by every inbound path.
 *
 * One parser now serves manual upload, SFTP drops, bucket drops and API push,
 * for banks and retail alike. Before this the paths had diverged badly:
 *
 *  - `apiIngestionService.parseAndValidateCsv` (the bank/SFTP path) was CSV-only,
 *    recognised exactly three spellings of "date", and coerced money with
 *    `replace(/[^0-9.-]/g, "")`. That silently turns the accounting negative
 *    "(12.30)" into +12.30 and the European "1.234,56" into 1.23456 — wrong
 *    numbers that still look like plausible amounts.
 *  - `sftpService` read every file with `.toString("utf8")`, so an Excel drop
 *    was mangled into text and parsed as nonsense.
 *
 * Money and dates are the product. Two implementations of "what is this number"
 * is one too many, so the coercion lives here and nowhere else.
 */
import Papa from "papaparse";
import { loadExcelJS } from "../exceljsLoader";

export const SPREADSHEET_EXTENSIONS = /\.(xlsx|xlsm|xlsb|xls)$/i;

/** True when the filename indicates a workbook rather than delimited text. */
export function isSpreadsheet(fileName: string): boolean {
  return SPREADSHEET_EXTENSIONS.test(fileName);
}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
  parseErrors: string[];
}

export const MAX_ROWS = 200_000;

/** Normalise a header for alias matching: lowercase, quotes out, spaces → `_`. */
export function normalizeHeader(h: string): string {
  return String(h ?? "").trim().toLowerCase().replace(/['"]/g, "").replace(/\s+/g, "_");
}

/**
 * Coerce a money string as written by real exports.
 *
 * Handles currency symbols, thousands grouping, European decimals and the
 * accounting negative `(12.30)`. Returns null rather than NaN so callers must
 * decide explicitly what an unreadable amount means.
 */
export function parseAmount(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;

  const parenNegative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[^0-9.,\-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return null;

  // Separator disambiguation. Getting this wrong is silently catastrophic:
  // "₦12,000" read as a European decimal becomes 12.00 — a 1000x understatement
  // that still looks like a plausible amount.
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Both present: whichever comes last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    // Repeated commas, or a final group of exactly 3 digits, means thousands
    // ("12,000"). A 1-2 digit tail means a European decimal ("12,30").
    const thousands = parts.length > 2 || parts[parts.length - 1].length === 3;
    s = thousands ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    // A single dot is a decimal point in virtually every export; only repeated
    // dots indicate grouping ("1.234.567").
    if (s.split(".").length > 2) s = s.replace(/\./g, "");
  }

  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return parenNegative ? -Math.abs(n) : n;
}

/** Parse a date, returning null (never an Invalid Date) when unreadable. */
export function parseDate(raw: string | Date | undefined | null): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a logical field to an actual header using ordered aliases.
 * `claimed` prevents one column being assigned to two fields.
 */
export function resolveColumn(
  headers: string[],
  aliases: string[],
  claimed?: Set<string>,
): string | undefined {
  const byNormalized = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (n && !byNormalized.has(n)) byNormalized.set(n, h);
  }
  for (const alias of aliases) {
    const actual = byNormalized.get(alias);
    if (actual && !claimed?.has(actual)) return actual;
  }
  return undefined;
}

function assertRowCap(n: number): void {
  if (n > MAX_ROWS) {
    throw new Error(`File has ${n.toLocaleString()} rows — split files above ${MAX_ROWS.toLocaleString()}`);
  }
}

/** exceljs cells can be richtext/formula/hyperlink/date objects, not just scalars. */
function cellToString(cell: { value: unknown; text?: string }): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.result === "number" || typeof o.result === "string") return String(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => (r as { text: string }).text).join("");
    if (typeof cell.text === "string") return cell.text;
    return "";
  }
  return String(v);
}

/**
 * Parse a CSV/TSV or Excel file into header-keyed rows.
 *
 * Excel is parsed server-side deliberately: exceljs sits behind
 * `exceljsLoader` (an ESM/CJS interop shim) and pulling it into the browser
 * bundle to read a monthly file would cost every page load.
 *
 * Pass a Buffer for spreadsheets. A string is accepted for delimited text; if a
 * string is passed for a spreadsheet it is treated as base64.
 */
export async function parseTabularFile(
  content: Buffer | string,
  fileName: string,
): Promise<ParsedTable> {
  if (!isSpreadsheet(fileName)) {
    const text = typeof content === "string" ? content : content.toString("utf8");
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const rows = (parsed.data ?? []) as Record<string, string>[];
    assertRowCap(rows.length);
    return {
      headers: parsed.meta?.fields ?? Object.keys(rows[0] ?? {}),
      rows,
      parseErrors: (parsed.errors ?? []).slice(0, 10).map(
        (e) => `row ${typeof e.row === "number" ? e.row + 2 : "?"}: ${e.message}`,
      ),
    };
  }

  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    (typeof content === "string" ? Buffer.from(content, "base64") : content) as never,
  );
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [], parseErrors: ["Workbook contains no worksheets"] };

  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellToString(cell);
    });
    if (rowNumber === 1) {
      for (const v of values) headers.push(String(v ?? "").trim());
      return;
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) rec[h] = values[i] ?? ""; });
    // Trailing blank rows are endemic in exported sheets.
    if (Object.values(rec).some((v) => String(v).trim() !== "")) rows.push(rec);
  });
  assertRowCap(rows.length);
  return { headers, rows, parseErrors: [] };
}
