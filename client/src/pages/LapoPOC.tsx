/**
 * ReconcileAI — LAPO MFB × Interswitch Card Settlement POC (public, no login).
 *
 * Demonstrates CBS vs Interswitch card settlement reconciliation for LAPO MFB.
 * Supports:
 *   • Pre-loaded demo dataset (LAPO CBS ledger + Interswitch settlement file)
 *   • Self-service upload (drag-and-drop, Excel/CSV/PDF, AI extraction)
 *   • 3-layer reconciliation engine (Balance → Exception → AI Agent)
 *   • Card-specific exception categories (chargeback, settlement shortfall, etc.)
 *   • Exception review & resolution workflow (OPEN → IN_REVIEW → RESOLVED | ESCALATED)
 *   • Resolution progress tracker with live stats
 *   • Shareable public report link
 *   • Interswitch column-mapping reference for analysts
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Upload as UploadIcon, FileSpreadsheet, FileText, CheckCircle2,
  Play, Scale, AlertTriangle, Bot, Copy, Check, CreditCard,
  FileImage, File as FileIcon, X, Download, Info, ChevronDown, ChevronUp,
  ClipboardCheck, MessageSquare, ChevronRight, CircleCheck, CircleAlert,
  ArrowUpRight, RotateCcw, Filter,
} from "lucide-react";
import { toast } from "sonner";

// ─── LAPO MFB Brand Tokens (extracted from https://www.lapo-nigeria.org/) ────
const LAPO_GREEN        = "#00954B"; // Primary brand green
const LAPO_DARK_GREEN   = "#0E3622"; // Deep accent
const LAPO_FOREST       = "#34423B"; // Body text / dark surfaces
const LAPO_ORANGE       = "#E78020"; // Accent / highlights
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LAPO_LIGHT_ORANGE = "#F99650"; // Secondary accent
const LAPO_LOGO_URL     = "/lapo_logo.svg";

// Inject Hanken Grotesk + Inter from Google Fonts if not already loaded
if (typeof document !== "undefined" && !document.getElementById("lapo-fonts")) {
  const link = document.createElement("link");
  link.id = "lapo-fonts";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Inter:wght@400;500;600&display=swap";
  document.head.appendChild(link);
}

const POC_SLUG = "lapo_mfb";

// ─── Types ────────────────────────────────────────────────────────────────────
type FileKind = "pdf" | "excel" | "csv";
type UploadState = {
  uploadId: number;
  rowCount: number;
  notes: string;
  fileName: string;
  preview: Array<{ date: string; description: string; amount: number; direction: string; reference?: string }>;
};
type ParseStage = "idle" | "reading" | "extracting" | "verifying" | "done" | "error";
type ReviewStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "ESCALATED";

// ─── Card-specific exception categories ──────────────────────────────────────
const CARD_CATEGORY_LABELS: Record<string, string> = {
  IN_LEDGER_NOT_IN_BANK:    "In CBS, not in Interswitch",
  IN_BANK_NOT_IN_LEDGER:    "In Interswitch, not in CBS",
  AMOUNT_MISMATCH:          "Amount mismatch",
  DUPLICATE:                "Duplicate RRN",
  REVERSAL:                 "Reversal / net-off",
  CHARGEBACK:               "Chargeback",
  SETTLEMENT_SHORTFALL:     "Settlement shortfall",
  LATE_PRESENTMENT:         "Late presentment",
  INTERCHANGE_DISPUTE:      "Interchange fee dispute",
  SCHEME_FEE_VARIANCE:      "Scheme fee variance",
  FORCE_POST:               "Force-post / offline txn",
  PARTIAL_REVERSAL:         "Partial reversal",
};

const CARD_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  CHARGEBACK:           "Customer or issuer has disputed the transaction. CBS shows a debit reversal; Interswitch has not yet reflected it.",
  SETTLEMENT_SHORTFALL: "Interswitch settled less than the CBS-posted amount — typically due to interchange or scheme fee deductions.",
  LATE_PRESENTMENT:     "Transaction date in CBS is outside the Interswitch settlement window (>3 days). May incur late-presentment fees.",
  INTERCHANGE_DISPUTE:  "Interchange fee applied by Interswitch does not match the expected rate for this card type / merchant category.",
  SCHEME_FEE_VARIANCE:  "Visa/Mastercard/Verve scheme fee differs from the contracted rate.",
  FORCE_POST:           "Offline / force-posted transaction — approved without authorisation. Higher chargeback risk.",
  PARTIAL_REVERSAL:     "Only part of the original transaction was reversed. Ensure the net amount is correctly reflected in CBS.",
  IN_LEDGER_NOT_IN_BANK: "CBS posted this card credit but Interswitch has not included it in the settlement file.",
  IN_BANK_NOT_IN_LEDGER: "Interswitch settled this amount but CBS has no matching posting.",
  AMOUNT_MISMATCH:       "A matching RRN was found but the amounts differ — check interchange/scheme fee deductions or a keying error.",
  DUPLICATE:             "The same RRN appears more than once in the Interswitch file — only one should be settled.",
  REVERSAL:              "Reversal pair found. Confirm both legs are recorded and net to zero.",
};

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  HIGH:     "bg-orange-100 text-orange-700",
  MEDIUM:   "bg-amber-100 text-amber-700",
  LOW:      "bg-gray-100 text-gray-600",
};

const REVIEW_STATUS_CONFIG: Record<ReviewStatus, { label: string; color: string; icon: React.ElementType }> = {
  OPEN:         { label: "Open",        color: "bg-red-100 text-red-700 border-red-200",       icon: CircleAlert },
  ACKNOWLEDGED: { label: "In Review",   color: "bg-amber-100 text-amber-700 border-amber-200", icon: MessageSquare },
  RESOLVED:     { label: "Resolved",    color: "bg-green-100 text-green-700 border-green-200", icon: CircleCheck },
  ESCALATED:    { label: "Escalated",   color: "bg-purple-100 text-purple-700 border-purple-200", icon: ArrowUpRight },
};

// ─── Interswitch column mapping reference ─────────────────────────────────────
const ISW_COLUMNS = [
  { field: "Settlement Date",             maps: "Value Date in CBS",          required: true  },
  { field: "Transaction Date",            maps: "Transaction Date in CBS",     required: true  },
  { field: "RRN",                         maps: "Reference / RRN in CBS",      required: true  },
  { field: "STAN",                        maps: "System Trace Audit Number",   required: false },
  { field: "Terminal ID",                 maps: "Terminal ID",                 required: false },
  { field: "Merchant Name",               maps: "Narration / Description",     required: false },
  { field: "Card Type",                   maps: "Card Type (VERVE/MC/VISA)",   required: false },
  { field: "PAN",                         maps: "PAN (masked)",                required: false },
  { field: "Transaction Amount (NGN)",    maps: "Gross amount",                required: true  },
  { field: "Settlement Amount (NGN)",     maps: "Settlement amount",           required: true  },
  { field: "Interchange Fee (NGN)",       maps: "Interchange fee deducted",    required: false },
  { field: "Scheme Fee (NGN)",            maps: "Scheme fee deducted",         required: false },
  { field: "Net Settlement (NGN)",        maps: "Amount CBS should receive",   required: true  },
  { field: "Response Code",               maps: "00 = approved",               required: false },
  { field: "Transaction Type",            maps: "PURCHASE / REVERSAL",         required: false },
];

const CBS_COLUMNS = [
  { field: "Transaction Date",  maps: "Transaction Date",           required: true  },
  { field: "Value Date",        maps: "Value Date",                 required: true  },
  { field: "Narration",         maps: "Description / Merchant",     required: false },
  { field: "Reference",         maps: "RRN / instrument number",    required: true  },
  { field: "Debit (NGN)",       maps: "Debit amount (reversals)",   required: false },
  { field: "Credit (NGN)",      maps: "Credit amount (settlements)",required: true  },
  { field: "Balance (NGN)",     maps: "Running balance",            required: false },
  { field: "Channel",           maps: "CARD",                       required: false },
  { field: "Card Type",         maps: "VERVE / MASTERCARD / VISA",  required: false },
  { field: "Terminal ID",       maps: "Terminal ID",                required: false },
  { field: "PAN (masked)",      maps: "Masked PAN",                 required: false },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
function getFileIcon(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return FileText;
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return FileSpreadsheet;
  if (n.endsWith(".png") || n.endsWith(".jpg")) return FileImage;
  return FileIcon;
}
const ngn = (n: number | string) =>
  `₦${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STAGE_LABELS: Record<ParseStage, string> = {
  idle: "", reading: "Reading file…", extracting: "AI extracting transactions…",
  verifying: "Verifying data…", done: "Done", error: "Failed",
};
const STAGE_PROGRESS: Record<ParseStage, number> = {
  idle: 0, reading: 20, extracting: 65, verifying: 90, done: 100, error: 100,
};

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ stage, fileName }: { stage: ParseStage; fileName?: string }) {
  const [displayPct, setDisplayPct] = useState(0);
  const targetPct = STAGE_PROGRESS[stage];
  useEffect(() => {
    if (stage === "idle") { setDisplayPct(0); return; }
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
  return (
    <div className="mt-3 space-y-1.5">
      {fileName && <p className="text-xs text-muted-foreground truncate">{fileName}</p>}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-300 ${isError ? "bg-red-500" : stage === "verifying" ? "bg-blue-500" : "bg-blue-600"}`}
            style={{ width: `${displayPct}%` }} />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums w-7 text-right shrink-0">{displayPct}%</span>
      </div>
      <p className={`text-xs font-medium flex items-center gap-1.5 ${isError ? "text-red-600" : "text-blue-700"}`}>
        {!isError && <Loader2 className="h-3 w-3 animate-spin" />}
        {STAGE_LABELS[stage]}
      </p>
    </div>
  );
}

// ─── Upload Slot ──────────────────────────────────────────────────────────────
function UploadSlot({
  label, hint, accept, state, stage, pendingFileName, onPick, onClear,
  demoFileName, onLoadDemo,
}: {
  label: string; hint: string; accept: string;
  state: UploadState | null; stage: ParseStage; pendingFileName?: string;
  onPick: (file: File) => void; onClear: () => void;
  demoFileName: string; onLoadDemo: () => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragFileName, setDragFileName] = useState<string | null>(null);
  const isBusy = stage !== "idle" && stage !== "done" && stage !== "error";
  const isCBS = label.toLowerCase().includes("cbs");

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (isBusy || state) return;
    setDragFileName(e.dataTransfer.items?.[0]?.getAsFile()?.name ?? null);
    setIsDragOver(true);
  }, [isBusy, state]);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setIsDragOver(false); setDragFileName(null);
    }
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragOver(false); setDragFileName(null);
    if (isBusy || state) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onPick(file);
  }, [isBusy, state, onPick]);

  const DefaultIcon = isCBS ? FileSpreadsheet : FileText;
  const DragIcon = dragFileName ? getFileIcon(dragFileName) : DefaultIcon;

  return (
    <Card className="flex-1 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <DefaultIcon className="h-4 w-4 text-blue-700" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
              <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{state.fileName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{state.notes}</p>
              </div>
              <button onClick={onClear} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors" title="Remove file">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {state.preview.length > 0 && (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-[11px]">
                  <thead><tr className="bg-muted/50 border-b">
                    <th className="text-left px-2 py-1">Date</th>
                    <th className="text-left px-2 py-1">Description</th>
                    <th className="text-right px-2 py-1">Amount</th>
                    <th className="text-left px-2 py-1">Dir</th>
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
                <p className="text-[10px] text-muted-foreground px-2 py-1">
                  Showing {Math.min(5, state.preview.length)} of {state.rowCount}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop} className="relative space-y-2">
            <label className={[
              "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-all duration-200 select-none",
              isBusy ? "opacity-70 pointer-events-none border-blue-300 bg-blue-50/40"
                : isDragOver
                  ? "border-blue-500 bg-blue-50 scale-[1.01] ring-2 ring-blue-300"
                  : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/30",
            ].join(" ")}>
              <input type="file" accept={accept} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} disabled={isBusy} />
              {isDragOver ? (
                <>
                  <DragIcon className="h-8 w-8 text-blue-500" />
                  <p className="text-sm font-medium text-blue-700">Drop to upload</p>
                  {dragFileName && <p className="text-xs text-blue-500 truncate max-w-[180px]">{dragFileName}</p>}
                </>
              ) : (
                <>
                  <UploadIcon className="h-7 w-7 text-gray-400" />
                  <p className="text-sm text-gray-600">Drag & drop or <span className="text-blue-600 font-medium">browse</span></p>
                  <p className="text-xs text-muted-foreground text-center">{hint}</p>
                </>
              )}
            </label>
            <ProgressBar stage={stage} fileName={pendingFileName} />
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <Button variant="outline" size="sm" className="w-full gap-2 text-xs border-blue-200 text-blue-700 hover:bg-blue-50" onClick={onLoadDemo} disabled={isBusy}>
              <Download className="h-3.5 w-3.5" /> Load demo dataset
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Column Mapping Reference ─────────────────────────────────────────────────
function ColumnMappingRef() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-white">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
        <span className="flex items-center gap-2"><Info className="h-4 w-4 text-blue-600" /> Interswitch column mapping reference</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-4 pb-4 grid md:grid-cols-2 gap-4 border-t pt-4">
          <div>
            <p className="text-xs font-semibold text-blue-800 mb-2">Interswitch Settlement File</p>
            <div className="overflow-x-auto rounded border bg-white">
              <table className="w-full text-[11px]">
                <thead><tr className="bg-muted/50 border-b">
                  <th className="text-left px-2 py-1">Column</th>
                  <th className="text-left px-2 py-1">Maps to</th>
                  <th className="text-center px-2 py-1">Req</th>
                </tr></thead>
                <tbody>
                  {ISW_COLUMNS.map((c, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1 font-mono text-blue-700">{c.field}</td>
                      <td className="px-2 py-1 text-muted-foreground">{c.maps}</td>
                      <td className="px-2 py-1 text-center">{c.required ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-blue-800 mb-2">CBS Card Settlement GL</p>
            <div className="overflow-x-auto rounded border bg-white">
              <table className="w-full text-[11px]">
                <thead><tr className="bg-muted/50 border-b">
                  <th className="text-left px-2 py-1">Column</th>
                  <th className="text-left px-2 py-1">Maps to</th>
                  <th className="text-center px-2 py-1">Req</th>
                </tr></thead>
                <tbody>
                  {CBS_COLUMNS.map((c, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1 font-mono text-blue-700">{c.field}</td>
                      <td className="px-2 py-1 text-muted-foreground">{c.maps}</td>
                      <td className="px-2 py-1 text-center">{c.required ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              Download sample files above to see the expected format. The AI extractor handles non-standard layouts automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Resolution Progress Tracker ─────────────────────────────────────────────
function ResolutionTracker({ statuses }: { statuses: Record<string, ReviewStatus> }) {
  const all = Object.values(statuses);
  const total = all.length;
  if (total === 0) return null;
  const resolved  = all.filter((s) => s === "RESOLVED").length;
  const inReview  = all.filter((s) => s === "ACKNOWLEDGED").length;
  const escalated = all.filter((s) => s === "ESCALATED").length;
  const open      = all.filter((s) => s === "OPEN").length;
  const pct = Math.round((resolved / total) * 100);

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-blue-700" />
          <span className="text-sm font-semibold text-gray-800">Resolution Progress</span>
        </div>
        <span className="text-sm font-bold text-gray-900">{resolved}/{total} resolved</span>
      </div>
      {/* Progress bar */}
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-green-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {/* Breakdown pills */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
          <CircleAlert className="h-3 w-3" /> {open} open
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
          <MessageSquare className="h-3 w-3" /> {inReview} in review
        </span>
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
          <CircleCheck className="h-3 w-3" /> {resolved} resolved
        </span>
        {escalated > 0 && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
            <ArrowUpRight className="h-3 w-3" /> {escalated} escalated
          </span>
        )}
      </div>
      {resolved === total && (
        <p className="text-xs font-medium text-green-700 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" /> All exceptions resolved — reconciliation complete.
        </p>
      )}
    </div>
  );
}

