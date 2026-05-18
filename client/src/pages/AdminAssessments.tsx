import { useState, useRef, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Search,
  ExternalLink,
  Mail,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Loader2,
  SendHorizonal,
  Download,
  Users,
  Phone,
  PhoneOff,
  Zap,
  StickyNote,
  Check,
  FileText,
  CalendarClock,
  X,
} from "lucide-react";

// ─── Pipeline stage config ──────────────────────────────────────────────────
type PipelineStage = "new" | "contacted" | "demo_booked" | "proposal_sent" | "closed_won" | "closed_lost";

const PIPELINE_STAGES: { value: PipelineStage; label: string; color: string; dot: string }[] = [
  { value: "new",           label: "New",            color: "bg-gray-100 text-gray-600 border-gray-200",         dot: "bg-gray-400" },
  { value: "contacted",     label: "Contacted",      color: "bg-blue-50 text-blue-700 border-blue-200",          dot: "bg-blue-500" },
  { value: "demo_booked",   label: "Demo Booked",    color: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500" },
  { value: "proposal_sent", label: "Proposal Sent",  color: "bg-purple-50 text-purple-700 border-purple-200",    dot: "bg-purple-500" },
  { value: "closed_won",    label: "Closed Won",     color: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  { value: "closed_lost",   label: "Closed Lost",    color: "bg-red-50 text-red-600 border-red-200",             dot: "bg-red-400" },
];

const STAGE_MAP = Object.fromEntries(PIPELINE_STAGES.map(s => [s.value, s])) as Record<PipelineStage, typeof PIPELINE_STAGES[0]>;

// ─── Risk badge config ───────────────────────────────────────────────────────
const RISK_COLORS: Record<string, { badge: string; dot: string; label: string }> = {
  critical: { badge: "bg-red-50 text-red-700 border-red-200",       dot: "bg-red-500",     label: "Critical" },
  high:     { badge: "bg-orange-50 text-orange-700 border-orange-200", dot: "bg-orange-500", label: "High" },
  medium:   { badge: "bg-amber-50 text-amber-700 border-amber-200",  dot: "bg-amber-500",   label: "Medium" },
  low:      { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", label: "Low" },
};

const INST_TYPE_LABELS: Record<string, string> = {
  commercial_bank: "Commercial Bank",
  microfinance_bank: "Microfinance Bank",
  fintech: "Fintech",
  payment_processor: "Payment Processor",
  corporate_b2b: "Corporate B2B",
  other: "Other",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function relativeTime(date: Date | null | undefined): string | null {
  if (!date) return null;
  const diffMs = Date.now() - new Date(date).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 30) return `${diffDay} days ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 8) return `${diffWk} weeks ago`;
  return `${Math.floor(diffDay / 30)} months ago`;
}

/** Returns true if the due date is in the past and the stage is not closed */
function isOverdue(dueAt: Date | null | undefined, stage: PipelineStage): boolean {
  if (!dueAt) return false;
  if (stage === "closed_won" || stage === "closed_lost") return false;
  return new Date(dueAt).getTime() < Date.now();
}

/** Format a Date as YYYY-MM-DD for the native date input value */
function toDateInputValue(date: Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function RiskBadge({ level }: { level: string }) {
  const c = RISK_COLORS[level] ?? RISK_COLORS.medium;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : score >= 40 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-sm font-semibold text-[#1B365D] tabular-nums">{score}</span>
    </div>
  );
}

function PipelineStageCell({ token, initialStage }: { token: string; initialStage: PipelineStage }) {
  const utils = trpc.useUtils();
  const [localStage, setLocalStage] = useState<PipelineStage>(initialStage);

  const setStage = trpc.assessment.setPipelineStage.useMutation({
    onMutate: ({ stage }) => setLocalStage(stage as PipelineStage),
    onSuccess: () => utils.assessment.listAll.invalidate(),
    onError: () => {
      setLocalStage(initialStage);
      toast.error("Failed to update pipeline stage");
    },
  });

  const cfg = STAGE_MAP[localStage];

  return (
    <Select
      value={localStage}
      onValueChange={(val) => setStage.mutate({ token, stage: val as PipelineStage })}
    >
      <SelectTrigger
        className={`h-7 text-xs font-semibold border rounded-full px-2.5 py-0 w-auto min-w-[120px] gap-1.5 ${cfg.color} focus:ring-0 focus:ring-offset-0`}
      >
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${cfg.dot}`} />
        <SelectValue />
        {setStage.isPending && <Loader2 className="h-3 w-3 animate-spin ml-auto" />}
      </SelectTrigger>
      <SelectContent>
        {PIPELINE_STAGES.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${s.dot}`} />
              {s.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FollowUpDateCell({
  token,
  initialDueAt,
  stage,
}: {
  token: string;
  initialDueAt: Date | null | undefined;
  stage: PipelineStage;
}) {
  const utils = trpc.useUtils();
  const [localDue, setLocalDue] = useState<Date | null>(initialDueAt ? new Date(initialDueAt) : null);
  const overdue = isOverdue(localDue, stage);

  const setDue = trpc.assessment.setFollowUpDue.useMutation({
    onSuccess: (data) => {
      setLocalDue(data.dueAt ? new Date(data.dueAt) : null);
      utils.assessment.listAll.invalidate();
    },
    onError: () => toast.error("Failed to update follow-up date"),
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) {
      setLocalDue(null);
      setDue.mutate({ token, dueAt: null });
    } else {
      const d = new Date(val + "T00:00:00");
      setLocalDue(d);
      setDue.mutate({ token, dueAt: d });
    }
  };

  const handleClear = () => {
    setLocalDue(null);
    setDue.mutate({ token, dueAt: null });
  };

  return (
    <div className="flex items-center gap-1 min-w-[130px]">
      <div className={`relative flex items-center rounded-md border transition-colors ${
        overdue ? "border-amber-400 bg-amber-50" : "border-gray-200 bg-white"
      }`}>
        <CalendarClock className={`h-3 w-3 ml-2 shrink-0 ${overdue ? "text-amber-500" : "text-gray-300"}`} />
        <input
          type="date"
          value={toDateInputValue(localDue)}
          onChange={handleChange}
          className={`text-xs px-1.5 py-1 bg-transparent outline-none w-[108px] ${
            overdue ? "text-amber-700 font-semibold" : "text-[#1B365D]"
          }`}
        />
        {setDue.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1.5 text-gray-400" />}
      </div>
      {localDue && !setDue.isPending && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleClear}
                className="h-5 w-5 flex items-center justify-center rounded-full text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Clear due date</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {overdue && (
        <span className="text-[10px] text-amber-600 font-semibold whitespace-nowrap">Overdue</span>
      )}
    </div>
  );
}

function DemoInviteButton({ token, hasEmail, demoInviteSent }: { token: string; hasEmail: boolean; demoInviteSent: boolean }) {
  const utils = trpc.useUtils();
  const [localSent, setLocalSent] = useState(demoInviteSent);

  const sendInvite = trpc.assessment.sendDemoInvite.useMutation({
    onSuccess: () => {
      setLocalSent(true);
      utils.assessment.listAll.invalidate();
      toast.success("Demo invite sent");
    },
    onError: (err) => toast.error("Failed to send invite", { description: err.message }),
  });

  if (!hasEmail) return <span className="text-xs text-gray-300 italic">No email</span>;
  if (localSent) return (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
      <CheckCircle2 className="h-3.5 w-3.5" /> Demo invited
    </span>
  );

  return (
    <Button
      size="sm" variant="outline"
      className="h-7 px-2.5 text-xs border-[#F47458]/40 text-[#F47458] hover:bg-[#F47458]/5 hover:border-[#F47458] gap-1.5"
      disabled={sendInvite.isPending}
      onClick={() => sendInvite.mutate({ token })}
    >
      {sendInvite.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <SendHorizonal className="h-3 w-3" />}
      Send Demo Invite
    </Button>
  );
}

function MarkContactedButton({
  token,
  markedContacted,
  lastContactedAt,
}: {
  token: string;
  markedContacted: boolean;
  lastContactedAt: Date | null | undefined;
}) {
  const utils = trpc.useUtils();
  const [localContacted, setLocalContacted] = useState(markedContacted);
  const [localTs, setLocalTs] = useState<Date | null | undefined>(lastContactedAt);

  const toggle = trpc.assessment.markContacted.useMutation({
    onMutate: () => {
      const next = !localContacted;
      setLocalContacted(next);
      setLocalTs(next ? new Date() : null);
    },
    onSuccess: (data) => {
      setLocalContacted(data.contacted);
      setLocalTs(data.lastContactedAt ?? null);
      utils.assessment.listAll.invalidate();
    },
    onError: () => {
      setLocalContacted(prev => !prev);
      setLocalTs(lastContactedAt ?? null);
      toast.error("Failed to update contacted status");
    },
  });

  const rel = relativeTime(localTs);

  return (
    <div className="flex flex-col items-center gap-0.5">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => toggle.mutate({ token, contacted: !localContacted })}
              disabled={toggle.isPending}
              className={`inline-flex items-center justify-center h-7 w-7 rounded-md border transition-all duration-150 ${
                localContacted
                  ? "bg-[#1B365D] border-[#1B365D] text-white hover:bg-[#142847]"
                  : "bg-white border-gray-200 text-gray-300 hover:border-[#1B365D] hover:text-[#1B365D]"
              }`}
            >
              {toggle.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Phone className="h-3 w-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs max-w-[200px]">
            {localContacted
              ? `Marked as contacted${rel ? ` · ${rel}` : ""} — click to unmark`
              : "Mark as contacted (offline follow-up)"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {localContacted && rel && (
        <span className="text-[10px] text-[#1B365D]/50 whitespace-nowrap leading-tight">{rel}</span>
      )}
    </div>
  );
}

function InlineNotes({ token, initialNotes }: { token: string; initialNotes: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialNotes ?? "");
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const saveNotes = trpc.assessment.updateNotes.useMutation({
    onSuccess: () => {
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: () => toast.error("Failed to save notes"),
  });

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  const handleSave = () => {
    if (value !== (initialNotes ?? "")) {
      saveNotes.mutate({ token, notes: value });
    } else {
      setEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setValue(initialNotes ?? ""); setEditing(false); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSave();
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1 min-w-[160px]">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          placeholder="Add a note…"
          maxLength={2000}
          rows={3}
          className="w-full text-xs text-[#1B365D] border border-[#1B365D]/30 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-[#1B365D]/40 bg-white placeholder:text-gray-300"
        />
        <p className="text-[10px] text-gray-300">⌘↵ save · Esc cancel</p>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={() => setEditing(true)} className="group flex items-start gap-1.5 text-left w-full max-w-[180px]">
            {saved ? (
              <Check className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" />
            ) : (
              <StickyNote className={`h-3 w-3 mt-0.5 shrink-0 transition-colors ${value ? "text-amber-400" : "text-gray-200 group-hover:text-gray-400"}`} />
            )}
            {value ? (
              <span className="text-xs text-[#1B365D]/70 line-clamp-2 leading-relaxed">{value}</span>
            ) : (
              <span className="text-xs text-gray-300 group-hover:text-gray-400 italic">Add note…</span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs max-w-[200px]">
          {value ? "Click to edit note" : "Click to add a sales note"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AdminAssessments() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [riskFilter, setRiskFilter] = useState<string>("all");
  const [optOutFilter, setOptOutFilter] = useState<string>("all");
  const [consentOnly, setConsentOnly] = useState(false);
  const [notContacted, setNotContacted] = useState(false);
  const [hasNotes, setHasNotes] = useState(false);
  const [exportEnabled, setExportEnabled] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);

  const emailOptedOutParam = optOutFilter === "opted_out" ? true : optOutFilter === "subscribed" ? false : undefined;

  const { data, isLoading, error } = trpc.assessment.listAll.useQuery({
    page,
    pageSize: 20,
    search: search || undefined,
    riskLevel: (riskFilter !== "all" ? riskFilter : undefined) as "critical" | "high" | "medium" | "low" | undefined,
    emailOptedOut: emailOptedOutParam,
    consentOnly: consentOnly || undefined,
    notContacted: notContacted || undefined,
    hasNotes: hasNotes || undefined,
  });

  const { data: eligibleData, refetch: refetchEligible } = trpc.assessment.countBulkEligible.useQuery(undefined, {
    enabled: false,
  });

  const utils = trpc.useUtils();
  const bulkSend = trpc.assessment.bulkSendDemoInvites.useMutation({
    onSuccess: (result) => {
      setBulkDialogOpen(false);
      utils.assessment.listAll.invalidate();
      utils.assessment.countBulkEligible.invalidate();
      if (result.failed > 0) {
        toast.warning(`Sent ${result.sent} invites — ${result.failed} failed`);
      } else {
        toast.success(`${result.sent} demo invite${result.sent !== 1 ? "s" : ""} sent`);
      }
    },
    onError: (err) => toast.error("Bulk send failed", { description: err.message }),
  });

  const { data: csvData, isFetching: csvLoading } = trpc.assessment.exportCsv.useQuery(
    {
      riskLevel: (riskFilter !== "all" ? riskFilter : undefined) as "critical" | "high" | "medium" | "low" | undefined,
      emailOptedOut: emailOptedOutParam,
      consentOnly: consentOnly || undefined,
      search: search || undefined,
    },
    { enabled: exportEnabled, staleTime: 0 }
  );

  if (exportEnabled && csvData && !csvLoading) {
    const blob = new Blob([csvData.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().split("T")[0];
    a.download = `compliance-assessments-${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportEnabled(false);
    toast.success(`Exported ${csvData.count} assessments`);
  }

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;
  const rows = data?.rows ?? [];

  const criticalCount = rows.filter(r => r.riskLevel === "critical").length;
  const highCount = rows.filter(r => r.riskLevel === "high").length;
  const consentCount = rows.filter(r => r.consentToContact).length;
  const avgScore = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + (r.overallScore ?? 0), 0) / rows.length) : 0;
  const overdueCount = rows.filter(r => isOverdue((r as any).followUpDueAt, (r as any).pipelineStage ?? "new")).length;

  const activeChips = [consentOnly && "consented", notContacted && "not contacted", hasNotes && "has notes"].filter(Boolean);

  return (
    <DashboardLayout>
      <div className="p-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <ClipboardCheck className="h-5 w-5 text-[#F47458]" />
              <h1 className="text-xl font-bold text-[#1B365D]">Compliance Assessments</h1>
            </div>
            <p className="text-sm text-[#8C757D]">
              All submitted CBN Compliance Readiness Assessments — leads generated by the public tool.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="bg-[#F47458] hover:bg-[#e0634a] text-white text-xs gap-1.5 shadow-sm"
                    onClick={() => { refetchEligible(); setBulkDialogOpen(true); }}
                  >
                    <Zap className="h-3.5 w-3.5" /> Bulk Send Invites
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-[220px]">
                  Send demo invites to all consented respondents who haven't been invited yet.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <Button
              variant="outline" size="sm"
              className="border-[#1B365D]/20 text-[#1B365D] text-xs gap-1.5 hover:bg-[#1B365D]/5"
              onClick={() => setExportEnabled(true)}
              disabled={csvLoading}
            >
              {csvLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Export CSV
            </Button>

            <a href="/compliance-assessment" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="border-[#1B365D]/20 text-[#1B365D] text-xs">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> View Public Tool
              </Button>
            </a>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {[
            { label: "Total Submitted",      value: data?.total ?? 0,                             color: "text-[#1B365D]" },
            { label: "Critical / High Risk", value: `${criticalCount + highCount} / ${rows.length}`, color: "text-red-600" },
            { label: "Avg Score",            value: `${avgScore} / 100`,                           color: "text-[#F47458]" },
            { label: "Consented to Contact", value: consentCount,                                  color: "text-emerald-600" },
            { label: "Overdue Follow-ups",   value: overdueCount,                                  color: overdueCount > 0 ? "text-amber-600" : "text-gray-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <p className="text-xs text-[#8C757D] mb-1">{label}</p>
              <p className={`text-xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-3">
          <div className="flex gap-2 flex-1">
            <Input
              placeholder="Search institution, name, or email…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && (setSearch(searchInput), setPage(1))}
              className="flex-1 h-9 text-sm border-gray-200"
            />
            <Button size="sm" onClick={() => { setSearch(searchInput); setPage(1); }} className="bg-[#1B365D] hover:bg-[#142847] text-white h-9 px-3">
              <Search className="h-4 w-4" />
            </Button>
          </div>
          <Select value={riskFilter} onValueChange={v => { setRiskFilter(v); setPage(1); }}>
            <SelectTrigger className="w-40 h-9 text-sm border-gray-200"><SelectValue placeholder="All risk levels" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All risk levels</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={optOutFilter} onValueChange={v => { setOptOutFilter(v); setPage(1); }}>
            <SelectTrigger className="w-44 h-9 text-sm border-gray-200"><SelectValue placeholder="All email status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All email status</SelectItem>
              <SelectItem value="subscribed">Subscribed</SelectItem>
              <SelectItem value="opted_out">Opted out</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Quick-filter chips */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <button
            onClick={() => { setConsentOnly(p => !p); setPage(1); }}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-150 ${
              consentOnly ? "bg-emerald-600 text-white border-emerald-600 shadow-sm" : "bg-white text-[#1B365D] border-gray-200 hover:border-emerald-400 hover:text-emerald-700"
            }`}
          >
            <Users className="h-3 w-3" />
            Consented only
            {consentOnly && <span className="ml-0.5 opacity-75">✕</span>}
          </button>

          <button
            onClick={() => { setNotContacted(p => !p); setPage(1); }}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-150 ${
              notContacted ? "bg-[#1B365D] text-white border-[#1B365D] shadow-sm" : "bg-white text-[#1B365D] border-gray-200 hover:border-[#1B365D]/50"
            }`}
          >
            <PhoneOff className="h-3 w-3" />
            Not yet contacted
            {notContacted && <span className="ml-0.5 opacity-75">✕</span>}
          </button>

          <button
            onClick={() => { setHasNotes(p => !p); setPage(1); }}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-150 ${
              hasNotes ? "bg-amber-500 text-white border-amber-500 shadow-sm" : "bg-white text-[#1B365D] border-gray-200 hover:border-amber-400 hover:text-amber-600"
            }`}
          >
            <FileText className="h-3 w-3" />
            Has notes
            {hasNotes && <span className="ml-0.5 opacity-75">✕</span>}
          </button>

          {activeChips.length > 0 && (
            <span className="text-xs text-[#8C757D]">Filtering by: {activeChips.join(" + ")}</span>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 text-[#F47458] animate-spin" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-16 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 mr-2" /> Failed to load assessments.
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <ClipboardCheck className="h-10 w-10 text-gray-200 mb-3" />
              <p className="text-sm font-medium text-[#1B365D] mb-1">No assessments found</p>
              <p className="text-xs text-[#8C757D]">
                {activeChips.length > 0 ? "Try adjusting your filters." : "Share the public assessment link to start collecting leads."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-[#F8F9FA]">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Institution</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Respondent</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Score / Risk</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Pipeline Stage</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">
                      <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" /> Follow-up Due</span>
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Status</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger className="cursor-default">
                            <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> Contacted</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs max-w-[200px]">
                            CRM flag — mark leads your team has followed up with offline.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">
                      <span className="flex items-center gap-1"><StickyNote className="h-3 w-3" /> Notes</span>
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[#8C757D] uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const stage = ((row as any).pipelineStage ?? "new") as PipelineStage;
                    const dueAt = (row as any).followUpDueAt;
                    const overdue = isOverdue(dueAt, stage);
                    return (
                      <tr
                        key={row.id}
                        className={`border-b border-gray-50 transition-colors ${
                          overdue
                            ? "bg-amber-50/40 hover:bg-amber-50/70"
                            : i % 2 === 0 ? "hover:bg-[#F8F9FA]" : "bg-gray-50/30 hover:bg-[#F8F9FA]"
                        }`}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-[#1B365D] truncate max-w-[150px]">
                            {row.institutionName ?? <span className="text-[#8C757D] italic">Anonymous</span>}
                          </p>
                          <p className="text-xs text-[#8C757D]">
                            {row.institutionType ? INST_TYPE_LABELS[row.institutionType] ?? row.institutionType : "—"}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-[#1B365D] truncate max-w-[130px]">{row.respondentName ?? "—"}</p>
                          {row.respondentEmail && (
                            <p className="text-xs text-[#8C757D] truncate max-w-[130px]">{row.respondentEmail}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <ScoreBar score={row.overallScore ?? 0} />
                          <div className="mt-1">
                            <RiskBadge level={row.riskLevel ?? "medium"} />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <PipelineStageCell token={row.token} initialStage={stage} />
                        </td>
                        <td className="px-4 py-3">
                          <FollowUpDateCell token={row.token} initialDueAt={dueAt} stage={stage} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-0.5">
                            {row.consentToContact ? (
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                                <CheckCircle2 className="h-3 w-3" /> Consented
                              </span>
                            ) : (
                              <span className="text-xs text-[#8C757D]">No consent</span>
                            )}
                            {row.followUpEmailSent && (
                              <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                                <Mail className="h-3 w-3" /> Auto-email sent
                              </span>
                            )}
                            {(row as any).emailOptedOut && (
                              <span className="inline-flex items-center gap-1 text-xs text-red-500 font-medium">
                                <X className="h-3 w-3" /> Opted out
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <MarkContactedButton
                            token={row.token}
                            markedContacted={(row as any).markedContacted ?? false}
                            lastContactedAt={(row as any).lastContactedAt ?? null}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <InlineNotes token={row.token} initialNotes={(row as any).adminNotes ?? null} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <DemoInviteButton
                              token={row.token}
                              hasEmail={!!row.respondentEmail}
                              demoInviteSent={row.demoInviteSent ?? false}
                            />
                            <a
                              href={`/compliance-assessment/result/${row.token}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center text-xs text-[#1B365D]/50 hover:text-[#1B365D]"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !error && rows.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
              <p className="text-xs text-[#8C757D]">
                Showing {((page - 1) * 20) + 1}–{Math.min(page * 20, data?.total ?? 0)} of {data?.total ?? 0} assessments
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="h-7 w-7 p-0 border-gray-200">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-[#8C757D]">{page} / {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="h-7 w-7 p-0 border-gray-200">
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bulk Send Confirmation Dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#1B365D]">
              <Zap className="h-5 w-5 text-[#F47458]" /> Bulk Send Demo Invites
            </DialogTitle>
            <DialogDescription className="text-sm text-[#8C757D] pt-1">
              This will send a personalised demo invitation email to every respondent who:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            {["Consented to be contacted", "Has a valid email address on record", "Has not yet received a demo invite", "Has not opted out of emails"].map((cond) => (
              <div key={cond} className="flex items-center gap-2 text-sm text-[#1B365D]">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" /> {cond}
              </div>
            ))}
          </div>
          <div className="rounded-lg bg-[#F8F9FA] border border-gray-100 px-4 py-3 text-center">
            {eligibleData === undefined ? (
              <div className="flex items-center justify-center gap-2 text-sm text-[#8C757D]">
                <Loader2 className="h-4 w-4 animate-spin" /> Counting eligible leads…
              </div>
            ) : eligibleData.count === 0 ? (
              <p className="text-sm text-[#8C757D]">No eligible leads — all consented respondents have already been invited.</p>
            ) : (
              <>
                <p className="text-3xl font-bold text-[#1B365D]">{eligibleData.count}</p>
                <p className="text-xs text-[#8C757D] mt-0.5">eligible lead{eligibleData.count !== 1 ? "s" : ""} will receive an invite</p>
              </>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkSend.isPending} className="border-gray-200 text-[#1B365D]">
              Cancel
            </Button>
            <Button
              className="bg-[#F47458] hover:bg-[#e0634a] text-white gap-1.5"
              onClick={() => bulkSend.mutate()}
              disabled={bulkSend.isPending || !eligibleData || eligibleData.count === 0}
            >
              {bulkSend.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : <><Zap className="h-4 w-4" /> Send {eligibleData?.count ?? ""} Invite{eligibleData?.count !== 1 ? "s" : ""}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
