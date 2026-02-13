import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Play, Eye, CheckCircle2, Clock, AlertTriangle, XCircle } from "lucide-react";
import { toast } from "sonner";

export default function ReconciliationPage() {
  const { data: channels } = trpc.channels.list.useQuery();
  const { data: jobs, isLoading, refetch } = trpc.reconciliation.list.useQuery();
  const createMutation = trpc.reconciliation.create.useMutation();

  const [open, setOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "",
    sourceChannelId: "",
    targetChannelId: "",
    dateFrom: "",
    dateTo: "",
    amountTolerance: "0.005",
    dateWindowDays: "3",
  });

  const { data: jobDetail, isLoading: detailLoading } = trpc.reconciliation.get.useQuery(
    { id: selectedJob! },
    { enabled: !!selectedJob }
  );

  const channelMap = useMemo(() => new Map(channels?.map((c) => [c.id, c]) || []), [channels]);

  const handleCreate = async () => {
    if (!form.name || !form.sourceChannelId || !form.targetChannelId || !form.dateFrom || !form.dateTo) {
      toast.error("Please fill in all required fields.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: form.name,
        sourceChannelId: parseInt(form.sourceChannelId),
        targetChannelId: parseInt(form.targetChannelId),
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        amountTolerance: parseFloat(form.amountTolerance),
        dateWindowDays: parseInt(form.dateWindowDays),
      });
      toast.success("Reconciliation job created and running!");
      setOpen(false);
      setForm({ name: "", sourceChannelId: "", targetChannelId: "", dateFrom: "", dateTo: "", amountTolerance: "0.005", dateWindowDays: "3" });
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to create job");
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case "running": return <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />;
      case "pending": return <Clock className="h-4 w-4 text-amber-500" />;
      case "failed": return <XCircle className="h-4 w-4 text-red-500" />;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Reconciliation</h1>
          <p className="text-muted-foreground mt-1">Create and manage reconciliation jobs</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Play className="h-4 w-4 mr-2" /> New Reconciliation</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Reconciliation Job</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <label className="text-sm font-medium mb-1 block">Job Name</label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. NIBSS vs Core Banking - Feb 2026" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Source Channel</label>
                  <Select value={form.sourceChannelId} onValueChange={(v) => setForm({ ...form, sourceChannelId: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {channels?.map((ch) => (
                        <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Target Channel</label>
                  <Select value={form.targetChannelId} onValueChange={(v) => setForm({ ...form, targetChannelId: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {channels?.map((ch) => (
                        <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Date From</label>
                  <Input type="date" value={form.dateFrom} onChange={(e) => setForm({ ...form, dateFrom: e.target.value })} />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Date To</label>
                  <Input type="date" value={form.dateTo} onChange={(e) => setForm({ ...form, dateTo: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Amount Tolerance (%)</label>
                  <Input type="number" step="0.001" value={form.amountTolerance} onChange={(e) => setForm({ ...form, amountTolerance: e.target.value })} />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Date Window (days)</label>
                  <Input type="number" value={form.dateWindowDays} onChange={(e) => setForm({ ...form, dateWindowDays: e.target.value })} />
                </div>
              </div>
              <Button onClick={handleCreate} disabled={createMutation.isPending} className="w-full">
                {createMutation.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : <><Play className="h-4 w-4 mr-2" /> Run Reconciliation</>}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Jobs List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : jobs && jobs.length > 0 ? (
        <div className="space-y-4">
          {jobs.map((job) => (
            <Card key={job.id} className={`cursor-pointer transition-shadow hover:shadow-md ${selectedJob === job.id ? "ring-2 ring-primary" : ""}`} onClick={() => setSelectedJob(job.id)}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {statusIcon(job.status)}
                    <div>
                      <h3 className="font-semibold">{job.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {channelMap.get(job.sourceChannelId)?.name || "?"} → {channelMap.get(job.targetChannelId)?.name || "?"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm">
                    <div className="text-right">
                      <p className="text-muted-foreground">Match Rate</p>
                      <p className={`font-bold text-lg ${parseFloat(job.matchRate || "0") >= 80 ? "text-green-600" : parseFloat(job.matchRate || "0") >= 50 ? "text-amber-500" : "text-red-500"}`}>
                        {job.matchRate ? `${parseFloat(job.matchRate).toFixed(1)}%` : "-"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-muted-foreground">Matched</p>
                      <p className="font-semibold">{job.matchedCount || 0}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-muted-foreground">Exceptions</p>
                      <p className="font-semibold text-amber-500">{job.exceptionCount || 0}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedJob(job.id); }}>
                      <Eye className="h-4 w-4 mr-1" /> View
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Play className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-semibold text-lg">No Reconciliation Jobs</h3>
            <p className="text-muted-foreground text-sm mt-1">Upload transaction data and create your first reconciliation job.</p>
          </CardContent>
        </Card>
      )}

      {/* Job Detail */}
      {selectedJob && (
        <Card>
          <CardHeader>
            <CardTitle>Job Details</CardTitle>
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : jobDetail ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="text-xs text-muted-foreground">Source Transactions</p>
                    <p className="text-xl font-bold">{jobDetail.job.totalSourceTxns || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="text-xs text-muted-foreground">Target Transactions</p>
                    <p className="text-xl font-bold">{jobDetail.job.totalTargetTxns || 0}</p>
                  </div>
                  <div className="p-3 bg-green-50 rounded-lg">
                    <p className="text-xs text-green-600">Matched</p>
                    <p className="text-xl font-bold text-green-700">{jobDetail.job.matchedCount || 0}</p>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-lg">
                    <p className="text-xs text-amber-600">Exceptions</p>
                    <p className="text-xl font-bold text-amber-700">{jobDetail.job.exceptionCount || 0}</p>
                  </div>
                </div>

                {jobDetail.matches.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2">Matches ({jobDetail.matches.length})</h4>
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/50 border-b">
                            <th className="text-left py-2 px-3">Type</th>
                            <th className="text-right py-2 px-3">Confidence</th>
                            <th className="text-right py-2 px-3">Amount Diff</th>
                            <th className="text-right py-2 px-3">Date Diff</th>
                            <th className="text-left py-2 px-3">Reason</th>
                            <th className="text-left py-2 px-3">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jobDetail.matches.slice(0, 20).map((m) => (
                            <tr key={m.id} className="border-b last:border-0">
                              <td className="py-2 px-3">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">{m.matchType}</span>
                              </td>
                              <td className="py-2 px-3 text-right font-mono">{parseFloat(m.confidenceScore || "0").toFixed(0)}%</td>
                              <td className="py-2 px-3 text-right font-mono">{parseFloat(m.amountDifference || "0").toFixed(2)}</td>
                              <td className="py-2 px-3 text-right">{m.dateDifference || 0} days</td>
                              <td className="py-2 px-3 max-w-[200px] truncate">{m.matchReason || "-"}</td>
                              <td className="py-2 px-3">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  m.status === "confirmed" ? "bg-green-100 text-green-700" :
                                  m.status === "pending_review" ? "bg-amber-100 text-amber-700" :
                                  "bg-red-100 text-red-700"
                                }`}>{m.status}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {jobDetail.exceptions.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2">Exceptions ({jobDetail.exceptions.length})</h4>
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/50 border-b">
                            <th className="text-left py-2 px-3">Category</th>
                            <th className="text-left py-2 px-3">Severity</th>
                            <th className="text-left py-2 px-3">Description</th>
                            <th className="text-left py-2 px-3">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jobDetail.exceptions.slice(0, 20).map((ex) => (
                            <tr key={ex.id} className="border-b last:border-0">
                              <td className="py-2 px-3 font-medium">{ex.category?.replace(/_/g, " ")}</td>
                              <td className="py-2 px-3">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  ex.severity === "critical" ? "bg-red-100 text-red-700" :
                                  ex.severity === "high" ? "bg-orange-100 text-orange-700" :
                                  ex.severity === "medium" ? "bg-amber-100 text-amber-700" :
                                  "bg-blue-100 text-blue-700"
                                }`}>{ex.severity}</span>
                              </td>
                              <td className="py-2 px-3 max-w-[300px] truncate">{ex.description}</td>
                              <td className="py-2 px-3">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  ex.status === "open" ? "bg-red-100 text-red-700" :
                                  ex.status === "in_review" ? "bg-amber-100 text-amber-700" :
                                  "bg-green-100 text-green-700"
                                }`}>{ex.status}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
