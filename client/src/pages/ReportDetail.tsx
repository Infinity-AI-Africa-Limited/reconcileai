import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Download, ArrowLeft, FileText, CheckCircle, AlertTriangle,
  Clock, Share2, Printer, Copy, Check, Trash2, ExternalLink
} from "lucide-react";
import { toast } from "sonner";

type ReportSummary = {
  jobName?: string;
  dateRange?: string;
  totalSource?: number;
  totalTarget?: number;
  matched?: number;
  exceptions?: number;
  unmatched?: number;
  matchRate?: number;
  processingTimeMs?: number;
  generatedAt?: string;
  generatedBy?: string;
  matchBreakdown?: {
    exact?: number;
    fuzzy?: number;
    amountTolerance?: number;
    dateWindow?: number;
    aiSuggested?: number;
    manual?: number;
    reversal?: number;
  };
  exceptionBreakdown?: {
    missingCounterparty?: number;
    amountMismatch?: number;
    timingDifference?: number;
    duplicate?: number;
    unmatched?: number;
    reversalUnmatched?: number;
    currencyMismatch?: number;
  };
};

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-muted/40 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${color ?? "text-foreground"}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function BreakdownBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground capitalize">{label.replace(/_/g, " ")}</span>
        <span className="font-medium">{count.toLocaleString()} <span className="text-muted-foreground text-xs">({pct}%)</span></span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ShareModal({ reportId, onClose }: { reportId: number; onClose: () => void }) {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [note, setNote] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("30");
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createToken = trpc.reports.createShareToken.useMutation({
    onSuccess: (data) => {
      const link = `${window.location.origin}/r/${data.token}`;
      setGeneratedLink(link);
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: tokens, refetch } = trpc.reports.listShareTokens.useQuery({ reportId });
  const revokeToken = trpc.reports.revokeShareToken.useMutation({
    onSuccess: () => { refetch(); toast.success("Link revoked"); },
    onError: (err) => toast.error(err.message),
  });

  const handleCreate = () => {
    createToken.mutate({
      reportId,
      recipientEmail: recipientEmail || undefined,
      recipientName: recipientName || undefined,
      note: note || undefined,
      expiresInDays: expiresInDays === "never" ? undefined : Number(expiresInDays),
    });
  };

  const handleCopy = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Share2 className="h-5 w-5" /> Share Report
        </DialogTitle>
        <DialogDescription>
          Generate a secure, read-only link to share this report with stakeholders. No login required.
        </DialogDescription>
      </DialogHeader>

      {!generatedLink ? (
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rname">Recipient Name <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input id="rname" placeholder="e.g. CFO, LAPO MFB" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="remail">Recipient Email <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input id="remail" type="email" placeholder="cfo@lapo.com" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expiry">Link Expiry</Label>
            <Select value={expiresInDays} onValueChange={setExpiresInDays}>
              <SelectTrigger id="expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="never">Never expires</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note">Internal Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Textarea id="note" placeholder="e.g. Shared with LAPO CFO for Q1 review" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          <Button className="w-full" onClick={handleCreate} disabled={createToken.isPending}>
            {createToken.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Share2 className="h-4 w-4 mr-2" />}
            Generate Share Link
          </Button>
        </div>
      ) : (
        <div className="space-y-4 pt-2">
          <div className="bg-muted/50 rounded-lg p-3 space-y-2">
            <p className="text-xs text-muted-foreground font-medium">Share link generated:</p>
            <div className="flex items-center gap-2">
              <code className="text-xs flex-1 truncate bg-background border rounded px-2 py-1.5">{generatedLink}</code>
              <Button size="sm" variant="outline" onClick={() => handleCopy(generatedLink)}>
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={generatedLink} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
          <Button variant="outline" className="w-full" onClick={() => setGeneratedLink(null)}>
            Generate Another Link
          </Button>
        </div>
      )}

      {/* Existing active links */}
      {tokens && tokens.filter((t) => !t.revokedAt).length > 0 && (
        <div className="border-t pt-4 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Active Links</p>
          {tokens.filter((t) => !t.revokedAt).map((t) => {
            const link = `${window.location.origin}/r/${t.token}`;
            return (
              <div key={t.id} className="flex items-center gap-2 text-xs">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{t.recipientName ?? t.recipientEmail ?? "Anonymous"}</p>
                  <p className="text-muted-foreground">
                    {t.expiresAt ? `Expires ${new Date(t.expiresAt).toLocaleDateString()}` : "Never expires"} · {t.viewCount} views
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => handleCopy(link)} className="shrink-0 h-7 px-2">
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => revokeToken.mutate({ tokenId: t.id })}
                  disabled={revokeToken.isPending}
                  className="shrink-0 h-7 px-2 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </DialogContent>
  );
}

export default function ReportDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [showShare, setShowShare] = useState(false);
  const reportId = Number(params.id);

  const { data: report, isLoading, error } = trpc.reports.get.useQuery(
    { id: reportId },
    { enabled: !isNaN(reportId) && reportId > 0 }
  );

  const handlePrint = () => window.print();

  if (isNaN(reportId) || reportId <= 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <h2 className="text-xl font-semibold">Invalid report ID</h2>
        <Button variant="outline" onClick={() => navigate("/reports")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Reports
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <h2 className="text-xl font-semibold">Report not found</h2>
        <Button variant="outline" onClick={() => navigate("/reports")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Reports
        </Button>
      </div>
    );
  }

  const summary = (report.summary ?? {}) as ReportSummary;
  const matchRate = summary.matchRate ?? 0;
  const matched = summary.matched ?? 0;
  const exceptions = summary.exceptions ?? 0;
  const unmatched = summary.unmatched ?? 0;
  const totalSource = summary.totalSource ?? 0;
  const totalTarget = summary.totalTarget ?? 0;
  const matchBreakdown = summary.matchBreakdown ?? {};
  const exceptionBreakdown = summary.exceptionBreakdown ?? {};
  const totalMatched = Object.values(matchBreakdown).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
  const totalExceptions = Object.values(exceptionBreakdown).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;

  const matchRateColor = matchRate >= 98 ? "text-green-600" : matchRate >= 95 ? "text-amber-600" : "text-red-600";

  return (
    <div className="space-y-6">
      {/* Share modal */}
      <Dialog open={showShare} onOpenChange={setShowShare}>
        <ShareModal reportId={reportId} onClose={() => setShowShare(false)} />
      </Dialog>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/reports")} className="mt-0.5 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-primary">{report.title}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {summary.jobName && <span className="font-medium">{summary.jobName}</span>}
              {summary.dateRange && <span className="ml-2 text-muted-foreground">· {summary.dateRange}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">completed</Badge>
          <Button size="sm" variant="outline" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" /> Print / PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowShare(true)}>
            <Share2 className="h-4 w-4 mr-2" /> Share
          </Button>
          {report.fileUrl && (
            <Button size="sm" asChild>
              <a href={report.fileUrl} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4 mr-2" /> Download
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* Print header (only visible when printing) */}
      <div className="hidden print:block mb-4">
        <h1 className="text-2xl font-bold">{report.title}</h1>
        <p className="text-sm text-gray-500">
          {summary.jobName} · {summary.dateRange} · Generated {new Date(report.createdAt).toLocaleString()}
        </p>
        <p className="text-xs text-gray-400 mt-1">ReconcileAI · reconcileai.vip · Confidential</p>
      </div>

      {/* Key Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Match Rate" value={`${matchRate.toFixed(1)}%`} sub={`${matched.toLocaleString()} matched`} color={matchRateColor} />
        <StatCard label="Total Source Txns" value={totalSource.toLocaleString()} sub="Source file records" />
        <StatCard label="Exceptions" value={exceptions.toLocaleString()} sub="Require attention" color={exceptions > 0 ? "text-amber-600" : "text-green-600"} />
        <StatCard label="Unmatched" value={unmatched.toLocaleString()} sub="No counterpart found" color={unmatched > 0 ? "text-red-600" : "text-green-600"} />
      </div>

      {/* Match Breakdown + Exception Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600" /> Match Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(matchBreakdown).map(([key, val]) => (
              <BreakdownBar key={key} label={key} count={val ?? 0} total={totalMatched} color="bg-green-500" />
            ))}
            {totalMatched === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No match breakdown data available</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Exception Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(exceptionBreakdown).map(([key, val]) => (
              <BreakdownBar key={key} label={key} count={val ?? 0} total={totalExceptions || 1} color="bg-amber-500" />
            ))}
            {totalExceptions === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No exceptions — clean reconciliation</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Report Metadata */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" /> Report Metadata
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Report Type</p>
              <p className="font-medium capitalize">{report.reportType}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Format</p>
              <p className="font-medium uppercase">{report.format}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Generated By</p>
              <p className="font-medium">{summary.generatedBy ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Generated At</p>
              <p className="font-medium">{new Date(report.createdAt).toLocaleString()}</p>
            </div>
            {summary.processingTimeMs !== undefined && (
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Processing Time</p>
                <p className="font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {summary.processingTimeMs < 1000
                    ? `${summary.processingTimeMs}ms`
                    : `${(summary.processingTimeMs / 1000).toFixed(1)}s`}
                </p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Source Txns</p>
              <p className="font-medium">{totalSource.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide mb-1">Target Txns</p>
              <p className="font-medium">{totalTarget.toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <style>{`
        @media print {
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
        }
      `}</style>
    </div>
  );
}
