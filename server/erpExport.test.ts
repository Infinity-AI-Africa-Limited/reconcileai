/**
 * ERP journal-entry export — Unit Tests (gap-closure plan WS-7)
 */
import { describe, it, expect } from "vitest";
import {
  buildJournalEntries,
  assertBalanced,
  csvCell,
  toSapB1Dtw,
  toSage300Csv,
  toQuickBooksCsv,
  renderErpExport,
  RECON_CONTROL_ACCOUNT,
  DEFAULT_GL_MAPPING,
  ERP_TARGETS,
  type ResolvedExceptionRow,
} from "./erpExport";

const JOB = { id: 42, name: "June NIP vs CBS", completedAt: new Date("2026-06-30T12:00:00Z") };

function row(overrides: Partial<ResolvedExceptionRow> & { id: number }): ResolvedExceptionRow {
  return {
    category: "amount_mismatch",
    currency: "NGN",
    amount: 5000,
    transactionRef: `REF-${overrides.id}`,
    resolvedAt: new Date("2026-07-01T09:00:00Z"),
    resolutionNotes: null,
    ...overrides,
  };
}

describe("buildJournalEntries", () => {
  it("creates one balanced two-line entry per resolved exception", () => {
    const entries = buildJournalEntries([row({ id: 1 }), row({ id: 2, category: "fx_rate_variance", amount: 120.5 })], JOB);
    expect(entries).toHaveLength(2);
    expect(() => assertBalanced(entries)).not.toThrow();

    const [a, b] = entries;
    expect(a.lines[0].account).toBe(DEFAULT_GL_MAPPING.amount_mismatch.debitAccount);
    expect(a.lines[0].debit).toBe(5000);
    expect(a.lines[1].account).toBe(RECON_CONTROL_ACCOUNT);
    expect(a.lines[1].credit).toBe(5000);
    expect(b.lines[0].account).toBe(DEFAULT_GL_MAPPING.fx_rate_variance.debitAccount);
    expect(b.currency).toBe("NGN");
  });

  it("skips zero-amount exceptions and uses fallback mapping for unknown categories", () => {
    const entries = buildJournalEntries(
      [row({ id: 1, amount: 0 }), row({ id: 2, category: "mystery_category" })],
      JOB,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].lines[0].account).toBe("1895-RECON-SUSPENSE");
  });

  it("uses absolute amounts, the resolvedAt date, and carries the exception currency", () => {
    const entries = buildJournalEntries(
      [row({ id: 3, amount: -750.25, currency: "USD", resolvedAt: new Date("2026-07-02T00:00:00Z") })],
      JOB,
    );
    expect(entries[0].lines[0].debit).toBe(750.25);
    expect(entries[0].date).toBe("2026-07-02");
    expect(entries[0].currency).toBe("USD");
  });

  it("assertBalanced throws on a cooked unbalanced entry", () => {
    const entries = buildJournalEntries([row({ id: 1 })], JOB);
    entries[0].lines[0].debit = 9999;
    expect(() => assertBalanced(entries)).toThrow(/unbalanced/);
  });
});

describe("csvCell", () => {
  it("quotes and escapes only when needed", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("with,comma")).toBe('"with,comma"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("formatters", () => {
  const entries = buildJournalEntries([row({ id: 1 }), row({ id: 2, category: "fx_rate_variance" })], JOB);

  it("SAP B1 DTW produces the OJDT/JDT1 pair with exact headers", () => {
    const { header, lines } = toSapB1Dtw(entries);
    expect(header.split("\r\n")[0]).toBe("RecordKey,ReferDate,TaxDate,Memo,Reference");
    expect(lines.split("\r\n")[0]).toBe("RecordKey,LineNum,AccountCode,Debit,Credit,LineMemo,Reference1");
    // 2 entries → 2 header rows; 4 line rows; LineNum restarts at 0 per entry
    expect(header.trim().split("\r\n")).toHaveLength(3);
    expect(lines.trim().split("\r\n")).toHaveLength(5);
    const firstLine = lines.trim().split("\r\n")[1].split(",");
    expect(firstLine[0]).toBe("1"); // RecordKey ties line to header
    expect(firstLine[1]).toBe("0"); // LineNum
    expect(firstLine[3]).toBe("5000.00"); // Debit
    expect(firstLine[4]).toBe(""); // Credit empty on debit line
  });

  it("Sage 300 uses signed amounts, YYYYMMDD dates, and line numbers stepping by 20", () => {
    const csv = toSage300Csv(entries);
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe("ENTRYNUMBER,LINENUMBER,ACCOUNTID,TRANSAMOUNT,JOURNALDATE,SOURCECODE,REFERENCE,DESCRIPTION,CURRENCY");
    const debit = rows[1].split(",");
    const credit = rows[2].split(",");
    expect(debit[1]).toBe("20");
    expect(credit[1]).toBe("40");
    expect(debit[3]).toBe("5000.00");
    expect(credit[3]).toBe("-5000.00"); // credit = negative
    expect(debit[4]).toBe("20260701");
    expect(debit[5]).toBe("GL-JE");
  });

  it("QuickBooks CSV uses Debits/Credits columns with the journal number repeated per line", () => {
    const csv = toQuickBooksCsv(entries);
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe("JournalNo,JournalDate,Currency,Memo,AccountName,Debits,Credits,Description");
    expect(rows).toHaveLength(5); // header + 2 entries × 2 lines
    const first = rows[1].split(",");
    expect(first[0]).toBe("1");
    expect(first[2]).toBe("NGN");
  });

  it("renderErpExport covers every target and names files per convention", () => {
    for (const target of ERP_TARGETS) {
      const files = renderErpExport(target, entries, JOB.id);
      expect(files.length).toBe(target === "sap_b1" ? 2 : 1);
      for (const f of files) {
        expect(f.filename).toContain(`job${JOB.id}`);
        expect(f.filename.endsWith(".csv")).toBe(true);
        expect(f.content.length).toBeGreaterThan(50);
      }
    }
  });
});