// ─── Exception Review Card ────────────────────────────────────────────────────
function ExceptionReviewCard({
  e, index, status, onStatusChange, showAgent,
}: {
  e: any;
  index: number;
  status: ReviewStatus;
  onStatusChange: (id: string, status: ReviewStatus, note: string, reviewer: string) => void;
  showAgent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [saving, setSaving] = useState(false);

  const catLabel = CARD_CATEGORY_LABELS[e.category] ?? e.category;
  const catDesc  = CARD_CATEGORY_DESCRIPTIONS[e.category];
  const statusCfg = REVIEW_STATUS_CONFIG[status];
  const StatusIcon = statusCfg.icon;

  const handleAction = async (newStatus: ReviewStatus) => {
    setSaving(true);
    await onStatusChange(String(index), newStatus, note, reviewer);
    setSaving(false);
    if (newStatus !== "ACKNOWLEDGED") setExpanded(false);
  };

  return (
    <Card className={`overflow-hidden transition-all duration-200 ${status === "RESOLVED" ? "opacity-70" : ""}`}>
      {/* Status accent bar */}
      <div className={`h-1 ${
        status === "RESOLVED" ? "bg-green-500" :
        status === "ACKNOWLEDGED" ? "bg-amber-400" :
        status === "ESCALATED" ? "bg-purple-500" : "bg-red-400"
      }`} />
      <CardContent className="pt-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="border-blue-300 text-blue-700 text-[11px]">{catLabel}</Badge>
              <Badge className={`text-[11px] ${PRIORITY_COLORS[e.priorityLevel] ?? ""}`}>{e.priorityLevel}</Badge>
              <Badge variant="outline" className={`text-[11px] ${statusCfg.color} flex items-center gap-1`}>
                <StatusIcon className="h-3 w-3" /> {statusCfg.label}
              </Badge>
              <span className="text-xs text-muted-foreground">{e.side}</span>
            </div>
            <p className="text-sm mt-1.5 font-medium truncate">{e.description || e.reference || "—"}</p>
            <p className="text-xs text-muted-foreground">{e.txnDate}{e.reference ? ` · Ref: ${e.reference}` : ""}</p>
            {catDesc && !showAgent && !expanded && (
              <p className="text-xs text-muted-foreground mt-1 italic">{catDesc}</p>
            )}
            {showAgent && !expanded && (
              <div className="mt-2 space-y-1">
                <p className="text-xs"><span className="font-medium">Why: </span>{e.agentExplanation}</p>
                <p className="text-xs"><span className="font-medium text-blue-700">Recommended: </span>{e.recommendedAction}</p>
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-mono text-sm font-semibold">{ngn(e.amount)}</span>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {expanded ? "Collapse" : "Review"}
            </button>
          </div>
        </div>

        {/* Expanded review panel */}
        {expanded && (
          <div className="mt-4 pt-4 border-t space-y-4">
            {/* AI explanation always shown in review panel */}
            <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 space-y-1.5">
              <p className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
                <Bot className="h-3.5 w-3.5" /> AI Agent Analysis
              </p>
              <p className="text-xs text-blue-900">{e.agentExplanation}</p>
              <p className="text-xs"><span className="font-medium text-blue-700">Recommended action: </span>{e.recommendedAction}</p>
              <p className="text-xs text-muted-foreground">Confidence: {e.agentConfidence}%</p>
            </div>

            {/* Reviewer name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-700">Reviewer name (optional)</label>
              <input
                type="text"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                placeholder="e.g. Amaka Obi"
                className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>

            {/* Resolution note */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-700">Resolution note</label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Describe the action taken, e.g. 'Confirmed with Interswitch — fee deduction is within contracted rate. No further action required.'"
                rows={3}
                className="text-xs resize-none"
              />
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {status !== "ACKNOWLEDGED" && (
                <Button size="sm" variant="outline" className="gap-1.5 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => handleAction("ACKNOWLEDGED")} disabled={saving}>
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                  Mark In Review
                </Button>
              )}
              {status !== "RESOLVED" && (
                <Button size="sm" className="gap-1.5 text-xs bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => handleAction("RESOLVED")} disabled={saving}>
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CircleCheck className="h-3 w-3" />}
                  Mark Resolved
                </Button>
              )}
              {status !== "ESCALATED" && (
                <Button size="sm" variant="outline" className="gap-1.5 text-xs border-purple-300 text-purple-700 hover:bg-purple-50"
                  onClick={() => handleAction("ESCALATED")} disabled={saving}>
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpRight className="h-3 w-3" />}
                  Escalate
                </Button>
              )}
              {status !== "OPEN" && (
                <Button size="sm" variant="ghost" className="gap-1.5 text-xs text-muted-foreground hover:text-red-600"
                  onClick={() => handleAction("OPEN")} disabled={saving}>
                  <RotateCcw className="h-3 w-3" /> Reopen
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Stat ─────────────────────────────────────────────────────────────────────
function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-red-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function LapoPOC() {
  const [cbs, setCbs] = useState<UploadState | null>(null);
  const [isw, setIsw] = useState<UploadState | null>(null);
  const [cbsStage, setCbsStage] = useState<ParseStage>("idle");
  const [iswStage, setIswStage] = useState<ParseStage>("idle");
  const [cbsPendingName, setCbsPendingName] = useState<string | undefined>();
  const [iswPendingName, setIswPendingName] = useState<string | undefined>();
  const [result, setResult] = useState<any>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Local review status map: index (string) → ReviewStatus
  // This allows instant UI updates without a round-trip query
  const [reviewStatuses, setReviewStatuses] = useState<Record<string, ReviewStatus>>({});
  const [filterStatus, setFilterStatus] = useState<ReviewStatus | "ALL">("ALL");

  const extract = trpc.poc.extract.useMutation();
  const run     = trpc.poc.run.useMutation();
  const share   = trpc.poc.createShareToken.useMutation();
  const updateStatus = trpc.poc.updateExceptionStatus.useMutation();

  const setStage = (side: "cbs" | "isw", s: ParseStage) => {
    if (side === "cbs") setCbsStage(s); else setIswStage(s);
  };

  const handlePick = async (side: "cbs" | "isw", file: File) => {
    const kind = detectKind(file.name);
    if (!kind) { toast.error("Unsupported file. Use PDF, Excel (.xlsx/.xls) or CSV."); return; }
    if (side === "cbs") setCbsPendingName(file.name); else setIswPendingName(file.name);
    setStage(side, "reading");
    try {
      const contentBase64 = await fileToBase64(file);
      setStage(side, "extracting");
      const res = await extract.mutateAsync({
        pocSlug: POC_SLUG,
        side: side === "cbs" ? "ledger" : "statement",
        fileName: file.name,
        fileType: kind,
        contentBase64,
      });
      setStage(side, "verifying");
      await new Promise((r) => setTimeout(r, 400));
      const state: UploadState = {
        uploadId: res.uploadId, rowCount: res.rowCount,
        notes: res.notes, fileName: file.name, preview: res.preview as any,
      };
      setStage(side, "done");
      if (side === "cbs") setCbs(state); else setIsw(state);
      if (res.rowCount === 0) toast.warning(res.notes);
      else toast.success(`${file.name}: ${res.rowCount} transactions extracted`);
    } catch (e: any) {
      setStage(side, "error");
      toast.error(e.message || "Could not read this file.");
      await new Promise((r) => setTimeout(r, 1800));
      setStage(side, "idle");
    } finally {
      if (side === "cbs") setCbsPendingName(undefined); else setIswPendingName(undefined);
    }
  };

  const handleLoadDemo = async (side: "cbs" | "isw") => {
    const fileName = side === "cbs"
      ? "lapo_cbs_ledger_sample.csv"
      : "lapo_interswitch_settlement_sample.csv";
    try {
      const resp = await fetch(`/${fileName}`);
      if (!resp.ok) throw new Error("Demo file not found");
      const blob = await resp.blob();
      const file = new File([blob], fileName, { type: "text/csv" });
      await handlePick(side, file);
    } catch (e: any) {
      toast.error("Could not load demo file: " + (e.message || "unknown error"));
    }
  };

  const handleClear = (side: "cbs" | "isw") => {
    if (side === "cbs") { setCbs(null); setCbsStage("idle"); }
    else { setIsw(null); setIswStage("idle"); }
    setResult(null); setShareUrl(null); setReviewStatuses({});
  };

  const handleRun = async () => {
    if (!cbs || !isw) return;
    setResult(null); setShareUrl(null); setReviewStatuses({});
    try {
      const res = await run.mutateAsync({
        pocSlug: POC_SLUG,
        ledgerUploadId: cbs.uploadId,
        statementUploadId: isw.uploadId,
        amountTolerance: 0.02,
        dateWindowDays: 5,
      });
      setResult(res);
      // Initialise all exceptions as OPEN
      const initial: Record<string, ReviewStatus> = {};
      (res.layer3 ?? []).forEach((_: any, i: number) => { initial[String(i)] = "OPEN"; });
      setReviewStatuses(initial);
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

  const handleStatusChange = async (id: string, newStatus: ReviewStatus, note: string, reviewer: string) => {
    // Optimistic update
    setReviewStatuses((prev) => ({ ...prev, [id]: newStatus }));
    const exception = (result?.layer3 ?? [])[Number(id)];
    if (!exception?.id) {
      // No DB id yet (in-memory only run) — just update local state
      toast.success(`Exception ${Number(id) + 1} marked as ${REVIEW_STATUS_CONFIG[newStatus].label}`);
      return;
    }
    try {
      await updateStatus.mutateAsync({
        exceptionId: exception.id,
        reviewStatus: newStatus,
        reviewedBy: reviewer || undefined,
        reviewNote: note || undefined,
      });
      toast.success(`Exception marked as ${REVIEW_STATUS_CONFIG[newStatus].label}`);
    } catch (e: any) {
      // Rollback on error
      setReviewStatuses((prev) => ({ ...prev, [id]: "OPEN" }));
      toast.error("Could not save status: " + (e.message || "unknown error"));
    }
  };

  const l1 = result?.layer1;
  const exceptions = (result?.layer3 ?? []) as any[];

  // Exception breakdown by card category
  const byCategory = exceptions.reduce((acc: Record<string, number>, e: any) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});

  // Filtered exceptions for review tab
  const filteredExceptions = filterStatus === "ALL"
    ? exceptions
    : exceptions.filter((_, i) => reviewStatuses[String(i)] === filterStatus);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Branding banner */}
      <div className="bg-gradient-to-r from-[#003087] via-[#0050b3] to-[#1677ff] px-6 py-3 flex items-center gap-4">
        <CreditCard className="h-6 w-6 text-white" />
        <div>
          <p className="text-white text-sm font-semibold leading-none">LAPO MFB — Interswitch Card Settlement POC</p>
          <p className="text-blue-200 text-xs mt-0.5">Powered by ReconcileAI · CBS vs Interswitch · Confidential</p>
        </div>
        <span className="ml-auto text-xs text-blue-50 bg-white/10 px-2.5 py-1 rounded-full border border-white/20">POC Environment</span>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">CBS vs Interswitch Card Settlement Reconciliation</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload your CBS card settlement GL extract and the Interswitch settlement file (CSV or Excel).
            The AI extracts all transactions, then the 3-layer engine reconciles them and flags every
            card-specific exception — chargebacks, shortfalls, late presentments, duplicates, and more.
            Analysts can then review and resolve each exception inline.
          </p>
        </div>

        {/* Column mapping reference */}
        <ColumnMappingRef />

        {/* Upload slots */}
        <div className="flex flex-col md:flex-row gap-4">
          <UploadSlot
            label="CBS Card Settlement GL"
            hint="Excel or CSV export from your core banking system"
            accept=".xlsx,.xls,.csv,.txt"
            state={cbs} stage={cbsStage} pendingFileName={cbsPendingName}
            onPick={(f) => handlePick("cbs", f)} onClear={() => handleClear("cbs")}
            demoFileName="lapo_cbs_ledger_sample.csv"
            onLoadDemo={() => handleLoadDemo("cbs")}
          />
          <UploadSlot
            label="Interswitch Settlement File"
            hint="CSV or Excel from Interswitch portal (ISW format)"
            accept=".xlsx,.xls,.csv,.txt,.pdf"
            state={isw} stage={iswStage} pendingFileName={iswPendingName}
            onPick={(f) => handlePick("isw", f)} onClear={() => handleClear("isw")}
            demoFileName="lapo_interswitch_settlement_sample.csv"
            onLoadDemo={() => handleLoadDemo("isw")}
          />
        </div>

        {/* Run */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={handleRun} disabled={!cbs || !isw || run.isPending}
            className="gap-2 bg-[#003087] hover:bg-[#002060]">
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run reconciliation
          </Button>
          {(!cbs || !isw) && <span className="text-xs text-muted-foreground">Load or upload both files to run.</span>}
          {run.isPending && (
            <span className="text-xs text-blue-700 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Running 3-layer card settlement engine…
            </span>
          )}
        </div>

        {/* Results */}
        {result && (
          <>
            {/* Resolution progress tracker — always visible once results are shown */}
            <ResolutionTracker statuses={reviewStatuses} />

            <Tabs defaultValue="review" className="mt-2">
              <TabsList>
                <TabsTrigger value="balance" className="gap-1.5"><Scale className="h-4 w-4" /> Balance</TabsTrigger>
                <TabsTrigger value="review" className="gap-1.5">
                  <ClipboardCheck className="h-4 w-4" /> Review & Resolve ({exceptions.length})
                </TabsTrigger>
                <TabsTrigger value="agent" className="gap-1.5"><Bot className="h-4 w-4" /> AI Agent</TabsTrigger>
              </TabsList>

              {/* Layer 1 — Balance */}
              <TabsContent value="balance" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold">Layer 1 — Balance</h3>
                      <Badge className={l1.status === "BALANCED" ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-700"}>
                        {l1.status === "BALANCED" ? "Balanced" : "Variance detected"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                      <Stat label="CBS transactions" value={l1.ledgerCount} />
                      <Stat label="Interswitch transactions" value={l1.statementCount} />
                      <Stat label="Matched" value={result.matchedCount} />
                      <Stat label="CBS net" value={ngn(l1.ledgerNet)} />
                      <Stat label="Interswitch net" value={ngn(l1.statementNet)} />
                      <Stat label="Variance" value={ngn(l1.varianceAmount)} highlight={l1.status !== "BALANCED"} />
                    </div>
                    {exceptions.length > 0 && (
                      <div className="mt-4 pt-4 border-t">
                        <p className="text-xs font-semibold text-muted-foreground mb-2">Exception breakdown by category</p>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(byCategory).map(([cat, count]) => (
                            <span key={cat} className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">
                              {CARD_CATEGORY_LABELS[cat] ?? cat}: {String(count)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Review & Resolve tab */}
              <TabsContent value="review" className="space-y-3">
                {exceptions.length === 0 ? (
                  <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 text-blue-500 mx-auto mb-2" />
                    No exceptions — everything reconciled.
                  </CardContent></Card>
                ) : (
                  <>
                    {/* Filter bar */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Filter:</span>
                      {(["ALL", "OPEN", "ACKNOWLEDGED", "RESOLVED", "ESCALATED"] as const).map((s) => {
                        const count = s === "ALL" ? exceptions.length : exceptions.filter((_, i) => reviewStatuses[String(i)] === s).length;
                        return (
                          <button key={s} onClick={() => setFilterStatus(s)}
                            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                               filterStatus === s
                                 ? "text-white"
                                 : "bg-white text-gray-600 border-gray-200 hover:border-green-400"
                             }`}
                            style={filterStatus === s ? { background: LAPO_GREEN, borderColor: LAPO_GREEN } : {}}>
                            {s === "ALL" ? "All" : REVIEW_STATUS_CONFIG[s].label} ({count})
                          </button>
                        );
                      })}
                    </div>
                    {filteredExceptions.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">No exceptions match this filter.</p>
                    ) : (
                      filteredExceptions.map((e, filteredIdx) => {
                        // Map back to original index for status tracking
                        const originalIdx = exceptions.indexOf(e);
                        return (
                          <ExceptionReviewCard
                            key={originalIdx}
                            e={e}
                            index={originalIdx}
                            status={reviewStatuses[String(originalIdx)] ?? "OPEN"}
                            onStatusChange={handleStatusChange}
                          />
                        );
                      })
                    )}
                  </>
                )}
              </TabsContent>

              {/* AI Agent tab — same cards but with agent analysis visible */}
              <TabsContent value="agent" className="space-y-3">
                {exceptions.length === 0 ? (
                  <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 text-blue-500 mx-auto mb-2" />
                    No exceptions — everything reconciled.
                  </CardContent></Card>
                ) : exceptions.map((e, i) => (
                  <ExceptionReviewCard
                    key={i}
                    e={e}
                    index={i}
                    status={reviewStatuses[String(i)] ?? "OPEN"}
                    onStatusChange={handleStatusChange}
                    showAgent
                  />
                ))}
              </TabsContent>
            </Tabs>
          </>
        )}

        {/* Share */}
        {result && (
          <div className="flex items-center gap-3 pt-2">
            <Button variant="outline" className="gap-2" onClick={handleShare} disabled={share.isPending}>
              {copied ? <Check className="h-4 w-4 text-blue-600" /> : <Copy className="h-4 w-4" />}
              {shareUrl ? "Copy share link again" : "Create shareable link"}
            </Button>
            {shareUrl && <span className="text-xs text-muted-foreground truncate max-w-[420px]">{shareUrl}</span>}
          </div>
        )}

        {/* Card exception glossary */}
        <div className="rounded-lg border bg-white p-4">
          <p className="text-xs font-semibold text-gray-700 mb-3">Card Settlement Exception Glossary</p>
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-2">
            {Object.entries(CARD_CATEGORY_DESCRIPTIONS).map(([cat, desc]) => (
              <div key={cat} className="flex gap-2">
                <Badge variant="outline" className="shrink-0 text-[10px] border-blue-200 text-blue-700 self-start mt-0.5">
                  {CARD_CATEGORY_LABELS[cat] ?? cat}
                </Badge>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
