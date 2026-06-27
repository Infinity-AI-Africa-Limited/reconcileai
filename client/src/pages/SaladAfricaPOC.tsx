/**
 * ReconcileAI — Salad Africa POC (public, no login).
 *
 * Self-service: upload a ledger (Excel/CSV) + a bank statement (Excel/CSV),
 * transactions are extracted directly from the structured file, then the
 * 3-layer engine reconciles them. Results are stored and shareable.
 *
 * Enhanced UX:
 *  - Drag-and-drop with animated border, overlay, and file-type icon feedback
 *  - Multi-stage parsing progress bar (Reading → Extracting → Verifying)
 *  - Smooth transitions between idle / dragging / uploading / done states
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, Upload as UploadIcon, FileSpreadsheet, FileText, CheckCircle2,
  Play, Scale, AlertTriangle, Bot, Copy, Check, Sparkles, X,
  File as FileIcon,
} from "lucide-react";
import { toast } from "sonner";

const POC_SLUG = "salad_africa";

// Stable anonymous visitor ID for this browser session — no PII, only used to
// correlate uploads from the same session in the owner notification / POC Hub.
function getVisitorId(): string {
  const key = "salad_africa_poc_visitor_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    sessionStorage.setItem(key, id);
  }
  return id;
}

type FileKind = "excel" | "csv";
type UploadState = {
  uploadId: number;
  rowCount: number;
  notes: string;
  fileName: string;
  preview: Array<{ date: string; description: string; amount: number; direction: string; reference?: string }>;
};

// Multi-stage progress: each stage has a label and a target % to animate to
type ParseStage = "idle" | "reading" | "extracting" | "verifying" | "done" | "error";
const STAGE_LABELS: Record<ParseStage, string> = {
  idle: "",
  reading: "Reading file…",
  extracting: "Extracting transactions…",
  verifying: "Verifying data…",
  done: "Done",
  error: "Failed",
};
const STAGE_PROGRESS: Record<ParseStage, number> = {
  idle: 0,
  reading: 20,
  extracting: 65,
  verifying: 90,
  done: 100,
  error: 100,
};

function detectKind(name: string): FileKind | null {
  const n = name.toLowerCase();
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

function getFileIcon(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return FileSpreadsheet;
  return FileIcon;
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

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ stage, fileName }: { stage: ParseStage; fileName?: string }) {
  const [displayPct, setDisplayPct] = useState(0);
  const targetPct = STAGE_PROGRESS[stage];

  useEffect(() => {
    if (stage === "idle") { setDisplayPct(0); return; }
    // Animate toward target
    const interval = setInterval(() => {
      setDisplayPct((prev) => {
        if (prev >= targetPct) { clearInterval(interval); return targetPct; }
        const step = Math.max(1, Math.ceil((targetPct - prev) / 8));
        return Math.min(prev + step, targetPct);
      });
    }, 40);
    return () => clearInterval(interval);
  }, [stage, targetPct]);

  if (stage === "idle" || stage === "done") return null;

  const isError = stage === "error";
  const barColor = isError
    ? "bg-red-500"
    : stage === "verifying"
    ? "bg-emerald-500"
    : "bg-emerald-600";

  return (
    <div className="mt-3 space-y-1.5">
      {fileName && (
        <p className="text-xs text-muted-foreground truncate max-w-full">
          {fileName}
        </p>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${displayPct}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums w-7 text-right shrink-0">
          {displayPct}%
        </span>
      </div>
      <p className={`text-xs font-medium flex items-center gap-1.5 ${isError ? "text-red-600" : "text-emerald-700"}`}>
        {!isError && <Loader2 className="h-3 w-3 animate-spin" />}
        {STAGE_LABELS[stage]}
      </p>
    </div>
  );
}

// ─── Upload Slot ──────────────────────────────────────────────────────────────
function UploadSlot({
  label, hint, accept, state, stage, pendingFileName, onPick, onClear,
}: {
  label: string;
  hint: string;
  accept: string;
  state: UploadState | null;
  stage: ParseStage;
  pendingFileName?: string;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragFileName, setDragFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isBusy = stage !== "idle" && stage !== "done" && stage !== "error";

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (isBusy || state) return;
    const file = e.dataTransfer.items?.[0];
    setDragFileName(file?.getAsFile()?.name ?? null);
    setIsDragOver(true);
  }, [isBusy, state]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    // Only leave if we exit the drop zone entirely (not a child element)
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDragFileName(null);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragOver(false); setDragFileName(null);
    if (isBusy || state) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onPick(file);
  }, [isBusy, state, onPick]);

  const isBank = label.toLowerCase().includes("bank");
  const DefaultIcon = isBank ? FileText : FileSpreadsheet;

  // Determine icon for dragged file
  const DragIcon = dragFileName ? getFileIcon(dragFileName) : DefaultIcon;

  return (
    <Card className="flex-1 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <DefaultIcon className="h-4 w-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state ? (
          /* ── Done state (success when rows were found, warning when none) ── */
          <div className="space-y-3">
            <div className={[
              "flex items-start gap-3 rounded-lg border p-3",
              state.rowCount > 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50",
            ].join(" ")}>
              {state.rowCount > 0 ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{state.fileName}</p>
                <p className={[
                  "text-xs mt-0.5",
                  state.rowCount > 0 ? "text-muted-foreground" : "text-amber-700",
                ].join(" ")}>{state.notes}</p>
              </div>
              <button
                onClick={onClear}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                title="Remove file"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {state.preview.length > 0 && (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left px-2 py-1">Date</th>
                      <th className="text-left px-2 py-1">Description</th>
                      <th className="text-right px-2 py-1">Amount</th>
                      <th className="text-left px-2 py-1">Dir</th>
                    </tr>
                  </thead>
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
                <p className="text-[10px] text-muted-foreground px-2 py-1">
                  Showing {Math.min(5, state.preview.length)} of {state.rowCount} — confirm the AI read your file correctly.
                </p>
              </div>
            )}
          </div>
        ) : (
          /* ── Upload / drag-drop zone ── */
          <div
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="relative"
          >
            <label
              className={[
                "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-all duration-200 select-none",
                isBusy
                  ? "opacity-70 pointer-events-none border-emerald-300 bg-emerald-50/40"
                  : isDragOver
                  ? "border-emerald-500 bg-emerald-50 scale-[1.01] shadow-sm"
                  : "border-gray-200 hover:border-emerald-400 hover:bg-gray-50",
              ].join(" ")}
            >
              {/* Icon area */}
              <div className={[
                "flex items-center justify-center w-12 h-12 rounded-full transition-all duration-200",
                isDragOver ? "bg-emerald-100 scale-110" : "bg-gray-100",
              ].join(" ")}>
                {isBusy ? (
                  <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
                ) : isDragOver ? (
                  <DragIcon className="h-6 w-6 text-emerald-600" />
                ) : (
                  <UploadIcon className="h-6 w-6 text-gray-400" />
                )}
              </div>

              {/* Label */}
              <div className="text-center">
                {isDragOver ? (
                  <>
                    <p className="text-sm font-semibold text-emerald-700">Drop to upload</p>
                    {dragFileName && (
                      <p className="text-xs text-emerald-600 mt-0.5 truncate max-w-[180px]">{dragFileName}</p>
                    )}
                  </>
                ) : isBusy ? (
                  <p className="text-sm font-medium text-emerald-700">{STAGE_LABELS[stage]}</p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-gray-700">
                      Drag & drop or <span className="text-emerald-600 underline underline-offset-2">browse</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
                  </>
                )}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept={accept}
                className="hidden"
                disabled={isBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPick(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>

            {/* Drag-over overlay glow ring */}
            {isDragOver && (
              <div className="absolute inset-0 rounded-lg ring-2 ring-emerald-400 ring-offset-1 pointer-events-none" />
            )}

            {/* Progress bar — shown while busy */}
            <ProgressBar stage={stage} fileName={pendingFileName} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SaladAfricaPOC() {
  const [ledger, setLedger] = useState<UploadState | null>(null);
  const [statement, setStatement] = useState<UploadState | null>(null);
  const [ledgerStage, setLedgerStage] = useState<ParseStage>("idle");
  const [statementStage, setStatementStage] = useState<ParseStage>("idle");
  const [ledgerPendingName, setLedgerPendingName] = useState<string | undefined>();
  const [statementPendingName, setStatementPendingName] = useState<string | undefined>();
  const [result, setResult] = useState<any>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const extract = trpc.poc.extract.useMutation();
  const run = trpc.poc.run.useMutation();
  const share = trpc.poc.createShareToken.useMutation();
  const saveFile = trpc.poc.saveFile.useMutation();

  const setStage = (side: "ledger" | "statement", s: ParseStage) => {
    if (side === "ledger") setLedgerStage(s);
    else setStatementStage(s);
  };

  const handlePick = async (side: "ledger" | "statement", file: File) => {
    const kind = detectKind(file.name);
    if (!kind) {
      toast.error("Unsupported file. Please upload Excel (.xlsx/.xls) or CSV.");
      return;
    }

    // Track pending file name for progress bar
    if (side === "ledger") setLedgerPendingName(file.name);
    else setStatementPendingName(file.name);

    setStage(side, "reading");

    try {
      // Stage 1: Read file locally
      const contentBase64 = await fileToBase64(file);

      // Save the raw file anonymously to S3 + notify the owner (fire-and-forget;
      // never block or fail the user's extraction over archival/notification).
      saveFile.mutateAsync({
        pocSlug: POC_SLUG,
        fileRole: side === "ledger" ? "cbs" : "statement",
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        dataBase64: contentBase64,
        visitorId: getVisitorId(),
        userAgent: navigator.userAgent.slice(0, 512),
      }).catch(() => {/* swallow — archival/notification must never block the user */});

      // Stage 2: AI extraction (server call)
      setStage(side, "extracting");
      const res = await extract.mutateAsync({
        pocSlug: POC_SLUG,
        side,
        fileName: file.name,
        fileType: kind,
        contentBase64,
      });

      // Stage 3: Brief verification stage for UX
      setStage(side, "verifying");
      await new Promise((r) => setTimeout(r, 400));

      const state: UploadState = {
        uploadId: res.uploadId,
        rowCount: res.rowCount,
        notes: res.notes,
        fileName: file.name,
        preview: res.preview as any,
      };

      setStage(side, "done");
      if (side === "ledger") setLedger(state);
      else setStatement(state);

      if (res.rowCount === 0) toast.warning(res.notes);
      else toast.success(`${file.name}: ${res.rowCount} transactions extracted`);
    } catch (e: any) {
      setStage(side, "error");
      toast.error(e.message || "Could not read this file.");
      // Reset after showing error briefly
      await new Promise((r) => setTimeout(r, 1800));
      setStage(side, "idle");
    } finally {
      if (side === "ledger") setLedgerPendingName(undefined);
      else setStatementPendingName(undefined);
    }
  };

  const handleClear = (side: "ledger" | "statement") => {
    if (side === "ledger") { setLedger(null); setLedgerStage("idle"); }
    else { setStatement(null); setStatementStage("idle"); }
    setResult(null); setShareUrl(null);
  };

  const handleRun = async () => {
    if (!ledger || !statement) return;
    setResult(null); setShareUrl(null);
    try {
      const res = await run.mutateAsync({
        pocSlug: POC_SLUG,
        ledgerUploadId: ledger.uploadId,
        statementUploadId: statement.uploadId,
      });
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
        <span className="ml-auto text-xs text-green-50 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">
          POC Environment
        </span>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reconcile your ledger against your bank statement</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload your two files as Excel (.xlsx/.xls) or CSV. We read the transactions directly,
            reconcile them, and explain every difference.
          </p>
        </div>

        {/* Upload slots */}
        <div className="flex flex-col md:flex-row gap-4">
          <UploadSlot
            label="Your Ledger / Cashbook"
            hint="Excel, CSV (your internal record)"
            accept=".xlsx,.xls,.csv,.txt"
            state={ledger}
            stage={ledgerStage}
            pendingFileName={ledgerPendingName}
            onPick={(f) => handlePick("ledger", f)}
            onClear={() => handleClear("ledger")}
          />
          <UploadSlot
            label="Bank Statement"
            hint="Excel, CSV (export from your bank)"
            accept=".xlsx,.xls,.csv,.txt"
            state={statement}
            stage={statementStage}
            pendingFileName={statementPendingName}
            onPick={(f) => handlePick("statement", f)}
            onClear={() => handleClear("statement")}
          />
        </div>

        {/* Run */}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleRun}
            disabled={!ledger || !statement || !ledger.rowCount || !statement.rowCount || run.isPending}
            className="gap-2 bg-emerald-700 hover:bg-emerald-800"
          >
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run reconciliation
          </Button>
          {(!ledger || !statement) && (
            <span className="text-xs text-muted-foreground">Upload both files to run.</span>
          )}
          {ledger && statement && (!ledger.rowCount || !statement.rowCount) && (
            <span className="text-xs text-amber-700">
              No transactions were read from the {!ledger.rowCount && !statement.rowCount ? "uploaded files" : !statement.rowCount ? "bank statement" : "ledger"}. Re-upload before running.
            </span>
          )}
          {run.isPending && (
            <span className="text-xs text-emerald-700 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Running 3-layer reconciliation engine…
            </span>
          )}
        </div>

        {/* Results */}
        {result && (
          <Tabs defaultValue="balance" className="mt-2">
            <TabsList>
              <TabsTrigger value="balance" className="gap-1.5">
                <Scale className="h-4 w-4" /> Balance
              </TabsTrigger>
              <TabsTrigger value="exceptions" className="gap-1.5">
                <AlertTriangle className="h-4 w-4" /> Exceptions ({exceptions.length})
              </TabsTrigger>
              <TabsTrigger value="agent" className="gap-1.5">
                <Bot className="h-4 w-4" /> AI Agent
              </TabsTrigger>
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

            {/* Layer 2 */}
            <TabsContent value="exceptions" className="space-y-3">
              {exceptions.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-sm text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                    No exceptions — everything reconciled.
                  </CardContent>
                </Card>
              ) : (
                exceptions.map((e, i) => <ExceptionCard key={i} e={e} />)
              )}
            </TabsContent>

            {/* Layer 3 */}
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
            {shareUrl && (
              <span className="text-xs text-muted-foreground truncate max-w-[420px]">{shareUrl}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
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
