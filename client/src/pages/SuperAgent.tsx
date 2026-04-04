import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Loader2,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Brain,
  MessageSquare,
  FileText,
  Mail,
  DollarSign,
  Clock,
  ChevronRight,
  Sparkles,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";
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

interface DiagnosisResult {
  exceptionId: number;
  category: string;
  rootCause: string;
  confidence: number;
  evidence: string[];
  proposedAction: ActionDraft;
  auditNote: string;
}

// ─── Agent Step Indicator ────────────────────────────────────────────

function AgentStep({ step, label, status }: { step: number; label: string; status: "pending" | "active" | "done" }) {
  return (
    <div className={`flex items-center gap-2 text-xs ${
      status === "done" ? "text-green-600" :
      status === "active" ? "text-primary" :
      "text-muted-foreground"
    }`}>
      <div className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
        status === "done" ? "bg-green-100 text-green-600" :
        status === "active" ? "bg-primary/10 text-primary" :
        "bg-muted text-muted-foreground"
      }`}>
        {status === "done" ? <CheckCircle2 className="h-3 w-3" /> : step}
      </div>
      <span className={status === "active" ? "font-medium" : ""}>{label}</span>
    </div>
  );
}

// ─── Action Draft Card ───────────────────────────────────────────────

function ActionDraftCard({
  draft,
  onApprove,
  onModify,
  onReject,
  isApproving,
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
      {/* Header */}
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

      {/* Details */}
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

      {/* HitL Approval Controls */}
      <div className="bg-amber-50/50 border-t px-4 py-3">
        <div className="flex items-center gap-1.5 mb-2">
          <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
          <span className="text-[11px] font-semibold text-amber-700">Human Approval Required — Draft Layer</span>
        </div>
        {!modifyMode ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-700"
              onClick={onApprove}
              disabled={isApproving}
            >
              {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Approve & Execute
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => setModifyMode(true)}
            >
              <FileText className="h-3 w-3" />
              Modify
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
              onClick={onReject}
            >
              <XCircle className="h-3 w-3" />
              Reject
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea
              placeholder="Describe your modification or add notes for the agent..."
              className="text-xs h-16 resize-none"
              value={modifyNotes}
              onChange={(e) => setModifyNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => { onModify(modifyNotes); setModifyMode(false); }}
                disabled={!modifyNotes.trim()}
              >
                Submit Modification
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setModifyMode(false)}
              >
                Cancel
              </Button>
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
          <div className={`rounded-lg px-3 py-2.5 text-sm ${
            isAgent
              ? "bg-muted/60 text-foreground"
              : "bg-primary text-primary-foreground"
          }`}>
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
  const [activeSteps, setActiveSteps] = useState<Record<string, "pending" | "active" | "done">>({});
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

    // Show thinking steps
    const thinkingId = addMessage({
      role: "agent",
      content: "Analysing your query and gathering context...",
      type: "thinking",
    });

    try {
      // Simulate multi-step agent reasoning with visual feedback
      await new Promise((r) => setTimeout(r, 600));
      removeMessage(thinkingId);

      const step1Id = addMessage({
        role: "agent",
        content: "Searching transaction records and exception queue...",
        type: "thinking",
      });
      await new Promise((r) => setTimeout(r, 700));
      removeMessage(step1Id);

      const step2Id = addMessage({
        role: "agent",
        content: "Running diagnostic reasoning engine...",
        type: "thinking",
      });

      const result = await agentQueryMutation.mutateAsync({ query: userQuery });
      removeMessage(step2Id);

      if (result.actionDraft) {
        addMessage({
          role: "agent",
          content: result.diagnosis,
          type: "diagnosis",
        });
        addMessage({
          role: "agent",
          content: `I have prepared a draft action for your review. Please examine the details below and approve, modify, or reject.`,
          type: "action_draft",
          actionDraft: result.actionDraft,
        });
      } else {
        addMessage({
          role: "agent",
          content: result.diagnosis,
          type: "result",
        });
      }
    } catch (err: any) {
      removeMessage(thinkingId);
      addMessage({
        role: "agent",
        content: `I encountered an error while processing your request: ${err.message || "Unknown error"}. Please try again or rephrase your query.`,
        type: "text",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApprove = async (msgId: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg?.actionDraft) return;
    setApprovingMsgId(msgId);
    try {
      await agentApproveMutation.mutateAsync({
        actionType: msg.actionDraft.type,
        details: msg.actionDraft.details,
        approved: true,
      });
      // Replace the action draft message with a success confirmation
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, actionDraft: undefined, content: `✓ Action approved and executed. ${msg.actionDraft!.title} has been committed to the audit trail. The finance team has been notified.` }
            : m
        )
      );
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
      const result = await agentQueryMutation.mutateAsync({
        query: `Revise the previous ${msg.actionDraft.type} draft with these modifications: ${notes}`,
      });
      removeMessage(thinkingId);
      // Remove old draft message and add revised one
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
      addMessage({
        role: "agent",
        content: result.diagnosis,
        type: "action_draft",
        actionDraft: result.actionDraft || msg.actionDraft,
      });
    } catch {
      removeMessage(thinkingId);
      addMessage({ role: "agent", content: "I was unable to revise the draft. Please try again.", type: "text" });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = (msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? { ...m, actionDraft: undefined, content: "Draft rejected. The exception has been returned to the review queue for manual handling. No changes were made to your books." }
          : m
      )
    );
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
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b bg-background">
        <div className="flex items-center justify-between">
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-amber-700 font-medium">Draft Layer Active — No action commits without your approval</span>
          </div>
        </div>

        {/* Agent capability pills */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {[
            { icon: Brain, label: "Root Cause Diagnosis" },
            { icon: Zap, label: "Many-to-Many Matching" },
            { icon: Mail, label: "Vendor Communication" },
            { icon: FileText, label: "Journal Entry Drafting" },
            { icon: ShieldCheck, label: "HitL Approval Gate" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-[11px] bg-muted/60 rounded-full px-2.5 py-1 text-muted-foreground">
              <Icon className="h-3 w-3 text-primary" />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            msg={msg}
            onApprove={handleApprove}
            onModify={handleModify}
            onReject={handleReject}
            isApproving={approvingMsgId === msg.id}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested queries (show when only welcome message) */}
      {messages.length === 1 && (
        <div className="flex-shrink-0 px-6 pb-2">
          <p className="text-xs text-muted-foreground mb-2">Suggested queries:</p>
          <div className="grid grid-cols-2 gap-2">
            {suggestedQueries.map((q) => (
              <button
                key={q}
                onClick={() => setInput(q)}
                className="text-left text-xs bg-muted/40 hover:bg-muted/80 border rounded-md px-3 py-2 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                <ChevronRight className="h-3 w-3 flex-shrink-0 text-primary" />
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 px-6 pb-6 pt-3 border-t bg-background">
        <div className="flex gap-2 items-end">
          <Textarea
            placeholder="Ask the agent to investigate, diagnose, or draft an action..."
            className="resize-none text-sm min-h-[44px] max-h-[120px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={isProcessing}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isProcessing}
            className="h-11 w-11 p-0 flex-shrink-0"
          >
            {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          All agent actions are logged to the immutable audit trail. Press Enter to send, Shift+Enter for new line.
        </p>
      </div>
    </div>
  );
}
