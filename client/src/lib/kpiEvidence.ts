/**
 * KPI evidence pack builder (gap-closure plan WS-1 engineering support).
 *
 * Turns a KPI report into the quantified-outcomes artifacts the case-study
 * pipeline needs — "our false positive rate is 1.8% versus the 2% target" as
 * a file a CFO can hold: a machine-readable CSV and the row model the PDF
 * export draws. Pure functions (no DOM, no React) so they are unit-tested in
 * node; the PDF rendering itself lives in PocKpiDashboard (jsPDF, browser).
 *
 * Structural types mirror server/routers/pocKpi.ts KpiReport — kept local so
 * this module never imports component/server code.
 */

export interface EvidenceMetric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  target: number;
  floor: number;
  higherIsBetter: boolean;
  status: "above_target" | "between" | "below_floor" | "no_data";
  trend: number[];
  runCount: number;
}

export interface EvidenceReport {
  pocSlug: string;
  computedAt: string;
  runCount: number;
  metrics: EvidenceMetric[];
}

export const STATUS_LABELS: Record<EvidenceMetric["status"], string> = {
  above_target: "On target",
  between: "Between target and floor",
  below_floor: "Below floor",
  no_data: "No data yet",
};

export function formatMetricValue(m: Pick<EvidenceMetric, "value" | "unit">): string {
  if (m.value === null || m.value === undefined) return "—";
  return m.unit === "%" ? `${m.value}%` : `${m.value} ${m.unit}`.trim();
}

/** One evidence sentence per metric — the quotable line for case-study copy. */
export function evidenceSentence(m: EvidenceMetric): string {
  if (m.value === null) return `${m.label}: no data yet.`;
  const rel = m.higherIsBetter
    ? (m.value >= m.target ? "meets" : m.value >= m.floor ? "approaches" : "is below")
    : (m.value <= m.target ? "meets" : m.value <= m.floor ? "approaches" : "is below");
  return `${m.label} of ${formatMetricValue(m)} ${rel} the ${m.target}${m.unit === "%" ? "%" : ` ${m.unit}`} target (floor ${m.floor}${m.unit === "%" ? "%" : ""}).`;
}

/** Table rows shared by the CSV and the PDF (header row first). */
export function buildEvidenceRows(report: EvidenceReport): string[][] {
  const rows: string[][] = [
    ["Metric", "Value", "Target", "Floor", "Status", "Trend (oldest→newest)", "Runs"],
  ];
  for (const m of report.metrics) {
    rows.push([
      m.label,
      formatMetricValue(m),
      `${m.target}${m.unit === "%" ? "%" : ""}`,
      `${m.floor}${m.unit === "%" ? "%" : ""}`,
      STATUS_LABELS[m.status],
      m.trend.length > 0 ? m.trend.join(" → ") : "—",
      String(m.runCount),
    ]);
  }
  return rows;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The CSV half of the pack: provenance header block, metric table, sentences. */
export function buildEvidenceCsv(report: EvidenceReport, title: string): string {
  const lines: string[] = [
    csvCell(`${title} — KPI Evidence Pack`),
    csvCell(`Generated,${new Date(report.computedAt).toISOString()}`),
    `Engagement,${csvCell(report.pocSlug)}`,
    `Reconciliation runs analysed,${report.runCount}`,
    `Source,ReconcileAI live KPI dashboard (www.reconcileaiafrica.com)`,
    "",
  ];
  for (const row of buildEvidenceRows(report)) {
    lines.push(row.map(csvCell).join(","));
  }
  lines.push("");
  lines.push("Evidence statements");
  for (const m of report.metrics) {
    lines.push(csvCell(evidenceSentence(m)));
  }
  return lines.join("\r\n") + "\r\n";
}

export function evidenceFilename(pocSlug: string, ext: "csv" | "pdf"): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = pocSlug.replace(/[^a-z0-9_-]/gi, "_");
  return `reconcileai-kpi-evidence-${slug}-${date}.${ext}`;
}
