import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, AlertTriangle, CheckCircle2, Eye, ClipboardList,
  FilterX, Filter, CalendarDays, X
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useDateRange, DATE_PRESETS, type DatePreset } from "@/hooks/useDateRange";

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
  "duplicate_transaction", "reversal_unmatched", "currency_mismatch", "format_error",
] as const;
type TemplateCategory = typeof TEMPLATE_CATEGORIES[number];

export default function Exceptions() {
  const {
    dateFrom, dateTo, dateFromObj, dateToObj,
    setDateFrom, setDateTo, applyPreset, resetToToday,
    activePreset, isToday, isSingleDay, today,
  } = useDateRange("reconcileai_exceptions_daterange");

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [filters, setFilters] = useState({ status: "all", category: "all", severity: "all" });
  const [autoFilter, setAutoFilter] = useState<boolean>(true);

  useEffect(() => { setAutoFilter(readFilterPref()); }, []);

  const selectedCategory: TemplateCategory | undefined =
    autoFilter && selectedEx && TEMPLATE_CATEGORIES.includes(selectedEx.category as TemplateCategory)
      ? (selectedEx.category as TemplateCategory)
      : undefined;

  const { data: templates } = trpc.resolutionTemplates.list.useQuery(
    selectedCategory ? { category: selectedCategory } : undefined
  );

  const { data, isLoading, refetch } = trpc.exceptions.list.useQuery({
    status: statusFilter !== "all" ? statusFilter : undefined,
    dateFrom: dateFromObj,
    dateTo: dateToObj,
    limit: 200,
    offset: 0,
  });

  const resolveMutation = trpc.exceptions.resolve.useMutation();
  const moveToReviewMutation = trpc.exceptions.moveToReview.useMutation();

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

  const dateLabel = isToday ? "Today" : isSingleDay ? dateFrom : `${dateFrom} – ${dateTo}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Exception Management</h1>
        <p className="text-muted-foreground mt-1">Review and resolve reconciliation exceptions</p>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Quick-select preset pills */}
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key as DatePreset)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                activePreset === p.key
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Date range inputs */}
        <div className="flex items-center gap-2 bg-muted/40 border rounded-lg px-3 py-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={dateFrom}
              max={dateTo}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-7 w-36 text-xs border-0 bg-transparent p-0 focus-visible:ring-0"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <Input
              type="date"
              value={dateTo}
              min={dateFrom}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-7 w-36 text-xs border-0 bg-transparent p-0 focus-visible:ring-0"
            />
          </div>
          {!isToday && (
            <button onClick={resetToToday} className="ml-1 text-muted-foreground hover:text-foreground" title="Reset to today">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Status */}
        <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v })}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_review">In Review</SelectItem>
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
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Category</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Severity</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Description</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Suggested Resolution</th>
                    <th className="text-right py-3 px-2 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((ex) => (
                    <tr key={ex.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-3 px-2 font-mono text-xs">{ex.id}</td>
                      <td className="py-3 px-2">
                        <span className="text-xs font-medium">{ex.category?.replace(/_/g, " ")}</span>
                      </td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColor(ex.severity || "low")}`}>{ex.severity}</span>
                      </td>
                      <td className="py-3 px-2 max-w-[250px] truncate text-muted-foreground">{ex.description}</td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColor(ex.status || "open")}`}>{ex.status}</span>
                      </td>
                      <td className="py-3 px-2 max-w-[200px] truncate text-xs text-muted-foreground">{ex.suggestedResolution || "-"}</td>
                      <td className="py-3 px-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedEx(ex)}>
                          <Eye className="h-3 w-3 mr-1" /> View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Showing {filtered.length} exception{filtered.length !== 1 ? "s" : ""} — {dateLabel}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
            <h3 className="font-semibold text-lg">No Exceptions Found</h3>
            <p className="text-muted-foreground text-sm mt-1">
              {isToday ? "No exceptions for today." : "No exceptions match the selected date range and filters."}
            </p>
            {!isToday && (
              <Button variant="outline" size="sm" className="mt-4" onClick={resetToToday}>Reset to today</Button>
            )}
          </CardContent>
        </Card>
      )}

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
                    {templates.map((t: any) => (
                      <button
                        key={t.id}
                        className="w-full text-left text-xs bg-muted/50 hover:bg-muted p-2 rounded border border-transparent hover:border-border"
                        onClick={() => setResolveNotes(t.templateText)}
                      >
                        <span className="font-medium">{t.title}</span>
                        {t.successRate != null && (
                          <span className="ml-2 text-green-600">{Math.round(t.successRate * 100)}% success</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
