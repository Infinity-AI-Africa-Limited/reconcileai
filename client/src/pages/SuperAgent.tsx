import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  Bot, Loader2, Send, CheckCircle2, XCircle, AlertTriangle, Zap, Brain,
  MessageSquare, FileText, Mail, DollarSign, Clock, ChevronRight, Sparkles,
  ShieldCheck, GitMerge, ArrowRight, CheckCheck, Info, Database, Inbox,
  RefreshCw, ThumbsUp, ThumbsDown, Edit3, Filter,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────

interface AgentMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  type?: "thinking" | "diagnosis" | "action_draft" | "result" | "text";
  actionDraft?: ActionDraft;
}

interface ActionDraft {
  type: "journal_entry" | "vendor_email" | "credit_note_request" | "payment_allocation" | "escalation";
  title: string;
  description: string;
  details: Record<string, string>;
  riskLevel: "low" | "medium" | "high";
}

// ─── Many-to-Many Demo Data ──────────────────────────────────────────

const M2M_DEPOSIT = {
  amount: "₦10,000,000.00",
  sender: "Kola Ventures Ltd",
  bankRef: "GTB-20240115-KV-001",
  valueDate: "15 Jan 2024",
  account: "0123456789 — ReconcileAI Demo Co.",
};

const M2M_INVOICES = [
  {
    id: "INV-2024-00847",
    description: "Distributor stock replenishment — Lagos Zone A",
    amount: "₦4,200,000.00",
    dueDate: "12 Jan 2024",
    confidence: 99.1,
    matchReason: "Exact payment reference match + amount within tolerance",
    status: "matched" as const,
  },
  {
    id: "INV-2024-00851",
    description: "Distributor stock replenishment — Lagos Zone B",
    amount: "₦3,800,000.00",
    dueDate: "14 Jan 2024",
    confidence: 97.8,
    matchReason: "Amount match + distributor pattern + date window (1 day)",
    status: "matched" as const,
  },
  {
    id: "INV-2024-00863",
    description: "Promotional stock advance — Q1 2024",
    amount: "₦2,000,000.00",
    dueDate: "20 Jan 2024",
    confidence: 94.3,
    matchReason: "Distributor identity match + partial reference similarity",
    status: "matched" as const,
  },
];

const M2M_STEPS = [
  { id: 1, label: "Ingest bank deposit", description: "Agent reads the ₦10M deposit from the GTBank feed" },
  { id: 2, label: "Identify payer", description: "Distributor Identity Registry resolves 'Kola Ventures Ltd' → Canonical ID: DIST-0042" },
  { id: 3, label: "Retrieve open invoices", description: "3 open invoices found for DIST-0042 totalling ₦10,000,000" },
  { id: 4, label: "Run many-to-many split", description: "Balance Engine allocates deposit across all 3 invoices with confidence scoring" },
  { id: 5, label: "Generate allocation draft", description: "Draft presented to finance team for HitL approval" },
];

// ─── Action Draft Card ───────────────────────────────────────────────

