/**
 * PocKpiDashboard — Shared KPI dashboard component for all three POC pages.
 *
 * Renders a grid of KPI metric cards, each showing:
 *   • Current value vs. Target and Floor benchmarks
 *   • A horizontal gauge bar with colour-coded zones (green / amber / red)
 *   • A mini sparkline trend chart (last N runs)
 *   • A status badge (On Target / Near Floor / Below Floor / No Data)
 *
 * Used by WoodcorePOC, LapoPOC, and SaladAfricaPOC pages.
 */
import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ─── Types (mirrors server/routers/pocKpi.ts) ────────────────────────────────

export interface KpiMetric {
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

export interface KpiReport {
  pocSlug: string;
  computedAt: string;
  runCount: number;
  metrics: KpiMetric[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusConfig(status: KpiMetric["status"]) {
  switch (status) {
    case "above_target":
      return { label: "On Target", color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200", icon: CheckCircle2 };
    case "between":
      return { label: "Near Floor", color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200", icon: AlertTriangle };
    case "below_floor":
      return { label: "Below Floor", color: "text-red-600", bg: "bg-red-50", border: "border-red-200", icon: AlertTriangle };
    default:
      return { label: "No Data", color: "text-slate-400", bg: "bg-slate-50", border: "border-slate-200", icon: Info };
  }
}

function gaugePercent(value: number, target: number, floor: number, higherIsBetter: boolean): number {
  // Normalize value to 0–100 for the gauge bar
  if (higherIsBetter) {
    // 0% = 0, 100% = target (or beyond)
    return Math.min(100, Math.max(0, (value / target) * 100));
  } else {
    // Lower is better: 0% = target (perfect), 100% = floor (bad)
    // Invert: 100% fill = at target, 0% = at floor or worse
    const range = floor - target;
    if (range <= 0) return value <= target ? 100 : 0;
    return Math.min(100, Math.max(0, ((floor - value) / range) * 100));
  }
}

function gaugeColor(status: KpiMetric["status"]): string {
  switch (status) {
    case "above_target": return "bg-emerald-500";
    case "between":      return "bg-amber-400";
    case "below_floor":  return "bg-red-500";
    default:             return "bg-slate-300";
  }
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "s") return `${value}s`;
  return String(value);
}

// ─── Mini Sparkline (pure SVG, no chart library needed) ──────────────────────

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-8 flex items-center text-xs text-slate-400">—</div>;

  const w = 80;
  const h = 28;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = points.join(" ");
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const delta = last - prev;

  return (
    <div className="flex items-center gap-1">
      <svg width={w} height={h} className="shrink-0">
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Last point dot */}
        <circle
          cx={parseFloat(points[points.length - 1].split(",")[0])}
          cy={parseFloat(points[points.length - 1].split(",")[1])}
          r="2"
          fill={color}
        />
      </svg>
      <span className={`text-xs font-medium ${delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-500" : "text-slate-400"}`}>
        {delta > 0 ? <TrendingUp size={12} className="inline" /> : delta < 0 ? <TrendingDown size={12} className="inline" /> : <Minus size={12} className="inline" />}
      </span>
    </div>
  );
}

// ─── Single KPI Card ─────────────────────────────────────────────────────────

function KpiCard({ metric }: { metric: KpiMetric }) {
  const sc = statusConfig(metric.status);
  const StatusIcon = sc.icon;
  const fillPct = metric.value !== null
    ? gaugePercent(metric.value, metric.target, metric.floor, metric.higherIsBetter)
    : 0;
  const barColor = gaugeColor(metric.status);

  // Compute floor marker position on the bar
  const floorPct = gaugePercent(metric.floor, metric.target, metric.floor, metric.higherIsBetter);

  const sparkColor = metric.status === "above_target" ? "#10b981" : metric.status === "between" ? "#f59e0b" : "#ef4444";

  return (
    <div className={`rounded-lg border p-4 ${sc.bg} ${sc.border} flex flex-col gap-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-tight">{metric.label}</p>
          <p className={`text-2xl font-bold mt-0.5 ${sc.color}`}>
            {formatValue(metric.value, metric.unit)}
          </p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${sc.bg} ${sc.border} ${sc.color} cursor-default shrink-0`}>
                <StatusIcon size={11} />
                {sc.label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              <p><strong>Target:</strong> {formatValue(metric.target, metric.unit)}</p>
              <p><strong>Floor:</strong> {formatValue(metric.floor, metric.unit)}</p>
              <p className="mt-1 text-slate-400">Based on {metric.runCount} run{metric.runCount !== 1 ? "s" : ""}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Gauge bar */}
      <div className="space-y-1">
        <div className="relative h-2 bg-slate-200 rounded-full overflow-visible">
          {/* Fill */}
          <div
            className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${fillPct}%` }}
          />
          {/* Floor marker */}
          <div
            className="absolute top-[-3px] h-[14px] w-[2px] bg-amber-500 rounded-full"
            style={{ left: `${floorPct}%` }}
            title={`Floor: ${formatValue(metric.floor, metric.unit)}`}
          />
          {/* Target marker (right edge = 100%) */}
          <div className="absolute top-[-3px] right-0 h-[14px] w-[2px] bg-emerald-600 rounded-full" title={`Target: ${formatValue(metric.target, metric.unit)}`} />
        </div>
        <div className="flex justify-between text-[10px] text-slate-400">
          <span>0{metric.unit}</span>
          <span className="text-amber-600">Floor {formatValue(metric.floor, metric.unit)}</span>
          <span className="text-emerald-600">Target {formatValue(metric.target, metric.unit)}</span>
        </div>
      </div>

      {/* Sparkline trend */}
      {metric.trend.length >= 2 && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400">Trend ({metric.trend.length} runs)</span>
          <Sparkline data={metric.trend} color={sparkColor} />
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

interface PocKpiDashboardProps {
  report: KpiReport | null | undefined;
  isLoading?: boolean;
  title?: string;
  subtitle?: string;
  accentColor?: string; // CSS hex for the section header accent
}

export function PocKpiDashboard({
  report,
  isLoading,
  title = "POC KPI Dashboard",
  subtitle,
  accentColor = "#0f172a",
}: PocKpiDashboardProps) {
  const summary = useMemo(() => {
    if (!report) return null;
    const total = report.metrics.length;
    const onTarget = report.metrics.filter((m) => m.status === "above_target").length;
    const between = report.metrics.filter((m) => m.status === "between").length;
    const below = report.metrics.filter((m) => m.status === "below_floor").length;
    const noData = report.metrics.filter((m) => m.status === "no_data").length;
    return { total, onTarget, between, below, noData };
  }, [report]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-slate-200 rounded w-48" />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-32 bg-slate-100 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!report || report.metrics.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center">
        <Info size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-sm font-medium text-slate-500">No KPI data yet</p>
        <p className="text-xs text-slate-400 mt-1">Run a reconciliation to start tracking KPIs.</p>
      </div>
    );
  }

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <span
                className="inline-block w-1 h-5 rounded-full"
                style={{ backgroundColor: accentColor }}
              />
              {title}
            </CardTitle>
            {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
            <p className="text-xs text-slate-400 mt-0.5">
              Based on {report.runCount} reconciliation run{report.runCount !== 1 ? "s" : ""} ·{" "}
              Updated {new Date(report.computedAt).toLocaleString()}
            </p>
          </div>

          {/* Summary pill row */}
          {summary && (
            <div className="flex flex-wrap gap-2">
              {summary.onTarget > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <CheckCircle2 size={11} /> {summary.onTarget} On Target
                </span>
              )}
              {summary.between > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  <AlertTriangle size={11} /> {summary.between} Near Floor
                </span>
              )}
              {summary.below > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200">
                  <AlertTriangle size={11} /> {summary.below} Below Floor
                </span>
              )}
              {summary.noData > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-50 text-slate-500 border border-slate-200">
                  <Info size={11} /> {summary.noData} No Data
                </span>
              )}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 text-[10px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-1.5 rounded-full bg-emerald-500" /> Above target
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-1.5 rounded-full bg-amber-400" /> Between target & floor
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-1.5 rounded-full bg-red-500" /> Below floor
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-0.5 h-3 rounded-full bg-amber-500" /> Floor marker
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-0.5 h-3 rounded-full bg-emerald-600" /> Target marker
          </span>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {report.metrics.map((m) => (
            <KpiCard key={m.key} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
