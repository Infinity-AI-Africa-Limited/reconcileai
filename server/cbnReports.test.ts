/**
 * Tests for the CBN report engine's pure formatting layer.
 *
 * toCsv() produces the CBN-format artifact: an institution identity header
 * block, the schedule table, and a summary block. Examiners consume this file
 * directly, so the shape is pinned here: header lines present and ordered,
 * values quoted/escaped correctly, all rows serialized, summary appended.
 */
import { describe, expect, it } from "vitest";
import { toCsv, type ReportResult } from "./cbnReports";

const sample: ReportResult = {
  meta: {
    title: "DAILY RECONCILIATION SUMMARY",
    institutionName: "Acme Microfinance Bank",
    institutionType: "Microfinance Bank (MFB)",
    rcNumber: "RC123456",
    cbnLicenseNumber: "MFB/2020/001",
    cbnInstitutionCode: "090999",
    periodLabel: "05 July 2026",
    preparedBy: "Jane Doe, Head of Reconciliation",
    generatedAt: "2026-07-06T00:00:00.000Z",
    currency: "NGN",
    regulatoryBasis: "CBN Guidelines; NIBSS Operating Rules",
  },
  columns: ["S/N", "Channel", "Match Rate (%)", "Status"],
  rows: [
    [1, "NIBSS vs Core Banking", "96.20", "COMPLIANT"],
    [2, 'POS, "Lagos" region', "91.00", "BREACH"], // comma + quotes need escaping
  ],
  summary: { "Overall match rate (%)": "94.10", "Daily reconciliation performed": "YES" },
};

describe("toCsv — CBN-format serialization", () => {
  const csv = toCsv(sample);
  const lines = csv.split("\n");

  it("starts with a BOM so Excel opens ₦/UTF-8 content correctly", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("emits the institution identity header block in order", () => {
    expect(lines[0]).toContain("DAILY RECONCILIATION SUMMARY");
    expect(lines[1]).toContain("Acme Microfinance Bank");
    expect(lines[2]).toContain("Microfinance Bank (MFB)");
    expect(lines[3]).toContain("RC123456");
    expect(lines[3]).toContain("MFB/2020/001");
    expect(lines[3]).toContain("090999");
    expect(lines[4]).toContain("05 July 2026");
    expect(lines[6]).toContain("CBN Guidelines");
  });

  it("serializes the column header and every data row", () => {
    expect(csv).toContain("S/N,Channel,Match Rate (%),Status");
    expect(csv).toContain("1,NIBSS vs Core Banking,96.20,COMPLIANT");
  });

  it("escapes commas and quotes per RFC 4180", () => {
    expect(csv).toContain('"POS, ""Lagos"" region"');
  });

  it("appends the summary block", () => {
    const summaryIdx = lines.findIndex((l) => l === '"Summary"');
    expect(summaryIdx).toBeGreaterThan(0);
    expect(csv).toContain("Overall match rate (%),94.10");
    expect(csv).toContain("Daily reconciliation performed,YES");
  });
});
