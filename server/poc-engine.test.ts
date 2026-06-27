import { describe, it, expect } from "vitest";
import {
  runLayer1, runLayer2, runLayer3, parseAmount, sniffFileType, isPdfBytes, extractTransactions,
  csvToMatrix, parseStructuredStatement, type CanonicalRow,
} from "./poc-engine";

const ledger: CanonicalRow[] = [
  { date: "2026-01-10", description: "Payment A", amount: 5000, direction: "debit", reference: "REF-1" },
  { date: "2026-01-11", description: "Cheque 22", amount: 200000, direction: "debit", reference: "REF-2" },
];
const statement: CanonicalRow[] = [
  { date: "2026-01-10", description: "Payment A", amount: 5000, direction: "debit", reference: "REF-1" },
  { date: "2026-01-12", description: "Bank charge", amount: 1500, direction: "debit", reference: "CHG-9" },
];

describe("POC extraction — parseAmount", () => {
  it("passes through finite numbers as their absolute value", () => {
    expect(parseAmount(16576000)).toBe(16576000);
    expect(parseAmount(-1500)).toBe(1500); // direction is tracked separately
    expect(parseAmount(0)).toBe(0);
  });

  it("parses real bank-statement string formats (currency, thousands, parens)", () => {
    expect(parseAmount("₦16,576,000.00")).toBe(16576000);
    expect(parseAmount("16,576,000.00")).toBe(16576000);
    expect(parseAmount("(1,234.56)")).toBe(1234.56); // parenthesised negative
    expect(parseAmount("  8,383,500.00  ")).toBe(8383500);
    expect(parseAmount("$2,000")).toBe(2000);
  });

  it("returns 0 for unparseable / empty values so they get filtered out", () => {
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("N/A")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount(NaN)).toBe(0);
  });
});

describe("POC extraction — sniffFileType", () => {
  const declare = (bytes: number[], declared: "csv" | "excel") =>
    sniffFileType(Buffer.from(bytes), declared);

  it("overrides a lying extension when bytes are an xlsx (ZIP) — the statement.xlsx(14).csv case", () => {
    // "PK\x03\x04" — an Excel workbook mislabeled as .csv would otherwise read as gibberish.
    expect(declare([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], "csv")).toBe("excel");
  });

  it("keeps the declared type for genuine text/CSV content", () => {
    const csv = Buffer.from("Date,Description,Amount\n2026-01-02,Advance,16576000\n", "utf8");
    expect(sniffFileType(csv, "csv")).toBe("csv");
  });

  it("falls back to text for a CSV misnamed .xlsx (non-ZIP bytes declared excel)", () => {
    const csv = Buffer.from("Date,Description,Amount\n2026-01-02,Advance,16576000\n", "utf8");
    expect(sniffFileType(csv, "excel")).toBe("csv");
  });

  it("still treats a real xlsx workbook as excel", () => {
    expect(sniffFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "excel")).toBe("excel");
  });
});

