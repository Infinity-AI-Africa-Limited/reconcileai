/**
 * ReconcileAI — Woodcore POC Dashboard
 * Three-layer reconciliation engine against the real Woodcore CBS dataset.
 * Features: Woodcore branding banner, date-range selector, run comparison view,
 *           exception status tracking (Acknowledged / Resolved / Escalated), PDF export.
 */

import { useState, useCallback, useRef } from "react";
import { LineChart, Line, Tooltip, ResponsiveContainer } from "recharts";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  Play,
  RefreshCw,
  Database,
  Layers,
  Bot,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
  Calendar,
  GitCompare,
  CheckCheck,
  AlertOctagon,
  ArrowUpCircle,
  Clock,
  User,
  MessageSquare,
  Share2,
  Copy,
  CheckCheck as CheckCheckIcon,
} from "lucide-react";
import jsPDF from "jspdf";

const WOODCORE_LOGO =
  "https://d2xsxph8kpxj0f.cloudfront.net/310419663029108989/fGjDi9wkBzgbvTayKYVoMB/woodcore-logo_78b5eba6.png";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReviewStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "ESCALATED";

type Layer1Result = {
  runId: number;
  productId: number;
  productName: string;
  portfolioLedgerAccountId: number;
  portfolioLedgerGlCode: string;
  portfolioLedgerName: string;
  expectedBalance: number;
  actualGlBalance: number;
  varianceAmount: number;
  varianceDirection: "OVER_POSTED" | "UNDER_POSTED" | "BALANCED";
  variancePercent?: number;
  status: "BALANCED" | "VARIANCE_DETECTED";
  layer2Triggered: boolean;
  glDebits: number;
  glCredits: number;
  savingsDeposits: number;
  savingsWithdrawals: number;
  currencyCode: string;
  periodStart: string;
  periodEnd: string;
};

type Layer2Exception = {
  glEntryId: number;
  exceptionCategory: string;
  exceptionContribution: number | string | null;
  glEntryAmount: number | string | null;
  glEntryDate: string;
  glEntryType: string;
  manualEntryFlag: number | boolean;
  linkedTransactionId: string | null;
  linkedSavingsTxnId: number | null;
  linkedSavingsAccountId: number | null;
  linkedProductId: number | null;
  productMatch: number | null;
  refNum: string | null;
  description: string | null;
};

type Layer3Result = {
  exceptionId: number;
  agentClassification: string;
  agentExplanation: string;
  agentConfidence: number;
  recommendedAction: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  reviewStatus?: ReviewStatus;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
};

type POCResult = {
  layer1: Layer1Result;
  layer2Exceptions: Layer2Exception[];
  layer3Results: Layer3Result[];
};

type RunRecord = {
  id: number;
  productName: string;
  productType: string | null;  // "SAVINGS" | "LOAN"
  periodStart: string;
  periodEnd: string;
  status: string;
  varianceAmount: string | null;
  varianceDirection: string | null;
  currencyCode: string | null;
  expectedBalance: string | null;
  actualGlBalance: string | null;
  totalGlEntries: number | null;
  totalSavingsTxns: number | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNGN(amount: number | string | null | undefined): string {
  const n = typeof amount === "string" ? parseFloat(amount) : (amount ?? 0);
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function categoryColor(cat: string): string {
  switch (cat) {
    case "CROSS_PRODUCT_MISPOSTING": return "bg-red-100 text-red-800 border-red-200";
    case "MANUAL_POSTING": return "bg-orange-100 text-orange-800 border-orange-200";
    case "ORPHANED_ENTRY": return "bg-purple-100 text-purple-800 border-purple-200";
    case "REVERSAL_ANOMALY": return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "MANUAL_POSTING_ANOMALY": return "bg-blue-100 text-blue-800 border-blue-200";
    case "VALID": return "bg-green-100 text-green-800 border-green-200";
    default: return "bg-gray-100 text-gray-800 border-gray-200";
  }
}

function priorityColor(p: string): string {
  switch (p) {
    case "CRITICAL": return "bg-red-600 text-white";
    case "HIGH": return "bg-orange-500 text-white";
    case "MEDIUM": return "bg-yellow-500 text-white";
    case "LOW": return "bg-blue-500 text-white";
    default: return "bg-gray-400 text-white";
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case "CROSS_PRODUCT_MISPOSTING": return "Cross-Product Mis-posting";
    case "MANUAL_POSTING": return "Manual Posting";
    case "ORPHANED_ENTRY": return "Orphaned Entry";
    case "REVERSAL_ANOMALY": return "Reversal Anomaly";
    case "MANUAL_POSTING_ANOMALY": return "Manual Posting Anomaly";
    case "VALID": return "Valid";
    default: return cat;
  }
}

function statusIcon(s: ReviewStatus) {
  switch (s) {
    case "ACKNOWLEDGED": return <CheckCheck className="h-3.5 w-3.5" />;
    case "RESOLVED": return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "ESCALATED": return <AlertOctagon className="h-3.5 w-3.5" />;
    default: return <Clock className="h-3.5 w-3.5" />;
  }
}

function statusStyle(s: ReviewStatus): string {
  switch (s) {
    case "ACKNOWLEDGED": return "bg-blue-100 text-blue-800 border-blue-300";
    case "RESOLVED": return "bg-green-100 text-green-800 border-green-300";
    case "ESCALATED": return "bg-red-100 text-red-800 border-red-300";
    default: return "bg-gray-100 text-gray-600 border-gray-300";
  }
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

function exportToPDF(layer1: Layer1Result, exceptions: Layer2Exception[], layer3: Layer3Result[]) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = 210;
  const margin = 18;
  const contentW = pageW - margin * 2;
  let y = 20;
  const LINE_H = 6;
  const SECTION_GAP = 8;

  doc.setFillColor(67, 56, 202);
  doc.rect(0, 0, pageW, 28, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("ReconcileAI — Woodcore CBS Exception Report", margin, 12);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}  |  Period: ${layer1.periodStart} to ${layer1.periodEnd}`, margin, 20);
  y = 36;

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Layer 1 — Balance Reconciliation Summary", margin, y);
  y += LINE_H;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageW - margin, y);
  y += 5;

  const summaryRows = [
    ["Product", layer1.productName],
    ["GL Account", `${layer1.portfolioLedgerName} (GL ${layer1.portfolioLedgerGlCode})`],
    ["Expected Balance", formatNGN(layer1.expectedBalance)],
    ["Actual GL Balance", formatNGN(layer1.actualGlBalance)],
    ["Variance", `${formatNGN(Math.abs(layer1.varianceAmount))} (${layer1.varianceDirection.replace("_", " ")})`],
    ["Status", layer1.status],
    ["Currency", layer1.currencyCode],
  ];

  doc.setFontSize(9);
  for (const [label, value] of summaryRows) {
    doc.setFont("helvetica", "bold");
    doc.text(label + ":", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(value), margin + 48, y);
    y += LINE_H;
  }

  y += SECTION_GAP;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(`Layer 2 & 3 — Exception Analysis (${exceptions.length} exceptions)`, margin, y);
  y += LINE_H;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageW - margin, y);
  y += 5;

  const priorityCounts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of layer3) priorityCounts[r.priorityLevel] = (priorityCounts[r.priorityLevel] ?? 0) + 1;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(`Critical: ${priorityCounts.CRITICAL}   High: ${priorityCounts.HIGH}   Medium: ${priorityCounts.MEDIUM}   Low: ${priorityCounts.LOW}`, margin, y);
  y += SECTION_GAP;

  for (let i = 0; i < exceptions.length; i++) {
    const exc = exceptions[i];
    const l3 = layer3[i];
    if (y > 260) { doc.addPage(); y = 20; }

    doc.setFillColor(245, 245, 250);
    doc.rect(margin, y - 4, contentW, 8, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(
      `Exception ${i + 1} — GL #${exc.glEntryId}  |  ${categoryLabel(exc.exceptionCategory)}  |  ${formatNGN(exc.glEntryAmount)} ${exc.glEntryType}  |  ${exc.glEntryDate}`,
      margin + 2, y + 1
    );
    y += 9;

    if (l3) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 100, 100);
      const statusLabel = l3.reviewStatus ? `  |  Status: ${l3.reviewStatus}` : "";
      doc.text(`Priority: ${l3.priorityLevel}   Confidence: ${l3.agentConfidence}%${statusLabel}`, margin + 2, y);
      y += LINE_H;

      if (l3.reviewedBy && l3.reviewedAt) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        doc.text(`Reviewed by ${l3.reviewedBy} at ${new Date(l3.reviewedAt).toLocaleString()}`, margin + 2, y);
        y += LINE_H - 1;
      }

      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(60, 60, 60);
      doc.text("AI Analysis:", margin + 2, y);
      y += LINE_H - 1;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(50, 50, 50);
      const explanationLines = doc.splitTextToSize(l3.agentExplanation, contentW - 4);
      for (const line of explanationLines) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(line, margin + 2, y);
        y += LINE_H - 1;
      }

      y += 1;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(146, 64, 14);
      doc.text("Recommended Action:", margin + 2, y);
      y += LINE_H - 1;

      doc.setFont("helvetica", "normal");
      doc.setTextColor(120, 53, 15);
      const actionLines = doc.splitTextToSize(l3.recommendedAction, contentW - 4);
      for (const line of actionLines) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(line, margin + 2, y);
        y += LINE_H - 1;
      }

      if (l3.reviewNote) {
        y += 1;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(30, 80, 30);
        doc.text("Reviewer Note:", margin + 2, y);
        y += LINE_H - 1;
        doc.setFont("helvetica", "normal");
        const noteLines = doc.splitTextToSize(l3.reviewNote, contentW - 4);
        for (const line of noteLines) {
          if (y > 270) { doc.addPage(); y = 20; }
          doc.text(line, margin + 2, y);
          y += LINE_H - 1;
        }
      }
    }
    y += SECTION_GAP;
  }

  const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.setFont("helvetica", "normal");
    doc.text(`ReconcileAI Confidential — Woodcore CBS POC Report — Page ${p} of ${totalPages}`, margin, 295);
  }

  doc.save(`ReconcileAI_Woodcore_Exception_Report_${layer1.periodStart}_${layer1.periodEnd}.pdf`);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon }: {
  label: string; value: string | number; sub?: string; icon: React.ElementType;
}) {
  return (
    <div className="rounded-xl border bg-white p-4 flex gap-3 items-start">
      <div className="mt-0.5 text-indigo-500"><Icon className="h-5 w-5" /></div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-0.5">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5 font-mono">{sub}</p>}
      </div>
    </div>
  );
}

