import { describe, it, expect } from "vitest";
import { runLayer1, runLayer2, runLayer3, parseAmount, sniffFileType, type CanonicalRow } from "./poc-engine";

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
  const declare = (bytes: number[], declared: "csv" | "excel" | "pdf") =>
    sniffFileType(Buffer.from(bytes), declared);

  it("overrides a lying extension when bytes are an xlsx (ZIP) — the statement.xlsx(14).csv case", () => {
    // "PK\x03\x04" — an Excel workbook mislabeled as .csv would otherwise read as gibberish.
    expect(declare([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], "csv")).toBe("excel");
  });

  it("detects a PDF by magic bytes regardless of declared type", () => {
    expect(declare([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "csv")).toBe("pdf"); // "%PDF-1"
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
