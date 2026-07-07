/**
 * MobileMoneyPOC.tsx
 *
 * Mobile Money Reconciliation POC page.
 * Supports settlement files from:
 *   Nigeria — NIBSS NIP, OPay, Palmpay (NGN)
 *   Uganda  — MTN MoMo, Airtel Money  (UGX)
 *
 * Features:
 *   • Operator selector grouped by country
 *   • Dual file upload: settlement file + internal ledger
 *   • Layer 1: Balance check (total credits vs total debits)
 *   • Layer 2: Transaction-level matching with exception detection
 *   • Layer 3: AI diagnosis with CBN (Nigeria) / BoU (Uganda) regulatory context,
 *     enriched with the institution's own resolution history
 *   • Exception resolution workflow (OPEN → RESOLVED | ESCALATED)
 *   • KPI Dashboard tab (Infinity AI super admins only)
 */
import { useState, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { PocKpiDashboard } from "@/components/PocKpiDashboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Upload as UploadIcon, FileSpreadsheet, CheckCircle2,
  Play, AlertTriangle, Bot, Copy, Check, Smartphone,
  File as FileIcon, X, ChevronDown, ChevronUp,
  ClipboardCheck, MessageSquare, ChevronRight, CircleAlert,
  RotateCcw, Filter, Wifi, WifiOff, Banknote, Wallet as WalletIcon,
} from "lucide-react";
import { toast } from "sonner";

// ─── Brand tokens ─────────────────────────────────────────────────────────────
const MM_BLUE        = "#1A56DB"; // Primary accent
const MM_DARK        = "#1E2A3A"; // Deep background
const MM_GREEN       = "#057A55"; // Success
const MM_AMBER       = "#B45309"; // Warning
const MM_RED         = "#C81E1E"; // Error

// Inject fonts
if (typeof document !== "undefined" && !document.getElementById("mm-fonts")) {
  const link = document.createElement("link");
  link.id = "mm-fonts";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
  document.head.appendChild(link);
}

// ─── Operator config ──────────────────────────────────────────────────────────
type MmOperator =
  | "nip" | "opay" | "palmpay"
  | "mtn_momo_ug" | "airtel_money_ug"
  | "opay_wallet" | "palmpay_wallet" | "moniepoint_wallet";
type MmCountry = "NG" | "UG";