function Layer1Panel({ layer1 }: { layer1: Layer1Result }) {
  const isBalanced = layer1.varianceDirection === "BALANCED";
  const isOver = layer1.varianceDirection === "OVER_POSTED";
  const isLoan = layer1.productName?.toLowerCase().includes("loan") || layer1.productName?.toLowerCase().includes("sme");
  return (
    <div className="space-y-4">
      <div className={`rounded-xl p-4 flex items-center gap-3 ${isBalanced ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
        {isBalanced
          ? <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
          : <AlertTriangle className="h-6 w-6 text-red-600 shrink-0" />}
        <div>
          <p className={`font-semibold text-sm ${isBalanced ? "text-green-800" : "text-red-800"}`}>
            {isBalanced ? "Reconciliation Balanced" : `Variance Detected — ${layer1.varianceDirection.replace("_", " ")}`}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            {layer1.productName} · {layer1.portfolioLedgerName} (GL {layer1.portfolioLedgerGlCode}) · {layer1.periodStart} to {layer1.periodEnd}
          </p>
        </div>
        {!isBalanced && (
          <Badge className="ml-auto bg-red-600 text-white text-sm px-3">
            {formatNGN(Math.abs(layer1.varianceAmount))} {isOver ? "over-posted" : "under-posted"}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Expected Balance</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatNGN(layer1.expectedBalance)}</p>
          <p className="text-xs text-gray-400 mt-1">{isLoan ? "Total disbursements minus principal repaid (CBS loan transactions)" : "Sum of account balances from CBS master"}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Actual GL Balance</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatNGN(layer1.actualGlBalance)}</p>
          <p className="text-xs text-gray-400 mt-1">{isLoan ? "Debits minus credits on Loan Portfolio Account (GL 117083)" : "Credits minus debits on portfolio ledger"}</p>
        </div>
      </div>
      <div className="rounded-xl border bg-white p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">GL Activity Breakdown ({layer1.currencyCode})</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <div><p className="text-xs text-gray-500">GL Credits</p><p className="font-semibold text-sm">{formatNGN(layer1.glCredits)}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-red-500" />
            <div><p className="text-xs text-gray-500">GL Debits</p><p className="font-semibold text-sm">{formatNGN(layer1.glDebits)}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-blue-500" />
            <div><p className="text-xs text-gray-500">{isLoan ? "Total Disbursed" : "CBS Deposits"}</p><p className="font-semibold text-sm">{formatNGN(layer1.savingsDeposits)}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-orange-500" />
            <div><p className="text-xs text-gray-500">{isLoan ? "Principal Repaid" : "CBS Withdrawals"}</p><p className="font-semibold text-sm">{formatNGN(layer1.savingsWithdrawals)}</p></div>
          </div>
        </div>
      </div>
      <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${layer1.layer2Triggered ? "bg-orange-50 border border-orange-200 text-orange-800" : "bg-green-50 border border-green-200 text-green-800"}`}>
        <Layers className="h-4 w-4 shrink-0" />
        {layer1.layer2Triggered
          ? "Variance exceeds threshold — Layer 2 exception classifier triggered automatically."
          : "Balance within threshold — Layer 2 not triggered."}
      </div>
    </div>
  );
}

// ─── Exception Status Dialog ──────────────────────────────────────────────────

