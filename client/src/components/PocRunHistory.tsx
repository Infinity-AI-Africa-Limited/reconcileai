import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { History, Loader2, Eye, CheckCircle2, AlertTriangle, ArrowLeft, X } from "lucide-react";

/**
 * Reusable reconciliation-run history for any POC page.
 *
 * Every run is persisted (poc_runs); this lists them so the client can see and
 * refer back to past reconciliations — mirroring the Woodcore POC. Drop it onto
 * any current or future POC page with its POC_SLUG.
 *
 * - Client pages call it without `admin` (uses the token-gated poc.listRuns,
 *   which the public page already holds the access token for).
 * - The super-admin POC Hub passes `admin` to use the no-token admin queries.
 * - Bump `refreshKey` after a new run completes to refresh the list.
 */
const ngn = (n: number | string, ccy = "NGN") =>
  `${ccy === "NGN" ? "₦" : ""}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  HIGH: "bg-orange-100 text-orange-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-gray-100 text-gray-600",
};

function fmtDate(d: Date | string) {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StatusBadge({ status }: { status: string }) {
  const balanced = status === "BALANCED";
  return (
    <Badge variant="outline" className={balanced ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"}>
      {balanced ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
      {balanced ? "Balanced" : "Variance"}
    </Badge>
  );
}

export default function PocRunHistory({
  pocSlug,
  admin = false,
  refreshKey = 0,
}: {
  pocSlug: string;
  admin?: boolean;
  refreshKey?: number;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // One of these is active depending on context; the other stays disabled.
  const clientRuns = trpc.poc.listRuns.useQuery({ pocSlug }, { enabled: !admin });
  const adminRuns = trpc.poc.adminListRuns.useQuery({ pocSlug }, { enabled: admin });
  const runsQuery = admin ? adminRuns : clientRuns;
  const runs = (runsQuery.data ?? []) as any[];

  const clientDetail = trpc.poc.getRun.useQuery(
    { pocSlug, runId: selectedId ?? 0 },
    { enabled: !admin && selectedId != null },
  );
  const adminDetail = trpc.poc.adminGetRun.useQuery(
    { pocSlug, runId: selectedId ?? 0 },
    { enabled: admin && selectedId != null },
  );
  const detailQuery = admin ? adminDetail : clientDetail;
  const detail = detailQuery.data as { run: any; exceptions: any[] } | undefined;

  // Refresh the list whenever the parent signals a new run completed.
  useEffect(() => {
    if (refreshKey > 0) runsQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // While the full-page run detail is open: close on Escape and lock body scroll
  // so the page behind doesn't scroll under the overlay.
  useEffect(() => {
    if (selectedId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedId(null); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [selectedId]);

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <History className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold text-gray-800">Reconciliation history</p>
        {runs.length > 0 && <span className="text-xs text-muted-foreground">({runs.length})</span>}
      </div>

      {runsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-6 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
        </div>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">
          No reconciliation runs yet. Each run you complete is saved here for future reference.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 font-medium">Date</th>
                <th className="text-left py-2 font-medium">Status</th>
                <th className="text-right py-2 font-medium">Match rate</th>
                <th className="text-right py-2 font-medium">Matched / Exceptions</th>
                <th className="text-right py-2 font-medium">Variance</th>
                <th className="text-right py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-2.5 text-xs text-gray-700 whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                  <td className="py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="py-2.5 text-right font-medium">{r.matchRate != null ? `${Number(r.matchRate)}%` : "—"}</td>
                  <td className="py-2.5 text-right text-xs">
                    <span className="text-emerald-700">{r.matchedCount}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span className={r.exceptionCount > 0 ? "text-amber-700" : "text-muted-foreground"}>{r.exceptionCount}</span>
                  </td>
                  <td className="py-2.5 text-right font-mono text-xs">{ngn(r.varianceAmount, r.currencyCode)}</td>
                  <td className="py-2.5 text-right">
                    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setSelectedId(r.id)}>
                      <Eye className="h-3.5 w-3.5" /> View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Run detail — full-page view (replaces the cramped modal) */}
      {selectedId != null && (
        <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
          {/* Sticky header with a Back action */}
          <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
              <Button variant="ghost" size="sm" className="gap-1.5 shrink-0" onClick={() => setSelectedId(null)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <div className="flex items-center gap-2 min-w-0">
                <History className="h-4 w-4 text-primary shrink-0" />
                <h2 className="text-base font-semibold truncate">Reconciliation run</h2>
                {detail?.run && (
                  <span className="text-sm font-normal text-muted-foreground whitespace-nowrap">· {fmtDate(detail.run.createdAt)}</span>
                )}
              </div>
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Close"
                className="ml-auto shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
            {detailQuery.isLoading || !detail ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-16 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
              </div>
            ) : (
              <div className="space-y-6">
                {/* Layer-1 summary */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: "Status", node: <StatusBadge status={detail.run.status} /> },
                    { label: "Match rate", node: <span className="font-semibold">{detail.run.matchRate != null ? `${Number(detail.run.matchRate)}%` : "—"}</span> },
                    { label: "Variance", node: <span className="font-mono text-sm break-all">{ngn(detail.run.varianceAmount, detail.run.currencyCode)}</span> },
                    { label: "Ledger", node: <span className="break-all">{detail.run.ledgerCount} · {ngn(detail.run.ledgerTotal, detail.run.currencyCode)}</span> },
                    { label: "Statement", node: <span className="break-all">{detail.run.statementCount} · {ngn(detail.run.statementTotal, detail.run.currencyCode)}</span> },
                    { label: "Matched / Exceptions", node: <span>{detail.run.matchedCount} / {detail.run.exceptionCount}</span> },
                  ].map((s) => (
                    <div key={s.label} className="rounded-md border bg-muted/20 p-3">
                      <p className="text-[11px] text-muted-foreground">{s.label}</p>
                      <div className="text-sm mt-1">{s.node}</div>
                    </div>
                  ))}
                </div>

                {/* Flagged & excluded fee/charge noise (set aside from the reconciliation) */}
                {Array.isArray(detail.run.summary?.excludedItems) && detail.run.summary.excludedItems.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50/50 p-4">
                    <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      {detail.run.summary.excludedItems.length} item(s) set aside
                      {detail.run.summary.excludedTotal != null && ` · ${ngn(detail.run.summary.excludedTotal, detail.run.currencyCode)}`}
                    </p>
                    <p className="text-xs text-amber-800/80 mt-1 mb-3">
                      Bank fees / charges / levies excluded from the balance and matching, listed for awareness.
                    </p>
                    <div className="space-y-1">
                      {detail.run.summary.excludedItems.map((e: any, i: number) => (
                        <div key={i} className="flex items-start gap-3 text-xs bg-white/70 rounded px-3 py-2">
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 shrink-0">{e.reason}</span>
                          <span className="flex-1 break-words min-w-0">{e.description || e.reference || "—"}</span>
                          <span className="font-mono shrink-0 whitespace-nowrap">{ngn(e.amount, detail.run.currencyCode)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Exceptions */}
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-2">
                    Exceptions {detail.exceptions.length > 0 && `(${detail.exceptions.length})`}
                  </p>
                  {detail.exceptions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No exceptions — everything reconciled.</p>
                  ) : (
                    <div className="space-y-2">
                      {detail.exceptions.map((e) => (
                        <div key={e.id} className="rounded-md border p-3 text-sm">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{String(e.category).replace(/_/g, " ")}</span>
                            {e.priorityLevel && (
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_COLORS[e.priorityLevel] ?? "bg-gray-100 text-gray-600"}`}>
                                {e.priorityLevel}
                              </span>
                            )}
                            <span className="ml-auto font-mono whitespace-nowrap">{ngn(e.amount, detail.run.currencyCode)}</span>
                          </div>
                          {e.description && <p className="text-muted-foreground mt-1 break-words">{e.description}</p>}
                          {e.recommendedAction && (
                            <p className="text-gray-700 mt-1 break-words"><span className="font-medium">Action:</span> {e.recommendedAction}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
