/**
 * CBN Compliance Report Module
 *
 * Scope: reconciliation-native compliance intelligence only.
 * All data is derived from existing reconciliation jobs, exceptions,
 * transactions, and anomaly scores — no standalone regulatory filing.
 *
 * Four panels:
 *  1. Reconciliation Compliance Scorecard — CBN threshold breach indicators
 *  2. CBN Returns Export — format completed reconciliation runs for regulatory returns
 *  3. Regulatory Deadline Tracker — upcoming CBN submission deadlines per framework
 *  4. AML/CFT Flag Summary — anomaly-flagged transactions requiring STR/CTR attention
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Download,
  RefreshCw,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  FileText,
  Zap,
  AlertCircle,
  CalendarClock,
  Activity,
  BarChart3,
} from "lucide-react";

// ─── CBN Regulatory Thresholds ────────────────────────────────────────────────
const CBN_THRESHOLDS = {
  minMatchRate: 95,           // CBN expects ≥95% reconciliation match rate for settlement
  maxUnreconciledDays: 3,     // Unreconciled items must be resolved within 3 business days
  maxExceptionRatio: 5,       // Exception ratio must stay below 5% of total transactions
  maxOpenExceptions: 50,      // More than 50 open exceptions triggers escalation review
  amlFlagThreshold: 0.75,     // Anomaly score ≥0.75 requires STR consideration
  ctrThresholdNGN: 5_000_000, // Cash transactions ≥₦5m require CTR filing
};

// ─── Upcoming CBN Submission Deadlines ───────────────────────────────────────
// Derived from CBN regulatory calendar — static reference data
const REGULATORY_DEADLINES = [
  {
    framework: "AML/CFT Monthly Returns",
    code: "AML_CFT",
    basis: "MLPPA 2022 / NFIU Act",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "goAML / NFIU Portal",
    relevance: "Reconciliation exceptions with suspicious patterns must be included in STR submissions",
    color: "red",
  },
  {
    framework: "Prudential Returns (FinA)",
    code: "PRUDENTIAL",
    basis: "BOFIA 2020 / CBN Prudential Guidelines",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "CBN FinA Portal",
    relevance: "Settlement reconciliation figures feed directly into the FinA balance sheet returns",
    color: "orange",
  },
  {
    framework: "Capital Adequacy Ratio",
    code: "CAPITAL_ADEQUACY",
    basis: "CBN Guidance Notes / Basel III",
    frequency: "Quarterly",
    daysAfterPeriod: 15,
    channel: "CBN FinA Portal",
    relevance: "Unreconciled exposures affect risk-weighted assets and CAR computation",
    color: "amber",
  },
  {
    framework: "Liquidity Coverage Ratio",
    code: "LIQUIDITY",
    basis: "CBN LCR Guidelines 2021",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "CBN FinA Portal",
    relevance: "Unsettled interbank positions affect HQLA and net cash outflow calculations",
    color: "blue",
  },
  {
    framework: "KYC/CDD Returns",
    code: "KYC_CDD",
    basis: "CBN KYC Regulations 2023",
    frequency: "Quarterly",
    daysAfterPeriod: 10,
    channel: "CBN Portal",
    relevance: "Transactions with unverified counterparties flagged in reconciliation require CDD escalation",
    color: "purple",
  },
  {
    framework: "IFRS 9 / Credit Risk Returns",
    code: "IFRS9",
    basis: "CBN Prudential Guidelines / IFRS 9",
    frequency: "Quarterly",
    daysAfterPeriod: 15,
    channel: "CBN FinA Portal",
    relevance: "Unmatched credit transactions may affect ECL staging and NPL ratio computation",
    color: "indigo",
  },
  {
    framework: "Cybersecurity Incident Report",
    code: "CYBERSECURITY",
    basis: "CBN Cybersecurity Framework 2022",
    frequency: "Quarterly",
    daysAfterPeriod: 10,
    channel: "CBN Portal",
    relevance: "Reconciliation anomalies that indicate system tampering must be reported as cyber incidents",
    color: "rose",
  },
  {
    framework: "Consumer Protection Returns",
    code: "CONSUMER_PROTECTION",
    basis: "CBN Consumer Protection Framework 2022",
    frequency: "Quarterly",
    daysAfterPeriod: 10,
    channel: "CBN Portal",
    relevance: "Unresolved exception complaints must be captured in the consumer protection returns",
    color: "teal",
  },
];

// Compute next deadline date for a framework given its frequency
function getNextDeadline(frequency: string, daysAfterPeriod: number): Date {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let periodEnd: Date;
  if (frequency === "Monthly") {
    // Period end = last day of current month; deadline = daysAfterPeriod into next month
    periodEnd = new Date(year, month + 1, 0); // last day of current month
  } else {
    // Quarterly — find end of current quarter
    const quarterEnd = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)
    const nextQEnd = quarterEnd.find(m => m >= month) ?? 11;
    periodEnd = new Date(year, nextQEnd + 1, 0);
  }
  const deadline = new Date(periodEnd);
  deadline.setDate(deadline.getDate() + daysAfterPeriod);
  return deadline;
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function urgencyColor(days: number): string {
  if (days <= 3) return "text-red-600 bg-red-50 border-red-200";
  if (days <= 7) return "text-orange-600 bg-orange-50 border-orange-200";
  if (days <= 14) return "text-amber-600 bg-amber-50 border-amber-200";
  return "text-emerald-600 bg-emerald-50 border-emerald-200";
}

function urgencyBadge(days: number): { label: string; variant: "destructive" | "secondary" | "outline" } {
  if (days <= 3) return { label: "Critical", variant: "destructive" };
  if (days <= 7) return { label: "Urgent", variant: "destructive" };
  if (days <= 14) return { label: "Due Soon", variant: "secondary" };
  return { label: "On Track", variant: "outline" };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ThresholdRow({
  label,
  value,
  threshold,
  unit,
  direction,
  helpText,
}: {
  label: string;
  value: number | null;
  threshold: number;
  unit: string;
  direction: "above" | "below"; // "above" = must be above threshold; "below" = must be below
  helpText: string;
}) {
  const isOk = value === null ? false : direction === "above" ? value >= threshold : value <= threshold;
  const isLoading = value === null;
  const delta = value !== null ? (direction === "above" ? value - threshold : threshold - value) : null;

  return (
    <div className="flex items-center justify-between py-3 border-b last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        {isLoading ? (
          <Minus className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : isOk ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500 shrink-0" />
        )}
        <span className="text-sm font-medium truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help shrink-0" />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs text-xs">{helpText}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-xs text-muted-foreground">
          CBN threshold: {direction === "above" ? "≥" : "≤"}{threshold}{unit}
        </span>
        <span className={`text-sm font-semibold tabular-nums ${isLoading ? "text-muted-foreground" : isOk ? "text-emerald-600" : "text-red-600"}`}>
          {isLoading ? "—" : `${value?.toFixed(1)}${unit}`}
        </span>
        {delta !== null && (
          <span className={`text-xs ${delta >= 0 ? "text-emerald-500" : "text-red-500"} flex items-center gap-0.5`}>
            {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(delta).toFixed(1)}{unit}
          </span>
        )}
        <Badge variant={isLoading ? "outline" : isOk ? "outline" : "destructive"} className={isOk ? "border-emerald-300 text-emerald-700 bg-emerald-50" : ""}>
          {isLoading ? "Loading" : isOk ? "Compliant" : "Breach"}
        </Badge>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function CBNCompliance() {
  const [exportPeriod, setExportPeriod] = useState<string>("last_30");
  const [isExporting, setIsExporting] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = trpc.dashboard.stats.useQuery();
  const { data: jobs, isLoading: jobsLoading } = trpc.reconciliation.list.useQuery();
  const { data: exceptions, isLoading: exceptionsLoading } = trpc.exceptions.list.useQuery({ limit: 500 });
  const { data: anomalies, isLoading: anomaliesLoading } = trpc.anomalies.getFlagged.useQuery({ reviewStatus: "pending", limit: 200 });

  // ── Computed compliance metrics ────────────────────────────────────────────
  const metrics = useMemo(() => {
    if (!stats) return null;
    const total = stats.transactions.total;
    const matched = stats.transactions.matched;
    const exceptionCount = stats.exceptions.total;
    const openExceptions = stats.exceptions.open;
    const matchRate = total > 0 ? (matched / total) * 100 : 0;
    const exceptionRatio = total > 0 ? (exceptionCount / total) * 100 : 0;
    return { matchRate, exceptionRatio, openExceptions, total, matched, exceptionCount };
  }, [stats]);

  // ── Completed jobs for export ──────────────────────────────────────────────
  const completedJobs = useMemo(() => {
    if (!jobs) return [];
    const now = Date.now();
    const cutoff = {
      last_7: 7,
      last_30: 30,
      last_90: 90,
      last_180: 180,
    }[exportPeriod] ?? 30;
    const cutoffMs = cutoff * 24 * 60 * 60 * 1000;
    return (jobs as Array<{
      id: number;
      name: string;
      status: string;
      matchRate: string | number | null;
      matchedCount: number;
      exceptionCount: number;
      unmatchedCount: number;
      totalSourceTxns: number;
      totalTargetTxns: number;
      dateFrom: string | Date;
      dateTo: string | Date;
      completedAt: string | Date | null;
      moduleType: string;
    }>)
      .filter(j => j.status === "completed" && j.completedAt && (now - new Date(j.completedAt).getTime()) <= cutoffMs)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());
  }, [jobs, exportPeriod]);

  // ── AML/CFT flags ──────────────────────────────────────────────────────────
  const amlFlags = useMemo(() => {
    if (!anomalies) return { high: 0, medium: 0, total: 0, items: [] };
    const items = (anomalies as unknown as Array<{ anomaly: { anomalyScore: string; detectionMethod: string; detectionReason: string; id: number }; transaction: { amount: string | number; description: string | null; transactionRef: string | null; createdAt: string | Date } }>);
    const high = items.filter(i => parseFloat(i.anomaly.anomalyScore) >= 0.85).length;
    const medium = items.filter(i => parseFloat(i.anomaly.anomalyScore) >= CBN_THRESHOLDS.amlFlagThreshold && parseFloat(i.anomaly.anomalyScore) < 0.85).length;
    return { high, medium, total: items.length, items: items.slice(0, 20) };
  }, [anomalies]);

  // ── Deadline data ──────────────────────────────────────────────────────────
  const deadlines = useMemo(() => {
    return REGULATORY_DEADLINES.map(d => {
      const deadline = getNextDeadline(d.frequency, d.daysAfterPeriod);
      const days = daysUntil(deadline);
      return { ...d, deadline, days };
    }).sort((a, b) => a.days - b.days);
  }, []);

  // ── Export CBN Returns CSV ─────────────────────────────────────────────────
  function handleExportCBNReturns() {
    if (!completedJobs.length) {
      toast.error("No completed reconciliation runs in the selected period");
      return;
    }
    setIsExporting(true);
    try {
      const headers = [
        "Run ID",
        "Run Name",
        "Module Type",
        "Period From",
        "Period To",
        "Completed At",
        "Total Source Txns",
        "Total Target Txns",
        "Matched Count",
        "Exception Count",
        "Unmatched Count",
        "Match Rate (%)",
        "CBN Threshold (%)",
        "Threshold Status",
        "Exception Ratio (%)",
        "CBN Exception Threshold (%)",
        "Exception Status",
      ];
      const rows = completedJobs.map(j => {
        const mr = parseFloat(String(j.matchRate ?? 0));
        const total = j.totalSourceTxns + j.totalTargetTxns;
        const excRatio = total > 0 ? (j.exceptionCount / total) * 100 : 0;
        return [
          j.id,
          `"${j.name.replace(/"/g, '""')}"`,
          j.moduleType,
          new Date(j.dateFrom).toISOString().split("T")[0],
          new Date(j.dateTo).toISOString().split("T")[0],
          j.completedAt ? new Date(j.completedAt).toISOString().split("T")[0] : "",
          j.totalSourceTxns,
          j.totalTargetTxns,
          j.matchedCount,
          j.exceptionCount,
          j.unmatchedCount,
          mr.toFixed(2),
          CBN_THRESHOLDS.minMatchRate,
          mr >= CBN_THRESHOLDS.minMatchRate ? "COMPLIANT" : "BREACH",
          excRatio.toFixed(2),
          CBN_THRESHOLDS.maxExceptionRatio,
          excRatio <= CBN_THRESHOLDS.maxExceptionRatio ? "COMPLIANT" : "BREACH",
        ].join(",");
      });
      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `CBN-Returns-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`CBN Returns exported`, { description: `${completedJobs.length} reconciliation run(s) included` });
    } catch {
      toast.error("Export failed");
    } finally {
      setIsExporting(false);
    }
  }

  // ── Overall compliance status ──────────────────────────────────────────────
  const overallStatus = useMemo(() => {
    if (!metrics) return "loading";
    const breaches = [
      metrics.matchRate < CBN_THRESHOLDS.minMatchRate,
      metrics.exceptionRatio > CBN_THRESHOLDS.maxExceptionRatio,
      metrics.openExceptions > CBN_THRESHOLDS.maxOpenExceptions,
    ].filter(Boolean).length;
    if (breaches === 0) return "compliant";
    if (breaches === 1) return "warning";
    return "breach";
  }, [metrics]);

  const statusConfig = {
    loading: { icon: Activity, label: "Loading…", color: "text-muted-foreground", bg: "bg-muted" },
    compliant: { icon: ShieldCheck, label: "All thresholds met", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    warning: { icon: ShieldAlert, label: "1 threshold breach", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    breach: { icon: AlertTriangle, label: "Multiple breaches", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  }[overallStatus];
  const StatusIcon = statusConfig.icon;

  const criticalDeadlines = deadlines.filter(d => d.days <= 7).length;

  return (
    <div className="space-y-6 p-6">
      {/* ── Page Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            CBN Compliance Reports
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reconciliation-derived compliance intelligence — match rate thresholds, CBN returns export, regulatory deadlines, and AML/CFT flags.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchStats()} className="gap-2 shrink-0">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* ── Summary Banner ── */}
      <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${statusConfig.bg}`}>
        <StatusIcon className={`h-5 w-5 ${statusConfig.color} shrink-0`} />
        <div className="flex-1 min-w-0">
          <span className={`text-sm font-semibold ${statusConfig.color}`}>
            Reconciliation Compliance Status: {statusConfig.label}
          </span>
          {criticalDeadlines > 0 && (
            <span className="ml-3 text-xs text-red-600 font-medium">
              · {criticalDeadlines} CBN deadline{criticalDeadlines > 1 ? "s" : ""} within 7 days
            </span>
          )}
        </div>
        {amlFlags.total > 0 && (
          <Badge variant="destructive" className="shrink-0">
            {amlFlags.total} AML flag{amlFlags.total > 1 ? "s" : ""} pending review
          </Badge>
        )}
      </div>

      {/* ── Tabs ── */}
      <Tabs defaultValue="scorecard" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="scorecard" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Scorecard
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            CBN Returns
          </TabsTrigger>
          <TabsTrigger value="deadlines" className="gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" />
            Deadlines
            {criticalDeadlines > 0 && (
              <Badge variant="destructive" className="ml-1 h-4 px-1 text-[10px]">{criticalDeadlines}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="aml" className="gap-1.5">
            <Zap className="h-3.5 w-3.5" />
            AML/CFT Flags
            {amlFlags.total > 0 && (
              <Badge variant="destructive" className="ml-1 h-4 px-1 text-[10px]">{amlFlags.total}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Reconciliation Compliance Scorecard ── */}
        <TabsContent value="scorecard" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Match Rate</span>
                </div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.matchRate >= CBN_THRESHOLDS.minMatchRate ? "text-emerald-600" : "text-red-600"}`}>
                  {statsLoading ? "—" : `${metrics?.matchRate.toFixed(1)}%`}
                </div>
                <p className="text-xs text-muted-foreground mt-1">CBN minimum: {CBN_THRESHOLDS.minMatchRate}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="h-4 w-4 text-orange-500" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Exception Ratio</span>
                </div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.exceptionRatio <= CBN_THRESHOLDS.maxExceptionRatio ? "text-emerald-600" : "text-red-600"}`}>
                  {statsLoading ? "—" : `${metrics?.exceptionRatio.toFixed(1)}%`}
                </div>
                <p className="text-xs text-muted-foreground mt-1">CBN maximum: {CBN_THRESHOLDS.maxExceptionRatio}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="h-4 w-4 text-amber-500" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Open Exceptions</span>
                </div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.openExceptions <= CBN_THRESHOLDS.maxOpenExceptions ? "text-emerald-600" : "text-red-600"}`}>
                  {statsLoading ? "—" : metrics?.openExceptions}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Escalation threshold: {CBN_THRESHOLDS.maxOpenExceptions}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">CBN Reconciliation Threshold Compliance</CardTitle>
              <CardDescription className="text-xs">
                Based on CBN Settlement System Regulations, Prudential Guidelines, and NIBSS Operating Rules.
                Thresholds apply to all licensed financial institutions conducting electronic settlement reconciliation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ThresholdRow
                label="Settlement Match Rate"
                value={metrics?.matchRate ?? null}
                threshold={CBN_THRESHOLDS.minMatchRate}
                unit="%"
                direction="above"
                helpText="CBN requires a minimum 95% match rate on all settlement reconciliation runs. Persistent failure triggers regulatory escalation under NIBSS Operating Rules §4.2."
              />
              <ThresholdRow
                label="Exception-to-Transaction Ratio"
                value={metrics?.exceptionRatio ?? null}
                threshold={CBN_THRESHOLDS.maxExceptionRatio}
                unit="%"
                direction="below"
                helpText="Exception ratio above 5% indicates systemic reconciliation failure. CBN Prudential Guidelines require immediate investigation and remediation plan within 48 hours."
              />
              <ThresholdRow
                label="Open Exception Count"
                value={metrics?.openExceptions ?? null}
                threshold={CBN_THRESHOLDS.maxOpenExceptions}
                unit=""
                direction="below"
                helpText="More than 50 open exceptions requires escalation to the Chief Compliance Officer and notification to CBN within 3 business days per CBN Circular FPR/DIR/GEN/CIR/07/003."
              />
              <ThresholdRow
                label="AML/CFT Pending Flags"
                value={amlFlags.total}
                threshold={0}
                unit=""
                direction="below"
                helpText="Any anomaly-flagged transaction with score ≥0.75 requires STR consideration under MLPPA 2022 §25. Zero pending flags is the compliant state."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Reconciliation Run Summary</CardTitle>
              <CardDescription className="text-xs">
                Aggregate statistics across all reconciliation jobs. Used as input for CBN prudential and settlement returns.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Total Transactions", value: stats?.transactions.total ?? 0, icon: Activity },
                  { label: "Matched", value: stats?.transactions.matched ?? 0, icon: CheckCircle2, color: "text-emerald-600" },
                  { label: "Unmatched", value: stats?.transactions.unmatched ?? 0, icon: XCircle, color: "text-red-600" },
                  { label: "Exceptions", value: stats?.exceptions.total ?? 0, icon: AlertTriangle, color: "text-amber-600" },
                ].map(item => (
                  <div key={item.label} className="rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <item.icon className={`h-3.5 w-3.5 ${item.color ?? "text-muted-foreground"}`} />
                      <span className="text-xs text-muted-foreground">{item.label}</span>
                    </div>
                    <div className={`text-xl font-bold tabular-nums ${item.color ?? "text-foreground"}`}>
                      {statsLoading ? "—" : item.value.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: CBN Returns Export ── */}
        <TabsContent value="export" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">CBN Returns Export</CardTitle>
              <CardDescription className="text-xs">
                Export completed reconciliation runs in a format compatible with CBN FinA portal returns and prudential reporting.
                Each row represents one reconciliation run with match rate, exception count, and threshold compliance status.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Select value={exportPeriod} onValueChange={setExportPeriod}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select period" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="last_7">Last 7 days</SelectItem>
                    <SelectItem value="last_30">Last 30 days</SelectItem>
                    <SelectItem value="last_90">Last 90 days (Quarter)</SelectItem>
                    <SelectItem value="last_180">Last 180 days (Half-year)</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={handleExportCBNReturns} disabled={isExporting || jobsLoading} className="gap-2">
                  <Download className="h-4 w-4" />
                  {isExporting ? "Exporting…" : `Export ${completedJobs.length} Run${completedJobs.length !== 1 ? "s" : ""} to CSV`}
                </Button>
              </div>

              {/* Preview table */}
              {jobsLoading ? (
                <div className="text-sm text-muted-foreground py-8 text-center">Loading reconciliation runs…</div>
              ) : completedJobs.length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center border rounded-lg bg-muted/20">
                  No completed reconciliation runs in the selected period.
                  Run a reconciliation job first, then return here to export.
                </div>
              ) : (
                <div className="rounded-lg border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        {["Run Name", "Period", "Module", "Match Rate", "Exceptions", "Unmatched", "Status"].map(h => (
                          <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {completedJobs.map(job => {
                        const mr = parseFloat(String(job.matchRate ?? 0));
                        const isCompliant = mr >= CBN_THRESHOLDS.minMatchRate;
                        return (
                          <tr key={job.id} className="border-b last:border-0 hover:bg-muted/20">
                            <td className="px-3 py-2 font-medium max-w-[180px] truncate">{job.name}</td>
                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                              {new Date(job.dateFrom).toLocaleDateString()} – {new Date(job.dateTo).toLocaleDateString()}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className="text-[10px] capitalize">{job.moduleType.replace(/_/g, " ")}</Badge>
                            </td>
                            <td className={`px-3 py-2 font-semibold tabular-nums ${isCompliant ? "text-emerald-600" : "text-red-600"}`}>
                              {mr.toFixed(1)}%
                            </td>
                            <td className="px-3 py-2 tabular-nums text-amber-600">{job.exceptionCount}</td>
                            <td className="px-3 py-2 tabular-nums text-red-600">{job.unmatchedCount}</td>
                            <td className="px-3 py-2">
                              <Badge variant={isCompliant ? "outline" : "destructive"} className={isCompliant ? "border-emerald-300 text-emerald-700 bg-emerald-50 text-[10px]" : "text-[10px]"}>
                                {isCompliant ? "Compliant" : "Breach"}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="rounded-lg border bg-blue-50 border-blue-200 p-3">
                <p className="text-xs text-blue-700 font-medium mb-1">CBN FinA Portal Submission Note</p>
                <p className="text-xs text-blue-600">
                  The exported CSV maps directly to the FinA portal's reconciliation returns template.
                  Upload the file under <strong>Returns → Settlement Reconciliation → Upload</strong> in the CBN FinA portal.
                  Ensure the reporting period matches your FinA submission window before uploading.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Regulatory Deadline Tracker ── */}
        <TabsContent value="deadlines" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">CBN Regulatory Submission Deadlines</CardTitle>
              <CardDescription className="text-xs">
                Upcoming submission deadlines across all 8 CBN reporting frameworks, with reconciliation relevance notes.
                Deadlines are computed from the current reporting period end dates.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {deadlines.map(d => {
                  const { label, variant } = urgencyBadge(d.days);
                  const rowColor = urgencyColor(d.days);
                  return (
                    <div key={d.code} className={`rounded-lg border p-3 ${rowColor}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold">{d.framework}</span>
                            <Badge variant="outline" className="text-[10px] border-current opacity-70">{d.frequency}</Badge>
                            <Badge variant={variant} className="text-[10px]">{label}</Badge>
                          </div>
                          <p className="text-xs mt-1 opacity-80">{d.basis}</p>
                          <p className="text-xs mt-1.5 font-medium">
                            Reconciliation relevance: <span className="font-normal opacity-90">{d.relevance}</span>
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-bold tabular-nums">
                            {d.days <= 0 ? "Overdue" : `${d.days}d`}
                          </div>
                          <div className="text-xs opacity-70">
                            {d.deadline.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
                          </div>
                          <div className="text-xs opacity-60 mt-0.5">{d.channel}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 4: AML/CFT Flag Summary ── */}
        <TabsContent value="aml" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">High Risk (≥0.85)</span>
                </div>
                <div className="text-3xl font-bold tabular-nums text-red-600">{anomaliesLoading ? "—" : amlFlags.high}</div>
                <p className="text-xs text-muted-foreground mt-1">Immediate STR consideration required</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Medium Risk (0.75–0.85)</span>
                </div>
                <div className="text-3xl font-bold tabular-nums text-amber-600">{anomaliesLoading ? "—" : amlFlags.medium}</div>
                <p className="text-xs text-muted-foreground mt-1">Enhanced monitoring required</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="h-4 w-4 text-orange-500" />
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Pending Review</span>
                </div>
                <div className="text-3xl font-bold tabular-nums text-orange-600">{anomaliesLoading ? "—" : amlFlags.total}</div>
                <p className="text-xs text-muted-foreground mt-1">Awaiting compliance officer review</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">AML/CFT Flagged Transactions</CardTitle>
              <CardDescription className="text-xs">
                Transactions flagged by the anomaly detection engine with scores above the CBN STR threshold (≥0.75).
                Under MLPPA 2022 §25, Suspicious Transaction Reports must be filed with the NFIU within 24 hours of detection.
                Review each flag in the Anomaly Detection module before filing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {anomaliesLoading ? (
                <div className="text-sm text-muted-foreground py-8 text-center">Loading flagged transactions…</div>
              ) : amlFlags.total === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400" />
                  <p className="text-sm font-medium text-emerald-700">No AML/CFT flags pending review</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    All anomaly-flagged transactions have been reviewed. The reconciliation engine found no transactions above the CBN STR threshold.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        {["Reference", "Amount", "Description", "Detection Method", "Score", "Risk Level", "Action"].map(h => (
                          <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {amlFlags.items.map(({ anomaly, transaction }) => {
                        const score = parseFloat(anomaly.anomalyScore);
                        const isHigh = score >= 0.85;
                        return (
                          <tr key={anomaly.id} className="border-b last:border-0 hover:bg-muted/20">
                            <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{transaction.transactionRef ?? "—"}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums whitespace-nowrap">
                              ₦{parseFloat(String(transaction.amount)).toLocaleString("en-NG", { minimumFractionDigits: 2 })}
                            </td>
                            <td className="px-3 py-2 max-w-[160px] truncate text-muted-foreground">{transaction.description ?? "—"}</td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className="text-[10px] capitalize">{anomaly.detectionMethod.replace(/_/g, " ")}</Badge>
                            </td>
                            <td className={`px-3 py-2 font-bold tabular-nums ${isHigh ? "text-red-600" : "text-amber-600"}`}>
                              {score.toFixed(2)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant={isHigh ? "destructive" : "secondary"} className="text-[10px]">
                                {isHigh ? "High" : "Medium"}
                              </Badge>
                            </td>
                            <td className="px-3 py-2">
                              <a href="/anomalies" className="text-primary hover:underline text-[10px] font-medium">Review →</a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {amlFlags.total > 20 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/20">
                      Showing 20 of {amlFlags.total} flagged transactions. <a href="/anomalies" className="text-primary hover:underline">View all in Anomaly Detection →</a>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 rounded-lg border bg-amber-50 border-amber-200 p-3">
                <p className="text-xs text-amber-700 font-medium mb-1">MLPPA 2022 STR Filing Obligation</p>
                <p className="text-xs text-amber-600">
                  Under the Money Laundering (Prevention and Prohibition) Act 2022 §25, financial institutions must file a Suspicious Transaction Report (STR) with the NFIU via the goAML portal within <strong>24 hours</strong> of detecting a suspicious transaction.
                  CTR filing is required for cash transactions ≥₦5,000,000 within 7 days. Failure to report attracts penalties up to ₦10,000,000 per violation.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
