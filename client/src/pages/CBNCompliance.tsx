/**
 * CBN Compliance Report Module
 *
 * Scope: reconciliation-native compliance intelligence only.
 * All data is derived from existing reconciliation jobs, exceptions,
 * transactions, and anomaly scores — no standalone regulatory filing.
 *
 * Four panels:
 *  1. Reconciliation Compliance Scorecard — CBN threshold breach indicators + Print Attestation PDF
 *  2. CBN Returns Export — format completed reconciliation runs for regulatory returns
 *  3. Regulatory Deadline Tracker — upcoming CBN submission deadlines + Mark as Submitted log
 *  4. AML/CFT Flag Summary — anomaly-flagged transactions requiring STR/CTR attention
 */
import { useState, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Printer,
  Send,
  ChevronDown,
  ChevronUp,
  History,
} from "lucide-react";

// ─── CBN Regulatory Thresholds ────────────────────────────────────────────────
const CBN_THRESHOLDS = {
  minMatchRate: 95,
  maxUnreconciledDays: 3,
  maxExceptionRatio: 5,
  maxOpenExceptions: 50,
  amlFlagThreshold: 0.75,
  ctrThresholdNGN: 5_000_000,
};

// ─── Upcoming CBN Submission Deadlines ───────────────────────────────────────
const REGULATORY_DEADLINES = [
  {
    framework: "AML/CFT Monthly Returns",
    code: "AML_CFT",
    basis: "MLPPA 2022 / NFIU Act",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "goAML / NFIU Portal",
    relevance: "Reconciliation exceptions with suspicious patterns must be included in STR submissions",
  },
  {
    framework: "Prudential Returns (FinA)",
    code: "PRUDENTIAL",
    basis: "BOFIA 2020 / CBN Prudential Guidelines",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "CBN FinA Portal",
    relevance: "Settlement reconciliation figures feed directly into the FinA balance sheet returns",
  },
  {
    framework: "Capital Adequacy Ratio",
    code: "CAPITAL_ADEQUACY",
    basis: "CBN Guidance Notes / Basel III",
    frequency: "Quarterly",
    daysAfterPeriod: 15,
    channel: "CBN FinA Portal",
    relevance: "Unreconciled exposures affect risk-weighted assets and CAR computation",
  },
  {
    framework: "Liquidity Coverage Ratio",
    code: "LIQUIDITY",
    basis: "CBN LCR Guidelines 2021",
    frequency: "Monthly",
    daysAfterPeriod: 5,
    channel: "CBN FinA Portal",
    relevance: "Unsettled interbank positions affect HQLA and net cash outflow calculations",
  },
  {
    framework: "KYC/CDD Returns",
    code: "KYC_CDD",
    basis: "CBN KYC Regulations 2023",
    frequency: "Quarterly",
    daysAfterPeriod: 10,
    channel: "CBN Portal",
    relevance: "Transactions with unverified counterparties flagged in reconciliation require CDD escalation",
  },
  {
    framework: "IFRS 9 / Credit Risk Returns",
    code: "IFRS9",
    basis: "CBN Prudential Guidelines / IFRS 9",
    frequency: "Quarterly",
    daysAfterPeriod: 15,
    channel: "CBN FinA Portal",
    relevance: "Unmatched credit transactions may affect ECL staging and NPL ratio computation",
  },
  {
    framework: "Cybersecurity Incident Report",
    code: "CYBERSECURITY",
    basis: "CBN Cybersecurity Framework 2022",
    frequency: "Semi-Annual",
    daysAfterPeriod: 30,
    channel: "CBN Portal",
    relevance: "Reconciliation anomalies that indicate system tampering must be reported as cyber incidents",
  },
  {
    framework: "Consumer Protection Returns",
    code: "CONSUMER_PROTECTION",
    basis: "CBN Consumer Protection Framework 2022",
    frequency: "Annual",
    daysAfterPeriod: 30,
    channel: "CBN Portal",
    relevance: "Unresolved exception complaints must be captured in the consumer protection returns",
  },
];