function ActionDraftCard({
  draft, onApprove, onModify, onReject, isApproving,
}: {
  draft: ActionDraft;
  onApprove: () => void;
  onModify: (notes: string) => void;
  onReject: () => void;
  isApproving: boolean;
}) {
  const [modifyMode, setModifyMode] = useState(false);
  const [modifyNotes, setModifyNotes] = useState("");

  const typeIcon = {
    journal_entry: <FileText className="h-4 w-4" />,
    vendor_email: <Mail className="h-4 w-4" />,
    credit_note_request: <DollarSign className="h-4 w-4" />,
    payment_allocation: <CheckCircle2 className="h-4 w-4" />,
    escalation: <AlertTriangle className="h-4 w-4" />,
  }[draft.type];

  const typeLabel = {
    journal_entry: "Journal Entry Draft",
    vendor_email: "Vendor Email Draft",
    credit_note_request: "Credit Note Request",
    payment_allocation: "Payment Allocation",
    escalation: "Escalation Notice",
  }[draft.type];

  const riskColors = {
    low: "bg-green-50 border-green-200 text-green-700",
    medium: "bg-amber-50 border-amber-200 text-amber-700",
    high: "bg-red-50 border-red-200 text-red-700",
  };

  return (
    <div className="mt-3 border rounded-lg overflow-hidden">
      <div className="bg-primary/5 border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center text-primary">
            {typeIcon}
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{typeLabel}</p>
            <p className="text-xs text-muted-foreground">{draft.title}</p>
          </div>
        </div>
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${riskColors[draft.riskLevel]}`}>
          {draft.riskLevel.toUpperCase()} RISK
        </span>
      </div>
      <div className="px-4 py-3 space-y-2">
        <p className="text-xs text-muted-foreground">{draft.description}</p>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {Object.entries(draft.details).map(([key, value]) => (
            <div key={key} className="bg-muted/40 rounded px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{key.replace(/_/g, " ")}</p>
              <p className="text-xs font-medium text-foreground mt-0.5 truncate">{value}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-amber-50/50 border-t px-4 py-3">
        <div className="flex items-center gap-1.5 mb-2">
          <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
          <span className="text-[11px] font-semibold text-amber-700">Human Approval Required — Draft Layer</span>
        </div>
        {!modifyMode ? (
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-700" onClick={onApprove} disabled={isApproving}>
              {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Approve & Execute
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setModifyMode(true)}>
              <FileText className="h-3 w-3" /> Modify
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-red-600 border-red-200 hover:bg-red-50" onClick={onReject}>
              <XCircle className="h-3 w-3" /> Reject
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea placeholder="Describe your modification..." className="text-xs h-16 resize-none" value={modifyNotes} onChange={(e) => setModifyNotes(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => { onModify(modifyNotes); setModifyMode(false); }} disabled={!modifyNotes.trim()}>Submit Modification</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setModifyMode(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Chat Message ────────────────────────────────────────────────────

function ChatMessage({ msg, onApprove, onModify, onReject, isApproving }: {
  msg: AgentMessage;
  onApprove?: (msgId: string) => void;
  onModify?: (msgId: string, notes: string) => void;
  onReject?: (msgId: string) => void;
  isApproving?: boolean;
}) {
  const isAgent = msg.role === "agent";
  return (
    <div className={`flex gap-3 ${isAgent ? "" : "flex-row-reverse"}`}>
      {isAgent && (
        <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bot className="h-4 w-4 text-primary-foreground" />
        </div>
      )}
      <div className={`max-w-[85%] ${isAgent ? "" : "items-end flex flex-col"}`}>
        {msg.type === "thinking" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground italic py-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {msg.content}
          </div>
        ) : (
          <div className={`rounded-lg px-3 py-2.5 text-sm ${isAgent ? "bg-muted/60 text-foreground" : "bg-primary text-primary-foreground"}`}>
            <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
          </div>
        )}
        {msg.actionDraft && onApprove && onModify && onReject && (
          <ActionDraftCard
            draft={msg.actionDraft}
            onApprove={() => onApprove(msg.id)}
            onModify={(notes) => onModify(msg.id, notes)}
            onReject={() => onReject(msg.id)}
            isApproving={isApproving || false}
          />
        )}
        <p className="text-[10px] text-muted-foreground mt-1 px-1">
          {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

// ─── Many-to-Many Demo Tab ───────────────────────────────────────────

function ManyToManyDemo() {
  const [demoStep, setDemoStep] = useState(0); // 0 = idle, 1-5 = steps, 6 = complete
  const [approved, setApproved] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const runDemo = async () => {
    setIsRunning(true);
    setApproved(false);
    for (let i = 1; i <= 5; i++) {
      setDemoStep(i);
      await new Promise((r) => setTimeout(r, 900));
    }
    setDemoStep(6);
    setIsRunning(false);
  };

  const reset = () => { setDemoStep(0); setApproved(false); };

  const totalInvoiceAmount = M2M_INVOICES.reduce((sum, inv) => {
    const num = parseFloat(inv.amount.replace(/[₦,]/g, ""));
    return sum + num;
  }, 0);

  const avgConfidence = Math.round(M2M_INVOICES.reduce((s, i) => s + i.confidence, 0) / M2M_INVOICES.length * 10) / 10;

  return (
    <div className="p-6 space-y-6">
      {/* Explainer banner */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-3">
        <Info className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Many-to-Many Matching</span> is the ability to split a single bank deposit across multiple open invoices — or aggregate multiple payments against a single invoice. Standard reconciliation tools cannot do this. ReconcileAI's Super Agent handles it natively, with full reasoning and HitL approval.
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Left: Incoming deposit + agent steps */}
        <div className="space-y-4">
          {/* Deposit card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <div className="h-6 w-6 rounded bg-blue-100 flex items-center justify-center">
                  <DollarSign className="h-3.5 w-3.5 text-blue-600" />
                </div>
                Incoming Bank Deposit
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-bold text-lg text-foreground">{M2M_DEPOSIT.amount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Sender</span>
                <span className="font-medium">{M2M_DEPOSIT.sender}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Bank Reference</span>
                <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{M2M_DEPOSIT.bankRef}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Value Date</span>
                <span>{M2M_DEPOSIT.valueDate}</span>
              </div>
            </CardContent>
          </Card>

          {/* Agent reasoning steps */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Brain className="h-4 w-4 text-primary" />
                Agent Reasoning Steps
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {M2M_STEPS.map((step) => {
                const status = demoStep === 0 ? "pending" : demoStep > step.id ? "done" : demoStep === step.id ? "active" : "pending";
                return (
                  <div key={step.id} className={`flex gap-3 transition-all duration-300 ${status === "pending" ? "opacity-40" : "opacity-100"}`}>
                    <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 transition-colors ${
                      status === "done" ? "bg-green-100 text-green-600" :
                      status === "active" ? "bg-primary text-primary-foreground" :
                      "bg-muted text-muted-foreground"
                    }`}>
                      {status === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : status === "active" ? <Loader2 className="h-3 w-3 animate-spin" /> : step.id}
                    </div>
                    <div>
                      <p className={`text-sm font-medium ${status === "active" ? "text-primary" : "text-foreground"}`}>{step.label}</p>
                      <p className="text-xs text-muted-foreground">{step.description}</p>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Run button */}
          {demoStep === 0 && (
            <Button className="w-full gap-2" onClick={runDemo}>
              <Zap className="h-4 w-4" />
              Run Many-to-Many Matching Demo
            </Button>
          )}
          {isRunning && (
            <div className="text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Agent is processing…
            </div>
          )}
          {demoStep === 6 && !isRunning && !approved && (
            <Button variant="outline" className="w-full gap-2 text-muted-foreground" onClick={reset}>
              Reset Demo
            </Button>
          )}
        </div>

        {/* Right: Invoice allocation results */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <GitMerge className="h-4 w-4 text-primary" />
                Proposed Invoice Allocation
                {demoStep >= 6 && (
                  <Badge className="ml-auto bg-green-100 text-green-700 border-green-200 text-[10px]">
                    Ready for Approval
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {M2M_INVOICES.map((inv, i) => {
                const visible = demoStep >= 4 + i - 1 && demoStep > 0;
                return (
                  <div key={inv.id} className={`border rounded-lg overflow-hidden transition-all duration-500 ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"} ${approved ? "border-green-300 bg-green-50/30" : "border-border"}`}>
                    <div className="px-3 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs font-semibold text-primary">{inv.id}</span>
                        {approved ? (
                          <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px] gap-1">
                            <CheckCheck className="h-2.5 w-2.5" /> Committed
                          </Badge>
                        ) : visible ? (
                          <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-[10px]">Draft</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">{inv.description}</p>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-foreground">{inv.amount}</span>
                        <span className="text-xs text-muted-foreground">Due {inv.dueDate}</span>
                      </div>
                      {visible && (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-muted-foreground">Confidence</span>
                            <span className={`font-semibold ${inv.confidence >= 97 ? "text-green-600" : "text-amber-600"}`}>{inv.confidence}%</span>
                          </div>
                          <Progress value={inv.confidence} className="h-1.5" />
                          <p className="text-[10px] text-muted-foreground italic">{inv.matchReason}</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {demoStep >= 6 && (
                <div className="border-t pt-3 space-y-1">
                  <div className="flex justify-between text-sm font-semibold">
                    <span>Total Allocated</span>
                    <span className="text-green-600">₦{totalInvoiceAmount.toLocaleString()}.00</span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Average Confidence</span>
                    <span>{avgConfidence}%</span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Unallocated Balance</span>
                    <span className="text-green-600">₦0.00</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* HitL Approval Panel */}
          {demoStep >= 6 && !approved && (
            <div className="border border-amber-200 bg-amber-50/60 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-800">Human Approval Required</span>
              </div>
              <p className="text-xs text-amber-700 mb-4">
                The Super Agent has proposed splitting the ₦10M deposit across 3 invoices with an average confidence of {avgConfidence}%. Review the allocation above and approve to commit to your books, or reject to return to manual review.
              </p>
              <div className="flex gap-3">
                <Button
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white gap-2"
                  onClick={() => {
                    setApproved(true);
                    toast.success("Allocation approved — 3 invoices matched and committed to audit trail");
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve Allocation
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-red-600 border-red-200 hover:bg-red-50 gap-2"
                  onClick={() => {
                    reset();
                    toast.info("Allocation rejected — returned to manual review queue");
                  }}
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </Button>
              </div>
            </div>
          )}

          {approved && (
            <div className="border border-green-300 bg-green-50 rounded-lg p-4 text-center">
              <CheckCheck className="h-8 w-8 text-green-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-green-800">Allocation Committed</p>
              <p className="text-xs text-green-700 mt-1">
                3 invoices matched. Logged to audit trail with timestamp and approver ID. Books updated.
              </p>
              <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={reset}>
                Run Demo Again
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action Drafts Queue Tab ────────────────────────────────────────

function ActionDraftsQueue() {
  const [statusFilter, setStatusFilter] = useState<string>("pending_approval");
  const [selectedDraft, setSelectedDraft] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const { data, isLoading, refetch } = trpc.superAgent.getDrafts.useQuery({
    status: statusFilter as any,
    limit: 50,
    offset: 0,
  });

  const resolveMutation = trpc.superAgent.resolveDraft.useMutation({
    onSuccess: (res) => {
      toast.success(res.message);
      setSelectedDraft(null);
      setShowRejectInput(false);
      setRejectReason("");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      pending_approval: "bg-amber-100 text-amber-700 border-amber-200",
      approved: "bg-green-100 text-green-700 border-green-200",
      rejected: "bg-red-100 text-red-700 border-red-200",
      executed: "bg-blue-100 text-blue-700 border-blue-200",
      modified: "bg-purple-100 text-purple-700 border-purple-200",
    };
    return map[s] || "bg-muted text-muted-foreground";
  };

  const actionIcon = (t: string) => ({
    vendor_email: <Mail className="h-4 w-4" />,
    credit_note_request: <DollarSign className="h-4 w-4" />,
    journal_entry: <FileText className="h-4 w-4" />,
    payment_allocation: <CheckCircle2 className="h-4 w-4" />,
    escalate_to_manager: <AlertTriangle className="h-4 w-4" />,
    no_action: <Info className="h-4 w-4" />,
  }[t] || <FileText className="h-4 w-4" />);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Action Draft Queue</h2>
          <p className="text-xs text-muted-foreground mt-0.5">All agent-generated action drafts pending your review. Nothing executes without approval.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 text-xs w-44">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="modified">Modified</SelectItem>
              <SelectItem value="executed">Executed</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading drafts...
        </div>
      ) : !data?.drafts.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Inbox className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No drafts found</p>
          <p className="text-xs mt-1">Use the Agent Chat to generate action drafts from exceptions</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {data.drafts.map((draft) => (
            <div
              key={draft.id}
              className={`border rounded-lg overflow-hidden cursor-pointer transition-all hover:shadow-sm ${
                selectedDraft?.id === draft.id ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => setSelectedDraft(selectedDraft?.id === draft.id ? null : draft)}
            >
              <div className="px-4 py-3 flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
                    {actionIcon(draft.actionType)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{draft.subject}</p>
                    <p className="text-xs text-muted-foreground">{draft.actionType.replace(/_/g, " ")}</p>
                  </div>
                </div>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${statusBadge(draft.status)}`}>
                  {draft.status.replace(/_/g, " ").toUpperCase()}
                </span>
              </div>
              {draft.transactionRef && (
                <div className="px-4 pb-2">
                  <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{draft.transactionRef}</span>
                </div>
              )}
              {selectedDraft?.id === draft.id && (
                <div className="border-t px-4 py-3 space-y-3 bg-muted/20">
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{draft.body}</p>
                  {draft.status === "pending_approval" && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
                        <span className="text-[11px] font-semibold text-amber-700">Human Approval Required</span>
                      </div>
                      {!showRejectInput ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm" className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-700"
                            disabled={resolveMutation.isPending}
                            onClick={(e) => { e.stopPropagation(); resolveMutation.mutate({ draftId: draft.id, decision: "approved" }); }}
                          >
                            {resolveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />}
                            Approve
                          </Button>
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs gap-1.5"
                            onClick={(e) => { e.stopPropagation(); setShowRejectInput(true); }}
                          >
                            <Edit3 className="h-3 w-3" /> Modify
                          </Button>
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                            onClick={(e) => { e.stopPropagation(); setShowRejectInput(true); }}
                          >
                            <ThumbsDown className="h-3 w-3" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                          <Textarea
                            placeholder="Reason for rejection or modification instructions..."
                            className="text-xs h-16 resize-none"
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700"
                              disabled={resolveMutation.isPending || !rejectReason.trim()}
                              onClick={() => resolveMutation.mutate({ draftId: draft.id, decision: "rejected", rejectionReason: rejectReason })}
                            >
                              Confirm Reject
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setShowRejectInput(false); setRejectReason(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Memory Layer Panel Tab ───────────────────────────────────────────

function MemoryLayerPanel() {
  const [searchText, setSearchText] = useState("");
  const { data, isLoading, refetch } = trpc.superAgent.getSimilarCases.useQuery(
    { embeddingText: searchText || "exception unmatched distributor payment", topK: 10 },
    { enabled: true }
  );
  const { data: demoStatus } = trpc.demo.status.useQuery();
  const activateDemo = trpc.demo.activate.useMutation({
    onSuccess: () => {
      toast.success("Demo memory loaded", { description: "12 realistic FMCG resolution records added to the memory layer." });
      refetch();
    },
    onError: (err) => toast.error("Failed to load demo memory", { description: err.message }),
  });

  const outcomeColor = (o: string) => ({
    resolved: "bg-green-100 text-green-700 border-green-200",
    escalated: "bg-amber-100 text-amber-700 border-amber-200",
    rejected: "bg-red-100 text-red-700 border-red-200",
  }[o] || "bg-muted text-muted-foreground");

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Semantic Memory Layer</h2>
          <p className="text-xs text-muted-foreground mt-0.5">The agent's institutional knowledge — past exception resolutions stored as searchable reasoning records.</p>
        </div>
        <div className="flex gap-2">
          {!demoStatus?.active && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5 border-purple-200 text-purple-700 hover:bg-purple-50"
              onClick={() => activateDemo.mutate({ segment: "fmcg" })}
              disabled={activateDemo.isPending}
            >
              {activateDemo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
              Load Demo Memory
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => refetch()}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-3">
        <Brain className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">How the memory layer works:</span> Every time a finance team member resolves an exception, the reasoning is stored here. When the agent encounters a similar case in future, it retrieves the most relevant past resolutions and uses them to generate a more accurate diagnosis — without retraining the model.
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Search memory by keyword (e.g. 'partial payment', 'bank fee', 'damaged goods')..."
          className="flex-1 h-9 text-sm border rounded-md px-3 bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Searching memory...
        </div>
      ) : !data?.cases.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Database className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">Memory layer is empty</p>
          <p className="text-xs mt-1">Resolved exceptions will appear here as the agent learns from your team's decisions</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.cases.map(({ memory, similarity }) => (
            <div key={memory.id} className="border rounded-lg overflow-hidden">
              <div className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-foreground capitalize">{memory.exceptionCategory.replace(/_/g, " ")}</span>
                    {memory.deductionType && (
                      <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{memory.deductionType}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{memory.resolution}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${outcomeColor(memory.outcome)}`}>
                    {memory.outcome.toUpperCase()}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{Math.round(similarity * 100)}% match</span>
                </div>
              </div>
              <div className="border-t px-4 py-2 bg-muted/20">
                <p className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Reasoning:</span> {memory.reasoning}</p>
              </div>
              <div className="px-4 py-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>Amount range: <span className="font-medium text-foreground">{memory.amountRange}</span></span>
                <span>·</span>
                <span>Counterparty: <span className="font-medium text-foreground">{memory.counterpartyType}</span></span>
                <span>·</span>
                <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Super Agent Page ───────────────────────────────────────────

export default function SuperAgentPage() {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "welcome",
      role: "agent",
      content: `Hello. I am the ReconcileAI Super Agent.\n\nI can autonomously investigate exceptions, diagnose root causes, and draft resolution actions for your approval. Nothing is committed to your books without your sign-off.\n\nYou can:\n• Ask me to investigate a specific exception ("Investigate exception #42")\n• Ask me why a payment is unmatched ("Why is the ₦2.4M payment from Kola Ventures unmatched?")\n• Ask me to analyse your reconciliation health ("What is causing the high exception rate this week?")\n• Request a draft action ("Draft a vendor email for the shortfall on Order #ORD-2847")\n\nWhat would you like me to investigate?`,
      timestamp: new Date(),
      type: "text",
    },
  ]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [approvingMsgId, setApprovingMsgId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agentQueryMutation = trpc.superAgent.query.useMutation();
  const agentApproveMutation = trpc.superAgent.approveAction.useMutation();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = (msg: Omit<AgentMessage, "id" | "timestamp">) => {
    const newMsg: AgentMessage = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newMsg]);
    return newMsg.id;
  };

  const removeMessage = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;
    const userQuery = input.trim();
    setInput("");
    setIsProcessing(true);
    addMessage({ role: "user", content: userQuery, type: "text" });
    const thinkingId = addMessage({ role: "agent", content: "Analysing your query and gathering context...", type: "thinking" });
    try {
      await new Promise((r) => setTimeout(r, 600));
      removeMessage(thinkingId);
      const step1Id = addMessage({ role: "agent", content: "Searching transaction records and exception queue...", type: "thinking" });
      await new Promise((r) => setTimeout(r, 700));
      removeMessage(step1Id);
      const step2Id = addMessage({ role: "agent", content: "Running diagnostic reasoning engine...", type: "thinking" });
      const result = await agentQueryMutation.mutateAsync({ query: userQuery });
      removeMessage(step2Id);
      if (result.actionDraft) {
        addMessage({ role: "agent", content: result.diagnosis, type: "diagnosis" });
        addMessage({ role: "agent", content: `I have prepared a draft action for your review. Please examine the details below and approve, modify, or reject.`, type: "action_draft", actionDraft: result.actionDraft });
      } else {
        addMessage({ role: "agent", content: result.diagnosis, type: "result" });
      }
    } catch (err: any) {
      removeMessage(thinkingId);
      addMessage({ role: "agent", content: `I encountered an error: ${err.message || "Unknown error"}. Please try again.`, type: "text" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApprove = async (msgId: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg?.actionDraft) return;
    setApprovingMsgId(msgId);
    try {
      await agentApproveMutation.mutateAsync({ actionType: msg.actionDraft.type, details: msg.actionDraft.details, approved: true });
      setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, actionDraft: undefined, content: `✓ Action approved and executed. ${msg.actionDraft!.title} has been committed to the audit trail.` } : m));
      toast.success("Action approved and logged to audit trail");
    } catch (err: any) {
      toast.error(err.message || "Approval failed");
    } finally {
      setApprovingMsgId(null);
    }
  };

  const handleModify = async (msgId: string, notes: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg?.actionDraft) return;
    setIsProcessing(true);
    addMessage({ role: "user", content: `Modification request: ${notes}`, type: "text" });
    const thinkingId = addMessage({ role: "agent", content: "Revising the draft based on your instructions...", type: "thinking" });
    try {
      const result = await agentQueryMutation.mutateAsync({ query: `Revise the previous ${msg.actionDraft.type} draft with these modifications: ${notes}` });
      removeMessage(thinkingId);
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
      addMessage({ role: "agent", content: result.diagnosis, type: "action_draft", actionDraft: result.actionDraft || msg.actionDraft });
    } catch {
      removeMessage(thinkingId);
      addMessage({ role: "agent", content: "I was unable to revise the draft. Please try again.", type: "text" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = (msgId: string) => {
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, actionDraft: undefined, content: "Draft rejected. Exception returned to the review queue. No changes were made to your books." } : m));
    toast.info("Draft rejected — exception returned to review queue");
  };

  const suggestedQueries = [
    "Why is the suspense account balance high this week?",
    "Investigate the top 3 unmatched exceptions",
    "Draft a vendor email for the largest amount mismatch",
    "What patterns are causing the most exceptions?",
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b bg-background">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2">
                Super Agent Workspace
                <Badge variant="secondary" className="text-[10px] font-semibold">BETA</Badge>
              </h1>
              <p className="text-xs text-muted-foreground">Autonomous reconciliation intelligence with Human-in-the-Loop approval</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-amber-700 font-medium">Draft Layer Active — No action commits without your approval</span>
          </div>
        </div>

        <Tabs defaultValue="chat" className="w-full">
          <TabsList className="h-8">
            <TabsTrigger value="chat" className="text-xs gap-1.5 h-7">
              <MessageSquare className="h-3 w-3" /> Agent Chat
            </TabsTrigger>
            <TabsTrigger value="m2m" className="text-xs gap-1.5 h-7">
              <GitMerge className="h-3 w-3" /> Many-to-Many Demo
              <Badge className="ml-1 bg-primary/10 text-primary border-none text-[9px] px-1">NEW</Badge>
            </TabsTrigger>
            <TabsTrigger value="drafts" className="text-xs gap-1.5 h-7">
              <Inbox className="h-3 w-3" /> Action Drafts
            </TabsTrigger>
            <TabsTrigger value="memory" className="text-xs gap-1.5 h-7">
              <Database className="h-3 w-3" /> Memory Layer
            </TabsTrigger>
          </TabsList>

          {/* ── Chat Tab ── */}
          <TabsContent value="chat" className="mt-0 flex flex-col" style={{ height: "calc(100vh - 14rem)" }}>
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {messages.map((msg) => (
                <ChatMessage key={msg.id} msg={msg} onApprove={handleApprove} onModify={handleModify} onReject={handleReject} isApproving={approvingMsgId === msg.id} />
              ))}
              <div ref={messagesEndRef} />
            </div>
            {messages.length === 1 && (
              <div className="flex-shrink-0 pb-2">
                <p className="text-xs text-muted-foreground mb-2">Suggested queries:</p>
                <div className="grid grid-cols-2 gap-2">
                  {suggestedQueries.map((q) => (
                    <button key={q} onClick={() => setInput(q)} className="text-left text-xs bg-muted/40 hover:bg-muted/80 border rounded-md px-3 py-2 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                      <ChevronRight className="h-3 w-3 flex-shrink-0 text-primary" />
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex-shrink-0 pt-3 border-t bg-background">
              <div className="flex gap-2 items-end">
                <Textarea
                  placeholder="Ask the agent to investigate, diagnose, or draft an action..."
                  className="resize-none text-sm min-h-[44px] max-h-[120px]"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  disabled={isProcessing}
                />
                <Button onClick={handleSend} disabled={!input.trim() || isProcessing} className="h-11 w-11 p-0 flex-shrink-0">
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                All agent actions are logged to the immutable audit trail. Press Enter to send, Shift+Enter for new line.
              </p>
            </div>
          </TabsContent>

          {/* ── Many-to-Many Demo Tab ── */}
          <TabsContent value="m2m" className="mt-0 overflow-y-auto" style={{ height: "calc(100vh - 14rem)" }}>
            <ManyToManyDemo />
          </TabsContent>

          {/* ── Action Drafts Tab ── */}
          <TabsContent value="drafts" className="mt-0 overflow-y-auto" style={{ height: "calc(100vh - 14rem)" }}>
            <ActionDraftsQueue />
          </TabsContent>

          {/* ── Memory Layer Tab ── */}
          <TabsContent value="memory" className="mt-0 overflow-y-auto" style={{ height: "calc(100vh - 14rem)" }}>
            <MemoryLayerPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
