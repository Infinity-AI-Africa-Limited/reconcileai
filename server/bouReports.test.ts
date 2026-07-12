/**
 * BoU report pack (G2): the regulator-aware CSV identity block. The data-heavy
 * builders need a DB; here we lock the regulator/currency labelling that makes
 * one report engine serve both CBN (Nigeria) and BoU (Uganda).
 */
import { describe, expect, it } from "vitest";
import { toCsv, type ReportResult } from "./cbnReports";

function fakeReport(regulator: "CBN" | "BoU", currency: string): ReportResult {
  return {
    meta: {
      title: "TEST RETURN",
      institutionName: "Test Institution",
      institutionType: "Commercial Bank",
      rcNumber: "RC-1",
      cbnLicenseNumber: "LIC-1",
      cbnInstitutionCode: "IC-1",
      periodLabel: "2026-07-01 to 2026-07-31",
      preparedBy: "Ops",
      generatedAt: new Date("2026-07-31T00:00:00Z").toISOString(),
      currency,
      regulatoryBasis: "Test basis",
      regulator,
    },
    columns: ["A", "B"],
    rows: [[1, "x"]],
    summary: { Total: 1 },
  };
}

describe("toCsv — regulator-aware identity block", () => {
  it("labels a CBN return with RC Number / CBN Licence / NGN", () => {
    const csv = toCsv(fakeReport("CBN", "NGN"));
    expect(csv).toContain("RC Number:");
    expect(csv).toContain("CBN Licence:");
    expect(csv).toContain('"Currency:","NGN"');
    expect(csv).not.toContain("BoU Licence:");
  });

  it("labels a BoU return with Registration No. / BoU Licence / UGX", () => {
    const csv = toCsv(fakeReport("BoU", "UGX"));
    expect(csv).toContain("Registration No.:");
    expect(csv).toContain("BoU Licence:");
    expect(csv).toContain('"Currency:","UGX"');
    expect(csv).not.toContain("CBN Licence:");
  });

  it("keeps the shared table/summary structure regardless of regulator", () => {
    const csv = toCsv(fakeReport("BoU", "UGX"));
    expect(csv).toContain('"TEST RETURN"');
    expect(csv).toContain('"Summary"');
    expect(csv).toContain("Total,1");
  });
});
