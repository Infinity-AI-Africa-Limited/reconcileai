import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Shield, ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";

export default function AuditTrailPage() {
  const [filters, setFilters] = useState({ action: "", entityType: "", dateFrom: "", dateTo: "" });
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = trpc.audit.list.useQuery({
    entityType: filters.entityType || undefined,
    limit,
    offset: page * limit,
  });

  const exportXlsxMutation = trpc.audit.exportXlsx.useMutation();
  const [integrity, setIntegrity] = useState<{ valid: boolean; signedRows: number; reason: string | null } | null>(null);
  const verifyChainQuery = trpc.audit.verifyChain.useQuery(undefined, { enabled: false });

  const handleVerifyIntegrity = async () => {
    try {
      const res = await verifyChainQuery.refetch();
      const r = res.data;
      if (!r) throw new Error("No result");
      setIntegrity({ valid: r.valid, signedRows: r.signedRows, reason: r.reason });
      if (r.valid) {
        toast.success(`Audit chain intact — ${r.signedRows.toLocaleString()} entries verified${r.unsignedRows ? `, ${r.unsignedRows} legacy` : ""}`);
      } else {
        toast.error(`Tampering detected: ${r.reason}`);
      }
    } catch (err: any) {
      toast.error(err.message || "Verification failed");
    }
  };

  const handleExportXlsx = async () => {
    try {
      const res = await exportXlsxMutation.mutateAsync({
        entityType: filters.entityType || undefined,
        action: filters.action || undefined,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
        limit: 10000,
      });
      window.open(res.url, "_blank");
      toast.success(`Audit Trail exported — ${res.rowCount.toLocaleString()} rows`);
    } catch (err: any) {
      toast.error(err.message || "Export failed");
    }
  };

  const actionColor = (a: string) => {
    if (a.includes("create") || a.includes("upload")) return "bg-blue-100 text-blue-700";
    if (a.includes("match") || a.includes("resolve")) return "bg-green-100 text-green-700";
    if (a.includes("reject") || a.includes("delete")) return "bg-red-100 text-red-700";
    if (a.includes("review") || a.includes("update")) return "bg-amber-100 text-amber-700";
    return "bg-gray-100 text-gray-700";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">Audit Trail</h1>
        <p className="text-muted-foreground mt-1">Complete log of all system actions for CBN compliance</p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap gap-3">
        <Select value={filters.action} onValueChange={(v) => { setFilters({ ...filters, action: v === "all" ? "" : v }); setPage(0); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="All Actions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            <SelectItem value="upload_batch">Upload Batch</SelectItem>
            <SelectItem value="create_reconciliation">Create Reconciliation</SelectItem>
            <SelectItem value="auto_match">Auto Match</SelectItem>
            <SelectItem value="manual_match">Manual Match</SelectItem>
            <SelectItem value="resolve_exception">Resolve Exception</SelectItem>
            <SelectItem value="dismiss_exception">Dismiss Exception</SelectItem>
            <SelectItem value="generate_report">Generate Report</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.entityType} onValueChange={(v) => { setFilters({ ...filters, entityType: v === "all" ? "" : v }); setPage(0); }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="All Entities" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Entities</SelectItem>
            <SelectItem value="batch">Batch</SelectItem>
            <SelectItem value="transaction">Transaction</SelectItem>
            <SelectItem value="reconciliation_job">Reconciliation Job</SelectItem>
            <SelectItem value="match">Match</SelectItem>
            <SelectItem value="exception">Exception</SelectItem>
            <SelectItem value="report">Report</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={filters.dateFrom} onChange={(e) => { setFilters({ ...filters, dateFrom: e.target.value }); setPage(0); }} />
        <Input type="date" className="w-40" value={filters.dateTo} onChange={(e) => { setFilters({ ...filters, dateTo: e.target.value }); setPage(0); }} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {integrity && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${integrity.valid ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
              {integrity.valid ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {integrity.valid ? `Chain intact (${integrity.signedRows.toLocaleString()})` : "Tampering detected"}
            </span>
          )}
          <Button
            variant="outline" size="sm"
            className="gap-2 border-[#1B365D] text-[#1B365D] bg-white hover:bg-[#EEF2F8]"
            disabled={verifyChainQuery.isFetching}
            onClick={handleVerifyIntegrity}
            title="Recompute the per-organization hash chain to detect any altered or removed audit entry"
          >
            {verifyChainQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Verify Integrity
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-2 border-[#1B365D] text-[#1B365D] bg-white hover:bg-[#EEF2F8]"
            disabled={exportXlsxMutation.isPending}
            onClick={handleExportXlsx}
          >
            {exportXlsxMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Download className="h-4 w-4" />}
            Export to Excel
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : data?.data && data.data.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Timestamp</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Action</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Entity</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Entity ID</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">Description</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">User</th>
                    <th className="text-left py-3 px-2 font-medium text-muted-foreground">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((log) => (
                    <tr key={log.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-3 px-2 text-xs font-mono whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 px-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${actionColor(log.action)}`}>
                          {log.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-xs">{log.entityType?.replace(/_/g, " ")}</td>
                      <td className="py-3 px-2 font-mono text-xs">{log.entityId || "-"}</td>
                      <td className="py-3 px-2 max-w-[300px] truncate text-xs text-muted-foreground">{typeof log.details === 'string' ? log.details : JSON.stringify(log.details) || "-"}</td>
                      <td className="py-3 px-2 text-xs">{log.userId || "System"}</td>
                      <td className="py-3 px-2 font-mono text-xs">{log.ipAddress || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {page * limit + 1}-{Math.min((page + 1) * limit, data.total)} of {data.total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Shield className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-semibold text-lg">No Audit Logs</h3>
            <p className="text-muted-foreground text-sm mt-1">Audit entries will appear as actions are performed.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
