/**
 * ReconcileAI — Salad Africa POC (public, no login).
 *
 * Self-service: upload a ledger (Excel/CSV) + a bank statement (PDF/Excel/CSV),
 * the AI extracts transactions from any format (incl. scanned PDFs), then the
 * 3-layer engine reconciles them. Results are stored and shareable.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, Upload as UploadIcon, FileSpreadsheet, FileText, CheckCircle2,
  Play, Scale, AlertTriangle, Bot, Copy, Check, Sparkles,
} from "lucide-react";
import { toast } from "sonner";

const POC_SLUG = "salad_africa";

type FileKind = "pdf" | "excel" | "csv";
type UploadState = {
  uploadId: number;
  rowCount: number;
  notes: string;
  fileName: string;
  preview: Array<{ date: string; description: string; amount: number; direction: string; reference?: string }>;
};

function detectKind(name: string): FileKind | null {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return "excel";
  if (n.endsWith(".csv") || n.endsWith(".txt")) return "csv";
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(((reader.result as string) || "").split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ngn = (n: number | string) =>
  `₦${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  HIGH: "bg-orange-100 text-orange-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-gray-100 text-gray-600",
};
const CATEGORY_LABELS: Record<string, string> = {
  IN_LEDGER_NOT_IN_BANK: "In ledger, not in bank",
  IN_BANK_NOT_IN_LEDGER: "In bank, not in ledger",
  AMOUNT_MISMATCH: "Amount mismatch",
  DUPLICATE: "Duplicate",
  REVERSAL: "Reversal",
};

function UploadSlot({
  label, hint, accept, state, busy, onPick,
}: {
  label: string; hint: string; accept: string; state: UploadState | null; busy: boolean;
  onPick: (file: File) => void;
}) {
  return (
    <Card className="flex-1">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {label.includes("Bank") ? <FileText className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{state.fileName}</p>
              <p className="text-xs text-muted-foreground">{state.notes}</p>
            </div>
          </div>
        ) : (
          <label className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-5 cursor-pointer hover:border-primary transition-colors ${busy ? "opacity-60 pointer-events-none" : ""}`}>
            {busy ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <UploadIcon className="h-6 w-6 text-muted-foreground" />}
            <span className="text-sm font-medium">{busy ? "Reading with AI…" : "Click to upload"}</span>
            <span className="text-xs text-muted-foreground text-center">{hint}</span>
            <input
              type="file" accept={accept} className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = ""; }}
            />
          </label>
        )}
        {state && state.preview.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded border">
            <table className="w-full text-[11px]">
              <thead><tr className="bg-muted/50 border-b">
                <th className="text-left px-2 py-1">Date</th><th className="text-left px-2 py-1">Description</th>
                <th className="text-right px-2 py-1">Amount</th><th className="text-left px-2 py-1">Dir</th>
              </tr></thead>
              <tbody>
                {state.preview.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1 whitespace-nowrap">{r.date}</td>
                    <td className="px-2 py-1 max-w-[160px] truncate">{r.description}</td>
                    <td className="px-2 py-1 text-right font-mono">{ngn(r.amount)}</td>
                    <td className="px-2 py-1">{r.direction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground px-2 py-1">Showing {Math.min(5, state.preview.length)} of {state.rowCount} — confirm the AI read your file correctly.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SaladAfricaPOC() {
  const [ledger, setLedger] = useState<UploadState | null>(null);
  const [statement, setStatement] = useState<UploadState | null>(null);
  const [busy, setBusy] = useState<"ledger" | "statement" | null>(null);
  const [result, setResult] = useState<any>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const extract = trpc.poc.extract.useMutation();
  const run = trpc.poc.run.useMutation();
  const share = trpc.poc.createShareToken.useMutation();

  const handlePick = async (side: "ledger" | "statement", file: File) => {
    const kind = detectKind(file.name);
    if (!kind) { toast.error("Unsupported file. Use PDF, Excel (.xlsx/.xls) or CSV."); return; }
    setBusy(side);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await extract.mutateAsync({ pocSlug: POC_SLUG, side, fileName: file.name, fileType: kind, contentBase64 });
      const state: UploadState = { uploadId: res.uploadId, rowCount: res.rowCount, notes: res.notes, fileName: file.name, preview: res.preview as any };
      if (side === "ledger") setLedger(state); else setStatement(state);
      if (res.rowCount === 0) toast.warning(res.notes);
      else toast.success(`${file.name}: ${res.rowCount} transactions extracted`);
    } catch (e: any) {
      toast.error(e.message || "Could not read this file.");
    } finally {
      setBusy(null);
    }
  };

  const handleRun = async () => {
    if (!ledger || !statement) return;
    setResult(null); setShareUrl(null);
    try {
      const res = await run.mutateAsync({ pocSlug: POC_SLUG, ledgerUploadId: ledger.uploadId, statementUploadId: statement.uploadId });
      setResult(res);
      toast.success("Reconciliation complete");
    } catch (e: any) {
      toast.error(e.message || "Reconciliation failed.");
    }
  };

  const handleShare = async () => {
    if (!result) return;
    try {
      const { token } = await share.mutateAsync({ pocSlug: POC_SLUG, runId: result.runId });
      const url = `${window.location.origin}/poc-report/${token}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(true); setTimeout(() => setCopied(false), 2000);
      toast.success("Share link copied to clipboard");
    } catch (e: any) {
      toast.error(e.message || "Could not create share link.");
    }
  };

  const l1 = result?.layer1;
  const exceptions = (result?.layer3 ?? []) as any[];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Branding banner */}
      <div className="bg-gradient-to-r from-emerald-700 via-green-600 to-lime-600 px-6 py-3 flex items-center gap-4">
        <Sparkles className="h-6 w-6 text-white" />
        <div>
          <p className="text-white text-sm font-semibold leading-none">Salad Africa — AI Reconciliation POC</p>
          <p className="text-green-100 text-xs mt-0.5">Powered by ReconcileAI · Ledger vs Bank Statement · Confidential</p>
        </div>
        <span className="ml-auto text-xs text-green-50 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">POC Environment</span>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reconcile your ledger against your bank statement</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload your two files in any format — Excel, CSV, or PDF (even a scan). Our AI extracts the
            transactions, then reconciles them and explains every difference.
          </p>
        </div>

        {/* Upload slots */}
        <div className="flex flex-col md:flex-row gap-4">
          <UploadSlot label="Your Ledger / Cashbook" hint="Excel, CSV (your internal record)" accept=".xlsx,.xls,.csv,.txt"
            state={ledger} busy={busy === "ledger"} onPick={(f) => handlePick("ledger", f)} />
          <UploadSlot label="Bank Statement" hint="PDF, Excel, CSV — scans are fine" accept=".pdf,.xlsx,.xls,.csv,.txt"
            state={statement} busy={busy === "statement"} onPick={(f) => handlePick("statement", f)} />
        </div>

        {/* Run */}
        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={!ledger || !statement || run.isPending} className="gap-2">
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run reconciliation
          </Button>
          {(!ledger || !statement) && <span className="text-xs text-muted-foreground">Upload both files to run.</span>}
        </div>

        {/* Results */}
        {result && (
          <Tabs defaultValue="balance" className="mt-2">
            <TabsList>
              <TabsTrigger value="balance" className="gap-1.5"><Scale className="h-4 w-4" /> Balance</TabsTrigger>
              <TabsTrigger value="exceptions" className="gap-1.5"><AlertTriangle className="h-4 w-4" /> Exceptions ({exceptions.length})</TabsTrigger>
              <TabsTrigger value="agent" className="gap-1.5"><Bot className="h-4 w-4" /> AI Agent</TabsTrigger>
            </TabsList>

            {/* Layer 1 */}
            <TabsContent value="balance" className="space-y-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold">Layer 1 — Balance</h3>
                    <Badge className={l1.status === "BALANCED" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}>
                      {l1.status === "BALANCED" ? "Balanced" : "Variance detected"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <Stat label="Ledger transactions" value={l1.ledgerCount} />
                    <Stat label="Statement transactions" value={l1.statementCount} />
                    <Stat label="Matched" value={result.matchedCount} />
                    <Stat label="Ledger net" value={ngn(l1.ledgerNet)} />
                    <Stat label="Statement net" value={ngn(l1.statementNet)} />
                    <Stat label="Variance" value={ngn(l1.varianceAmount)} highlight={l1.status !== "BALANCED"} />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Layer 2 / 3 list */}
            <TabsContent value="exceptions" className="space-y-3">
              {exceptions.length === 0 ? (
                <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" /> No exceptions — everything reconciled.
                </CardContent></Card>
              ) : exceptions.map((e, i) => <ExceptionCard key={i} e={e} />)}
            </TabsContent>

            <TabsContent value="agent" className="space-y-3">
              {exceptions.map((e, i) => <ExceptionCard key={i} e={e} showAgent />)}
            </TabsContent>
          </Tabs>
        )}

        {/* Share */}
        {result && (
          <div className="flex items-center gap-3 pt-2">
            <Button variant="outline" className="gap-2" onClick={handleShare} disabled={share.isPending}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {shareUrl ? "Copy share link again" : "Create shareable link"}
            </Button>
            {shareUrl && <span className="text-xs text-muted-foreground truncate max-w-[420px]">{shareUrl}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-red-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

function ExceptionCard({ e, showAgent }: { e: any; showAgent?: boolean }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline">{CATEGORY_LABELS[e.category] ?? e.category}</Badge>
              <Badge className={PRIORITY_COLORS[e.priorityLevel] ?? ""}>{e.priorityLevel}</Badge>
              <span className="text-xs text-muted-foreground">{e.side}</span>
            </div>
            <p className="text-sm mt-1 truncate">{e.description || e.reference || "—"}</p>
            <p className="text-xs text-muted-foreground">{e.txnDate}{e.reference ? ` · ${e.reference}` : ""}</p>
            {showAgent && (
              <div className="mt-2 space-y-1">
                <p className="text-xs"><span className="font-medium">Why: </span>{e.agentExplanation}</p>
                <p className="text-xs"><span className="font-medium text-emerald-700">Recommended: </span>{e.recommendedAction}</p>
              </div>
            )}
          </div>
          <span className="font-mono text-sm font-semibold shrink-0">{ngn(e.amount)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
