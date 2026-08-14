/**
 * Shared ingestion core + the bank-path money bugs it fixes.
 *
 * Before unification the bank/SFTP path coerced money with
 * `parseFloat(String(x).replace(/[^0-9.-]/g, ""))`, which:
 *   - turned the accounting negative "(12.30)" into +12.30 — a refund posted as
 *     a credit, inverting the sign of real money;
 *   - turned the European "1.234,56" into 1.23456 — off by three orders of
 *     magnitude.
 * Both produced numbers that still looked plausible, so nothing downstream
 * would flag them. These tests exist so that cannot come back.
 */
import { describe, it, expect } from "vitest";
import {
  parseAmount,
  parseDate,
  normalizeHeader,
  resolveColumn,
  isSpreadsheet,
  parseTabularFile,
} from "./ingest/fileParser";
import { parseAndValidateCsv } from "./apiIngestionService";

describe("parseAmount — the bank-path regressions", () => {
  it("preserves the sign of an accounting negative", () => {
    // Old behaviour: +12.30. A refund would have posted as a credit.
    expect(parseAmount("(12.30)")).toBe(-12.3);
    expect(parseAmount("(1,234.56)")).toBeCloseTo(-1234.56, 2);
  });

  it("reads European decimals at the right magnitude", () => {
    // Old behaviour: 1.23456 — three orders of magnitude out.
    expect(parseAmount("1.234,56")).toBeCloseTo(1234.56, 2);
    expect(parseAmount("1.234.567,89")).toBeCloseTo(1234567.89, 2);
  });

  it("does not mistake thousands grouping for a decimal", () => {
    expect(parseAmount("₦ 12,000")).toBe(12000);
    expect(parseAmount("12,000")).toBe(12000);
    expect(parseAmount("1,234,567.89")).toBeCloseTo(1234567.89, 2);
  });

  it("still reads ordinary values", () => {
    expect(parseAmount("1234.56")).toBeCloseTo(1234.56, 2);
    expect(parseAmount("$1,234.56")).toBeCloseTo(1234.56, 2);
    expect(parseAmount("-45.00")).toBe(-45);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount(42)).toBe(42);
  });

  it("returns null rather than NaN for unreadable input", () => {
    for (const v of ["", "   ", "n/a", "-", ".", undefined, null]) {
      expect(parseAmount(v as string)).toBeNull();
    }
  });
});

describe("parseDate", () => {
  it("never yields an Invalid Date", () => {
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
  it("accepts ISO strings and Date objects", () => {
    expect(parseDate("2026-08-02T10:00:00Z")?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(parseDate(new Date("2026-08-02"))).toBeInstanceOf(Date);
  });
});

describe("header helpers", () => {
  it("normalises case, quotes and spacing", () => {
    expect(normalizeHeader('  "Posting Date" ')).toBe("posting_date");
  });
  it("resolves by alias order and respects claimed columns", () => {
    const headers = ["Posting Date", "Value"];
    expect(resolveColumn(headers, ["date", "posting_date"])).toBe("Posting Date");
    const claimed = new Set(["Posting Date"]);
    expect(resolveColumn(headers, ["posting_date", "value"], claimed)).toBe("Value");
  });
  it("identifies spreadsheets by extension", () => {
    expect(isSpreadsheet("payouts.xlsx")).toBe(true);
    expect(isSpreadsheet("payouts.XLS")).toBe(true);
    expect(isSpreadsheet("payouts.csv")).toBe(false);
  });
});

describe("parseAndValidateCsv — widened header vocabulary", () => {
  it("accepts a bank file headed 'Posting Date' and 'Value'", () => {
    // Previously rejected wholesale: only transactionDate|date|Date and
    // amount|Amount were recognised.
    const csv = "Posting Date,Value,Reference\n2026-08-02,1234.56,REF1\n";
    const r = parseAndValidateCsv(csv, 1);
    expect(r.invalid).toHaveLength(0);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].amount).toBe("1234.56");
    expect(r.valid[0].transactionDate).toBe("2026-08-02");
  });

  it("still reports genuinely malformed rows", () => {
    const csv = "Posting Date,Value\nnot-a-date,abc\n";
    const r = parseAndValidateCsv(csv, 1);
    expect(r.valid).toHaveLength(0);
    expect(r.invalid[0].errors).toEqual(
      expect.arrayContaining(["Invalid amount format", "Invalid date format"]),
    );
  });

  it("flags a row missing both required fields", () => {
    const csv = "Foo,Bar\nx,y\n";
    const r = parseAndValidateCsv(csv, 1);
    expect(r.invalid[0].errors).toEqual(
      expect.arrayContaining(["Missing transaction date", "Missing amount"]),
    );
  });

  // Precedence: an empty `amount` column must not clobber a value resolved
  // from a later alias.
  it("does not let an empty same-named column overwrite the resolved value", () => {
    const csv = "Date,amount,Value\n2026-08-02,,987.65\n";
    const r = parseAndValidateCsv(csv, 1);
    expect(r.invalid).toHaveLength(0);
    expect(r.valid[0].amount).toBe("987.65");
  });
});

describe("parseTabularFile", () => {
  it("parses delimited text", async () => {
    const r = await parseTabularFile("A,B\n1,2\n", "f.csv");
    expect(r.rows).toEqual([{ A: "1", B: "2" }]);
  });

  it("parses a real workbook and drops trailing blank rows", { timeout: 90_000 }, async () => {
    const { loadExcelJS } = await import("./exceljsLoader");
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Posting Date", "Value"]);
    ws.addRow(["2026-08-02", 1234.56]);
    ws.addRow(["", ""]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseTabularFile(buf, "bank.xlsx");
    expect(r.headers).toEqual(["Posting Date", "Value"]);
    expect(r.rows).toHaveLength(1);
    expect(parseAmount(r.rows[0]["Value"])).toBeCloseTo(1234.56, 2);
  });
});
