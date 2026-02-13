import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, CheckCircle2, XCircle, Eye, ClipboardList, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export default function ReviewQueuePage() {
  const { data: exceptions, isLoading, refetch } = trpc.exceptions.list.useQuery({
    status: "open",
    limit: 100,
    offset: 0,
  });

  const resolveMutation = trpc.exceptions.resolve.useMutation();
  const [selectedEx, setSelectedEx] = useState<any>(null);
  const [notes, setNotes] = useState("");

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

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "bg-red-100 text-red-700 border-red-200";
      case "high": return "bg-orange-100 text-orange-700 border-orange-200";
      case "medium": return "bg-amber-100 text-amber-700 border-amber-200";
      default: return "bg-blue-100 text-blue-700 border-blue-200";
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
                    <div className="flex items-center gap-2 mb-2">
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
                  <div className="flex gap-2 ml-4">
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
    </div>
  );
}