const OPERATOR_META: Record<MmOperator, {
  label: string;
  country: MmCountry;
  currency: "NGN" | "UGX";
  color: string;
  bg: string;
  settlementLabel: string;
  ledgerLabel: string;
  description: string;
  hint: string;
  icon: React.ReactNode;
}> = {
  nip: {
    label: "NIBSS NIP",
    country: "NG",
    currency: "NGN",
    color: "#1A56DB",
    bg: "#EFF6FF",
    settlementLabel: "NIP Settlement Report (CSV/Excel)",
    ledgerLabel: "Internal Ledger / CBS Extract (CSV/Excel)",
    description: "NIBSS Instant Payment inter-bank transfers. Reconcile NIP settlement credits against your internal ledger.",
    hint: "The NIP settlement report from NIBSS",
    icon: <Banknote className="w-5 h-5" />,
  },
  opay: {
    label: "OPay",
    country: "NG",
    currency: "NGN",
    color: "#00A859",
    bg: "#F0FDF4",
    settlementLabel: "OPay Settlement File (CSV/Excel)",
    ledgerLabel: "Internal Ledger / CBS Extract (CSV/Excel)",
    description: "OPay mobile money transfers and agent banking. Reconcile OPay settlement credits against your internal ledger.",
    hint: "The settlement report from OPay",
    icon: <Smartphone className="w-5 h-5" />,
  },
  palmpay: {
    label: "Palmpay",
    country: "NG",
    currency: "NGN",
    color: "#6D28D9",
    bg: "#F5F3FF",
    settlementLabel: "Palmpay Settlement File (CSV/Excel)",
    ledgerLabel: "Internal Ledger / CBS Extract (CSV/Excel)",
    description: "Palmpay mobile money and wallet transfers. Reconcile Palmpay settlement credits against your internal ledger.",
    hint: "The settlement report from Palmpay",
    icon: <Wifi className="w-5 h-5" />,
  },
  mtn_momo_ug: {
    label: "MTN MoMo",
    country: "UG",
    currency: "UGX",
    color: "#F7C600",
    bg: "#FFFBEB",
    settlementLabel: "MTN MoMo Settlement Statement (CSV/Excel)",
    ledgerLabel: "Internal Ledger / CBS Extract (CSV/Excel)",
    description: "MTN Mobile Money Uganda wallet-to-bank and bank-to-wallet flows. Reconciled under the BoU NPS framework (UGX).",
    hint: "The settlement statement from MTN MoMo Uganda",
    icon: <Smartphone className="w-5 h-5" />,
  },
  airtel_money_ug: {
    label: "Airtel Money",
    country: "UG",
    currency: "UGX",
    color: "#E40000",
    bg: "#FEF2F2",
    settlementLabel: "Airtel Money Settlement Statement (CSV/Excel)",
    ledgerLabel: "Internal Ledger / CBS Extract (CSV/Excel)",
    description: "Airtel Money Uganda wallet-to-bank and bank-to-wallet flows. Reconciled under the BoU NPS framework (UGX).",
    hint: "The settlement statement from Airtel Money Uganda",
    icon: <Wifi className="w-5 h-5" />,
  },
  // ── Nigeria wallets (WS-8): provider wallet statement vs internal wallet ledger ──
  opay_wallet: {
    label: "OPay Wallet",
    country: "NG",
    currency: "NGN",
    color: "#047857",
    bg: "#ECFDF5",
    settlementLabel: "OPay Wallet Statement (CSV/Excel)",
    ledgerLabel: "Internal Wallet Ledger (CSV/Excel)",
    description: "OPay customer wallet balances. Reconcile the provider's wallet statement against your internal wallet ledger — funding credits, reversals, and settlement.",
    hint: "The wallet statement from the OPay partner portal",
    icon: <WalletIcon className="w-5 h-5" />,
  },
  palmpay_wallet: {
    label: "Palmpay Wallet",
    country: "NG",
    currency: "NGN",
    color: "#7C3AED",
    bg: "#F5F3FF",
    settlementLabel: "Palmpay Wallet Statement (CSV/Excel)",
    ledgerLabel: "Internal Wallet Ledger (CSV/Excel)",
    description: "Palmpay customer wallet balances. Reconcile the provider's wallet statement against your internal wallet ledger — funding credits, reversals, and settlement.",
    hint: "The wallet statement from the Palmpay partner portal",
    icon: <WalletIcon className="w-5 h-5" />,
  },
  moniepoint_wallet: {
    label: "Moniepoint Wallet",
    country: "NG",
    currency: "NGN",
    color: "#0369A1",
    bg: "#F0F9FF",
    settlementLabel: "Moniepoint Wallet Statement (CSV/Excel)",
    ledgerLabel: "Internal Wallet Ledger (CSV/Excel)",
    description: "Moniepoint customer wallet balances. Reconcile the provider's wallet statement against your internal wallet ledger — funding credits, reversals, and settlement.",
    hint: "The wallet statement from the Moniepoint partner portal",
    icon: <WalletIcon className="w-5 h-5" />,
  },
};

const OPERATOR_GROUPS: Array<{ key: string; label: string; gridCls: string; operators: MmOperator[] }> = [
  { key: "ng_transfers", label: "🇳🇬 Nigeria — Transfers & USSD", gridCls: "grid grid-cols-3 gap-3", operators: ["nip", "opay", "palmpay"] },
  { key: "ng_wallets", label: "🇳🇬 Nigeria — Wallets", gridCls: "grid grid-cols-3 gap-3", operators: ["opay_wallet", "palmpay_wallet", "moniepoint_wallet"] },
  { key: "ug", label: "🇺🇬 Uganda", gridCls: "grid grid-cols-2 gap-3", operators: ["mtn_momo_ug", "airtel_money_ug"] },
];

