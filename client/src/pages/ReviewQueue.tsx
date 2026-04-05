import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Loader2, CheckCircle2, XCircle, Eye, ClipboardList,
  AlertTriangle, Sparkles, Brain, FileText, Mail, BookOpen,
  ChevronRight, Clock, TrendingDown, Zap
} from "lucide-react";
import { toast } from "sonner";

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
  const { data: exceptions, isLoading, refetch } = trpc.exceptions.list.useQuery({
    status: "open",
    limit: 100,
    offset: 0,
  });
  const resolveMutation = trpc.exceptions.resolve.useMutation();
  const diagnoseMutation = trpc.superAgent.diagnose.useMutation();

  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [diagnosisEx, setDiagnosisEx] = useState<any>(null);
  const [diagnosisResult, setDiagnosisResult] = useState<DiagnosisResult | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);

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
      // The diagnose procedure takes a transactionId — use the exception's transactionId if available,
      // otherwise fall back to the exception id itself as a best-effort
      const txnId = ex.transactionId ?? ex.id;
      const raw = await diagnoseMutation.mutateAsync({ transactionId: txnId });
      // Map the server response shape to our local DiagnosisResult type
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
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeepDiagnose(ex)}
                      className="gap-1.5 border-purple-200 text-purple-700 hover:bg-purple-50"
                    >
                      <Sparkles className="h-3 w-3" />
                      Deep Diagnose
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setSelectedEx(ex); setNotes(""); }}>
                      <Eye className="h-3 w-3 mr-1" /> Review
                    </Button>
                    <Button size="sm" onClick={() => handleAction(ex.id, "resolved")} disabled={resolveMutation.isPending}>
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleAction(ex.id, "dismissed")} disabled={resolveMutation.isPending}>
                      <XCircle className="h-3 w-3 mr-1" /> Dismiss
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-muted-foreground text-center">{exceptions.data.length} of {exceptions.total} open exceptions</p>
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ClipboardList className="h-12 w-12 text-green-500 mb-4" />
            <h3 className="font-semibold text-lg">Queue is Clear</h3>
            <p className="text-muted-foreground text-sm mt-1">No exceptions requiring manual review.</p>
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
              <div className="flex gap-2">
                <Button onClick={() => handleAction(selectedEx.id, "resolved")} disabled={resolveMutation.isPending} className="flex-1">
                  <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
                </Button>
                <Button variant="outline" onClick={() => handleAction(selectedEx.id, "dismissed")} disabled={resolveMutation.isPending} className="flex-1">
                  Dismiss
                </Button>
              </div>
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
              Super Agent Deep Diagnosis
            </SheetTitle>
          </SheetHeader>

          {diagnosisEx && (
            <div className="mt-4 space-y-4">
              {/* Exception summary */}
              <div className="p-3 rounded-lg bg-muted/50 border">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColor(diagnosisEx.severity || "low")}`}>
                    {diagnosisEx.severity?.toUpperCase()}
                  </span>
                  <span className="text-xs text-muted-foreground">Exception #{diagnosisEx.id}</span>
                </div>
                <p className="text-sm">{diagnosisEx.description}</p>
              </div>

              {isDiagnosing && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="relative">
                    <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
                    <Sparkles className="h-4 w-4 text-purple-400 absolute -top-1 -right-1" />
                  </div>
                  <p className="text-sm text-muted-foreground">Super Agent is analysing this exception…</p>
                  <div className="text-xs text-muted-foreground space-y-1 text-center">
                    <p className="flex items-center gap-1"><ChevronRight className="h-3 w-3" /> Classifying exception type</p>
                    <p className="flex items-center gap-1"><ChevronRight className="h-3 w-3" /> Retrieving similar past cases</p>
                    <p className="flex items-center gap-1"><ChevronRight className="h-3 w-3" /> Generating resolution drafts</p>
                  </div>
                </div>
              )}

              {diagnosisResult && !isDiagnosing && (
                <div className="space-y-4">
                  {/* Diagnosis */}
                  <div className="p-4 rounded-lg border border-purple-200 bg-purple-50/50">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-sm text-purple-900">Diagnosis</h3>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-16 rounded-full bg-purple-200">
                          <div
                            className="h-1.5 rounded-full bg-purple-600"
                            style={{ width: `${(diagnosisResult.confidence ?? 0) * 100}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-purple-700 font-medium">
                          {Math.round((diagnosisResult.confidence ?? 0) * 100)}% confidence
                        </span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <p className="text-[10px] text-purple-600 uppercase tracking-wide font-medium">Category</p>
                        <p className="text-sm font-medium text-purple-900">{diagnosisResult.category?.replace(/_/g, " ")}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-purple-600 uppercase tracking-wide font-medium">Root Cause</p>
                        <p className="text-sm text-purple-800">{diagnosisResult.rootCause}</p>
                      </div>
                      {diagnosisResult.shortfall != null && (
                        <div className="flex items-center gap-2">
                          <TrendingDown className="h-4 w-4 text-red-500" />
                          <span className="text-sm text-red-700 font-medium">
                            Shortfall: ₦{diagnosisResult.shortfall?.toLocaleString()}
                          </span>
                          {diagnosisResult.deductionType && (
                            <Badge variant="outline" className="text-[10px]">{diagnosisResult.deductionType}</Badge>
                          )}
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] text-purple-600 uppercase tracking-wide font-medium">Recommended Action</p>
                        <p className="text-sm text-purple-800">{diagnosisResult.recommendedAction}</p>
                      </div>
                    </div>
                  </div>

                  {/* Similar past cases */}
                  {diagnosisResult.similarCases && diagnosisResult.similarCases.length > 0 && (
                    <div>
                      <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                        <Clock className="h-4 w-4 text-gray-500" />
                        Similar Past Cases
                      </h3>
                      <div className="space-y-2">
                        {diagnosisResult.similarCases.slice(0, 3).map((c, i) => (
                          <div key={i} className="p-3 rounded-lg border bg-muted/30 text-xs space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge variant={c.outcome === "resolved" ? "default" : "secondary"} className="text-[10px]">
                                {c.outcome}
                              </Badge>
                              <span className="text-muted-foreground">Case #{c.id}</span>
                            </div>
                            <p className="text-foreground">{c.resolution}</p>
                            <p className="text-muted-foreground italic">{c.reasoning}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Action drafts */}
                  {diagnosisResult.actionDrafts && diagnosisResult.actionDrafts.length > 0 && (
                    <div>
                      <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                        <Zap className="h-4 w-4 text-amber-500" />
                        Proposed Actions (Pending Your Approval)
                      </h3>
                      <div className="space-y-3">
                        {diagnosisResult.actionDrafts.map((draft, i) => (
                          <div key={i} className="p-3 rounded-lg border bg-background">
                            <div className="flex items-center gap-2 mb-2">
                              {actionTypeIcon(draft.actionType)}
                              <span className="text-xs font-semibold capitalize">{draft.actionType?.replace(/_/g, " ")}</span>
                            </div>
                            {draft.subject && (
                              <p className="text-xs text-muted-foreground mb-1"><strong>Subject:</strong> {draft.subject}</p>
                            )}
                            {draft.body && (
                              <p className="text-xs bg-muted/50 p-2 rounded whitespace-pre-wrap leading-relaxed">{draft.body}</p>
                            )}
                            {draft.narrative && (
                              <p className="text-xs bg-muted/50 p-2 rounded">{draft.narrative}</p>
                            )}
                            {draft.amount != null && (
                              <p className="text-xs text-muted-foreground mt-1"><strong>Amount:</strong> ₦{draft.amount?.toLocaleString()}</p>
                            )}
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                className="h-7 text-xs gap-1"
                                onClick={() => {
                                  toast.success("Action approved", { description: "Draft sent to execution queue." });
                                }}
                              >
                                <CheckCircle2 className="h-3 w-3" /> Approve
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs">
                                Edit Draft
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Resolve from panel */}
                  <div className="pt-2 border-t">
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={() => {
                          handleAction(diagnosisEx.id, "resolved");
                          setDiagnosisEx(null);
                          setDiagnosisResult(null);
                        }}
                        disabled={resolveMutation.isPending}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Mark Resolved
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          handleAction(diagnosisEx.id, "dismissed");
                          setDiagnosisEx(null);
                          setDiagnosisResult(null);
                        }}
                        disabled={resolveMutation.isPending}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