function StatusDialog({
  open,
  onClose,
  exceptionId,
  currentStatus,
  currentNote,
  onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  exceptionId: number;
  currentStatus: ReviewStatus;
  currentNote: string | null | undefined;
  onUpdated: (id: number, status: ReviewStatus, note: string, reviewedAt: string) => void;
}) {
  const [status, setStatus] = useState<ReviewStatus>(currentStatus);
  const [note, setNote] = useState(currentNote ?? "");

  const updateMutation = trpc.woodcore.updateExceptionStatus.useMutation({
    onSuccess: (data) => {
      onUpdated(data.exceptionId, data.reviewStatus as ReviewStatus, note, new Date().toISOString());
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-indigo-600" />
            Update Exception Status
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Review Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as ReviewStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open — not yet reviewed</SelectItem>
                <SelectItem value="ACKNOWLEDGED">Acknowledged — under investigation</SelectItem>
                <SelectItem value="RESOLVED">Resolved — corrective action taken</SelectItem>
                <SelectItem value="ESCALATED">Escalated — requires senior review</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Reviewer Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context, findings, or action taken…"
              className="resize-none h-24 text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => updateMutation.mutate({ exceptionId, reviewStatus: status, reviewNote: note, reviewedBy: "Reviewer" })}
            disabled={updateMutation.isPending}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {updateMutation.isPending ? "Saving…" : "Save Status"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Exception Row ────────────────────────────────────────────────────────────

function ExceptionRow({
  exc,
  layer3,
  onStatusUpdate,
}: {
  exc: Layer2Exception;
  layer3?: Layer3Result;
  onStatusUpdate: (id: number, status: ReviewStatus, note: string, reviewedAt: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const reviewStatus: ReviewStatus = (layer3?.reviewStatus as ReviewStatus) ?? "OPEN";

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${categoryColor(exc.exceptionCategory)}`}>
          {categoryLabel(exc.exceptionCategory)}
        </span>
        <span className="text-sm font-mono text-gray-600 shrink-0">GL #{exc.glEntryId}</span>
        {exc.linkedTransactionId && (
          <span className="text-xs font-mono bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded shrink-0" title="GL Transaction ID">TXN: {exc.linkedTransactionId}</span>
        )}
        {exc.linkedSavingsTxnId && (
          <span className="text-xs font-mono bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded shrink-0" title="CBS Savings Transaction ID">CBS: {exc.linkedSavingsTxnId}</span>
        )}
        <span className="text-sm font-semibold text-gray-900 ml-1">{formatNGN(exc.glEntryAmount)}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${exc.glEntryType === "CREDIT" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
          {exc.glEntryType}
        </span>
        <span className="text-xs text-gray-400 ml-1">{exc.glEntryDate}</span>
        {layer3 && (
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-semibold ${priorityColor(layer3.priorityLevel)}`}>
            {layer3.priorityLevel}
          </span>
        )}
        <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${statusStyle(reviewStatus)}`}>
          {statusIcon(reviewStatus)} {reviewStatus}
        </span>
        <span className="ml-1 text-gray-400">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t bg-gray-50 px-4 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-xs text-gray-500 font-medium">GL Entry ID</p><p className="font-mono text-xs font-bold text-gray-800">#{exc.glEntryId}</p></div>
            <div><p className="text-xs text-gray-500 font-medium">GL Transaction ID</p><p className="font-mono text-xs text-blue-700">{exc.linkedTransactionId ?? "—"}</p></div>
            <div><p className="text-xs text-gray-500 font-medium">CBS Savings Txn ID</p><p className="font-mono text-xs text-purple-700">{exc.linkedSavingsTxnId ?? "None"}</p></div>
            <div><p className="text-xs text-gray-500 font-medium">Manual Entry Flag</p><p className="font-semibold">{exc.manualEntryFlag ? "Yes" : "No"}</p></div>
            <div><p className="text-xs text-gray-500 font-medium">Reference</p><p className="font-mono text-xs">{exc.refNum ?? "—"}</p></div>
            <div>
              <p className="text-xs text-gray-500 font-medium">Product Match</p>
              <p className={`font-semibold text-xs ${exc.productMatch === null ? "text-gray-400" : exc.productMatch ? "text-green-600" : "text-red-600"}`}>
                {exc.productMatch === null ? "N/A" : exc.productMatch ? "Yes" : "No — mis-posting"}
              </p>
            </div>
            {exc.description && (
              <div className="col-span-2"><p className="text-xs text-gray-500 font-medium">GL Description</p><p className="text-xs text-gray-700">{exc.description}</p></div>
            )}
          </div>

          {layer3 && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">AI Agent Analysis</p>
                  <span className="text-xs text-gray-400 ml-auto">Confidence: {layer3.agentConfidence}%</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed bg-white rounded-lg p-3 border">{layer3.agentExplanation}</p>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800 mb-1">Recommended Action</p>
                  <p className="text-sm text-amber-900">{layer3.recommendedAction}</p>
                </div>
              </div>
            </>
          )}

          {/* Status tracking */}
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Review Status
              </p>
              <div className="flex items-center gap-2">
                <span className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border font-semibold ${statusStyle(reviewStatus)}`}>
                  {statusIcon(reviewStatus)} {reviewStatus}
                </span>
                {layer3?.reviewedBy && (
                  <span className="text-xs text-gray-400">
                    by {layer3.reviewedBy}
                    {layer3.reviewedAt && ` · ${new Date(layer3.reviewedAt).toLocaleString()}`}
                  </span>
                )}
              </div>
              {layer3?.reviewNote && (
                <p className="text-xs text-gray-600 italic mt-1 bg-white border rounded px-2 py-1">"{layer3.reviewNote}"</p>
              )}
            </div>
            {layer3 && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-indigo-700 border-indigo-300 hover:bg-indigo-50"
                onClick={(e) => { e.stopPropagation(); setDialogOpen(true); }}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Update Status
              </Button>
            )}
          </div>

          {layer3 && dialogOpen && (
            <StatusDialog
              open={dialogOpen}
              onClose={() => setDialogOpen(false)}
              exceptionId={layer3.exceptionId}
              currentStatus={reviewStatus}
              currentNote={layer3.reviewNote}
              onUpdated={onStatusUpdate}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Comparison Panel ─────────────────────────────────────────────────────────

function exportComparisonPDF(
  runA: RunRecord,
  runB: RunRecord,
  exceptionsA: Layer2Exception[],
  exceptionsB: Layer2Exception[],
  catA: Map<string, number>,
  catB: Map<string, number>,
  allCats: string[]
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = 297; // A4 landscape width
  const margin = 14;
  let y = margin;

  // Header banner
  doc.setFillColor(67, 56, 202); // indigo-700
  doc.rect(0, 0, W, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("ReconcileAI — Woodcore CBS Reconciliation POC", margin, 10);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text("Run Comparison Report · Generated " + new Date().toLocaleString(), margin, 17);
  doc.setTextColor(0, 0, 0);
  y = 30;

  // Section title
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Side-by-Side Run Summary", margin, y);
  y += 6;

  const colW = (W - margin * 2 - 6) / 2;
  const panels = [
    { run: runA, exceptions: exceptionsA, label: "Run A" },
    { run: runB, exceptions: exceptionsB, label: "Run B" },
  ];

  panels.forEach(({ run, exceptions, label }, pi) => {
    const x = margin + pi * (colW + 6);
    // Panel header
    doc.setFillColor(pi === 0 ? 79 : 99, pi === 0 ? 70 : 102, pi === 0 ? 229 : 241);
    doc.rect(x, y, colW, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text(`${label} — Run #${run.id}  |  ${run.status}`, x + 3, y + 5.5);
    doc.setTextColor(0, 0, 0);

    let py = y + 12;
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.text(`Period: ${run.periodStart} → ${run.periodEnd}`, x + 3, py); py += 5;
    doc.text(`Expected Balance: ₦${Number(run.expectedBalance).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`, x + 3, py); py += 5;
    doc.text(`Actual GL Balance: ₦${Number(run.actualGlBalance).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`, x + 3, py); py += 5;
    const variance = run.varianceAmount ? Math.abs(parseFloat(run.varianceAmount)) : 0;
    doc.setFont("helvetica", "bold");
    doc.text(`Variance: ₦${variance.toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${run.varianceDirection ?? "—"})`, x + 3, py); py += 5;
    doc.setFont("helvetica", "normal");
    doc.text(`Total Exceptions: ${exceptions.length}`, x + 3, py);
  });

  y += 55;

  // Category comparison table
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Exception Category Comparison", margin, y);
  y += 6;

  // Table header
  doc.setFillColor(243, 244, 246);
  doc.rect(margin, y, W - margin * 2, 7, "F");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("Category", margin + 3, y + 5);
  doc.text("Run A", margin + 100, y + 5);
  doc.text("Run B", margin + 130, y + 5);
  doc.text("Change", margin + 160, y + 5);
  y += 7;

  doc.setFont("helvetica", "normal");
  allCats.forEach((cat, i) => {
    if (i % 2 === 0) {
      doc.setFillColor(249, 250, 251);
      doc.rect(margin, y, W - margin * 2, 7, "F");
    }
    const a = catA.get(cat) ?? 0;
    const b = catB.get(cat) ?? 0;
    const diff = b - a;
    doc.setFontSize(8);
    doc.text(categoryLabel(cat), margin + 3, y + 5);
    doc.text(String(a), margin + 103, y + 5);
    doc.text(String(b), margin + 133, y + 5);
    if (diff !== 0) {
      doc.setTextColor(diff > 0 ? 220 : 22, diff > 0 ? 38 : 163, diff > 0 ? 38 : 74);
    }
    doc.text(diff === 0 ? "—" : (diff > 0 ? `+${diff}` : String(diff)), margin + 163, y + 5);
    doc.setTextColor(0, 0, 0);
    y += 7;
  });

  y += 8;
  // Footer
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text("Confidential — ReconcileAI POC Environment · Woodcore CBS · August 2025 Dataset", margin, y);

  doc.save(`ReconcileAI_Woodcore_Comparison_Run${runA.id}_vs_Run${runB.id}.pdf`);
}

function ComparisonPanel({ runs }: { runs: RunRecord[] }) {
  const [runIdA, setRunIdA] = useState<number | null>(null);
  const [runIdB, setRunIdB] = useState<number | null>(null);

  const compareQuery = trpc.woodcore.compareRuns.useQuery(
    { runIdA: runIdA!, runIdB: runIdB! },
    { enabled: runIdA !== null && runIdB !== null && runIdA !== runIdB }
  );

  const data = compareQuery.data;

  function countByCategory(exceptions: Layer2Exception[]) {
    const m = new Map<string, number>();
    for (const e of exceptions) m.set(e.exceptionCategory, (m.get(e.exceptionCategory) ?? 0) + 1);
    return m;
  }

  const catA = data ? countByCategory(data.exceptionsA as Layer2Exception[]) : new Map<string, number>();
  const catB = data ? countByCategory(data.exceptionsB as Layer2Exception[]) : new Map<string, number>();
  const allCats = Array.from(new Set([...Array.from(catA.keys()), ...Array.from(catB.keys())]));

  return (
    <div className="space-y-4">
      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide flex items-center gap-1.5 mb-3">
          <GitCompare className="h-3.5 w-3.5" /> Select Two Runs to Compare
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-600">Run A</Label>
            <Select value={runIdA?.toString() ?? ""} onValueChange={(v) => setRunIdA(Number(v))}>
              <SelectTrigger className="bg-white">
                <SelectValue placeholder="Select run…" />
              </SelectTrigger>
              <SelectContent>
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id.toString()}>
                    Run #{r.id} — {r.periodStart} → {r.periodEnd} ({r.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-600">Run B</Label>
            <Select value={runIdB?.toString() ?? ""} onValueChange={(v) => setRunIdB(Number(v))}>
              <SelectTrigger className="bg-white">
                <SelectValue placeholder="Select run…" />
              </SelectTrigger>
              <SelectContent>
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id.toString()}>
                    Run #{r.id} — {r.periodStart} → {r.periodEnd} ({r.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {compareQuery.isLoading && (
        <div className="text-center py-8 text-gray-400">
          <RefreshCw className="h-6 w-6 mx-auto mb-2 animate-spin text-indigo-400" />
          <p className="text-sm">Loading comparison…</p>
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Side-by-side summary */}
          <div className="grid grid-cols-2 gap-4">
            {([
              { run: data.runA, exceptions: data.exceptionsA, label: "Run A" },
              { run: data.runB, exceptions: data.exceptionsB, label: "Run B" },
            ] as { run: RunRecord; exceptions: Layer2Exception[]; label: string }[]).map(({ run, exceptions, label }) => (
              <div key={label} className="border rounded-xl overflow-hidden">
                <div className="bg-indigo-600 text-white px-4 py-2 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wide">{label} — Run #{run?.id}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${run?.status === "BALANCED" ? "bg-green-400 text-green-900" : "bg-red-400 text-red-900"}`}>
                    {run?.status}
                  </span>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-xs text-gray-500 font-medium">Period</p>
                    <p className="text-sm font-semibold">{run?.periodStart} → {run?.periodEnd}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-xs text-gray-500">Expected</p>
                      <p className="text-sm font-bold">{formatNGN(run?.expectedBalance)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Actual GL</p>
                      <p className="text-sm font-bold">{formatNGN(run?.actualGlBalance)}</p>
                    </div>
                  </div>
                  <div className={`rounded-lg p-2 text-center ${run?.status === "BALANCED" ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                    <p className="text-xs text-gray-500">Variance</p>
                    <p className={`text-lg font-bold ${run?.status === "BALANCED" ? "text-green-700" : "text-red-700"}`}>
                      {run?.varianceAmount ? formatNGN(Math.abs(parseFloat(run.varianceAmount))) : "—"}
                    </p>
                    {run?.varianceDirection && run.varianceDirection !== "BALANCED" && (
                      <p className="text-xs text-gray-500">{run.varianceDirection.replace("_", " ")}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 font-medium mb-1">Exceptions ({exceptions.length})</p>
                    {exceptions.length === 0 ? (
                      <p className="text-xs text-green-600">None detected</p>
                    ) : (
                      <div className="space-y-1">
                        {Array.from(countByCategory(exceptions).entries()).map(([cat, count]) => (
                          <div key={cat} className="flex items-center justify-between">
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${categoryColor(cat)}`}>{categoryLabel(cat)}</span>
                            <span className="text-xs font-bold text-gray-700">{count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Category comparison table */}
          {allCats.length > 0 && (
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 border-b">
                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Exception Category Comparison</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Category</th>
                    <th className="text-center px-4 py-2 text-xs font-semibold text-indigo-600">Run A</th>
                    <th className="text-center px-4 py-2 text-xs font-semibold text-indigo-600">Run B</th>
                    <th className="text-center px-4 py-2 text-xs font-semibold text-gray-500">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {allCats.map((cat) => {
                    const a = catA.get(cat) ?? 0;
                    const b = catB.get(cat) ?? 0;
                    const diff = b - a;
                    return (
                      <tr key={cat} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${categoryColor(cat)}`}>{categoryLabel(cat)}</span>
                        </td>
                        <td className="text-center px-4 py-2 font-bold">{a}</td>
                        <td className="text-center px-4 py-2 font-bold">{b}</td>
                        <td className="text-center px-4 py-2">
                          {diff === 0 ? (
                            <span className="text-gray-400 text-xs">—</span>
                          ) : diff > 0 ? (
                            <span className="text-red-600 text-xs font-semibold flex items-center justify-center gap-0.5">
                              <ArrowUpCircle className="h-3 w-3" /> +{diff}
                            </span>
                          ) : (
                            <span className="text-green-600 text-xs font-semibold">{diff}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
            onClick={() =>
              exportComparisonPDF(
                data.runA as RunRecord,
                data.runB as RunRecord,
                data.exceptionsA as Layer2Exception[],
                data.exceptionsB as Layer2Exception[],
                catA,
                catB,
                allCats
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export Comparison to PDF
          </Button>
        </div>
      )}

      {!data && !compareQuery.isLoading && runIdA !== null && runIdB !== null && runIdA !== runIdB && (
        <div className="text-center py-8 text-gray-400">
          <p className="text-sm">No data available for the selected runs.</p>
        </div>
      )}

      {runIdA === null || runIdB === null ? (
        <div className="text-center py-8 text-gray-400">
          <GitCompare className="h-8 w-8 mx-auto mb-2 text-indigo-200" />
          <p className="text-sm">Select two runs above to see the side-by-side comparison.</p>
          <p className="text-xs mt-1 text-gray-300">Run multiple periods first using the Run POC button.</p>
        </div>
      ) : null}
    </div>
  );
}

// ─── Date Range Presets ───────────────────────────────────────────────────────

const DATE_PRESETS = [
  { label: "April only", start: "2025-04-01", end: "2025-04-30" },
  { label: "May only", start: "2025-05-01", end: "2025-05-31" },
  { label: "June only", start: "2025-06-01", end: "2025-06-30" },
  { label: "July only", start: "2025-07-01", end: "2025-07-31" },
  { label: "Apr–Jun", start: "2025-04-01", end: "2025-06-30" },
  { label: "Apr–Jul (full)", start: "2025-04-01", end: "2025-07-31" },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── Variance Sparkline ──────────────────────────────────────────────────────

function VarianceSparkline({ runs }: { runs: RunRecord[] }) {
  if (runs.length < 2) return null;
  const sorted = [...runs].sort((a, b) => a.id - b.id);
  const data = sorted.map((r) => ({
    name: `Run #${r.id}`,
    variance: r.varianceAmount ? Math.abs(parseFloat(r.varianceAmount)) : 0,
    period: `${r.periodStart?.slice(5)} → ${r.periodEnd?.slice(5)}`,
  }));
  const max = Math.max(...data.map((d) => d.variance));
  const min = Math.min(...data.map((d) => d.variance));
  const trend = data[data.length - 1].variance < data[0].variance ? "improving" : "worsening";
  return (
    <div className="bg-white border rounded-xl px-5 py-3 flex items-center gap-4">
      <div className="shrink-0">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Variance Trend</p>
        <p className={`text-xs font-bold mt-0.5 ${trend === "improving" ? "text-green-600" : "text-red-500"}`}>
          {trend === "improving" ? "↓ Improving" : "↑ Worsening"} across {data.length} runs
        </p>
      </div>
      <div className="flex-1" style={{ height: 48 }}>
        <ResponsiveContainer width="100%" height={48}>
          <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <Line
              type="monotone"
              dataKey="variance"
              stroke={trend === "improving" ? "#16a34a" : "#dc2626"}
              strokeWidth={2}
              dot={{ r: 3, fill: trend === "improving" ? "#16a34a" : "#dc2626" }}
              isAnimationActive={false}
            />
            <Tooltip
              formatter={(v: number) => [`₦${v.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`, "Variance"]}
              labelFormatter={(label) => label}
              contentStyle={{ fontSize: 11, padding: "4px 8px" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-xs text-gray-400">Peak: ₦{max.toLocaleString("en-NG", { minimumFractionDigits: 0 })}</p>
        <p className="text-xs text-gray-400">Low: ₦{min.toLocaleString("en-NG", { minimumFractionDigits: 0 })}</p>
      </div>
    </div>
  );
}

// ─── POC Mode Panel ─────────────────────────────────────────────────────────
// A self-contained panel for one POC mode (Savings or Loan).
// All state is local to this component so the two modes never interfere.
function POCModePanel({
  mode,
  onBack,
}: {
  mode: "SAVINGS" | "LOAN";
  onBack: () => void;
}) {
  const isSavings = mode === "SAVINGS";
  const accentClass = isSavings ? "bg-indigo-600 hover:bg-indigo-700" : "bg-amber-600 hover:bg-amber-700";
  const accentText = isSavings ? "text-indigo-600" : "text-amber-600";
  const accentBorder = isSavings ? "border-indigo-300" : "border-amber-300";
  const accentBg = isSavings ? "bg-indigo-50" : "bg-amber-50";

  const [pocResult, setPocResult] = useState<POCResult | null>(null);
  const [activeTab, setActiveTab] = useState("layer1");
  const [periodStart, setPeriodStart] = useState("2025-04-01");
  const [periodEnd, setPeriodEnd] = useState("2025-07-31");
  const [showDatePanel, setShowDatePanel] = useState(false);
  const [layer3Local, setLayer3Local] = useState<Layer3Result[]>([]);
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | "ALL">("ALL");
  const [bulkAckOpen, setBulkAckOpen] = useState(false);
  const [bulkNote, setBulkNote] = useState("");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const statsQuery = trpc.woodcore.stats.useQuery();
  const runsQuery = trpc.woodcore.getRuns.useQuery();

  const bulkAcknowledge = trpc.woodcore.bulkAcknowledge.useMutation({
    onSuccess: () => {
      setLayer3Local((prev) =>
        prev.map((r) => (r.reviewStatus === "OPEN" || !r.reviewStatus)
          ? { ...r, reviewStatus: "ACKNOWLEDGED", reviewNote: bulkNote || "Bulk acknowledged", reviewedBy: "Reviewer", reviewedAt: new Date().toISOString() }
          : r
        )
      );
      setBulkAckOpen(false);
      setBulkNote("");
    },
  });

  const createShareToken = trpc.woodcore.createShareToken.useMutation({
    onSuccess: (data) => { setShareToken(data.token); },
  });

  const runPOC = trpc.woodcore.runPOC.useMutation({
    onSuccess: (data) => {
      const result = data as POCResult;
      setPocResult(result);
      setLayer3Local(result.layer3Results ?? []);
      setActiveTab("layer1");
      runsQuery.refetch();
    },
  });

  const stats = statsQuery.data;
  const isRunning = runPOC.isPending;
  // Filter runs to only show those matching this panel's mode
  const allRuns: RunRecord[] = (runsQuery.data ?? []) as RunRecord[];
  const runs: RunRecord[] = allRuns.filter((r) => {
    const pt = (r.productType ?? "").toUpperCase();
    if (mode === "SAVINGS") return pt === "SAVINGS" || pt === "";
    return pt === "LOAN";
  });

  const categoryCount = new Map<string, number>();
  for (const exc of pocResult?.layer2Exceptions ?? []) {
    categoryCount.set(exc.exceptionCategory, (categoryCount.get(exc.exceptionCategory) ?? 0) + 1);
  }

  const handleStatusUpdate = useCallback((id: number, status: ReviewStatus, note: string, reviewedAt: string) => {
    setLayer3Local((prev) =>
      prev.map((r) =>
        r.exceptionId === id
          ? { ...r, reviewStatus: status, reviewNote: note, reviewedAt, reviewedBy: "Reviewer" }
          : r
      )
    );
  }, []);

  const handleRunPOC = () => {
    const productId = mode === "LOAN" ? 1 : 2;
    runPOC.mutate({ productId, productType: mode, currencyCode: "NGN", periodStart, periodEnd, varianceThreshold: 1.0 });
    setShowDatePanel(false);
  };

  const modeLabel = isSavings ? "Savings Reconciliation" : "Loan Principal Balance Reconciliation";
  const modeGlLabel = isSavings ? "GL 100001 · Savings Control Account" : "GL 117083 · SME Loan Portfolio Account";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mode sub-header */}
      <div className={`${isSavings ? "bg-gradient-to-r from-indigo-700 to-indigo-500" : "bg-gradient-to-r from-amber-700 to-amber-500"} px-6 py-3 flex items-center gap-3`}>
        <button
          onClick={onBack}
          className="text-white/80 hover:text-white text-xs flex items-center gap-1 border border-white/30 rounded-full px-3 py-1 transition-colors"
        >
          ← Back to POC Selection
        </button>
        <div className="h-4 w-px bg-white/30" />
        <span className="text-white text-sm font-semibold">{modeLabel}</span>
        <span className="text-white/70 text-xs">{modeGlLabel}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDatePanel(!showDatePanel)}
            className="gap-1.5 text-white border-white/40 bg-white/10 hover:bg-white/20 hover:text-white text-xs"
          >
            <Calendar className="h-3.5 w-3.5" />
            {periodStart} → {periodEnd}
            <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
          <Button
            onClick={handleRunPOC}
            disabled={isRunning}
            className="bg-white text-gray-800 hover:bg-gray-100 gap-2 text-sm font-semibold"
          >
            {isRunning
              ? <><RefreshCw className="h-4 w-4 animate-spin" /> Running…</>
              : <><Play className="h-4 w-4" /> Run POC</>}
          </Button>
        </div>
      </div>

      {/* Date panel */}
      {showDatePanel && (
        <div className="bg-white border-b px-6 py-4">
          <div className="border rounded-xl bg-gray-50 p-4 space-y-4">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" /> Select Analysis Period
            </p>
            <div className="flex flex-wrap gap-2">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { setPeriodStart(p.start); setPeriodEnd(p.end); }}
                  className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
                    periodStart === p.start && periodEnd === p.end
                      ? `${accentClass} text-white`
                      : "bg-white text-gray-700 border-gray-300 hover:border-indigo-400 hover:text-indigo-600"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">From</Label>
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="h-8 text-sm w-40" min="2025-04-01" max="2025-07-31" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">To</Label>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="h-8 text-sm w-40" min="2025-04-01" max="2025-07-31" />
              </div>
              <Button size="sm" onClick={handleRunPOC} disabled={isRunning} className={`${accentClass} text-white gap-1.5`}>
                <Play className="h-3.5 w-3.5" /> Run
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Dataset stats */}
        <div className="grid grid-cols-3 gap-4">
          {isSavings ? (
            <>
              <StatCard label="GL Journal Entries" value={stats?.glEntries ?? "—"} sub="wc_acc_gl_journal_entry" icon={FileText} />
              <StatCard label="Savings Transactions" value={stats?.savingsTransactions ?? "—"} sub="wc_m_savings_account_transaction" icon={TrendingUp} />
              <StatCard label="Savings Accounts" value={stats?.savingsAccounts ?? "—"} sub="wc_m_savings_account" icon={Database} />
            </>
          ) : (
            <>
              <StatCard label="GL Journal Entries" value={stats?.glEntries ?? "—"} sub="wc_acc_gl_journal_entry" icon={FileText} />
              <StatCard label="Loan Transactions" value={(stats as any)?.loanTransactions ?? "—"} sub="wc_m_loan_transaction" icon={TrendingUp} />
              <StatCard label="Loan Accounts" value={(stats as any)?.loanAccounts ?? "—"} sub="wc_m_loan (SME product)" icon={Database} />
            </>
          )}
        </div>

        {runs.length >= 2 && <VarianceSparkline runs={runs} />}

        {/* Initial state */}
        {!pocResult && runs.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Play className={`h-12 w-12 mx-auto mb-4 ${accentText}`} />
            <p className="text-lg font-semibold text-gray-600">Ready to run</p>
            <p className="text-sm mt-2 max-w-md mx-auto">
              Select a period above and click <strong>Run POC</strong> to execute all three layers against the real Woodcore CBS dataset.
            </p>
          </div>
        )}

        {/* Run history when no fresh result */}
        {!pocResult && runs.length > 0 && (
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-gray-700">Previous Runs</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {runs.slice(0, 8).map((run) => (
                    <div key={run.id} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                      <span className="font-mono text-gray-500 text-xs">Run #{run.id}</span>
                      <span className="text-gray-700">{run.productName}</span>
                      <span className="text-gray-400">{run.periodStart} → {run.periodEnd}</span>
                      <Badge className={`ml-auto text-xs ${run.status === "BALANCED" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {run.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <ComparisonPanel runs={runs} />
          </div>
        )}

        {/* POC results */}
        {pocResult && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className={`bg-white border`}>
              <TabsTrigger value="layer1" className="gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" /> Layer 1 — Balance
              </TabsTrigger>
              <TabsTrigger value="layer2" className="gap-1.5">
                <Layers className="h-3.5 w-3.5" /> Layer 2 — Exceptions
                {pocResult.layer2Exceptions.length > 0 && (
                  <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold">
                    {pocResult.layer2Exceptions.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="layer3" className="gap-1.5">
                <Bot className="h-3.5 w-3.5" /> Layer 3 — AI Agent
                {layer3Local.length > 0 && (
                  <span className="ml-1 bg-indigo-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold">
                    {layer3Local.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="compare" className="gap-1.5">
                <GitCompare className="h-3.5 w-3.5" /> Compare Runs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="layer1" className="mt-4">
              <Layer1Panel layer1={pocResult.layer1} />
            </TabsContent>

            <TabsContent value="layer2" className="mt-4 space-y-4">
              {pocResult.layer2Exceptions.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-400" />
                  <p className="font-medium">No exceptions found</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(categoryCount.entries()).map(([cat, count]) => (
                      <span key={cat} className={`text-xs font-semibold px-3 py-1 rounded-full border ${categoryColor(cat)}`}>
                        {categoryLabel(cat)}: {count}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">
                      {pocResult.layer2Exceptions.filter((_, i) => ((layer3Local[i]?.reviewStatus as ReviewStatus) ?? "OPEN") === "OPEN").length} OPEN exception(s) pending review
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50"
                      onClick={() => setBulkAckOpen(true)}
                      disabled={pocResult.layer2Exceptions.filter((_, i) => ((layer3Local[i]?.reviewStatus as ReviewStatus) ?? "OPEN") === "OPEN").length === 0}
                    >
                      <CheckCheck className="h-3.5 w-3.5" /> Mark All as Acknowledged
                    </Button>
                  </div>
                  <Dialog open={bulkAckOpen} onOpenChange={setBulkAckOpen}>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <CheckCheck className="h-4 w-4 text-blue-600" /> Bulk Acknowledge All OPEN Exceptions
                        </DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3 py-2">
                        <p className="text-sm text-gray-600">
                          This will mark all <strong>{pocResult.layer2Exceptions.filter((_, i) => ((layer3Local[i]?.reviewStatus as ReviewStatus) ?? "OPEN") === "OPEN").length} OPEN</strong> exceptions as <strong>ACKNOWLEDGED</strong> for Run #{pocResult.layer1.runId}.
                        </p>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-gray-600">Reviewer Note (optional)</Label>
                          <Textarea
                            placeholder="e.g. Reviewed by compliance team — all manual entries confirmed as authorised"
                            value={bulkNote}
                            onChange={(e) => setBulkNote(e.target.value)}
                            className="text-sm"
                            rows={3}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setBulkAckOpen(false)}>Cancel</Button>
                        <Button
                          size="sm"
                          className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5"
                          onClick={() => bulkAcknowledge.mutate({ runId: pocResult.layer1.runId, reviewedBy: "Reviewer", reviewNote: bulkNote })}
                          disabled={bulkAcknowledge.isPending}
                        >
                          {bulkAcknowledge.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                          Acknowledge All
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <div className="flex items-center gap-2 bg-gray-50 border rounded-xl px-4 py-2.5">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">Filter by status:</span>
                    {(["ALL", "OPEN", "ACKNOWLEDGED", "RESOLVED", "ESCALATED"] as const).map((s) => {
                      const count = s === "ALL"
                        ? pocResult.layer2Exceptions.length
                        : pocResult.layer2Exceptions.filter((_, i) => ((layer3Local[i]?.reviewStatus as ReviewStatus) ?? "OPEN") === s).length;
                      return (
                        <button
                          key={s}
                          onClick={() => setStatusFilter(s)}
                          className={`text-xs px-3 py-1 rounded-full border font-semibold transition-all ${
                            statusFilter === s
                              ? s === "ALL" ? "bg-gray-700 text-white border-gray-700"
                                : s === "OPEN" ? "bg-gray-600 text-white border-gray-600"
                                : s === "ACKNOWLEDGED" ? "bg-blue-600 text-white border-blue-600"
                                : s === "RESOLVED" ? "bg-green-600 text-white border-green-600"
                                : "bg-red-600 text-white border-red-600"
                              : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
                          }`}
                        >
                          {s === "ALL" ? `All (${count})` : `${s} (${count})`}
                        </button>
                      );
                    })}
                  </div>
                  <div className="space-y-2">
                    {pocResult.layer2Exceptions
                      .map((exc, idx) => ({ exc, idx, layer3: layer3Local[idx] }))
                      .filter(({ layer3 }) => {
                        if (statusFilter === "ALL") return true;
                        const s: ReviewStatus = (layer3?.reviewStatus as ReviewStatus) ?? "OPEN";
                        return s === statusFilter;
                      })
                      .map(({ exc, idx, layer3 }) => (
                        <ExceptionRow
                          key={exc.glEntryId}
                          exc={exc}
                          layer3={layer3}
                          onStatusUpdate={handleStatusUpdate}
                        />
                      ))
                    }
                    {pocResult.layer2Exceptions
                      .filter((_, i) => {
                        if (statusFilter === "ALL") return false;
                        const s: ReviewStatus = (layer3Local[i]?.reviewStatus as ReviewStatus) ?? "OPEN";
                        return s !== statusFilter;
                      }).length === pocResult.layer2Exceptions.length && (
                      <div className="text-center py-8 text-gray-400">
                        <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                        <p className="text-sm">No exceptions with status <strong>{statusFilter}</strong></p>
                        <button className="text-xs text-indigo-500 mt-1 underline" onClick={() => setStatusFilter("ALL")}>Show all</button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="layer3" className="mt-4 space-y-4">
              {layer3Local.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <Bot className="h-10 w-10 mx-auto mb-3 text-indigo-300" />
                  <p className="font-medium">No AI analysis generated</p>
                </div>
              ) : (
                <>
                  <div className={`${accentBg} border ${accentBorder} rounded-xl p-4 flex items-start gap-3`}>
                    <Bot className={`h-5 w-5 ${accentText} shrink-0 mt-0.5`} />
                    <div className="flex-1">
                      <p className={`text-sm font-semibold ${accentText}`}>Context-Aware Agent Report — {modeLabel}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {layer3Local.length} exception{layer3Local.length !== 1 ? "s" : ""} analysed · Period: {pocResult.layer1.periodStart} to {pocResult.layer1.periodEnd}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className={`gap-1.5 ${accentBorder} ${accentText} hover:${accentBg}`}
                        onClick={() => exportToPDF(pocResult.layer1, pocResult.layer2Exceptions, layer3Local)}
                      >
                        <Download className="h-3.5 w-3.5" /> Download PDF
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 border-green-300 text-green-700 hover:bg-green-50"
                        onClick={() => createShareToken.mutate({ runId: pocResult.layer1.runId, createdBy: "ReconcileAI User" })}
                        disabled={createShareToken.isPending}
                      >
                        {createShareToken.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                        Share Report
                      </Button>
                    </div>
                  </div>
                  {shareToken && (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                      <p className="text-xs font-semibold text-green-800 mb-2 flex items-center gap-1.5">
                        <Share2 className="h-3.5 w-3.5" /> Shareable Report Link (valid 30 days)
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-white border border-green-200 rounded px-2 py-1.5 font-mono text-green-900 truncate">
                          {window.location.origin}/shared-report/{shareToken}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 border-green-300 text-green-700 hover:bg-green-100 gap-1"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/shared-report/${shareToken}`);
                            setShareCopied(true);
                            setTimeout(() => setShareCopied(false), 2000);
                          }}
                        >
                          {shareCopied ? <CheckCheckIcon className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          {shareCopied ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                      <p className="text-xs text-green-600 mt-1.5">Anyone with this link can view the exception report without logging in.</p>
                    </div>
                  )}
                  <div className="grid grid-cols-4 gap-3">
                    {([
                      { level: "CRITICAL", def: "Immediate action — regulatory breach or material financial exposure" },
                      { level: "HIGH",     def: "Resolve within 4 hrs — significant variance or fraud indicator" },
                      { level: "MEDIUM",   def: "Resolve within 24 hrs — timing or posting difference, low financial risk" },
                      { level: "LOW",      def: "Informational — minor discrepancy, auto-resolvable or monitoring only" },
                    ] as const).map(({ level: p, def }) => {
                      const count = layer3Local.filter((r) => r.priorityLevel === p).length;
                      return (
                        <div key={p} className={`rounded-xl p-3 text-center ${priorityColor(p)}`}>
                          <p className="text-2xl font-bold">{count}</p>
                          <p className="text-xs font-semibold opacity-90 mt-0.5 tracking-wide">{p}</p>
                          <p className="text-[10px] opacity-75 mt-1 leading-tight">{def}</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="space-y-3">
                    {layer3Local.map((r, idx) => {
                      const exc = pocResult.layer2Exceptions[idx];
                      const reviewStatus: ReviewStatus = (r.reviewStatus as ReviewStatus) ?? "OPEN";
                      return (
                        <div key={r.exceptionId} className="border rounded-xl overflow-hidden bg-white">
                          <div className="px-4 py-3 flex items-center gap-3 bg-gray-50 border-b">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${priorityColor(r.priorityLevel)}`}>{r.priorityLevel}</span>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${categoryColor(r.agentClassification)}`}>{categoryLabel(r.agentClassification)}</span>
                            <span className="text-sm font-mono text-gray-500">Exception #{r.exceptionId}</span>
                            {exc && <span className="text-sm font-semibold text-gray-700 ml-1">{formatNGN(exc.glEntryAmount)}</span>}
                            <span className={`ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${statusStyle(reviewStatus)}`}>
                              {statusIcon(reviewStatus)} {reviewStatus}
                            </span>
                            <span className="text-xs text-gray-400">Confidence: {r.agentConfidence}%</span>
                          </div>
                          <div className="px-4 py-4 space-y-3">
                            <p className="text-sm text-gray-700 leading-relaxed">{r.agentExplanation}</p>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                              <p className="text-xs font-semibold text-amber-800 mb-1">Recommended Action</p>
                              <p className="text-sm text-amber-900">{r.recommendedAction}</p>
                            </div>
                            {r.reviewNote && (
                              <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                                <p className="text-xs font-semibold text-green-800 mb-1 flex items-center gap-1">
                                  <User className="h-3 w-3" /> Reviewer Note
                                  {r.reviewedAt && <span className="font-normal text-green-600 ml-1">· {new Date(r.reviewedAt).toLocaleString()}</span>}
                                </p>
                                <p className="text-sm text-green-900 italic">"{r.reviewNote}"</p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="compare" className="mt-4">
              <ComparisonPanel runs={runs} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}


// ─── Main Page ────────────────────────────────────────────────────────────────
export default function WoodcorePOC() {
  const [activeMode, setActiveMode] = useState<"SAVINGS" | "LOAN" | null>(null);

  if (activeMode !== null) {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* Woodcore Branding Banner */}
        <div className="bg-gradient-to-r from-[#1a2f6e] via-[#1e3a8a] to-[#2563eb] px-6 py-3 flex items-center gap-4">
          <img
            src={WOODCORE_LOGO}
            alt="WoodCore"
            className="h-7 object-contain brightness-0 invert"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="h-5 w-px bg-white/30" />
          <div>
            <p className="text-white text-sm font-semibold leading-none">Woodcore CBS — AI Reconciliation POC</p>
            <p className="text-blue-200 text-xs mt-0.5">Powered by ReconcileAI · Live production dataset · August 2025</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-blue-200 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">
              Confidential — POC Environment
            </span>
          </div>
        </div>
        <POCModePanel mode={activeMode} onBack={() => setActiveMode(null)} />
      </div>
    );
  }

  // Landing — two-card selector
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Woodcore Branding Banner */}
      <div className="bg-gradient-to-r from-[#1a2f6e] via-[#1e3a8a] to-[#2563eb] px-6 py-3 flex items-center gap-4">
        <img
          src={WOODCORE_LOGO}
          alt="WoodCore"
          className="h-7 object-contain brightness-0 invert"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        <div className="h-5 w-px bg-white/30" />
        <div>
          <p className="text-white text-sm font-semibold leading-none">Woodcore CBS — AI Reconciliation POC</p>
          <p className="text-blue-200 text-xs mt-0.5">Powered by ReconcileAI · Live production dataset · August 2025</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-blue-200 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">
            Confidential — POC Environment
          </span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-16 space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">Select a Reconciliation POC</h1>
          <p className="text-gray-500 text-sm">Choose a product type to run the AI reconciliation engine against the live Woodcore CBS dataset.</p>
        </div>
        <div className="grid grid-cols-2 gap-6">
          {/* Savings card */}
          <button
            onClick={() => setActiveMode("SAVINGS")}
            className="group text-left border-2 border-indigo-200 hover:border-indigo-500 bg-white rounded-2xl p-8 shadow-sm hover:shadow-md transition-all space-y-4"
          >
            <div className="h-12 w-12 rounded-xl bg-indigo-100 flex items-center justify-center group-hover:bg-indigo-600 transition-colors">
              <TrendingUp className="h-6 w-6 text-indigo-600 group-hover:text-white transition-colors" />
            </div>
            <div>
              <p className="text-lg font-bold text-gray-900">Savings Reconciliation</p>
              <p className="text-xs text-indigo-600 font-semibold mt-0.5">GL 100001 · Savings Control Account</p>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed">Reconcile CBS savings account transactions against the GL savings control account. Detects timing differences, unposted withdrawals, and manual entry anomalies.</p>
            <div className="flex items-center gap-2 text-indigo-600 text-sm font-semibold">
              Launch Savings POC <span>→</span>
            </div>
          </button>
          {/* Loan card */}
          <button
            onClick={() => setActiveMode("LOAN")}
            className="group text-left border-2 border-amber-200 hover:border-amber-500 bg-white rounded-2xl p-8 shadow-sm hover:shadow-md transition-all space-y-4"
          >
            <div className="h-12 w-12 rounded-xl bg-amber-100 flex items-center justify-center group-hover:bg-amber-600 transition-colors">
              <Database className="h-6 w-6 text-amber-600 group-hover:text-white transition-colors" />
            </div>
            <div>
              <p className="text-lg font-bold text-gray-900">Loan Principal Balance</p>
              <p className="text-xs text-amber-600 font-semibold mt-0.5">GL 117083 · SME Loan Portfolio Account</p>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed">Reconcile SME loan disbursements and principal repayments against the GL loan portfolio account. Detects mispostings, orphaned entries, and unposted repayments.</p>
            <div className="flex items-center gap-2 text-amber-600 text-sm font-semibold">
              Launch Loan POC <span>→</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
