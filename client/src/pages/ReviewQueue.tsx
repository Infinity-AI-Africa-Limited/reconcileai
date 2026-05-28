import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Loader2, CheckCircle2, XCircle, Eye, ClipboardList,
  AlertTriangle, Sparkles, Brain, FileText, Mail, BookOpen,
  Zap, CalendarDays, X, Lock
} from "lucide-react";
import { toast } from "sonner";
import { useDateRange, DATE_PRESETS, type DatePreset } from "@/hooks/useDateRange";
import { useAuth } from "@/_core/hooks/useAuth";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type DiagnosisResult = {
  exceptionId: number;
  category: string;
  rootCause: string;
  shortfall?: number;
  deductionType?: string;
  confidence: number;
  recommendedAction: string;
  similarCases?: Array<{ id: number; resolution: string; outcome: string; reasoning: string }>;
  actionDrafts?: Array<{ actionType: string; subject?: string; body?: string; amount?: number; narrative?: string; instruction?: string }>;
};

export default function ReviewQueuePage() {
  const { user } = useAuth();
  const isReadOnly = user?.role === "cfo" || user?.role === "compliance";
  const {
    dateFrom, dateTo, dateFromObj, dateToObj,
    setDateFrom, setDateTo, applyPreset, resetToToday,
    activePreset, isToday, isSingleDay,
  } = useDateRange("reconcileai_reviewqueue_daterange");

  const { data: exceptions, isLoading, refetch } = trpc.exceptions.list.useQuery({
    status: "open",
    dateFrom: dateFromObj,
    dateTo: dateToObj,
    limit: 200,
    offset: 0,
  });

  const resolveMutation = trpc.exceptions.resolve.useMutation();
  const diagnoseMutation = trpc.superAgent.diagnose.useMutation();

  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [diagnosisEx, setDiagnosisEx] = useState<any>(null);
  const [diagnosisResult, setDiagnosisResult] = useState<DiagnosisResult | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);

  const dateLabel = isToday ? "Today" : isSingleDay ? dateFrom : `${dateFrom} – ${dateTo}`;

  const handleAction = async (id: number, status: "resolved" | "dismissed") => {
    try {
      await resolveMutation.mutateAsync({ id, status, resolutionNotes: notes });
      toast.success(`Exception ${status}`);
      setSelectedEx(null);
      setNotes("");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed");
    }
  };

  const handleDeepDiagnose = async (ex: any) => {
    setDiagnosisEx(ex);
    setDiagnosisResult(null);
    setIsDiagnosing(true);
    try {
      const txnId = ex.transactionId ?? ex.id;
      const raw = await diagnoseMutation.mutateAsync({ transactionId: txnId });
      const r = raw as { diagnosis: any; actionDraft: any; memoriesUsed: number };
      const mapped: DiagnosisResult = {
        exceptionId: ex.id,
        category: r.diagnosis?.category ?? "unmatched",
        rootCause: r.diagnosis?.rootCause ?? r.diagnosis?.description ?? "Unable to determine root cause",
        shortfall: r.diagnosis?.shortfall,
        deductionType: r.diagnosis?.deductionType,
        confidence: r.diagnosis?.confidence ?? 0.8,
        recommendedAction: r.diagnosis?.recommendedAction ?? "Manual review required",
        similarCases: r.diagnosis?.similarCases ?? [],
        actionDrafts: r.actionDraft ? [r.actionDraft] : [],
      };
      setDiagnosisResult(mapped);
    } catch (err: any) {
      toast.error("Diagnosis failed: " + (err.message || "Unknown error"));
      setDiagnosisEx(null);
    } finally {
      setIsDiagnosing(false);
    }
  };

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "bg-red-100 text-red-700 border-red-200";
      case "high": return "bg-orange-100 text-orange-700 border-orange-200";
      case "medium": return "bg-amber-100 text-amber-700 border-amber-200";
      default: return "bg-blue-100 text-blue-700 border-blue-200";
    }
  };

  const actionTypeIcon = (type: string) => {
    switch (type) {
      case "vendor_email": return <Mail className="h-4 w-4 text-blue-500" />;
      case "credit_note": return <FileText className="h-4 w-4 text-purple-500" />;
      case "journal_entry": return <BookOpen className="h-4 w-4 text-green-500" />;
      case "payment_allocation": return <Zap className="h-4 w-4 text-amber-500" />;
      default: return <FileText className="h-4 w-4 text-gray-500" />;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Review Queue</h1>
        <p className="text-muted-foreground mt-1">Exceptions requiring manual review and intervention</p>
      </div>

      {/* Read-only role banner */}
      {isReadOnly && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <span className="font-semibold">Read-only access.</span>{" "}
            Your role ({user?.role === "cfo" ? "CFO" : "Compliance / Audit"}) can view the review queue but cannot resolve, dismiss, or take action on exceptions.
          </span>
        </div>
      )}

      {/* Date range filter */}
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

        {/* Date inputs */}
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

        <span className="text-xs text-muted-foreground">{dateLabel}</span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : exceptions?.data && exceptions.data.length > 0 ? (
        <div className="space-y-3">
          {exceptions.data.map((ex) => (
            <Card key={ex.id} className={`border-l-4 ${
              ex.severity === "critical" ? "border-l-red-500" :
              ex.severity === "high" ? "border-l-orange-500" :
              ex.severity === "medium" ? "border-l-amber-500" :
              "border-l-blue-500"
            }`}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColor(ex.severity || "low")}`}>
                        {ex.severity?.toUpperCase()}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700">
                        {ex.category?.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs text-muted-foreground">Exception #{ex.id}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{ex.description}</p>
                    {ex.suggestedResolution && (
                      <p className="text-xs text-blue-600 mt-2 bg-blue-50 p-2 rounded">
                        <strong>AI Suggestion:</strong> {ex.suggestedResolution}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 ml-4 flex-wrap justify-end">
                    <Button
                      variant="outline" size="sm"
                      onClick={() => !isReadOnly && handleDeepDiagnose(ex)}
                      disabled={isReadOnly}
                      className={`gap-1.5 border-purple-200 text-purple-700 hover:bg-purple-50 ${isReadOnly ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <Sparkles className="h-3 w-3" /> Deep Diagnose
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setSelectedEx(ex); setNotes(""); }}>
                      <Eye className="h-3 w-3 mr-1" /> View
                    </Button>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button size="sm" onClick={() => handleAction(ex.id, "resolved")} disabled={resolveMutation.isPending || isReadOnly} className={isReadOnly ? "opacity-50 cursor-not-allowed" : ""}>
                              <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {isReadOnly && (
                          <TooltipContent>Your role has read-only access to this module</TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button variant="ghost" size="sm" onClick={() => handleAction(ex.id, "dismissed")} disabled={resolveMutation.isPending || isReadOnly} className={isReadOnly ? "opacity-50 cursor-not-allowed" : ""}>
                              <XCircle className="h-3 w-3 mr-1" /> Dismiss
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {isReadOnly && (
                          <TooltipContent>Your role has read-only access to this module</TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-muted-foreground text-center">
            {exceptions.data.length} of {exceptions.total} open exception{exceptions.total !== 1 ? "s" : ""} — {dateLabel}
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ClipboardList className="h-12 w-12 text-green-500 mb-4" />
            <h3 className="font-semibold text-lg">Queue is Clear</h3>
            <p className="text-muted-foreground text-sm mt-1">
              {isToday ? "No open exceptions for today." : "No open exceptions match the selected date range."}
            </p>
            {!isToday && (
              <Button variant="outline" size="sm" className="mt-4" onClick={resetToToday}>Reset to today</Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Review Dialog */}
      <Dialog open={!!selectedEx} onOpenChange={(o) => { if (!o) setSelectedEx(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Review Exception #{selectedEx?.id}
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
              <div>
                <label className="text-sm font-medium mb-1 block">Resolution Notes</label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Describe the resolution..." rows={3} />
              </div>
              {isReadOnly ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <Lock className="h-4 w-4 shrink-0 text-amber-600" />
                  <span>Your role has <strong>read-only access</strong> to this queue. Contact an Operations user to resolve or dismiss this exception.</span>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Resolution Notes</label>
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Describe the resolution..." rows={3} />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => handleAction(selectedEx.id, "resolved")} disabled={resolveMutation.isPending} className="flex-1">
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
                    </Button>
                    <Button variant="outline" onClick={() => handleAction(selectedEx.id, "dismissed")} disabled={resolveMutation.isPending} className="flex-1">
                      Dismiss
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Deep Diagnose Side Panel */}
      <Sheet open={!!diagnosisEx} onOpenChange={(o) => { if (!o) { setDiagnosisEx(null); setDiagnosisResult(null); } }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-purple-600" />
              Deep Diagnosis — Exception #{diagnosisEx?.id}
            </SheetTitle>
          </SheetHeader>
          {isDiagnosing ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
              <p className="text-sm text-muted-foreground">Analysing exception with AI...</p>
            </div>
          ) : diagnosisResult ? (
            <div className="mt-6 space-y-5">
              <div className="rounded-lg bg-purple-50 border border-purple-200 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-purple-600" />
                  <p className="text-sm font-semibold text-purple-900">Root Cause</p>
                </div>
                <p className="text-sm text-purple-800">{diagnosisResult.rootCause}</p>
                {diagnosisResult.shortfall != null && (
                  <p className="text-xs text-purple-700 mt-1">
                    Shortfall: ₦{diagnosisResult.shortfall.toLocaleString()}
                    {diagnosisResult.deductionType && ` (${diagnosisResult.deductionType})`}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1">Confidence</p>
                  <p className="text-lg font-bold text-primary">{Math.round(diagnosisResult.confidence * 100)}%</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1">Recommended Action</p>
                  <p className="text-xs font-medium">{diagnosisResult.recommendedAction}</p>
                </div>
              </div>
              {diagnosisResult.similarCases && diagnosisResult.similarCases.length > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2">Similar Past Cases</p>
                  <div className="space-y-2">
                    {diagnosisResult.similarCases.map((c) => (
                      <div key={c.id} className="rounded border p-3 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Exception #{c.id}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.outcome === "resolved" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"}`}>{c.outcome}</span>
                        </div>
                        <p className="text-muted-foreground">{c.resolution}</p>
                        {c.reasoning && <p className="text-blue-600 italic">{c.reasoning}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {diagnosisResult.actionDrafts && diagnosisResult.actionDrafts.length > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                    <Zap className="h-4 w-4 text-amber-500" /> Suggested Actions
                  </p>
                  <div className="space-y-3">
                    {diagnosisResult.actionDrafts.map((a, i) => (
                      <div key={i} className="rounded border p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          {actionTypeIcon(a.actionType)}
                          <span className="text-xs font-semibold capitalize">{a.actionType.replace(/_/g, " ")}</span>
                        </div>
                        {a.subject && <p className="text-xs font-medium">{a.subject}</p>}
                        {a.body && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{a.body}</p>}
                        {a.amount != null && <p className="text-xs">Amount: ₦{a.amount.toLocaleString()}</p>}
                        {a.narrative && <p className="text-xs text-muted-foreground">{a.narrative}</p>}
                        {a.instruction && <p className="text-xs text-blue-600">{a.instruction}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
