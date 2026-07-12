/**
 * KPI evidence pack — Unit Tests (gap-closure plan WS-1)
 */
import { describe, it, expect } from "vitest";
import {
  buildEvidenceCsv,
  buildEvidenceRows,
  evidenceSentence,
  evidenceFilename,
  formatMetricValue,
  STATUS_LABELS,
  type EvidenceReport,
  type EvidenceMetric,
} from "./kpiEvidence";

function metric(overrides: Partial<EvidenceMetric>): EvidenceMetric {
  return {
    key: "falsePositiveRate",
    label: "False Positive Rate",
    value: 1.8,
    unit: "%",
    target: 2,
    floor: 5,
    higherIsBetter: false,
    status: "above_target",
    trend: [3.1, 2.4, 1.8],
    runCount: 12,
    ...overrides,
  };
}

const REPORT: EvidenceReport = {
  pocSlug: "lapo_mfb",
  computedAt: "2026-07-12T09:00:00.000Z",
  runCount: 12,
  metrics: [
    metric({}),
    metric({ key: "autoMatchRate", label: "Auto-Match Rate", value: 96.4, target: 95, floor: 85, higherIsBetter: true, trend: [91, 94, 96.4] }),
    metric({ key: "chargebackDetection", label: "Chargeback Detection Rate", value: null, status: "no_data", trend: [] }),
  ],
};

describe("evidence rows and values", () => {
  it("builds a header row plus one row per metric", () => {
    const rows = buildEvidenceRows(REPORT);
    expect(rows).toHaveLength(4);
    expect(rows[0][0]).toBe("Metric");
    expect(rows[1]).toEqual([
      "False Positive Rate", "1.8%", "2%", "5%", "On target", "3.1 → 2.4 → 1.8", "12",
    ]);
    expect(rows[3][1]).toBe("—"); // null value renders as em dash
    expect(rows[3][4]).toBe(STATUS_LABELS.no_data);
  });

  it("formats percentage and unit-suffixed values", () => {
    expect(formatMetricValue({ value: 1.8, unit: "%" })).toBe("1.8%");
    expect(formatMetricValue({ value: 45, unit: "s" })).toBe("45 s");
    expect(formatMetricValue({ value: null, unit: "%" })).toBe("—");
  });
});

describe("evidence sentences (case-study quotables)", () => {
  it("states the value against target and floor", () => {
    expect(evidenceSentence(metric({}))).toBe(
      "False Positive Rate of 1.8% meets the 2% target (floor 5%).",
    );
  });

  it("handles higher-is-better direction and the between band", () => {
    const s = evidenceSentence(metric({
      label: "Auto-Match Rate", value: 90, target: 95, floor: 85, higherIsBetter: true,
    }));
    expect(s).toContain("approaches the 95% target");
  });

  it("handles missing data", () => {
    expect(evidenceSentence(metric({ value: null }))).toBe("False Positive Rate: no data yet.");
  });
});

describe("CSV pack", () => {
  it("contains provenance, the metric table, and evidence statements", () => {
    const csv = buildEvidenceCsv(REPORT, "LAPO MFB POC");
    expect(csv).toContain("LAPO MFB POC — KPI Evidence Pack");
    expect(csv).toContain("Reconciliation runs analysed,12");
    expect(csv).toContain("False Positive Rate,1.8%,2%,5%,On target");
    expect(csv).toContain("Evidence statements");
    expect(csv).toContain("meets the 2% target");
  });

  it("escapes commas and quotes in metric labels", () => {
    const csv = buildEvidenceCsv({
      ...REPORT,
      metrics: [metric({ label: 'Rate, "special"' })],
    }, "T");
    expect(csv).toContain('"Rate, ""special"""');
  });
});

describe("filenames", () => {
  it("is date-stamped and slug-safe", () => {
    const name = evidenceFilename("lapo_mfb", "pdf");
    expect(name).toMatch(/^reconcileai-kpi-evidence-lapo_mfb-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(evidenceFilename("weird/slug!", "csv")).toContain("weird_slug_");
  });
});
