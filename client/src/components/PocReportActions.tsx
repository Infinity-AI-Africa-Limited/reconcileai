import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Download, Share2, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Shared report actions for any POC page: download the reconciliation report as a
 * CSV and create a shareable link. Drop it in after a run so every POC — current
 * and future — has parity with the Woodcore POC (download + share).
 *
 * The share link uses the existing `poc.createShareToken` procedure and the public
 * `/poc-report/:token` viewer, so nothing new is needed server-side.
 */
export interface PocReportRun {
  status?: string;
  matchRate?: number | string | null;
  varianceAmount?: number | string | null;
  ledgerCount?: number;
  ledgerTotal?: number | string | null;
  statementCount?: number;
  statementTotal?: number | string | null;
  matchedCount?: number;
  exceptionCount?: number;
  currencyCode?: string;
  createdAt?: string | Date;
}

export interface PocReportException {
  id?: number;
  category?: string;
  priorityLevel?: string;
  side?: string;
  txnDate?: string;
  reference?: string | null;
  description?: string | null;
  amount?: number | string;
  recommendedAction?: string;
}

export interface PocReportExcluded {
  reason?: string;
  side?: string;
  date?: string;
  reference?: string | null;
  description?: string | null;
  amount?: number | string;
}

/** CSV-escape a single value (RFC4180). */
const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells: unknown[]) => cells.map(esc).join(",");

function buildCsv(opts: {
  reportName: string;
  runId: number;
  run: PocReportRun;
  exceptions: PocReportException[];
  statuses?: Record<string, string>;
  excluded?: PocReportExcluded[];
}): string {
  const { reportName, runId, run, exceptions, statuses, excluded } = opts;
  const rows: string[] = [];
  rows.push(line(["ReconcileAI reconciliation report", reportName]));
  rows.push(line(["Generated", new Date().toISOString()]));
  rows.push(line(["Run ID", runId]));
  if (run.createdAt) rows.push(line(["Run date", new Date(run.createdAt).toISOString()]));
  rows.push(line(["Status", run.status ?? ""]));
  rows.push(line(["Match rate", run.matchRate != null ? `${run.matchRate}%` : ""]));
  rows.push(line(["Variance", run.varianceAmount ?? ""]));
  rows.push(line(["Ledger entries", run.ledgerCount ?? "", run.ledgerTotal ?? ""]));
  rows.push(line(["Statement entries", run.statementCount ?? "", run.statementTotal ?? ""]));
  rows.push(line(["Matched", run.matchedCount ?? ""]));
  rows.push(line(["Exceptions", run.exceptionCount ?? exceptions.length]));

  rows.push("");
  rows.push(line(["Exceptions"]));
  rows.push(line(["#", "Category", "Priority", "Side", "Date", "Reference", "Description", "Amount", "Status", "Recommended action"]));
  exceptions.forEach((e, i) => {
    rows.push(line([
      i + 1, e.category ?? "", e.priorityLevel ?? "", e.side ?? "", e.txnDate ?? "",
      e.reference ?? "", e.description ?? "", e.amount ?? "",
      statuses?.[String(i)] ?? "OPEN", e.recommendedAction ?? "",
    ]));
  });

  if (excluded && excluded.length > 0) {
    rows.push("");
    rows.push(line(["Set aside (bank fees / charges / levies — excluded from matching)"]));
    rows.push(line(["#", "Reason", "Side", "Date", "Reference", "Description", "Amount"]));
    excluded.forEach((e, i) => {
      rows.push(line([i + 1, e.reason ?? "", e.side ?? "", e.date ?? "", e.reference ?? "", e.description ?? "", e.amount ?? ""]));
    });
  }
  return rows.join("\n");
}

export default function PocReportActions({
  pocSlug, runId, run, exceptions, statuses, excluded,
  reportName = "reconciliation-report",
  showShare = true,
  showDownload = true,
}: {
  pocSlug: string;
  runId: number;
  run: PocReportRun;
  exceptions: PocReportException[];
  statuses?: Record<string, string>;
  excluded?: PocReportExcluded[];
  reportName?: string;
  showShare?: boolean;
  showDownload?: boolean;
}) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const share = trpc.poc.createShareToken.useMutation();

  const handleDownload = () => {
    try {
      const csv = buildCsv({ reportName, runId, run, exceptions, statuses, excluded });
      // Prepend a BOM so Excel opens the ₦ and other UTF-8 characters correctly.
      const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportName}-run-${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error("Could not generate the report.");
    }
  };

  const handleShare = async () => {
    try {
      const { token } = await share.mutateAsync({ pocSlug, runId });
      const url = `${window.location.origin}/poc-report/${token}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Share link copied to clipboard");
    } catch (e: any) {
      toast.error(e?.message || "Could not create share link.");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {showDownload && (
        <Button variant="outline" className="gap-2" onClick={handleDownload}>
          <Download className="h-4 w-4" /> Download report (CSV)
        </Button>
      )}
      {showShare && (
        <Button variant="outline" className="gap-2" onClick={handleShare} disabled={share.isPending}>
          {share.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Share2 className="h-4 w-4" />}
          {shareUrl ? "Copy share link again" : "Create shareable link"}
        </Button>
      )}
      {shareUrl && <span className="text-xs text-muted-foreground truncate max-w-[420px]">{shareUrl}</span>}
    </div>
  );
}
