import { useState, useEffect, useCallback } from "react";
import { useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, AlertTriangle, CheckCircle2, Eye, ClipboardList,
  FilterX, Filter, Download, Lock, RefreshCw
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useDateRange } from "@/hooks/useDateRange";
import { DateRangeBar } from "@/components/DateRangeBar";
import { rangeFromSearch } from "@/lib/dateRange";
import { EXCEPTION_LIST_STATUSES, statusFromSearch } from "@/lib/listLinks";
import { useAuth } from "@/_core/hooks/useAuth";
import ExceptionGlossary from "@/components/ExceptionGlossary";
import { useViewAsOrgId } from "@/contexts/PortalContext";
import { HiddenExceptionsNotice } from "@/components/HiddenExceptionsNotice";

// ─── Template category filter persistence ───────────────────────────────────
const LS_KEY = "reconcileai_template_autofilter";

function readFilterPref(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writeFilterPref(value: boolean) {
  try {
    localStorage.setItem(LS_KEY, String(value));
  } catch {}
}

const TEMPLATE_CATEGORIES = [
  "unmatched", "missing_counterparty", "amount_mismatch", "timing_difference",
  "duplicate_transaction", "reversal_unmatched", "currency_mismatch", "fx_rate_variance", "format_error",
] as const;
type TemplateCategory = typeof TEMPLATE_CATEGORIES[number];

export default function Exceptions() {
  // Super admins inside a tenant portal must read THAT tenant's data.
  const viewAsOrgId = useViewAsOrgId();
  const { user } = useAuth();
  const isReadOnly = user?.role === "cfo" || user?.role === "compliance";
  // A link (a dashboard count) names the rows it counted; honour it for this
  // visit. Read once: the URL is where the viewer ARRIVED from, not live state.
  const search = useSearch();
  const [arrival] = useState(() => ({
    range: rangeFromSearch(search),
    status: statusFromSearch(search, EXCEPTION_LIST_STATUSES),
  }));
  const range = useDateRange("reconcileai_exceptions_daterange", { initial: arrival.range });
  const { dateFromObj, dateToObj, setDateFrom, resetToDefault, isToday, label: dateLabel } = range;

  // ONE status filter. There used to be two: the Status menu wrote
  // `filters.status`, while the query and the notice read a `statusFilter`
  // nothing ever set — so choosing "Open" changed the menu and nothing else.
  const [statusFilter, setStatusFilter] = useState<string>(arrival.status ?? "all");
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [filters, setFilters] = useState({ category: "all", severity: "all" });
  const [autoFilter, setAutoFilter] = useState<boolean>(true);

  useEffect(() => { setAutoFilter(readFilterPref()); }, []);

  const selectedCategory: TemplateCategory | undefined =
    autoFilter && selectedEx && TEMPLATE_CATEGORIES.includes(selectedEx.category as TemplateCategory)
      ? (selectedEx.category as TemplateCategory)
      : undefined;

  const { data: templates } = trpc.resolutionTemplates.list.useQuery(
    { viewAsOrgId, ...(selectedCategory ? { category: selectedCategory } : {}) }
  );

  const { data, isLoading, refetch } = trpc.exceptions.list.useQuery({
    viewAsOrgId,
    status: statusFilter !== "all" ? statusFilter : undefined,
    dateFrom: dateFromObj,
    dateTo: dateToObj,
    limit: 200,
    offset: 0,
  });

  // Staleness state: exceptionId → { cbsStillAnomalous, verificationNote, userKeptResolved }
  const [stalenessMap, setStalenessMap] = useState<Map<number, { cbsStillAnomalous: boolean; verificationNote: string; userKeptResolved: boolean }>>(new Map());

  const resolveMutation = trpc.exceptions.resolve.useMutation();
  const moveToReviewMutation = trpc.exceptions.moveToReview.useMutation();
  const exportXlsxMutation = trpc.exceptions.exportXlsx.useMutation();

  const reopenMutation = trpc.exceptions.reopen.useMutation({
    onSuccess: () => {
      toast.success("Exception reverted to Open — CBS fix still required");
      setSelectedEx(null);
      refetch();
    },
    onError: (err) => toast.error(err.message || "Failed to reopen"),
  });

  const checkStalenessMutation = trpc.exceptions.checkStaleness.useMutation({
    onSuccess: (result) => {
      if (!result.results.length) return;
      setStalenessMap((prev) => {
        const next = new Map(prev);
        for (const r of result.results) {
          next.set(r.exceptionId, { cbsStillAnomalous: r.cbsStillAnomalous, verificationNote: r.verificationNote, userKeptResolved: false });
        }
        return next;
      });
    },
  });

  const keepResolvedMutation = trpc.exceptions.keepResolvedDespiteStaleness.useMutation({
    onSuccess: (result) => {
      setStalenessMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(result.exceptionId);
        if (existing) next.set(result.exceptionId, { ...existing, userKeptResolved: true });
        return next;
      });
    },
  });

  // Auto-check staleness whenever the resolved exceptions list changes
  const triggerStalenessCheck = useCallback((exceptions: any[]) => {
    const resolvedIds = exceptions
      .filter((ex) => (ex.status === "resolved" || ex.status === "dismissed") && !stalenessMap.has(ex.id))
      .map((ex) => ex.id);
    if (resolvedIds.length > 0) checkStalenessMutation.mutate({ exceptionIds: resolvedIds });
  }, [stalenessMap]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (data?.data && data.data.length > 0) triggerStalenessCheck(data.data);
  }, [data?.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResolve = async (id: number, status: "resolved" | "dismissed") => {
    try {
      await resolveMutation.mutateAsync({ id, status, resolutionNotes: resolveNotes });
      toast.success(`Exception ${status}`);
      setSelectedEx(null);
      setResolveNotes("");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to resolve");
    }
  };

  const handleMoveToReview = async (id: number) => {
    try {
      await moveToReviewMutation.mutateAsync({ id, notes: resolveNotes || undefined });
      toast.success("Exception moved to Review Queue");
      setSelectedEx(null);
      setResolveNotes("");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to move to review");
    }
  };

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "bg-red-100 text-red-700";
      case "high": return "bg-orange-100 text-orange-700";
      case "medium": return "bg-amber-100 text-amber-700";
      default: return "bg-blue-100 text-blue-700";
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "open": return "bg-red-100 text-red-700";
      case "in_review": return "bg-amber-100 text-amber-700";
      case "resolved": return "bg-green-100 text-green-700";
      case "dismissed": return "bg-gray-100 text-gray-700";
      default: return "bg-gray-100 text-gray-700";
    }
  };

  const filtered = data?.data?.filter((ex) => {
    if (filters.category !== "all" && ex.category !== filters.category) return false;
    if (filters.severity !== "all" && ex.severity !== filters.severity) return false;
    return true;
  }) ?? [];
  const loaded = data?.data?.length ?? 0;
  const matchingTotal = data?.total ?? 0;
  const clientFiltered = filters.category !== "all" || filters.severity !== "all";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Exception Management</h1>
          <p className="text-muted-foreground mt-1">Review and resolve reconciliation exceptions</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const res = await exportXlsxMutation.mutateAsync({
                status: statusFilter !== "all" ? statusFilter : undefined,
                severity: filters.severity !== "all" ? filters.severity : undefined,
                category: filters.category !== "all" ? filters.category : undefined,
              });
              window.open(res.url, "_blank");
              toast.success(`Excel export ready: ${res.fileName}`);
            } catch (err: any) { toast.error(err.message || "Excel export failed"); }
          }}
          disabled={exportXlsxMutation.isPending}
        >
          {exportXlsxMutation.isPending
            ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            : <Download className="h-4 w-4 mr-2" />}
          Export to Excel
        </Button>
      </div>

      {/* Read-only role banner */}
      {isReadOnly && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <span className="font-semibold">Read-only access.</span>{" "}
            Your role ({user?.role === "cfo" ? "CFO" : "Compliance / Audit"}) can view exceptions but cannot resolve, assign, or escalate them.
          </span>
        </div>
      )}

      <HiddenExceptionsNotice
        dateFrom={dateFromObj}
        status={statusFilter !== "all" ? statusFilter : undefined}
        onReveal={setDateFrom}
      />

      {/* Filters row */}
      <div className="flex flex-wrap gap-3 items-center">
        <DateRangeBar range={range} />

        {/* Status — sent to the server, so it filters every row, not just the loaded page */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_review">In Review</SelectItem>
            <SelectItem value="escalated">Escalated</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>

        {/* Category */}
        <Select value={filters.category} onValueChange={(v) => setFilters({ ...filters, category: v })}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="missing_counterparty">Missing Counterparty</SelectItem>
            <SelectItem value="amount_mismatch">Amount Mismatch</SelectItem>
            <SelectItem value="timing_difference">Timing Difference</SelectItem>
            <SelectItem value="duplicate_transaction">Duplicate</SelectItem>
            <SelectItem value="unmatched">Unmatched</SelectItem>
            <SelectItem value="currency_mismatch">Currency Mismatch</SelectItem>
            <SelectItem value="fx_rate_variance">FX Rate Variance</SelectItem>
          </SelectContent>
        </Select>

        {/* Severity */}
        <Select value={filters.severity} onValueChange={(v) => setFilters({ ...filters, severity: v })}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severity</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground self-center">{dateLabel}</span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : filtered.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">ID</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Raised</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Category</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Severity</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Description</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Suggested Resolution</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((ex) => {
                    const staleness = stalenessMap.get(ex.id);
                    const isStale = staleness?.cbsStillAnomalous && !staleness?.userKeptResolved;
                    return (
                      <tr key={ex.id} className={`border-b last:border-0 hover:bg-muted/30 ${isStale ? "bg-amber-50/40" : ""}`}>
                        <td className="py-3 px-2 font-mono text-xs">{ex.id}</td>
                        {/* When it was raised — the only way to see, on this page, that the list is current. */}
                        <td className="py-3 px-2 text-xs text-muted-foreground whitespace-nowrap">
                          {ex.createdAt
                            ? new Date(ex.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
                            : "-"}
                        </td>
                        <td className="py-3 px-2">
                          <span className="text-xs font-medium">{ex.category?.replace(/_/g, " ")}</span>
                        </td>
                        <td className="py-3 px-2">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColor(ex.severity || "low")}`}>{ex.severity}</span>
                        </td>
                        <td className="py-3 px-2 max-w-[250px] truncate text-muted-foreground">{ex.description}</td>
                        <td className="py-3 px-2">
                          <div className="flex items-center gap-1.5">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColor(ex.status || "open")}`}>{ex.status}</span>
                            {isStale && (
                              <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-700 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded-full" title={staleness.verificationNote}>
                                <AlertTriangle className="h-2.5 w-2.5" /> CBS mismatch
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-2 max-w-[200px] truncate text-xs text-muted-foreground">{ex.suggestedResolution || "-"}</td>
                        <td className="py-3 px-2 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedEx(ex)}>
                            <Eye className="h-3 w-3 mr-1" /> View
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {/* Say when the list is a slice. A dashboard count of 558 beside a
                  page that silently stopped at 200 reads as missing data. */}
              {loaded < matchingTotal
                ? `Showing the ${loaded.toLocaleString()} most recent of ${matchingTotal.toLocaleString()} exceptions — narrow the dates or status to see the rest`
                : `Showing ${filtered.length} exception${filtered.length !== 1 ? "s" : ""}`}
              {clientFiltered && loaded > 0 ? ` (${filtered.length} match the category/severity filter)` : ""}
              {" — "}{dateLabel}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
            <h3 className="font-semibold text-lg">No Exceptions Found</h3>
            <p className="text-muted-foreground text-sm mt-1">
              {isToday && statusFilter === "all" && !clientFiltered
                ? "No exceptions for today."
                : "No exceptions match the selected date range and filters."}
            </p>
            {range.isDefault ? null : (
              <Button variant="outline" size="sm" className="mt-4" onClick={resetToDefault}>Reset to today</Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Plain-English reference for every exception type */}
      <ExceptionGlossary />

      {/* Exception Detail Dialog */}
      <Dialog open={!!selectedEx} onOpenChange={(o) => { if (!o) setSelectedEx(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Exception #{selectedEx?.id}
            </DialogTitle>
          </DialogHeader>
          {selectedEx && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Category</p>
                  <p className="font-medium text-sm">{selectedEx.category?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Severity</p>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${severityColor(selectedEx.severity || "low")}`}>{selectedEx.severity}</span>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {selectedEx.severity === "critical" && "Immediate action — regulatory breach or material financial exposure"}
                    {selectedEx.severity === "high" && "Resolve within 4 hrs — significant variance or fraud indicator"}
                    {selectedEx.severity === "medium" && "Resolve within 24 hrs — timing or posting difference, low financial risk"}
                    {(selectedEx.severity === "low" || !selectedEx.severity) && "Informational — minor discrepancy, auto-resolvable or monitoring only"}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description</p>
                <p className="text-sm bg-muted/50 p-3 rounded">{selectedEx.description}</p>
              </div>
              {selectedEx.suggestedResolution && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">AI Suggested Resolution</p>
                  <p className="text-sm bg-blue-50 p-3 rounded text-blue-800">{selectedEx.suggestedResolution}</p>
                </div>
              )}
              {templates && templates.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">Resolution Templates</p>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => { const v = !autoFilter; setAutoFilter(v); writeFilterPref(v); }}
                            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                          >
                            {autoFilter ? <FilterX className="h-3 w-3" /> : <Filter className="h-3 w-3" />}
                            {autoFilter ? "Clear filter" : "Re-enable filter"}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {autoFilter ? "Stop auto-filtering templates by category" : "Auto-filter templates by exception category"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        className="w-full text-left text-xs bg-muted/50 hover:bg-muted p-2 rounded border border-transparent hover:border-border"
                        onClick={() => setResolveNotes(t.templateText)}
                        title={t.templateText}
                      >
                        <span className="font-medium">{t.name}</span>
                        <span className="block text-muted-foreground truncate">{t.templateText}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* CBS staleness alert */}
              {(() => {
                const staleness = stalenessMap.get(selectedEx.id);
                const isStale = staleness?.cbsStillAnomalous && !staleness?.userKeptResolved;
                if (!isStale) return null;
                return (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-amber-800">CBS still shows this anomaly</p>
                        <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">{staleness.verificationNote}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-amber-300 text-amber-800 hover:bg-amber-100"
                        onClick={() => reopenMutation.mutate({ id: selectedEx.id, notes: "Reverted — CBS still shows the anomaly" })}
                        disabled={reopenMutation.isPending}
                      >
                        <RefreshCw className="h-3.5 w-3.5 mr-1" /> Revert to Open
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                        onClick={() => keepResolvedMutation.mutate({ exceptionId: selectedEx.id })}
                        disabled={keepResolvedMutation.isPending}
                      >
                        Keep as Resolved
                      </Button>
                    </div>
                  </div>
                );
              })()}

              {isReadOnly ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <Lock className="h-4 w-4 shrink-0 text-amber-600" />
                  <span>Your role has <strong>read-only access</strong> to exception management. Contact an Operations user to resolve or escalate this exception.</span>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Resolution Notes</label>
                    <Textarea value={resolveNotes} onChange={(e) => setResolveNotes(e.target.value)} placeholder="Describe the resolution..." rows={3} />
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <Button onClick={() => handleResolve(selectedEx.id, "resolved")} disabled={resolveMutation.isPending} className="flex-1">
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
                    </Button>
                    <Button variant="outline" onClick={() => handleMoveToReview(selectedEx.id)} disabled={moveToReviewMutation.isPending} className="flex-1">
                      <ClipboardList className="h-4 w-4 mr-1" /> Move to Review
                    </Button>
                    <Button variant="ghost" onClick={() => handleResolve(selectedEx.id, "dismissed")} disabled={resolveMutation.isPending} className="flex-1">
                      Dismiss
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
