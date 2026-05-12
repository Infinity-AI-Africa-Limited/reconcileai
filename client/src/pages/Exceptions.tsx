import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, AlertTriangle, CheckCircle2, Eye, MessageSquare, ClipboardList } from "lucide-react";
import { toast } from "sonner";

export default function Exceptions() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [filters, setFilters] = useState({ status: "all", category: "all", severity: "all" });
  const { data: templates } = trpc.resolutionTemplates.list.useQuery();

  const { data, isLoading, refetch } = trpc.exceptions.list.useQuery({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 100,
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Exception Management</h1>
        <p className="text-muted-foreground mt-1">Review and resolve reconciliation exceptions</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v === "all" ? "" : v })}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_review">In Review</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.category} onValueChange={(v) => setFilters({ ...filters, category: v === "all" ? "" : v })}>
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
        <Select value={filters.severity} onValueChange={(v) => setFilters({ ...filters, severity: v === "all" ? "" : v })}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severity</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Exceptions Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : data?.data && data.data.length > 0 ? (
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
                  {data.data.map((ex) => (
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
            <p className="text-xs text-muted-foreground mt-3">Showing {data.data.length} of {data.total} exceptions</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
            <h3 className="font-semibold text-lg">No Exceptions Found</h3>
            <p className="text-muted-foreground text-sm mt-1">All transactions are reconciled or no matching filters.</p>
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
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(selectedEx.status || "open")}`}>{selectedEx.status}</span>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Transaction ID</p>
                  <p className="font-mono text-sm">{selectedEx.transactionId}</p>
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-1">Description</p>
                <p className="text-sm bg-muted/50 p-3 rounded">{selectedEx.description}</p>
              </div>

              {selectedEx.suggestedResolution && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Suggested Resolution</p>
                  <p className="text-sm bg-blue-50 p-3 rounded text-blue-800">{selectedEx.suggestedResolution}</p>
                </div>
              )}

              {selectedEx.aiAnalysis && (() => {
                let parsed: any = null;
                try { parsed = JSON.parse(selectedEx.aiAnalysis); } catch {}
                if (parsed && typeof parsed === "object") {
                  return (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1"><MessageSquare className="h-3 w-3" /> AI Analysis</p>
                      <div className="bg-purple-50 p-3 rounded space-y-2">
                        {parsed.plainLanguage && (
                          <p className="text-sm text-purple-900">{parsed.plainLanguage}</p>
                        )}
                        {parsed.rootCause && (
                          <div>
                            <p className="text-[10px] font-semibold text-purple-700 uppercase tracking-wide">Root Cause</p>
                            <p className="text-xs text-purple-800">{parsed.rootCause}</p>
                          </div>
                        )}
                        {parsed.recommendedAction && (
                          <div>
                            <p className="text-[10px] font-semibold text-purple-700 uppercase tracking-wide">Recommended Action</p>
                            <p className="text-xs text-purple-800">{parsed.recommendedAction}</p>
                          </div>
                        )}
                        {parsed.confidence !== undefined && (
                          <p className="text-[10px] text-purple-600">Confidence: {Math.round(parsed.confidence * 100)}%</p>
                        )}
                      </div>
                    </div>
                  );
                }
                return (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><MessageSquare className="h-3 w-3" /> AI Analysis</p>
                    <p className="text-sm bg-purple-50 p-3 rounded text-purple-800">{selectedEx.aiAnalysis}</p>
                  </div>
                );
              })()}

              {(selectedEx.status === "open" || selectedEx.status === "in_review") && (
                <div className="space-y-3 pt-2 border-t">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium block">Resolution Notes</label>
                      <Select 
                        value="" 
                        onValueChange={(templateId: string) => {
                          const template = (templates || []).find((t: any) => t.id.toString() === templateId);
                          if (template) {
                            setResolveNotes(template.templateText);
                          }
                        }}
                      >
                        <SelectTrigger className="w-[180px] h-8">
                          <SelectValue placeholder="Use Template" />
                        </SelectTrigger>
                        <SelectContent>
                          {(templates || []).map((template: any) => (
                            <SelectItem key={template.id} value={String(template.id)}>
                              {template.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Textarea value={resolveNotes} onChange={(e) => setResolveNotes(e.target.value)} placeholder="Add notes about how this was resolved..." rows={3} />
                  </div>
                  {selectedEx.status === "open" && (
                    <Button
                      variant="outline"
                      onClick={() => handleMoveToReview(selectedEx.id)}
                      disabled={moveToReviewMutation.isPending}
                      className="w-full border-amber-300 text-amber-700 hover:bg-amber-50"
                    >
                      {moveToReviewMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <ClipboardList className="h-4 w-4 mr-1" />
                      )}
                      Move to Review Queue
                    </Button>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={() => handleResolve(selectedEx.id, "resolved")} disabled={resolveMutation.isPending} className="flex-1">
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
                    </Button>
                    <Button variant="outline" onClick={() => handleResolve(selectedEx.id, "dismissed")} disabled={resolveMutation.isPending} className="flex-1">
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
