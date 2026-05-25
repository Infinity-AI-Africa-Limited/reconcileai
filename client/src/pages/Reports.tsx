import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, FileText, Download, Plus, AlertCircle, Eye } from "lucide-react";
import { toast } from "sonner";

export default function ReportsPage() {
  const [, navigate] = useLocation();
  const { data: reports, isLoading, refetch } = trpc.reports.list.useQuery();
  const { data: jobs } = trpc.reconciliation.list.useQuery();
  const generateMutation = trpc.reports.generate.useMutation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    type: "custom",
    jobId: "",
    format: "pdf",
  });

  // Completed jobs only — these have full match/exception data to report on
  const completedJobs = (jobs ?? []).filter((j) => j.status === "completed");

  // Auto-populate report name when job or type changes
  const handleJobChange = (jobId: string) => {
    const selectedJob = completedJobs.find((j) => String(j.id) === jobId);
    const typeLabelMap: Record<string, string> = {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      custom: "Custom",
    };
    const autoName = selectedJob
      ? `${selectedJob.name} — ${typeLabelMap[form.type] ?? "Custom"} Report`
      : form.name;
    setForm({ ...form, jobId, name: autoName });
  };

  const handleTypeChange = (type: string) => {
    const selectedJob = completedJobs.find((j) => String(j.id) === form.jobId);
    const typeLabelMap: Record<string, string> = {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      custom: "Custom",
    };
    const autoName = selectedJob
      ? `${selectedJob.name} — ${typeLabelMap[type] ?? "Custom"} Report`
      : form.name;
    setForm({ ...form, type, name: autoName });
  };

  const handleGenerate = async () => {
    if (!form.name) {
      toast.error("Please enter a report name.");
      return;
    }
    if (!form.jobId) {
      toast.error("Please select a reconciliation job to report on.");
      return;
    }
    try {
      await generateMutation.mutateAsync({
        title: form.name,
        reportType: form.type as "daily" | "weekly" | "monthly" | "custom",
        jobId: Number(form.jobId),
      });
      toast.success("Report generated successfully!");
      setOpen(false);
      setForm({ name: "", type: "custom", jobId: "", format: "pdf" });
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to generate report");
    }
  };

  const typeLabel = (t: string) => {
    switch (t) {
      case "daily": return "Daily";
      case "weekly": return "Weekly";
      case "monthly": return "Monthly";
      case "custom": return "Custom";
      default: return t;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Reports</h1>
          <p className="text-muted-foreground mt-1">Generate and download reconciliation reports</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" /> Generate Report</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate Reconciliation Report</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              {/* Job selector — must be first so name auto-populates */}
              <div>
                <label className="text-sm font-medium mb-1 block">Reconciliation Job</label>
                {completedJobs.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    No completed reconciliation jobs found. Run a reconciliation first.
                  </div>
                ) : (
                  <Select value={form.jobId} onValueChange={handleJobChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a completed job…" />
                    </SelectTrigger>
                    <SelectContent>
                      {completedJobs.map((j) => (
                        <SelectItem key={j.id} value={String(j.id)}>
                          {j.name} — {new Date(j.dateFrom).toLocaleDateString()} → {new Date(j.dateTo).toLocaleDateString()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Report Type</label>
                  <Select value={form.type} onValueChange={handleTypeChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Format</label>
                  <Select value={form.format} onValueChange={(v) => setForm({ ...form, format: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">PDF</SelectItem>
                      <SelectItem value="excel">Excel</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Report name — auto-populated, still editable */}
              <div>
                <label className="text-sm font-medium mb-1 block">Report Name</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Select a job above to auto-fill…"
                />
                <p className="text-xs text-muted-foreground mt-1">Auto-filled from job + type selection. You can edit it.</p>
              </div>

              <Button
                onClick={handleGenerate}
                disabled={generateMutation.isPending || !form.jobId || completedJobs.length === 0}
                className="w-full"
              >
                {generateMutation.isPending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating...</>
                  : <><FileText className="h-4 w-4 mr-2" /> Generate Report</>}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : reports && reports.length > 0 ? (
        <div className="space-y-3">
          {reports.map((r) => (
            <Card key={r.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => navigate(`/reports/${r.id}`)}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{r.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {typeLabel(r.reportType)} &middot; {r.format?.toUpperCase()} &middot; Generated {new Date(r.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700">completed</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); navigate(`/reports/${r.id}`); }}
                    >
                      <Eye className="h-4 w-4 mr-1" /> View
                    </Button>
                    {r.fileUrl && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={r.fileUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                          <Download className="h-4 w-4 mr-1" /> Download
                        </a>
                      </Button>
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
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-semibold text-lg">No Reports Generated</h3>
            <p className="text-muted-foreground text-sm mt-1">Generate your first reconciliation report.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