// ─── Exception category labels ────────────────────────────────────────────────
const MM_CATEGORY_LABELS: Record<string, string> = {
  mm_failed_ussd_debit:      "Failed USSD Debit",
  mm_reversal_not_credited:  "Reversal Not Credited",
  mm_nip_settlement_shortfall: "NIP Settlement Shortfall",
  mm_duplicate_credit:       "Duplicate Credit",
  mm_expired_session_debit:  "Expired Session Debit",
  mm_amount_mismatch:        "Amount Mismatch",
  mm_unmatched_nip_inflow:   "Unmatched NIP Inflow",
  mm_operator_fee_variance:  "Operator Fee Variance",
  mm_wallet_to_bank_failed:  "Wallet-to-Bank Failed",
  mm_bank_to_wallet_failed:  "Bank-to-Wallet Failed",
  mm_withdrawal_tax_variance: "Withdrawal Tax Variance (0.5%)",
  mm_momo_settlement_shortfall: "MoMo Settlement Shortfall",
  mm_wallet_credit_failed:   "Wallet Credit Failed",
  mm_wallet_debit_reversed:  "Wallet Debit Reversed",
  mm_wallet_settlement_shortfall: "Wallet Settlement Shortfall",
  IN_SETTLEMENT_NOT_IN_LEDGER: "In Settlement, Not in Ledger",
  IN_LEDGER_NOT_IN_SETTLEMENT: "In Ledger, Not in Settlement",
  AMOUNT_MISMATCH:           "Amount Mismatch",
  DUPLICATE:                 "Duplicate Transaction",
};

const MM_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  mm_failed_ussd_debit:      "Customer was debited via USSD but the institution was not credited. Requires NIP dispute or reversal.",
  mm_reversal_not_credited:  "A reversal was processed by the operator but the credit has not appeared in the internal ledger.",
  mm_nip_settlement_shortfall: "Net NIP settlement amount differs from the sum of individual transaction credits. Check NIBSS settlement report.",
  mm_duplicate_credit:       "The same session ID or reference has been credited twice. One credit must be reversed.",
  mm_expired_session_debit:  "USSD session timed out but the customer debit was not reversed within the CBN 24-hour window.",
  mm_amount_mismatch:        "Settlement amount differs from the transaction amount in the internal ledger.",
  mm_unmatched_nip_inflow:   "NIP credit appears in the settlement report but has no matching entry in the internal ledger.",
  mm_operator_fee_variance:  "Operator fee deducted differs from the contracted rate. Raise a dispute with the operator.",
  mm_wallet_to_bank_failed:  "Customer's mobile money wallet was debited but the bank account was never credited. BoU error-resolution obligations apply.",
  mm_bank_to_wallet_failed:  "Bank account was debited for a push-to-wallet but the wallet was never credited. Reverse or escalate to the operator.",
  mm_withdrawal_tax_variance: "Variance matches Uganda's 0.5% excise duty on mobile money withdrawals — a statutory deduction, not an operator error.",
  mm_momo_settlement_shortfall: "Net settlement received is below the gross statement sum. Itemise fees, levies, and netted reversals against the trust account.",
  mm_wallet_credit_failed:   "Wallet credit missing on one side: customer funding collected but wallet not credited, or wallet credited with no provider settlement backing it.",
  mm_wallet_debit_reversed:  "Provider reversed a wallet debit but the reversal credit has not reached the internal wallet ledger. Customer balance is understated.",
  mm_wallet_settlement_shortfall: "Net wallet settlement below the gross statement sum. Itemise provider fees, commissions, and netted failed transactions.",
};

// ─── Types ────────────────────────────────────────────────────────────────────
type FileKind = "excel" | "csv";
type ParseStage = "idle" | "reading" | "done" | "error";
type ReviewStatus = "OPEN" | "RESOLVED" | "ESCALATED" | "REJECTED";

interface FileState {
  file: File | null;
  kind: FileKind;
  base64: string;
  stage: ParseStage;
  error: string | null;
}

interface RunResult {
  runId: number;
  operator: string;
  currency?: string;
  learningApplied?: number;
  layer1: {
    statementNet: number;
    ledgerNet: number;
    varianceAmount: number;
    statementCount: number;
    ledgerCount: number;
    status: "BALANCED" | "VARIANCE_DETECTED";
  };
  matchedCount: number;
  exceptionCount: number;
  exceptions: Array<{
    // MmLayer3Item fields (from engine)
    category: string;
    side: "settlement" | "ledger";
    amount: number;
    txnDate: string;
    reference: string | null;
    sessionId: string | null;
    description: string | null;
    reversalStatus?: string | null;
    agentExplanation: string;
    recommendedAction: string;
    cbnRuleReference: string;
    priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    agentConfidence: number;
    // DB-saved fields (added by runFullMmReconciliation)
    id?: number;
    reviewStatus?: ReviewStatus;
  }>;
  aiSummary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getVisitorId(): string {
  const key = "mm_poc_visitor_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    sessionStorage.setItem(key, id);
  }
  return id;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function detectFileKind(file: File): FileKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
  return "csv";
}

