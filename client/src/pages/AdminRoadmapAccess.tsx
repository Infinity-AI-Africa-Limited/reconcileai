import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CheckCircle, XCircle, Clock, Users, Copy, Check } from "lucide-react";
import { toast } from "sonner";

function StatusBadge({ status }: { status: string }) {
  if (status === "approved") return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Approved</Badge>;
  if (status === "rejected") return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Rejected</Badge>;
  return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">Pending</Badge>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy} className="ml-2 text-gray-400 hover:text-white transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export default function AdminRoadmapAccess() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [expiryDays, setExpiryDays] = useState(30);

  const utils = trpc.useUtils();

  const { data: requests, isLoading } = trpc.roadmap.listRequests.useQuery(
    { status: statusFilter },
    { enabled: user?.role === "admin" }
  );

  const updateStatus = trpc.roadmap.updateStatus.useMutation({
    onSuccess: (data, variables) => {
      utils.roadmap.listRequests.invalidate();
      if (variables.action === "approve") {
        toast.success("Access Approved", { description: "The access link has been sent to your Manus notifications. Copy it and email it to the requester." });
      } else {
        toast.success("Request Rejected", { description: "The request has been rejected." });
      }
    },
    onError: (err) => {
      toast.error("Error", { description: err.message });
    },
  });

  if (user?.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-400">Admin access required.</p>
        </div>
      </DashboardLayout>
    );
  }

  const pending = requests?.filter(r => r.status === "pending").length ?? 0;
  const approved = requests?.filter(r => r.status === "approved").length ?? 0;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-6xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Roadmap Access Requests</h1>
          <p className="text-gray-400 mt-1">Manage who can view the private GTM Execution Roadmap.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="bg-[#111827] border-[#1e2d4a]">
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <Clock className="w-8 h-8 text-amber-400" />
              <div>
                <p className="text-2xl font-bold text-white">{pending}</p>
                <p className="text-xs text-gray-400">Pending Review</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-[#111827] border-[#1e2d4a]">
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <CheckCircle className="w-8 h-8 text-emerald-400" />
              <div>
                <p className="text-2xl font-bold text-white">{approved}</p>
                <p className="text-xs text-gray-400">Approved</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-[#111827] border-[#1e2d4a]">
            <CardContent className="pt-4 pb-4 flex items-center gap-3">
              <Users className="w-8 h-8 text-blue-400" />
              <div>
                <p className="text-2xl font-bold text-white">{requests?.length ?? 0}</p>
                <p className="text-xs text-gray-400">Total Requests</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-40 bg-[#111827] border-[#1e2d4a] text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#111827] border-[#1e2d4a] text-white">
              <SelectItem value="all">All Requests</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
            <SelectTrigger className="w-44 bg-[#111827] border-[#1e2d4a] text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#111827] border-[#1e2d4a] text-white">
              <SelectItem value="7">7-day access</SelectItem>
              <SelectItem value="14">14-day access</SelectItem>
              <SelectItem value="30">30-day access</SelectItem>
              <SelectItem value="90">90-day access</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Requests table */}
        <Card className="bg-[#111827] border-[#1e2d4a]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base">Access Requests</CardTitle>
            <CardDescription className="text-gray-400 text-xs">
              When you approve a request, a private link is generated and sent to your Manus notifications. Copy it and email it to the requester.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12 text-gray-400">Loading requests...</div>
            ) : !requests?.length ? (
              <div className="text-center py-12 text-gray-400">
                No {statusFilter !== "all" ? statusFilter : ""} requests yet.
              </div>
            ) : (
              <div className="space-y-3">
                {requests.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-start gap-4 p-4 rounded-lg bg-[#0a0f1e] border border-[#1e2d4a]"
                  >
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-medium">{req.name}</span>
                        <StatusBadge status={req.status} />
                        {req.company && (
                          <span className="text-gray-400 text-sm">· {req.company}</span>
                        )}
                      </div>
                      <p className="text-gray-400 text-sm">{req.email}</p>
                      {req.reason && (
                        <p className="text-gray-500 text-xs italic">"{req.reason}"</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-gray-600 pt-1">
                        <span>Requested {new Date(req.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                        {req.approvedAt && (
                          <span>Approved {new Date(req.approvedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                        )}
                        {req.tokenExpiresAt && req.status === "approved" && (
                          <span className={new Date(req.tokenExpiresAt) < new Date() ? "text-red-400" : "text-emerald-400"}>
                            {new Date(req.tokenExpiresAt) < new Date() ? "Expired" : `Expires ${new Date(req.tokenExpiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`}
                          </span>
                        )}
                      </div>
                      {req.status === "approved" && req.accessToken && (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-gray-500 font-mono truncate max-w-xs">
                            https://reconcileai.vip/roadmap?token={req.accessToken.slice(0, 16)}...
                          </span>
                          <CopyButton text={`https://reconcileai.vip/roadmap?token=${req.accessToken}`} />
                        </div>
                      )}
                    </div>
                    {req.status === "pending" && (
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          onClick={() => updateStatus.mutate({ id: req.id, action: "approve", expiryDays })}
                          disabled={updateStatus.isPending}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs"
                        >
                          <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateStatus.mutate({ id: req.id, action: "reject", expiryDays })}
                          disabled={updateStatus.isPending}
                          className="border-red-500/40 text-red-400 hover:bg-red-500/10 h-8 text-xs"
                        >
                          <XCircle className="w-3.5 h-3.5 mr-1" /> Reject
                        </Button>
                      </div>
                    )}
                    {req.status === "approved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateStatus.mutate({ id: req.id, action: "reject", expiryDays })}
                        disabled={updateStatus.isPending}
                        className="border-red-500/40 text-red-400 hover:bg-red-500/10 h-8 text-xs shrink-0"
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
