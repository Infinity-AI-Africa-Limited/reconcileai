/**
 * ReconcileAI — Public Shared Report Viewer (Platform-wide)
 * Read-only view of any reconciliation report, accessible via a signed token.
 * No login required. Works for any organisation / report type.
 */

import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Loader2, FileText, AlertCircle, CheckCircle2, XCircle, Printer, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SharedReportPublic() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";

  const { data, isLoading, error } = trpc.reports.viewShared.useQuery(
    { token },
    { enabled: token.length === 64, retry: false }
  );

  const handlePrint = () => window.print();

  if (!token || token.length !== 64) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-6">
        <div className="text-center text-white">
          <XCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-xl font-semibold">Invalid Link</h1>
          <p className="text-gray-400 mt-2">This share link is malformed or incomplete.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#f5a623]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-6">
        <div className="text-center text-white max-w-md">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-xl font-semibold">Access Denied</h1>
          <p className="text-gray-400 mt-2">{error.message}</p>
          <p className="text-gray-500 text-sm mt-4">Contact the sender to request a new link.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { report, expiresAt } = data;
  const summary = report.summary as Record<string, any> | null;
  const matchRate = Number(summary?.matchRate ?? 0);
  const matched = Number(summary?.matched ?? 0);
  const totalSource = Number(summary?.totalSource ?? 0);
  const exceptions = Number(summary?.exceptions ?? 0);
  const unmatched = Number(summary?.unmatched ?? 0);
  const matchBreakdown = (summary?.matchBreakdown ?? {}) as Record<string, number>;
  const exceptionBreakdown = (summary?.exceptionBreakdown ?? {}) as Record<string, number>;

  const typeLabel = (t: string) => {
    const map: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", custom: "Custom" };
    return map[t] ?? t;
  };

  const rateColor = matchRate >= 98 ? "text-green-400" : matchRate >= 95 ? "text-yellow-400" : "text-red-400";
  const barColor = matchRate >= 98 ? "bg-green-500" : matchRate >= 95 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-[#161b22] px-6 py-4 print:hidden">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-[#f5a623] flex items-center justify-center">
              <FileText className="h-4 w-4 text-black" />
            </div>
            <div>
              <span className="font-bold text-lg">ReconcileAI</span>
              <span className="text-gray-400 text-xs ml-2">· Shared Report</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Shield className="h-3 w-3" /> Read-only · Confidential
            </span>
            {expiresAt && (
              <span className="text-xs text-gray-400">
                Expires {new Date(expiresAt).toLocaleDateString()}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrint}
              className="border-white/20 text-white hover:bg-white/10 bg-transparent"
            >
              <Printer className="h-4 w-4 mr-2" /> Print / Save PDF
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Title block */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[#f5a623]/20 text-[#f5a623]">
              {typeLabel(report.reportType)} Report
            </span>
            <span className="text-xs text-gray-400">
              Generated {new Date(report.createdAt).toLocaleString()}
            </span>
          </div>
          <h1 className="text-2xl font-bold">{report.title}</h1>
          {summary?.dateRange && (
            <p className="text-gray-400 text-sm mt-1">Period: {summary.dateRange}</p>
          )}
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Match Rate", value: `${matchRate.toFixed(1)}%`, color: rateColor },
            { label: "Matched", value: matched.toLocaleString(), color: "text-white" },
            { label: "Exceptions", value: exceptions.toLocaleString(), color: exceptions > 0 ? "text-yellow-400" : "text-green-400" },
            { label: "Unmatched", value: unmatched.toLocaleString(), color: unmatched > 0 ? "text-red-400" : "text-green-400" },
          ].map((m) => (
            <div key={m.label} className="bg-[#161b22] border border-white/10 rounded-lg p-4">
              <p className="text-xs text-gray-400 mb-1">{m.label}</p>
              <p className={`text-2xl font-bold ${m.color}`}>{m.value}</p>
            </div>
          ))}
        </div>

        {/* Match rate bar */}
        <div className="bg-[#161b22] border border-white/10 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Match Rate</h2>
            <span className={`text-sm font-bold ${rateColor}`}>{matchRate.toFixed(2)}%</span>
          </div>
          <div className="h-3 bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${barColor}`}
              style={{ width: `${Math.min(100, matchRate)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0%</span>
            <span className="text-yellow-400">95% threshold</span>
            <span>100%</span>
          </div>
        </div>

        {/* Match breakdown */}
        {Object.keys(matchBreakdown).length > 0 && (
          <div className="bg-[#161b22] border border-white/10 rounded-lg p-5">
            <h2 className="font-semibold mb-4">Match Breakdown</h2>
            <div className="space-y-3">
              {Object.entries(matchBreakdown).map(([key, count]) => {
                const pct = totalSource > 0 ? (count / totalSource) * 100 : 0;
                const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
                return (
                  <div key={key}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300">{label}</span>
                      <span className="text-white font-medium">
                        {count.toLocaleString()}{" "}
                        <span className="text-gray-400 text-xs">({pct.toFixed(1)}%)</span>
                      </span>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-[#f5a623] rounded-full" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Exception breakdown */}
        {Object.keys(exceptionBreakdown).length > 0 && (
          <div className="bg-[#161b22] border border-white/10 rounded-lg p-5">
            <h2 className="font-semibold mb-4">Exception Breakdown</h2>
            <div className="space-y-1">
              {Object.entries(exceptionBreakdown).map(([key, count]) => {
                const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
                return (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <span className="text-gray-300 text-sm">{label}</span>
                    <span className={`text-sm font-semibold ${count > 0 ? "text-yellow-400" : "text-gray-500"}`}>
                      {count.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-white/10 pt-6 flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span>Verified by ReconcileAI · reconcileai.vip</span>
          </div>
          {expiresAt ? (
            <span>Link expires {new Date(expiresAt).toLocaleDateString()}</span>
          ) : (
            <span>Link does not expire</span>
          )}
        </div>
      </div>

      <style>{`
        @media print {
          body { background: white !important; color: black !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </div>
  );
}