function fmtMoney(amount: number | null | undefined, currency: string = "NGN"): string {
  if (amount == null) return "—";
  const locale = currency === "UGX" ? "en-UG" : "en-NG";
  // UGX is not subdivided in practice — whole shillings only.
  const digits = currency === "UGX" ? 0 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: digits }).format(amount);
}

function severityColor(severity: string): string {
  switch (severity) {
    case "CRITICAL": return "#C81E1E";
    case "HIGH": return "#B45309";
    case "MEDIUM": return "#D97706";
    default: return "#6B7280";
  }
}

// ─── File Upload Card ─────────────────────────────────────────────────────────
function FileUploadCard({
  label,
  hint,
  fileState,
  onFile,
  onClear,
  accentColor,
}: {
  label: string;
  hint: string;
  fileState: FileState;
  onFile: (file: File) => void;
  onClear: () => void;
  accentColor: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [onFile]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-semibold" style={{ color: MM_DARK }}>{label}</div>
      <div className="text-xs text-gray-500 mb-1">{hint}</div>
      {fileState.file ? (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50">
          <FileSpreadsheet className="w-5 h-5 flex-shrink-0" style={{ color: accentColor }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate">{fileState.file.name}</div>
            <div className="text-xs text-gray-500">{(fileState.file.size / 1024).toFixed(1)} KB · {fileState.kind.toUpperCase()}</div>
          </div>
          {fileState.stage === "reading" && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          {fileState.stage === "done" && <CheckCircle2 className="w-4 h-4" style={{ color: MM_GREEN }} />}
          {fileState.stage === "error" && <AlertTriangle className="w-4 h-4" style={{ color: MM_RED }} />}
          <button onClick={onClear} className="p-1 rounded hover:bg-gray-200 transition-colors">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      ) : (
        <div
          className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center gap-2 cursor-pointer transition-colors ${dragging ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-gray-300 bg-gray-50"}`}
          style={{ borderColor: dragging ? accentColor : undefined }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <UploadIcon className="w-8 h-8 text-gray-300" />
          <div className="text-sm text-gray-500">Drop file here or <span className="font-medium" style={{ color: accentColor }}>browse</span></div>
          <div className="text-xs text-gray-400">CSV or Excel (.xlsx)</div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />
        </div>
      )}
      {fileState.error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> {fileState.error}
        </div>
      )}
    </div>
  );
}

// ─── Exception Card ───────────────────────────────────────────────────────────
function ExceptionCard({
  exc,
  pocSlug,
  onResolved,
  accentColor,
  currency,
}: {
  exc: RunResult["exceptions"][number];
  pocSlug: string;
  onResolved: () => void;
  accentColor: string;
  currency: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  const updateStatus = trpc.mobileMoney.updateExceptionStatus.useMutation({
    onSuccess: () => {
      toast.success("Exception updated");
      onResolved();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleAction = (status: ReviewStatus) => {
    updateStatus.mutate({
      pocSlug,
      exceptionId: exc.id ?? 0,
      reviewStatus: status,
      reviewedBy: getVisitorId(),
      reviewNote: note,
    });
  };

  const copyDiagnosis = () => {
    const text = [exc.agentExplanation, exc.recommendedAction, exc.cbnRuleReference].filter(Boolean).join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const statusColors: Record<ReviewStatus, string> = {
    OPEN: "#6B7280",
    RESOLVED: MM_GREEN,
    ESCALATED: MM_AMBER,
    REJECTED: MM_RED,
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
      {/* Header */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: severityColor(exc.priorityLevel) }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-800">
              {MM_CATEGORY_LABELS[exc.category] ?? exc.category}
            </span>
            <Badge variant="outline" className="text-xs" style={{ borderColor: severityColor(exc.priorityLevel), color: severityColor(exc.priorityLevel) }}>
              {exc.priorityLevel}
            </Badge>
            <Badge variant="outline" className="text-xs" style={{ borderColor: statusColors[exc.reviewStatus ?? "OPEN"], color: statusColors[exc.reviewStatus ?? "OPEN"] }}>
              {exc.reviewStatus ?? "OPEN"}
            </Badge>
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">{exc.description}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-bold" style={{ color: exc.amount !== 0 ? MM_RED : MM_GREEN }}>
            {fmtMoney(Math.abs(exc.amount), currency)}
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400 mt-1" /> : <ChevronDown className="w-4 h-4 text-gray-400 mt-1" />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4">
                    {/* Amounts */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-500 mb-1">{exc.side === "settlement" ? "Settlement Amount" : "Side"}</div>
              <div className="text-sm font-semibold text-gray-800">{exc.side === "settlement" ? fmtMoney(exc.amount, currency) : exc.side}</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xs text-gray-500 mb-1">Transaction Date</div>
              <div className="text-sm font-semibold text-gray-800">{exc.txnDate}</div>
            </div>
            <div className="rounded-lg p-3" style={{ backgroundColor: "#FEF2F2" }}>
              <div className="text-xs text-gray-500 mb-1">Exception Amount</div>
              <div className="text-sm font-semibold" style={{ color: MM_RED }}>
                {fmtMoney(exc.amount, currency)}
              </div>
            </div>
          </div>
          {/* Reference */}
          {exc.reference && (
            <div className="text-xs text-gray-500">
              <span className="font-medium">Reference:</span> {exc.reference}
            </div>
          )}

          {/* Category description */}
          {MM_CATEGORY_DESCRIPTIONS[exc.category] && (
            <div className="rounded-lg p-3 text-xs text-gray-600" style={{ backgroundColor: "#F8FAFC" }}>
              {MM_CATEGORY_DESCRIPTIONS[exc.category]}
            </div>
          )}

          {/* AI Diagnosis */}
          {(exc.agentExplanation || exc.recommendedAction) && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4" style={{ color: MM_BLUE }} />
                  <span className="text-xs font-semibold" style={{ color: MM_BLUE }}>AI Diagnosis</span>
                  <span className="text-xs text-blue-400">({exc.agentConfidence}% confidence)</span>
                </div>
                <button onClick={copyDiagnosis} className="p-1 rounded hover:bg-blue-100 transition-colors">
                  {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3 text-blue-400" />}
                </button>
              </div>
              {exc.agentExplanation && <p className="text-xs text-gray-700 leading-relaxed">{exc.agentExplanation}</p>}
              {exc.recommendedAction && (
                <div className="rounded-lg bg-white border border-blue-100 p-3">
                  <div className="text-xs font-semibold text-blue-700 mb-1 flex items-center gap-1">
                    <ChevronRight className="w-3 h-3" /> Recommended Action
                  </div>
                  <p className="text-xs text-gray-700">{exc.recommendedAction}</p>
                </div>
              )}
              {exc.cbnRuleReference && (
                <div className="text-xs text-blue-600 italic">{exc.cbnRuleReference}</div>
              )}
            </div>
          )}

          {/* Resolution */}
          {exc.reviewStatus === "OPEN" && (
            <div className="space-y-2">
              <Textarea
                placeholder="Add a resolution note (optional)..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="text-xs min-h-[60px] resize-none"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 text-xs"
                  style={{ backgroundColor: MM_GREEN, color: "white" }}
                  onClick={() => handleAction("RESOLVED")}
                  disabled={updateStatus.isPending}
                >
                  {updateStatus.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ClipboardCheck className="w-3 h-3 mr-1" />}
                  Mark Resolved
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs"
                  style={{ borderColor: MM_AMBER, color: MM_AMBER }}
                  onClick={() => handleAction("ESCALATED")}
                  disabled={updateStatus.isPending}
                >
                  <MessageSquare className="w-3 h-3 mr-1" />
                  Escalate
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
interface MobileMoneyPOCProps {
  pocSlug?: string;
}

export default function MobileMoneyPOC({ pocSlug = "lapo_mfb" }: MobileMoneyPOCProps) {
  const [operator, setOperator] = useState<MmOperator>("nip");
  const [settlementFile, setSettlementFile] = useState<FileState>({ file: null, kind: "csv", base64: "", stage: "idle", error: null });
  const [ledgerFile, setLedgerFile] = useState<FileState>({ file: null, kind: "csv", base64: "", stage: "idle", error: null });
  const [result, setResult] = useState<RunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("upload");
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [refreshKey, setRefreshKey] = useState(0);

  const meta = OPERATOR_META[operator];
  const currency = result?.currency ?? meta.currency;

  // KPI dashboards are an internal Infinity AI view — hidden from POC customers
  // (matches LapoPOC/WoodcorePOC; the server enforces this with a super-admin guard).
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";

  const kpiQuery = trpc.pocKpi.getKpis.useQuery(
    { pocSlug },
    { staleTime: 30_000, enabled: isSuperAdmin }
  );

  const runMutation = trpc.mobileMoney.run.useMutation({
    onSuccess: (data) => {
      setResult(data as RunResult);
      setActiveTab("results");
      setIsRunning(false);
      toast.success(`Reconciliation complete — ${data.exceptionCount} exception${data.exceptionCount !== 1 ? "s" : ""} detected`);
    },
    onError: (e) => {
      setIsRunning(false);
      toast.error(e.message || "Reconciliation failed. Please check your files and try again.");
    },
  });

  const handleFile = useCallback(async (
    file: File,
    setter: React.Dispatch<React.SetStateAction<FileState>>
  ) => {
    const kind = detectFileKind(file);
    setter({ file, kind, base64: "", stage: "reading", error: null });
    try {
      const base64 = await fileToBase64(file);
      setter({ file, kind, base64, stage: "done", error: null });
    } catch {
      setter({ file, kind, base64: "", stage: "error", error: "Failed to read file. Please try again." });
    }
  }, []);

  const handleRun = () => {
    if (!settlementFile.base64 || !ledgerFile.base64) {
      toast.error("Please upload both the settlement file and the internal ledger before running.");
      return;
    }
    setIsRunning(true);
    runMutation.mutate({
      pocSlug,
      operator,
      settlementFileName: settlementFile.file?.name,
      settlementFileType: settlementFile.kind,
      settlementContentBase64: settlementFile.base64,
      ledgerFileName: ledgerFile.file?.name,
      ledgerFileType: ledgerFile.kind,
      ledgerContentBase64: ledgerFile.base64,
    });
  };

  const filteredExceptions = result?.exceptions.filter((e) => {
        if (filterSeverity !== "ALL" && e.priorityLevel !== filterSeverity) return false;
    if (filterStatus !== "ALL" && (e.reviewStatus ?? "OPEN") !== filterStatus) return false;
    return true;
  }) ?? [];
  const resolvedCount = result?.exceptions.filter((e) => (e.reviewStatus ?? "OPEN") === "RESOLVED").length ?? 0;
  const openCount = result?.exceptions.filter((e) => (e.reviewStatus ?? "OPEN") === "OPEN").length ?? 0;

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", backgroundColor: "#F8FAFC", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg, ${MM_DARK} 0%, #2D3F55 100%)` }} className="px-6 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: meta.color }}>
              {meta.icon}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Mobile Money Reconciliation</h1>
              <p className="text-sm text-blue-200">Nigeria: NIBSS NIP · OPay · Palmpay · Wallets (OPay/Palmpay/Moniepoint) &nbsp;|&nbsp; Uganda: MTN MoMo · Airtel Money — AI-powered exception detection</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 bg-white border border-gray-200 rounded-xl p-1">
            <TabsTrigger value="upload" className="rounded-lg text-sm">Upload Files</TabsTrigger>
            <TabsTrigger value="results" className="rounded-lg text-sm" disabled={!result}>Results</TabsTrigger>
            <TabsTrigger value="exceptions" className="rounded-lg text-sm" disabled={!result}>
              Exceptions {result && result.exceptionCount > 0 && (
                <Badge className="ml-1 text-xs" style={{ backgroundColor: MM_RED, color: "white" }}>
                  {result.exceptionCount}
                </Badge>
              )}
            </TabsTrigger>
            {isSuperAdmin && <TabsTrigger value="kpi" className="rounded-lg text-sm">KPI Dashboard</TabsTrigger>}
          </TabsList>

          {/* ── Upload Tab ── */}
          <TabsContent value="upload">
            <div className="space-y-6">
              {/* Operator selector */}
              <Card className="border-gray-200">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold text-gray-800">Select Mobile Money Operator</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {OPERATOR_GROUPS.map(({ key, label, gridCls, operators }) => (
                    <div key={key}>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        {label}
                      </div>
                      <div className={gridCls}>
                        {operators.map((op) => {
                          const m = OPERATOR_META[op];
                          const selected = operator === op;
                          return (
                            <button
                              key={op}
                              onClick={() => setOperator(op)}
                              className="rounded-xl border-2 p-4 text-left transition-all"
                              style={{
                                borderColor: selected ? m.color : "#E5E7EB",
                                backgroundColor: selected ? m.bg : "white",
                              }}
                            >
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: m.color, color: "white" }}>
                                  {m.icon}
                                </div>
                                <span className="font-semibold text-sm" style={{ color: selected ? m.color : MM_DARK }}>{m.label}</span>
                                <Badge variant="outline" className="ml-auto text-[10px]">{m.currency}</Badge>
                              </div>
                              <p className="text-xs text-gray-500 leading-relaxed">{m.description}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* File uploads */}
              <Card className="border-gray-200">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold text-gray-800">Upload Settlement & Ledger Files</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-6">
                    <FileUploadCard
                      label={meta.settlementLabel}
                      hint={meta.hint}
                      fileState={settlementFile}
                      onFile={(f) => handleFile(f, setSettlementFile)}
                      onClear={() => setSettlementFile({ file: null, kind: "csv", base64: "", stage: "idle", error: null })}
                      accentColor={meta.color}
                    />
                    <FileUploadCard
                      label={meta.ledgerLabel}
                      hint="Your internal CBS or ledger extract for the same period"
                      fileState={ledgerFile}
                      onFile={(f) => handleFile(f, setLedgerFile)}
                      onClear={() => setLedgerFile({ file: null, kind: "csv", base64: "", stage: "idle", error: null })}
                      accentColor={meta.color}
                    />
                  </div>

                  <div className="mt-6 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      Both files required · CSV or Excel · Max 20 MB each
                    </div>
                    <Button
                      onClick={handleRun}
                      disabled={isRunning || settlementFile.stage !== "done" || ledgerFile.stage !== "done"}
                      style={{ backgroundColor: meta.color, color: "white" }}
                      className="px-6"
                    >
                      {isRunning ? (
                        <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Running Reconciliation...</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2" /> Run Reconciliation</>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── Results Tab ── */}
          <TabsContent value="results">
            {result && (
              <div className="space-y-6">
                {/* Layer 1: Balance */}
                <Card className="border-gray-200">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base font-semibold text-gray-800">Layer 1: Balance Check</CardTitle>
                      <Badge
                        className="text-xs"
                        style={{
                          backgroundColor: result.layer1.status === "BALANCED" ? MM_GREEN : MM_RED,
                          color: "white",
                        }}
                      >
                        {result.layer1.status === "BALANCED" ? "BALANCED" : "VARIANCE DETECTED"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-4 gap-4">
                      <div className="rounded-lg bg-gray-50 p-4">
                        <div className="text-xs text-gray-500 mb-1">Settlement Total</div>
                        <div className="text-lg font-bold text-gray-800">{fmtMoney(result.layer1.statementNet, currency)}</div>
                        <div className="text-xs text-gray-400">{result.layer1.statementCount.toLocaleString()} txns</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-4">
                        <div className="text-xs text-gray-500 mb-1">Ledger Total</div>
                        <div className="text-lg font-bold text-gray-800">{fmtMoney(result.layer1.ledgerNet, currency)}</div>
                        <div className="text-xs text-gray-400">{result.layer1.ledgerCount.toLocaleString()} txns</div>
                      </div>
                      <div       className="rounded-lg p-4" style={{ backgroundColor: result.layer1.varianceAmount !== 0 ? "#FEF2F2" : "#F0FDF4" }}>
                        <div className="text-xs text-gray-500 mb-1">Variance</div>
                        <div className="text-lg font-bold" style={{ color: result.layer1.varianceAmount !== 0 ? MM_RED : MM_GREEN }}>
                          {fmtMoney(Math.abs(result.layer1.varianceAmount), currency)}
                        </div>
                        <div className="text-xs text-gray-400">{result.layer1.varianceAmount > 0 ? "Ledger > Settlement" : result.layer1.varianceAmount < 0 ? "Settlement > Ledger" : "Balanced"}</div>
                      </div>
                      <div className="rounded-lg bg-blue-50 p-4">
                        <div className="text-xs text-gray-500 mb-1">Matched Transactions</div>
                        <div className="text-lg font-bold text-blue-700">{result.matchedCount.toLocaleString()}</div>
                        <div className="text-xs text-gray-400">{result.exceptionCount} exceptions</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Summary */}
                {result.aiSummary && (
                  <Card className="border-blue-100" style={{ backgroundColor: "#EFF6FF" }}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4" style={{ color: MM_BLUE }} />
                        <CardTitle className="text-sm font-semibold" style={{ color: MM_BLUE }}>AI Reconciliation Summary</CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{result.aiSummary}</p>
                    </CardContent>
                  </Card>
                )}

                {/* Action buttons */}
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setActiveTab("exceptions"); }}
                    disabled={result.exceptionCount === 0}
                  >
                    <AlertTriangle className="w-4 h-4 mr-2" />
                    Review {result.exceptionCount} Exceptions
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setResult(null); setSettlementFile({ file: null, kind: "csv", base64: "", stage: "idle", error: null }); setLedgerFile({ file: null, kind: "csv", base64: "", stage: "idle", error: null }); setActiveTab("upload"); }}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    New Reconciliation
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Exceptions Tab ── */}
          <TabsContent value="exceptions">
            {result && (
              <div className="space-y-4">
                {/* Progress bar */}
                <Card className="border-gray-200">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">Resolution Progress</span>
                      <span className="text-sm text-gray-500">{resolvedCount} / {result.exceptionCount} resolved</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${result.exceptionCount > 0 ? (resolvedCount / result.exceptionCount) * 100 : 0}%`, backgroundColor: MM_GREEN }}
                      />
                    </div>
                    <div className="flex gap-4 mt-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><CircleAlert className="w-3 h-3 text-gray-400" /> {openCount} Open</span>
                      <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" style={{ color: MM_GREEN }} /> {resolvedCount} Resolved</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Filters */}
                <div className="flex gap-3 items-center">
                  <Filter className="w-4 h-4 text-gray-400" />
                  <div className="flex gap-2">
                    {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => (
                      <button
                        key={s}
                        onClick={() => setFilterSeverity(s)}
                        className="text-xs px-3 py-1 rounded-full border transition-colors"
                        style={{
                          borderColor: filterSeverity === s ? meta.color : "#E5E7EB",
                          backgroundColor: filterSeverity === s ? meta.bg : "white",
                          color: filterSeverity === s ? meta.color : "#6B7280",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 ml-2">
                    {["ALL", "OPEN", "RESOLVED", "ESCALATED"].map((s) => (
                      <button
                        key={s}
                        onClick={() => setFilterStatus(s)}
                        className="text-xs px-3 py-1 rounded-full border transition-colors"
                        style={{
                          borderColor: filterStatus === s ? meta.color : "#E5E7EB",
                          backgroundColor: filterStatus === s ? meta.bg : "white",
                          color: filterStatus === s ? meta.color : "#6B7280",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Exception list */}
                <div className="space-y-3">
                  {filteredExceptions.length === 0 ? (
                    <div className="text-center py-12 text-gray-400">
                      <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-gray-200" />
                      <p className="text-sm">No exceptions match the current filters</p>
                    </div>
                  ) : (
                    filteredExceptions.map((exc) => (
                      <ExceptionCard
                        key={`${exc.id}-${refreshKey}`}
                        exc={exc}
                        pocSlug={pocSlug}
                        onResolved={() => setRefreshKey((k) => k + 1)}
                        accentColor={meta.color}
                        currency={currency}
                      />
                    ))
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── KPI Dashboard Tab (Infinity AI super admins only) ── */}
          {isSuperAdmin && (
            <TabsContent value="kpi">
              <PocKpiDashboard
                report={kpiQuery.data ?? null}
                isLoading={kpiQuery.isLoading}
                isError={kpiQuery.isError}
                accentColor={MM_BLUE}
                title="Mobile Money KPI Dashboard"
                subtitle="Nigeria: NIBSS NIP · OPay · Palmpay · Wallets | Uganda: MTN MoMo · Airtel Money"
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
