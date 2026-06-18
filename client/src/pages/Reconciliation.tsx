import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Play, Eye, CheckCircle2, Clock, AlertTriangle, XCircle, Download, Lock } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export default function ReconciliationPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isReadOnly = user?.role === "cfo" || user?.role === "compliance";
  const { data: channels } = trpc.channels.list.useQuery();
  const { data: jobs, isLoading, refetch } = trpc.reconciliation.list.useQuery();
  const createMutation = trpc.reconciliation.create.useMutation();
  const createMultiMutation = trpc.reconciliation.createMultiChannel.useMutation();
  const exportMutation = trpc.export.csv.useMutation();
  const exportXlsxMutation = trpc.export.xlsx.useMutation();

  const [open, setOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [multiChannel, setMultiChannel] = useState(false);
  const [targetChannelIds, setTargetChannelIds] = useState<number[]>([]);
  const [form, setForm] = useState({
    name: "",
    // Transaction Integrity is merged into Settlement — only two selectable modules.
    moduleType: "settlement" as "settlement" | "account_level",
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

  const resetForm = () => {
    setForm({ name: "", moduleType: "settlement", sourceChannelId: "", targetChannelId: "", dateFrom: "", dateTo: "", amountTolerance: "0.005", dateWindowDays: "3" });
    setMultiChannel(false);
    setTargetChannelIds([]);
  };

  const handleCreate = async () => {
    const baseValid = form.name && form.sourceChannelId && form.dateFrom && form.dateTo;
    if (!baseValid || (multiChannel ? targetChannelIds.length === 0 : !form.targetChannelId)) {
      toast.error(multiChannel ? "Pick a source, at least one target channel, and a date range." : "Please fill in all required fields.");
      return;
    }
    try {
      if (multiChannel) {
        const res = await createMultiMutation.mutateAsync({
          name: form.name,
          moduleType: form.moduleType,
          sourceChannelId: parseInt(form.sourceChannelId),
          targetChannelIds,
          dateFrom: form.dateFrom,
          dateTo: form.dateTo,
          amountTolerance: parseFloat(form.amountTolerance),
          dateWindowDays: parseInt(form.dateWindowDays),
        });
        toast.success(`Multi-channel run started across ${res.targetCount} channels (${res.jobIds.length} jobs).`);
      } else {
        await createMutation.mutateAsync({
          name: form.name,
          moduleType: form.moduleType,
          sourceChannelId: parseInt(form.sourceChannelId),
          targetChannelId: parseInt(form.targetChannelId),
          dateFrom: form.dateFrom,
          dateTo: form.dateTo,
          amountTolerance: parseFloat(form.amountTolerance),
          dateWindowDays: parseInt(form.dateWindowDays),
        });
        toast.success("Reconciliation job created and running!");
      }
      setOpen(false);
      resetForm();
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to create job");
    }
  };

  const toggleTarget = (id: number) => {
    setTargetChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
      {/* Read-only role banner */}
      {isReadOnly && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <span className="font-semibold">Read-only access.</span>{" "}
            Your role ({user?.role === "cfo" ? "CFO" : "Compliance / Audit"}) can view reconciliation jobs but cannot create or modify them.
          </span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Reconciliation</h1>
          <p className="text-muted-foreground mt-1">Create and manage reconciliation jobs</p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Dialog open={isReadOnly ? false : open} onOpenChange={isReadOnly ? undefined : setOpen}>
                  <DialogTrigger asChild>
                    <Button disabled={isReadOnly} className={isReadOnly ? "opacity-50 cursor-not-allowed" : ""}>
                      {isReadOnly ? <Lock className="h-4 w-4 mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                      New Reconciliation
                    </Button>
                  </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Reconciliation Job</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              {/* Single vs multi-channel mode */}
              <div className="flex rounded-lg border p-1 text-sm">
                <button
                  type="button"
                  onClick={() => setMultiChannel(false)}
                  className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${!multiChannel ? "bg-[#1B365D] text-white" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Single Channel Pair
                </button>
                <button
                  type="button"
                  onClick={() => setMultiChannel(true)}
                  className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${multiChannel ? "bg-[#1B365D] text-white" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Multi-Channel (single run)
                </button>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Job Name</label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. NIBSS vs Core Banking - Feb 2026" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Reconciliation Module</label>
                <Select value={form.moduleType} onValueChange={(v: any) => setForm({ ...form, moduleType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="settlement">Settlement</SelectItem>
                    <SelectItem value="account_level">Account-Level</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500 mt-1">
                  {form.moduleType === "settlement" && "Validate bulk settlement amounts against detailed transaction reports — includes transaction-integrity checks (multi-source ingestion, duplicate detection, timestamp normalisation)"}
                  {form.moduleType === "account_level" && "Account balance validation - match money in accounts to transaction reports"}
                </p>
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
                {!multiChannel && (
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
                )}
              </div>
              {multiChannel && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    Target Channels <span className="text-muted-foreground font-normal">— reconciled against the source in one run ({targetChannelIds.length} selected)</span>
                  </label>
                  <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                    {channels?.filter((ch) => String(ch.id) !== form.sourceChannelId).map((ch) => (
                      <label key={ch.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={targetChannelIds.includes(ch.id)}
                          onChange={() => toggleTarget(ch.id)}
                          className="h-4 w-4"
                        />
                        {ch.name}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-1 text-xs text-[#1B365D] font-medium hover:underline"
                    onClick={() => {
                      const eligible = (channels ?? []).filter((ch) => String(ch.id) !== form.sourceChannelId).map((ch) => ch.id);
                      setTargetChannelIds((prev) => (prev.length === eligible.length ? [] : eligible));
                    }}
                  >
                    {targetChannelIds.length === (channels ?? []).filter((ch) => String(ch.id) !== form.sourceChannelId).length ? "Clear all" : "Select all channels"}
                  </button>
                </div>
              )}
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
              <Button onClick={handleCreate} disabled={createMutation.isPending || createMultiMutation.isPending} className="w-full">
                {(createMutation.isPending || createMultiMutation.isPending)
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</>
                  : <><Play className="h-4 w-4 mr-2" /> {multiChannel ? `Run Across ${targetChannelIds.length || ""} Channels` : "Run Reconciliation"}</>}
              </Button>
            </div>
          </DialogContent>
                </Dialog>
              </span>
            </TooltipTrigger>
            {isReadOnly && (
              <TooltipContent side="bottom">
                Your role has read-only access to this module
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
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
                    {job.status === "completed" && (
                      <>
                        <Button variant="outline" size="sm" onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const res = await exportMutation.mutateAsync({ jobId: job.id, type: "full" });
                            window.open(res.url, "_blank");
                            toast.success(`CSV ready: ${res.fileName}`);
                          } catch (err: any) { toast.error(err.message || "Export failed"); }
                        }} disabled={exportMutation.isPending}>
                          {exportMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} CSV
                        </Button>
                        <Button variant="outline" size="sm" onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const res = await exportXlsxMutation.mutateAsync({ jobId: job.id, type: "full" });
                            window.open(res.url, "_blank");
                            toast.success(`Excel ready: ${res.fileName}`);
                          } catch (err: any) { toast.error(err.message || "Excel export failed"); }
                        }} disabled={exportXlsxMutation.isPending}>
                          {exportXlsxMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} Excel
                        </Button>
                      </>
                    )}
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
                            <tr key={ex.id} className="border-b last:border-0 hover:bg-muted/30">
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
                                <button
                                  onClick={() => setLocation("/exceptions")}
                                  title={`View exception #${ex.id} in Exception Management`}
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer hover:opacity-75 transition-opacity underline-offset-2 hover:underline ${
                                    ex.status === "open" ? "bg-red-100 text-red-700" :
                                    ex.status === "in_review" ? "bg-amber-100 text-amber-700" :
                                    "bg-green-100 text-green-700"
                                  }`}
                                >{ex.status}</button>
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