function getNextDeadline(frequency: string, daysAfterPeriod: number): Date {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let periodEnd: Date;
  if (frequency === "Monthly") {
    periodEnd = new Date(year, month + 1, 0);
  } else if (frequency === "Semi-Annual") {
    const semiEnd = month < 6 ? 5 : 11;
    periodEnd = new Date(year, semiEnd + 1, 0);
  } else if (frequency === "Annual") {
    periodEnd = new Date(year, 12, 0);
  } else {
    // Quarterly
    const quarterEnd = [2, 5, 8, 11];
    const nextQEnd = quarterEnd.find(m => m >= month) ?? 11;
    periodEnd = new Date(year, nextQEnd + 1, 0);
  }
  const deadline = new Date(periodEnd);
  deadline.setDate(deadline.getDate() + daysAfterPeriod);
  return deadline;
}

function getPeriodLabel(frequency: string): string {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = now.getMonth();
  const year = now.getFullYear();
  if (frequency === "Monthly") return `${months[month]} ${year}`;
  if (frequency === "Semi-Annual") return month < 6 ? `H1 ${year}` : `H2 ${year}`;
  if (frequency === "Annual") return `FY ${year}`;
  // Quarterly
  const q = Math.floor(month / 3) + 1;
  return `Q${q} ${year}`;
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

// ─── ThresholdRow helper ──────────────────────────────────────────────────────
function ThresholdRow({
  label, value, threshold, unit, direction, helpText,
}: {
  label: string; value: number | null; threshold: number; unit: string;
  direction: "above" | "below"; helpText: string;
}) {
  const isOk = value === null ? false : direction === "above" ? value >= threshold : value <= threshold;
  const isLoading = value === null;
  const delta = value !== null ? (direction === "above" ? value - threshold : threshold - value) : null;
  return (
    <div className="flex items-center justify-between py-3 border-b last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        {isLoading ? <Minus className="h-4 w-4 text-muted-foreground shrink-0" />
          : isOk ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          : <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
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
  const { user } = useAuth();
  const [exportPeriod, setExportPeriod] = useState<string>("last_30");
  const [isExporting, setIsExporting] = useState(false);
  // Mark as submitted dialog state
  const [submitDialog, setSubmitDialog] = useState<{ open: boolean; code: string; name: string; periodLabel: string } | null>(null);
  const [submitNotes, setSubmitNotes] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const attestationRef = useRef<HTMLDivElement>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = trpc.dashboard.stats.useQuery();
  const { data: jobs, isLoading: jobsLoading } = trpc.reconciliation.list.useQuery();
  const { data: anomalies, isLoading: anomaliesLoading } = trpc.anomalies.getFlagged.useQuery({ reviewStatus: "pending", limit: 200 });
  const { data: submissionLog, refetch: refetchLog } = trpc.cbnCompliance.listDeadlineSubmissions.useQuery();
  const markSubmittedMutation = trpc.cbnCompliance.markDeadlineSubmitted.useMutation({
    onSuccess: () => {
      toast.success("Submission recorded", { description: `${submitDialog?.name} — ${submitDialog?.periodLabel}` });
      refetchLog();
      setSubmitDialog(null);
      setSubmitNotes("");
    },
    onError: (e) => toast.error("Failed to record submission", { description: e.message }),
  });

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
    const cutoff = { last_7: 7, last_30: 30, last_90: 90, last_180: 180 }[exportPeriod] ?? 30;
    const cutoffMs = cutoff * 24 * 60 * 60 * 1000;
    return (jobs as Array<{
      id: number; name: string; status: string; matchRate: string | number | null;
      matchedCount: number; exceptionCount: number; unmatchedCount: number;
      totalSourceTxns: number; totalTargetTxns: number;
      dateFrom: string | Date; dateTo: string | Date; completedAt: string | Date | null; moduleType: string;
    }>)
      .filter(j => j.status === "completed" && j.completedAt && (now - new Date(j.completedAt).getTime()) <= cutoffMs)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());
  }, [jobs, exportPeriod]);

  // ── AML/CFT flags ──────────────────────────────────────────────────────────
  const amlFlags = useMemo(() => {
    if (!anomalies) return { high: 0, medium: 0, total: 0, items: [] };
    const items = (anomalies as unknown as Array<{
      anomaly: { anomalyScore: string; detectionMethod: string; detectionReason: string; id: number };
      transaction: { amount: string | number; description: string | null; transactionRef: string | null; createdAt: string | Date };
    }>);
    const high = items.filter(i => parseFloat(i.anomaly.anomalyScore) >= 0.85).length;
    const medium = items.filter(i => parseFloat(i.anomaly.anomalyScore) >= CBN_THRESHOLDS.amlFlagThreshold && parseFloat(i.anomaly.anomalyScore) < 0.85).length;
    return { high, medium, total: items.length, items: items.slice(0, 20) };
  }, [anomalies]);

  // ── Deadline data with submission log lookup ───────────────────────────────
  const deadlines = useMemo(() => {
    return REGULATORY_DEADLINES.map(d => {
      const deadline = getNextDeadline(d.frequency, d.daysAfterPeriod);
      const days = daysUntil(deadline);
      const periodLabel = getPeriodLabel(d.frequency);
      const submission = submissionLog?.find(s => s.frameworkCode === d.code && s.periodLabel === periodLabel) ?? null;
      return { ...d, deadline, days, periodLabel, submission };
    }).sort((a, b) => a.days - b.days);
  }, [submissionLog]);

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
  const criticalDeadlines = deadlines.filter(d => d.days <= 7 && !d.submission).length;

  // ── Print attestation ──────────────────────────────────────────────────────
  function handlePrintAttestation() {
    window.print();
  }

  // ── Export CBN Returns CSV ─────────────────────────────────────────────────
  function handleExportCBNReturns() {
    if (!completedJobs.length) { toast.error("No completed reconciliation runs in the selected period"); return; }
    setIsExporting(true);
    try {
      const headers = ["Run ID","Run Name","Module Type","Period From","Period To","Completed At","Total Source Txns","Total Target Txns","Matched Count","Exception Count","Unmatched Count","Match Rate (%)","CBN Threshold (%)","Threshold Status","Exception Ratio (%)","CBN Exception Threshold (%)","Exception Status"];
      const rows = completedJobs.map(j => {
        const mr = parseFloat(String(j.matchRate ?? 0));
        const total = j.totalSourceTxns + j.totalTargetTxns;
        const excRatio = total > 0 ? (j.exceptionCount / total) * 100 : 0;
        return [j.id, `"${j.name.replace(/"/g,'""')}"`, j.moduleType, new Date(j.dateFrom).toISOString().split("T")[0], new Date(j.dateTo).toISOString().split("T")[0], j.completedAt ? new Date(j.completedAt).toISOString().split("T")[0] : "", j.totalSourceTxns, j.totalTargetTxns, j.matchedCount, j.exceptionCount, j.unmatchedCount, mr.toFixed(2), CBN_THRESHOLDS.minMatchRate, mr >= CBN_THRESHOLDS.minMatchRate ? "COMPLIANT" : "BREACH", excRatio.toFixed(2), CBN_THRESHOLDS.maxExceptionRatio, excRatio <= CBN_THRESHOLDS.maxExceptionRatio ? "COMPLIANT" : "BREACH"].join(",");
      });
      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `CBN-Returns-${new Date().toISOString().split("T")[0]}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success(`CBN Returns exported`, { description: `${completedJobs.length} reconciliation run(s) included` });
    } catch { toast.error("Export failed"); } finally { setIsExporting(false); }
  }

  const today = new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
  const institutionName = user?.name ?? "Financial Institution";
  const thresholdRows = [
    { label: "Settlement Match Rate", value: metrics?.matchRate ?? null, threshold: CBN_THRESHOLDS.minMatchRate, unit: "%", direction: "above" as const, ok: metrics ? metrics.matchRate >= CBN_THRESHOLDS.minMatchRate : false },
    { label: "Exception-to-Transaction Ratio", value: metrics?.exceptionRatio ?? null, threshold: CBN_THRESHOLDS.maxExceptionRatio, unit: "%", direction: "below" as const, ok: metrics ? metrics.exceptionRatio <= CBN_THRESHOLDS.maxExceptionRatio : false },
    { label: "Open Exception Count", value: metrics?.openExceptions ?? null, threshold: CBN_THRESHOLDS.maxOpenExceptions, unit: "", direction: "below" as const, ok: metrics ? metrics.openExceptions <= CBN_THRESHOLDS.maxOpenExceptions : false },
    { label: "AML/CFT Pending Flags", value: amlFlags.total, threshold: 0, unit: "", direction: "below" as const, ok: amlFlags.total === 0 },
  ];

  return (
    <>
      {/* ── Print Stylesheet ── */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #cbn-attestation-print { display: block !important; position: fixed; top: 0; left: 0; width: 100%; z-index: 9999; background: white; }
          .print\\:hidden { display: none !important; }
        }
        @media screen {
          #cbn-attestation-print { display: none; }
        }
      `}</style>

      {/* ── Hidden Print Attestation Document ── */}
      <div id="cbn-attestation-print" ref={attestationRef} style={{ fontFamily: "serif", padding: "40px 60px", color: "#000", background: "#fff" }}>
        <div style={{ textAlign: "center", borderBottom: "2px solid #000", paddingBottom: "16px", marginBottom: "24px" }}>
          <div style={{ fontSize: "11px", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "4px" }}>Central Bank of Nigeria</div>
          <div style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "4px" }}>Reconciliation Compliance Attestation</div>
          <div style={{ fontSize: "12px", color: "#444" }}>Issued pursuant to CBN Settlement System Regulations &amp; NIBSS Operating Rules</div>
        </div>
        <table style={{ width: "100%", fontSize: "12px", marginBottom: "24px", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={{ padding: "4px 0", fontWeight: "bold", width: "200px" }}>Institution:</td><td>{institutionName}</td></tr>
            <tr><td style={{ padding: "4px 0", fontWeight: "bold" }}>Date of Attestation:</td><td>{today}</td></tr>
            <tr><td style={{ padding: "4px 0", fontWeight: "bold" }}>Reporting Period:</td><td>{getPeriodLabel("Monthly")}</td></tr>
            <tr><td style={{ padding: "4px 0", fontWeight: "bold" }}>Overall Status:</td><td style={{ fontWeight: "bold", color: overallStatus === "compliant" ? "#166534" : overallStatus === "warning" ? "#92400e" : "#991b1b" }}>{overallStatus === "compliant" ? "COMPLIANT — All CBN thresholds met" : overallStatus === "warning" ? "WARNING — 1 threshold breach detected" : "BREACH — Multiple threshold breaches detected"}</td></tr>
          </tbody>
        </table>
        <div style={{ fontSize: "13px", fontWeight: "bold", marginBottom: "8px", borderBottom: "1px solid #ccc", paddingBottom: "4px" }}>Threshold Compliance Results</div>
        <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", marginBottom: "24px" }}>
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th style={{ padding: "6px 8px", textAlign: "left", border: "1px solid #d1d5db" }}>Metric</th>
              <th style={{ padding: "6px 8px", textAlign: "center", border: "1px solid #d1d5db" }}>CBN Threshold</th>
              <th style={{ padding: "6px 8px", textAlign: "center", border: "1px solid #d1d5db" }}>Actual Value</th>
              <th style={{ padding: "6px 8px", textAlign: "center", border: "1px solid #d1d5db" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {thresholdRows.map(row => (
              <tr key={row.label}>
                <td style={{ padding: "6px 8px", border: "1px solid #d1d5db" }}>{row.label}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #d1d5db", textAlign: "center" }}>{row.direction === "above" ? "≥" : "≤"}{row.threshold}{row.unit}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #d1d5db", textAlign: "center" }}>{row.value !== null ? `${typeof row.value === "number" ? row.value.toFixed(1) : row.value}${row.unit}` : "—"}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #d1d5db", textAlign: "center", fontWeight: "bold", color: row.ok ? "#166534" : "#991b1b" }}>{row.ok ? "COMPLIANT" : "BREACH"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: "11px", color: "#555", marginBottom: "32px", lineHeight: "1.6" }}>
          This attestation certifies that the reconciliation compliance metrics above have been computed from the institution's live reconciliation engine as at the date stated. The figures are derived from the ReconcileAI platform and reflect the institution's settlement reconciliation performance against applicable CBN regulatory thresholds. This document is intended to accompany CBN regulatory submissions as supporting evidence of reconciliation compliance.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "40px", marginTop: "24px" }}>
          <div>
            <div style={{ borderBottom: "1px solid #000", marginBottom: "4px", height: "32px" }}></div>
            <div style={{ fontSize: "11px" }}>Chief Compliance Officer</div>
            <div style={{ fontSize: "11px", color: "#666" }}>Name &amp; Signature</div>
          </div>
          <div>
            <div style={{ borderBottom: "1px solid #000", marginBottom: "4px", height: "32px" }}></div>
            <div style={{ fontSize: "11px" }}>Managing Director / CEO</div>
            <div style={{ fontSize: "11px", color: "#666" }}>Name &amp; Signature</div>
          </div>
        </div>
        <div style={{ marginTop: "40px", textAlign: "center", fontSize: "10px", color: "#888", borderTop: "1px solid #ccc", paddingTop: "8px" }}>
          Generated by ReconcileAI · {today} · This document is computer-generated and is valid without a physical stamp when accompanied by a digital signature.
        </div>
      </div>

      {/* ── Mark as Submitted Dialog ── */}
      <Dialog open={!!submitDialog?.open} onOpenChange={(o) => { if (!o) { setSubmitDialog(null); setSubmitNotes(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4 text-emerald-600" />
              Mark as Submitted
            </DialogTitle>
            <DialogDescription>
              Record that <strong>{submitDialog?.name}</strong> ({submitDialog?.periodLabel}) has been submitted to the CBN. This will be logged in the submission history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</Label>
              <Textarea
                placeholder="e.g. Submitted via FinA portal at 14:32. Reference: CBN/2026/05/0042"
                value={submitNotes}
                onChange={e => setSubmitNotes(e.target.value)}
                rows={3}
                maxLength={1000}
                className="text-sm resize-none"
              />
              <p className="text-xs text-muted-foreground mt-1">{submitNotes.length}/1000</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSubmitDialog(null); setSubmitNotes(""); }}>Cancel</Button>
            <Button
              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              disabled={markSubmittedMutation.isPending}
              onClick={() => {
                if (!submitDialog) return;
                markSubmittedMutation.mutate({
                  frameworkCode: submitDialog.code,
                  frameworkName: submitDialog.name,
                  periodLabel: submitDialog.periodLabel,
                  notes: submitNotes || undefined,
                });
              }}
            >
              <CheckCircle2 className="h-4 w-4" />
              {markSubmittedMutation.isPending ? "Saving…" : "Confirm Submission"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Main Page ── */}
      <div className="space-y-6 p-6 print:hidden">
        {/* Page Header */}
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

        {/* Summary Banner */}
        <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${statusConfig.bg}`}>
          <StatusIcon className={`h-5 w-5 ${statusConfig.color} shrink-0`} />
          <div className="flex-1 min-w-0">
            <span className={`text-sm font-semibold ${statusConfig.color}`}>
              Reconciliation Compliance Status: {statusConfig.label}
            </span>
            {criticalDeadlines > 0 && (
              <span className="ml-3 text-xs text-red-600 font-medium">
                · {criticalDeadlines} CBN deadline{criticalDeadlines > 1 ? "s" : ""} within 7 days (unsubmitted)
              </span>
            )}
          </div>
          {amlFlags.total > 0 && (
            <Badge variant="destructive" className="shrink-0">
              {amlFlags.total} AML flag{amlFlags.total > 1 ? "s" : ""} pending review
            </Badge>
          )}
        </div>

        {/* Tabs */}
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

          {/* ── Tab 1: Scorecard ── */}
          <TabsContent value="scorecard" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><BarChart3 className="h-4 w-4 text-primary" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Match Rate</span></div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.matchRate >= CBN_THRESHOLDS.minMatchRate ? "text-emerald-600" : "text-red-600"}`}>{statsLoading ? "—" : `${metrics?.matchRate.toFixed(1)}%`}</div>
                <p className="text-xs text-muted-foreground mt-1">CBN minimum: {CBN_THRESHOLDS.minMatchRate}%</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><AlertCircle className="h-4 w-4 text-orange-500" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Exception Ratio</span></div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.exceptionRatio <= CBN_THRESHOLDS.maxExceptionRatio ? "text-emerald-600" : "text-red-600"}`}>{statsLoading ? "—" : `${metrics?.exceptionRatio.toFixed(1)}%`}</div>
                <p className="text-xs text-muted-foreground mt-1">CBN maximum: {CBN_THRESHOLDS.maxExceptionRatio}%</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><Clock className="h-4 w-4 text-amber-500" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Open Exceptions</span></div>
                <div className={`text-3xl font-bold tabular-nums ${statsLoading ? "text-muted-foreground" : metrics && metrics.openExceptions <= CBN_THRESHOLDS.maxOpenExceptions ? "text-emerald-600" : "text-red-600"}`}>{statsLoading ? "—" : metrics?.openExceptions}</div>
                <p className="text-xs text-muted-foreground mt-1">Escalation threshold: {CBN_THRESHOLDS.maxOpenExceptions}</p>
              </CardContent></Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">CBN Reconciliation Threshold Compliance</CardTitle>
                    <CardDescription className="text-xs mt-0.5">
                      Based on CBN Settlement System Regulations, Prudential Guidelines, and NIBSS Operating Rules.
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={handlePrintAttestation} className="gap-2 shrink-0">
                    <Printer className="h-4 w-4" />
                    Print Attestation
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ThresholdRow label="Settlement Match Rate" value={metrics?.matchRate ?? null} threshold={CBN_THRESHOLDS.minMatchRate} unit="%" direction="above" helpText="CBN requires a minimum 95% match rate on all settlement reconciliation runs. Persistent failure triggers regulatory escalation under NIBSS Operating Rules §4.2." />
                <ThresholdRow label="Exception-to-Transaction Ratio" value={metrics?.exceptionRatio ?? null} threshold={CBN_THRESHOLDS.maxExceptionRatio} unit="%" direction="below" helpText="Exception ratio above 5% indicates systemic reconciliation failure. CBN Prudential Guidelines require immediate investigation and remediation plan within 48 hours." />
                <ThresholdRow label="Open Exception Count" value={metrics?.openExceptions ?? null} threshold={CBN_THRESHOLDS.maxOpenExceptions} unit="" direction="below" helpText="More than 50 open exceptions requires escalation to the Chief Compliance Officer and notification to CBN within 3 business days per CBN Circular FPR/DIR/GEN/CIR/07/003." />
                <ThresholdRow label="AML/CFT Pending Flags" value={amlFlags.total} threshold={0} unit="" direction="below" helpText="Any anomaly-flagged transaction with score ≥0.75 requires STR consideration under MLPPA 2022 §25. Zero pending flags is the compliant state." />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Reconciliation Run Summary</CardTitle>
                <CardDescription className="text-xs">Aggregate statistics across all reconciliation jobs. Used as input for CBN prudential and settlement returns.</CardDescription>
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
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <Select value={exportPeriod} onValueChange={setExportPeriod}>
                    <SelectTrigger className="w-48"><SelectValue placeholder="Select period" /></SelectTrigger>
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
                {jobsLoading ? (
                  <div className="text-sm text-muted-foreground py-8 text-center">Loading reconciliation runs…</div>
                ) : completedJobs.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-8 text-center border rounded-lg bg-muted/20">No completed reconciliation runs in the selected period.</div>
                ) : (
                  <div className="rounded-lg border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b bg-muted/40">{["Run Name","Period","Module","Match Rate","Exceptions","Unmatched","Status"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>)}</tr></thead>
                      <tbody>
                        {completedJobs.map(job => {
                          const mr = parseFloat(String(job.matchRate ?? 0));
                          const isCompliant = mr >= CBN_THRESHOLDS.minMatchRate;
                          return (
                            <tr key={job.id} className="border-b last:border-0 hover:bg-muted/20">
                              <td className="px-3 py-2 font-medium max-w-[180px] truncate">{job.name}</td>
                              <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{new Date(job.dateFrom).toLocaleDateString()} – {new Date(job.dateTo).toLocaleDateString()}</td>
                              <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] capitalize">{job.moduleType.replace(/_/g," ")}</Badge></td>
                              <td className={`px-3 py-2 font-semibold tabular-nums ${isCompliant ? "text-emerald-600" : "text-red-600"}`}>{mr.toFixed(1)}%</td>
                              <td className="px-3 py-2 tabular-nums text-amber-600">{job.exceptionCount}</td>
                              <td className="px-3 py-2 tabular-nums text-red-600">{job.unmatchedCount}</td>
                              <td className="px-3 py-2"><Badge variant={isCompliant ? "outline" : "destructive"} className={isCompliant ? "border-emerald-300 text-emerald-700 bg-emerald-50 text-[10px]" : "text-[10px]"}>{isCompliant ? "Compliant" : "Breach"}</Badge></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="rounded-lg border bg-blue-50 border-blue-200 p-3">
                  <p className="text-xs text-blue-700 font-medium mb-1">CBN FinA Portal Submission Note</p>
                  <p className="text-xs text-blue-600">Upload the exported CSV under <strong>Returns → Settlement Reconciliation → Upload</strong> in the CBN FinA portal. Ensure the reporting period matches your FinA submission window before uploading.</p>
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
                  Upcoming submission deadlines across all 8 CBN reporting frameworks. Click "Mark as Submitted" once you have filed each return to track your submission log.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {deadlines.map(d => {
                    const isSubmitted = !!d.submission;
                    const { label, variant } = urgencyBadge(d.days);
                    const rowColor = isSubmitted ? "text-emerald-700 bg-emerald-50 border-emerald-200" : urgencyColor(d.days);
                    return (
                      <div key={d.code} className={`rounded-lg border p-3 ${rowColor}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold">{d.framework}</span>
                              <Badge variant="outline" className="text-[10px] border-current opacity-70">{d.frequency}</Badge>
                              {isSubmitted ? (
                                <Badge variant="outline" className="text-[10px] border-emerald-400 text-emerald-700 bg-emerald-100">
                                  <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                                  Submitted
                                </Badge>
                              ) : (
                                <Badge variant={variant} className="text-[10px]">{label}</Badge>
                              )}
                            </div>
                            <p className="text-xs mt-1 opacity-80">{d.basis}</p>
                            <p className="text-xs mt-1.5 font-medium">
                              Reconciliation relevance: <span className="font-normal opacity-90">{d.relevance}</span>
                            </p>
                            {isSubmitted && d.submission && (
                              <div className="mt-2 text-xs opacity-80">
                                <span className="font-medium">Submitted:</span> {new Date(d.submission.submittedAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
                                {d.submission.submittedByName && <span> by {d.submission.submittedByName}</span>}
                                {d.submission.notes && <span> · <em>{d.submission.notes}</em></span>}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-2 shrink-0">
                            <div className="text-right">
                              <div className={`text-lg font-bold tabular-nums ${isSubmitted ? "line-through opacity-50" : ""}`}>
                                {d.days <= 0 ? "Overdue" : `${d.days}d`}
                              </div>
                              <div className="text-xs opacity-70">
                                {d.deadline.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
                              </div>
                              <div className="text-xs opacity-60 mt-0.5">{d.channel}</div>
                            </div>
                            {!isSubmitted ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-[11px] h-7 px-2 gap-1 border-current"
                                onClick={() => setSubmitDialog({ open: true, code: d.code, name: d.framework, periodLabel: d.periodLabel })}
                              >
                                <Send className="h-3 w-3" />
                                Mark as Submitted
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-[11px] h-7 px-2 gap-1 opacity-60"
                                onClick={() => setSubmitDialog({ open: true, code: d.code, name: d.framework, periodLabel: d.periodLabel })}
                              >
                                Re-submit
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* ── Submission History Log ── */}
            <Card className="border border-border/50">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between w-full">
                  <button
                    className="flex items-center gap-2 text-left group flex-1"
                    onClick={() => setHistoryOpen(h => !h)}
                  >
                    <History className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">Submission History</span>
                    {submissionLog && submissionLog.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{submissionLog.length}</Badge>
                    )}
                    {historyOpen
                      ? <ChevronUp className="h-4 w-4 text-muted-foreground ml-1" />
                      : <ChevronDown className="h-4 w-4 text-muted-foreground ml-1" />}
                  </button>
                  {submissionLog && submissionLog.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const headers = ["Framework", "Period", "Submitted By", "Date", "Notes"];
                        const rows = [...submissionLog]
                          .sort((a, b) => Number(b.submittedAt ?? 0) - Number(a.submittedAt ?? 0))
                          .map(s => [
                            `"${(s.frameworkName ?? s.frameworkCode ?? "").replace(/"/g, '""')}"`,
                            `"${(s.periodLabel ?? "").replace(/"/g, '""')}"`,
                            `"${(s.submittedByName ?? "").replace(/"/g, '""')}"`,
                            `"${s.submittedAt ? new Date(s.submittedAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) : ""}"`,
                            `"${(s.notes ?? "").replace(/"/g, '""')}"`,
                          ]);
                        const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                        const blob = new Blob([csv], { type: "text/csv" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `cbn-submission-log-${new Date().toISOString().slice(0, 10)}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                        toast.success("Submission log downloaded");
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download CSV
                    </Button>
                  )}
                </div>
              </CardHeader>
              {historyOpen && (
                <CardContent className="px-4 pb-4 pt-0">
                  {!submissionLog || submissionLog.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">No submissions recorded yet.</p>
                      <p className="text-xs mt-1">Use "Mark as Submitted" on any deadline row above to start the log.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border/50">
                            <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Framework</th>
                            <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Period</th>
                            <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Submitted By</th>
                            <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</th>
                            <th className="text-left py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...submissionLog].sort((a, b) => (Number(b.submittedAt ?? 0)) - (Number(a.submittedAt ?? 0))).map((s, i) => (
                            <tr key={i} className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors">
                              <td className="py-2 pr-4 font-medium">{s.frameworkName ?? s.frameworkCode}</td>
                              <td className="py-2 pr-4 text-muted-foreground">{s.periodLabel}</td>
                              <td className="py-2 pr-4">
                                <div className="flex items-center gap-1.5">
                                  <div className="h-5 w-5 rounded-full bg-[#1B365D] text-white text-[10px] flex items-center justify-center font-bold flex-shrink-0">
                                    {(s.submittedByName ?? "?").charAt(0).toUpperCase()}
                                  </div>
                                  <span className="text-sm">{s.submittedByName ?? "Unknown"}</span>
                                </div>
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground text-xs whitespace-nowrap">
                                {s.submittedAt ? new Date(s.submittedAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                              </td>
                              <td className="py-2 text-muted-foreground text-xs max-w-[200px] truncate" title={s.notes ?? ""}>
                                {s.notes ? s.notes : <span className="opacity-40 italic">No notes</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </TabsContent>

          {/* ── Tab 4: AML/CFT Flag Summary ── */}
          <TabsContent value="aml" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><AlertTriangle className="h-4 w-4 text-red-500" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">High Risk (≥0.85)</span></div>
                <div className="text-3xl font-bold tabular-nums text-red-600">{anomaliesLoading ? "—" : amlFlags.high}</div>
                <p className="text-xs text-muted-foreground mt-1">Immediate STR consideration required</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><AlertCircle className="h-4 w-4 text-amber-500" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Medium Risk (0.75–0.85)</span></div>
                <div className="text-3xl font-bold tabular-nums text-amber-600">{anomaliesLoading ? "—" : amlFlags.medium}</div>
                <p className="text-xs text-muted-foreground mt-1">Enhanced monitoring required</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-orange-500" /><span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Pending Review</span></div>
                <div className="text-3xl font-bold tabular-nums text-orange-600">{anomaliesLoading ? "—" : amlFlags.total}</div>
                <p className="text-xs text-muted-foreground mt-1">Awaiting compliance officer review</p>
              </CardContent></Card>
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">AML/CFT Flagged Transactions</CardTitle>
                <CardDescription className="text-xs">
                  Transactions flagged by the anomaly detection engine with scores above the CBN STR threshold (≥0.75). Under MLPPA 2022 §25, STRs must be filed with the NFIU within 24 hours of detection.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {anomaliesLoading ? (
                  <div className="text-sm text-muted-foreground py-8 text-center">Loading flagged transactions…</div>
                ) : amlFlags.total === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <CheckCircle2 className="h-10 w-10 text-emerald-400" />
                    <p className="text-sm font-medium text-emerald-700">No AML/CFT flags pending review</p>
                    <p className="text-xs text-muted-foreground max-w-sm">All anomaly-flagged transactions have been reviewed. No transactions above the CBN STR threshold were found.</p>
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b bg-muted/40">{["Reference","Amount","Description","Detection Method","Score","Risk Level","Action"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>)}</tr></thead>
                      <tbody>
                        {amlFlags.items.map(({ anomaly, transaction }) => {
                          const score = parseFloat(anomaly.anomalyScore);
                          const isHigh = score >= 0.85;
                          return (
                            <tr key={anomaly.id} className="border-b last:border-0 hover:bg-muted/20">
                              <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{transaction.transactionRef ?? "—"}</td>
                              <td className="px-3 py-2 font-semibold tabular-nums whitespace-nowrap">₦{parseFloat(String(transaction.amount)).toLocaleString("en-NG", { minimumFractionDigits: 2 })}</td>
                              <td className="px-3 py-2 max-w-[160px] truncate text-muted-foreground">{transaction.description ?? "—"}</td>
                              <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] capitalize">{anomaly.detectionMethod.replace(/_/g," ")}</Badge></td>
                              <td className={`px-3 py-2 font-bold tabular-nums ${isHigh ? "text-red-600" : "text-amber-600"}`}>{score.toFixed(2)}</td>
                              <td className="px-3 py-2"><Badge variant={isHigh ? "destructive" : "secondary"} className="text-[10px]">{isHigh ? "High" : "Medium"}</Badge></td>
                              <td className="px-3 py-2"><a href="/anomalies" className="text-primary hover:underline text-[10px] font-medium">Review →</a></td>
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
                  <p className="text-xs text-amber-600">Under MLPPA 2022 §25, financial institutions must file an STR with the NFIU via the goAML portal within <strong>24 hours</strong> of detecting a suspicious transaction. CTR filing is required for cash transactions ≥₦5,000,000 within 7 days. Failure to report attracts penalties up to ₦10,000,000 per violation.</p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
