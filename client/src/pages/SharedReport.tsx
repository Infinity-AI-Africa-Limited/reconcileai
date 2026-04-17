/**
 * ReconcileAI — Public Shared Report Page
 * Read-only view of a specific run's Layer 3 exception report, accessible via a share token.
 * No login required.
 */

import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileText,
  TrendingUp,
  User,
  Clock,
  Shield,
} from "lucide-react";

const WOODCORE_LOGO =
  "https://d2xsxph8kpxj0f.cloudfront.net/310419663029108989/fGjDi9wkBzgbvTayKYVoMB/woodcore-logo_78b5eba6.png";

function formatNGN(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priorityColor(p: string) {
  if (p === "CRITICAL") return "bg-red-100 text-red-800 border-red-300";
  if (p === "HIGH") return "bg-orange-100 text-orange-800 border-orange-300";
  if (p === "MEDIUM") return "bg-yellow-100 text-yellow-800 border-yellow-300";
  return "bg-gray-100 text-gray-700 border-gray-300";
}

function statusStyle(s: string) {
  if (s === "ACKNOWLEDGED") return "bg-blue-50 text-blue-700 border-blue-300";
  if (s === "RESOLVED") return "bg-green-50 text-green-700 border-green-300";
  if (s === "ESCALATED") return "bg-red-50 text-red-700 border-red-300";
  return "bg-gray-50 text-gray-600 border-gray-300";
}

export default function SharedReport() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const reportQuery = trpc.woodcore.getSharedReport.useQuery(
    { token: token ?? "" },
    { enabled: !!token }
  );

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="h-10 w-10 text-red-400 mx-auto mb-3" />
          <p className="text-gray-700 font-semibold">Invalid report link</p>
          <p className="text-sm text-gray-500 mt-1">This link is missing a report token.</p>
        </div>
      </div>
    );
  }

  if (reportQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">Loading report…</p>
        </div>
      </div>
    );
  }

  if (reportQuery.error || !reportQuery.data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <AlertTriangle className="h-10 w-10 text-red-400 mx-auto mb-3" />
          <p className="text-gray-700 font-semibold">Report not found or expired</p>
          <p className="text-sm text-gray-500 mt-1">
            This link may have expired (30-day limit) or the token is invalid.
          </p>
        </div>
      </div>
    );
  }

  const { run, exceptions, layer3Results } = reportQuery.data as unknown as {
    run: {
      id: number;
      productName: string;
      periodStart: string;
      periodEnd: string;
      expectedBalance: string;
      actualGlBalance: string;
      varianceAmount: string;
      varianceDirection: string;
      status: string;
    };
    exceptions: Array<{
      glEntryId: number;
      glEntryAmount: number;
      glEntryType: string;
      glEntryDate: string;
      exceptionCategory: string;
      manualEntryFlag: boolean | number;
      refNum: string | null;
      linkedSavingsTxnId: number | null;
      productMatch: boolean | null;
      description: string | null;
    }>;
    layer3Results: Array<{
      exceptionId: number;
      priorityLevel: string;
      agentClassification: string;
      agentExplanation: string;
      recommendedAction: string;
      agentConfidence: number;
      reviewStatus: string | null;
      reviewNote: string | null;
      reviewedBy: string | null;
      reviewedAt: string | null;
    }>;
  };

  const openCount = layer3Results.filter((r) => !r.reviewStatus || r.reviewStatus === "OPEN").length;
  const resolvedCount = layer3Results.filter((r) => r.reviewStatus === "RESOLVED").length;
  const criticalCount = layer3Results.filter((r) => r.priorityLevel === "CRITICAL").length;

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
          <p className="text-white text-sm font-semibold leading-none">Woodcore CBS — AI Reconciliation Report</p>
          <p className="text-blue-200 text-xs mt-0.5">Powered by ReconcileAI · Read-only shared view</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-blue-200 bg-white/10 px-2.5 py-1 rounded-full border border-white/20 flex items-center gap-1.5">
            <Shield className="h-3 w-3" /> Read-only · Confidential
          </span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Report header */}
        <div className="bg-white border rounded-xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <FileText className="h-5 w-5 text-indigo-600" />
                <h1 className="text-lg font-bold text-gray-900">Exception Report — Run #{run.id}</h1>
                <Badge className={`text-xs ${run.status === "BALANCED" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {run.status}
                </Badge>
              </div>
              <p className="text-sm text-gray-500">{run.productName} · {run.periodStart} → {run.periodEnd}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-gray-400">Generated by ReconcileAI</p>
              <p className="text-xs text-gray-400 mt-0.5">Woodcore CBS · August 2025 Dataset</p>
            </div>
          </div>

          {/* Layer 1 summary */}
          <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t">
            <div className="text-center">
              <p className="text-xs text-gray-500 font-medium">Expected Balance</p>
              <p className="text-base font-bold text-gray-900 mt-0.5">{formatNGN(run.expectedBalance)}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-gray-500 font-medium">Actual GL Balance</p>
              <p className="text-base font-bold text-gray-900 mt-0.5">{formatNGN(run.actualGlBalance)}</p>
            </div>
            <div className={`text-center rounded-lg p-2 ${run.status === "BALANCED" ? "bg-green-50" : "bg-red-50"}`}>
              <p className="text-xs text-gray-500 font-medium">Variance</p>
              <p className={`text-base font-bold mt-0.5 ${run.status === "BALANCED" ? "text-green-700" : "text-red-700"}`}>
                {formatNGN(run.varianceAmount ? Math.abs(parseFloat(run.varianceAmount)) : 0)}
              </p>
              {run.varianceDirection && run.varianceDirection !== "BALANCED" && (
                <p className="text-xs text-gray-500">{run.varianceDirection.replace("_", " ")}</p>
              )}
            </div>
          </div>
        </div>

        {/* Summary pills */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white border rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{exceptions.length}</p>
            <p className="text-xs text-gray-500 font-medium mt-0.5">Total Exceptions</p>
          </div>
          <div className={`border rounded-xl p-4 text-center ${openCount > 0 ? "bg-orange-50 border-orange-200" : "bg-green-50 border-green-200"}`}>
            <p className={`text-2xl font-bold ${openCount > 0 ? "text-orange-700" : "text-green-700"}`}>{openCount}</p>
            <p className={`text-xs font-medium mt-0.5 ${openCount > 0 ? "text-orange-600" : "text-green-600"}`}>Open / Pending</p>
          </div>
          <div className={`border rounded-xl p-4 text-center ${criticalCount > 0 ? "bg-red-50 border-red-200" : "bg-gray-50"}`}>
            <p className={`text-2xl font-bold ${criticalCount > 0 ? "text-red-700" : "text-gray-600"}`}>{criticalCount}</p>
            <p className={`text-xs font-medium mt-0.5 ${criticalCount > 0 ? "text-red-600" : "text-gray-500"}`}>Critical Priority</p>
          </div>
        </div>

        {/* Exception list */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-indigo-600" />
            <h2 className="text-sm font-bold text-gray-800 uppercase tracking-wide">AI Agent Exception Analysis</h2>
          </div>

          {layer3Results.length === 0 ? (
            <div className="text-center py-12 bg-white border rounded-xl text-gray-400">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-400" />
              <p className="font-medium">No exceptions to report</p>
            </div>
          ) : (
            layer3Results.map((r, idx) => {
              const exc = exceptions[idx];
              const reviewStatus = r.reviewStatus ?? "OPEN";
              return (
                <div key={r.exceptionId} className="bg-white border rounded-xl overflow-hidden">
                  <div className="px-4 py-3 flex items-center gap-3 bg-gray-50 border-b">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${priorityColor(r.priorityLevel)}`}>
                      {r.priorityLevel}
                    </span>
                    <span className="text-sm font-mono text-gray-500">Exception #{r.exceptionId}</span>
                    {exc && (
                      <>
                        <span className="text-sm font-semibold text-gray-700">{formatNGN(exc.glEntryAmount)}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${exc.glEntryType === "CREDIT" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                          {exc.glEntryType}
                        </span>
                        <span className="text-xs text-gray-400">{exc.glEntryDate}</span>
                      </>
                    )}
                    <span className={`ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${statusStyle(reviewStatus)}`}>
                      {reviewStatus}
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
                          {r.reviewedAt && (
                            <span className="font-normal text-green-600 ml-1 flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" /> {new Date(r.reviewedAt).toLocaleString()}
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-green-900 italic">"{r.reviewNote}"</p>
                        {r.reviewedBy && <p className="text-xs text-green-600 mt-0.5">— {r.reviewedBy}</p>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="text-center py-4 border-t text-xs text-gray-400 space-y-1">
          <p>This report was generated by ReconcileAI and shared via a secure, time-limited link.</p>
          <p>Confidential — for authorised Woodcore CBS reviewers only. Do not distribute externally.</p>
          <p className="flex items-center justify-center gap-1 mt-2">
            <Database className="h-3 w-3" /> ReconcileAI · Woodcore CBS POC · August 2025 Dataset
          </p>
        </div>
      </div>
    </div>
  );
}