describe("POC extraction — PDF is rejected (CSV/Excel only)", () => {
  const pdfBase64 = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj", "latin1").toString("base64");

  it("isPdfBytes detects %PDF magic", () => {
    expect(isPdfBytes(Buffer.from("%PDF-1.7", "latin1"))).toBe(true);
    expect(isPdfBytes(Buffer.from("Date,Amount\n", "utf8"))).toBe(false);
  });

  it("extractTransactions rejects a PDF even when uploaded as .csv", async () => {
    // A PDF mislabeled .csv must fail clearly (never reach the LLM) — no API key needed.
    await expect(
      extractTransactions({ fileType: "csv", base64: pdfBase64, fileName: "statement.csv" }),
    ).rejects.toThrow(/PDF files aren't supported/);
  });
});

describe("POC extraction — parseStructuredStatement", () => {
  // A ProvidusBank-style statement: account preamble, a header row with separate
  // DEBIT/CREDIT columns, transaction rows, then a totals footer + disclaimer.
  const bankCsv = [
    "STATEMENT OF ACCOUNT,,,,,",
    ",,,,,",
    "CUST. NAME,SALAD TECHNOLOGIES LIMITED,,START DATE,01-01-2026,",
    "CURRENCY,NGN,,,,",
    ",,,,,",
    "TXN DATE,VAL DATE,REMARKS,DEBIT,CREDIT,BALANCE",
    "02-01-2026,24-06-2026,INWARD TRANSFER FROM LOTUS BANK,,100000000,131376988.5",
    "02-01-2026,24-06-2026,OUTWARD TRANSFER TO MAHMUD,\"16,576,000.00\",,114800988.5",
    "03-01-2026,24-06-2026,STAMP DUTY,50,,114800938.5",
    ",,,,,",
    "TOTAL DEBIT,6243240395,,,,",
    "DEB. COUNT,2,,,,",
  ].join("\n");

  it("parses a bank statement with separate debit/credit columns", () => {
    const res = parseStructuredStatement(csvToMatrix(bankCsv));
    expect(res).not.toBeNull();
    const rows = res!.rows;
    expect(rows.length).toBe(3); // footer/total rows are skipped (no debit or credit)
    expect(res!.currency).toBe("NGN");
    // Direction derives from which column holds the value.
    expect(rows[0]).toMatchObject({ amount: 100000000, direction: "credit", date: "2026-01-02" });
    expect(rows[1]).toMatchObject({ amount: 16576000, direction: "debit" }); // "16,576,000.00" parsed
    expect(rows[1].description).toContain("OUTWARD TRANSFER");
    // Dates normalised from DD-MM-YYYY to ISO so both sides match in the date window.
    expect(rows[2].date).toBe("2026-01-03");
  });

  it("parses an amount + explicit direction column", () => {
    const csv = [
      "Date,Narration,Amount,Type",
      "2026-01-02,Bank charge,1500,Debit",
      "2026-01-03,Interest,200,Credit",
    ].join("\n");
    const res = parseStructuredStatement(csvToMatrix(csv));
    expect(res!.rows).toHaveLength(2);
    expect(res!.rows[0]).toMatchObject({ amount: 1500, direction: "debit" });
    expect(res!.rows[1]).toMatchObject({ amount: 200, direction: "credit" });
  });

  it("returns null for a bare amount column with no direction (trade ledger → LLM)", () => {
    // The Salad 'Credit Tracker' shape: a generic Amount with no debit/credit or type.
    const ledger = [
      "Date,Product,Supplier,Buyer,Qty,Landing Cost,Amount,Expected Margin",
      "2026-01-02,Advance,Mahmud,WASIL,40000,518,16576000,12",
    ].join("\n");
    expect(parseStructuredStatement(csvToMatrix(ledger))).toBeNull();
  });

  it("returns null when no recognizable table header exists", () => {
    const junk = "hello world\nfoo,bar,baz\n1,2,3\n";
    expect(parseStructuredStatement(csvToMatrix(junk))).toBeNull();
  });
});

describe("POC Layer 1 — balance", () => {
  it("detects a net variance between ledger and statement", () => {
    const l1 = runLayer1(ledger, statement, "NGN");
    expect(l1.ledgerCount).toBe(2);
    expect(l1.statementCount).toBe(2);
    expect(l1.ledgerNet).toBe(-205000); // both debits
    expect(l1.statementNet).toBe(-6500);
    expect(l1.varianceAmount).toBe(-198500);
    expect(l1.status).toBe("VARIANCE_DETECTED");
  });

  it("reports BALANCED when the nets agree", () => {
    const same = runLayer1(ledger, ledger, "NGN");
    expect(same.varianceAmount).toBe(0);
    expect(same.status).toBe("BALANCED");
  });
});

describe("POC Layer 2 — exceptions", () => {
  it("matches the common item and flags the unmatched ones on each side", () => {
    const l2 = runLayer2(ledger, statement);
    expect(l2.matchedCount).toBe(1); // REF-1 matches
    const cats = l2.exceptions.map((e) => e.category).sort();
    expect(cats).toEqual(["IN_BANK_NOT_IN_LEDGER", "IN_LEDGER_NOT_IN_BANK"]);

    const ledgerOnly = l2.exceptions.find((e) => e.category === "IN_LEDGER_NOT_IN_BANK");
    expect(ledgerOnly?.reference).toBe("REF-2");
    expect(ledgerOnly?.amount).toBe(200000);

    const bankOnly = l2.exceptions.find((e) => e.category === "IN_BANK_NOT_IN_LEDGER");
    expect(bankOnly?.reference).toBe("CHG-9");
    expect(bankOnly?.amount).toBe(1500);
  });
});

describe("POC Layer 3 — AI agent", () => {
  it("assigns priority by amount and attaches an explanation + action", () => {
    const l2 = runLayer2(ledger, statement);
    const l3 = runLayer3(l2.exceptions);
    const high = l3.find((e) => e.reference === "REF-2");
    const low = l3.find((e) => e.reference === "CHG-9");
    expect(high?.priorityLevel).toBe("HIGH"); // 200,000
    expect(low?.priorityLevel).toBe("LOW"); // 1,500
    for (const e of l3) {
      expect(e.agentExplanation.length).toBeGreaterThan(0);
      expect(e.recommendedAction.length).toBeGreaterThan(0);
      expect(e.agentConfidence).toBeGreaterThan(0);
    }
  });
});
