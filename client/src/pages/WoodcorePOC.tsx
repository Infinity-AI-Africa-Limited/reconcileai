/**
 * ReconcileAI — Woodcore POC Dashboard
 * Demonstrates all three layers of the reconciliation engine against
 * the real Woodcore CBS dataset (August 2025 dump).
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Play,
  RefreshCw,
  Database,
  Layers,
  Bot,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronDown,
  ChevronUp,
  FileText,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Layer1Result = {
  runId: number;
  productId: number;
  productName: string;
  portfolioLedgerAccountId: number;
  portfolioLedgerGlCode: string;
  portfolioLedgerName: string;
  expectedBalance: number;
  actualGlBalance: number;
  varianceAmount: number;
  varianceDirection: "OVER_POSTED" | "UNDER_POSTED" | "BALANCED";
  variancePercent?: number;
  status: "BALANCED" | "VARIANCE_DETECTED";
  layer2Triggered: boolean;
  glDebits: number;
  glCredits: number;
  savingsDeposits: number;
  savingsWithdrawals: number;
  currencyCode: string;
  periodStart: string;
  periodEnd: string;
};

type Layer2Exception = {
  glEntryId: number;
  exceptionCategory: string;
  exceptionContribution: number;
  glEntryAmount: number;
  glEntryDate: string;
  glEntryType: string;
  manualEntryFlag: number | boolean;
  linkedTransactionId: string | null;
  linkedSavingsTxnId: number | null;
  linkedSavingsAccountId: number | null;
  linkedProductId: number | null;
  productMatch: number | null;
  refNum: string | null;
  description: string | null;
};

type Layer3Result = {
  exceptionId: number;
  agentClassification: string;
  agentExplanation: string;
  agentConfidence: number;
  recommendedAction: string;
  priorityLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
};

type POCResult = {
  layer1: Layer1Result;
  layer2Exceptions: Layer2Exception[];
  layer3Results: Layer3Result[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNGN(amount: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function categoryColor(cat: string): string {
  switch (cat) {
    case "CROSS_PRODUCT_MISPOSTING": return "bg-red-100 text-red-800 border-red-200";
    case "MANUAL_POSTING": return "bg-orange-100 text-orange-800 border-orange-200";
    case "ORPHANED_ENTRY": return "bg-purple-100 text-purple-800 border-purple-200";
    case "REVERSAL_ANOMALY": return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "MANUAL_POSTING_ANOMALY": return "bg-blue-100 text-blue-800 border-blue-200";
    case "VALID": return "bg-green-100 text-green-800 border-green-200";
    default: return "bg-gray-100 text-gray-800 border-gray-200";
  }
}

function priorityColor(p: string): string {
  switch (p) {
    case "CRITICAL": return "bg-red-600 text-white";
    case "HIGH": return "bg-orange-500 text-white";
    case "MEDIUM": return "bg-yellow-500 text-white";
    case "LOW": return "bg-blue-500 text-white";
    default: return "bg-gray-400 text-white";
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case "CROSS_PRODUCT_MISPOSTING": return "Cross-Product Mis-posting";
    case "MANUAL_POSTING": return "Manual Posting";
    case "ORPHANED_ENTRY": return "Orphaned Entry";
    case "REVERSAL_ANOMALY": return "Reversal Anomaly";
    case "MANUAL_POSTING_ANOMALY": return "Manual Posting Anomaly";
    case "VALID": return "Valid";
    default: return cat;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className={`rounded-xl border p-4 flex gap-3 items-start ${color}`}>
      <div className="mt-0.5">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs font-medium opacity-70 uppercase tracking-wide">{label}</p>
        <p className="text-xl font-bold mt-0.5">{value}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function Layer1Panel({ layer1 }: { layer1: Layer1Result }) {
  const isBalanced = layer1.varianceDirection === "BALANCED";
  const isOver = layer1.varianceDirection === "OVER_POSTED";

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <div className={`rounded-xl p-4 flex items-center gap-3 ${isBalanced ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
        {isBalanced
          ? <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
          : <AlertTriangle className="h-6 w-6 text-red-600 shrink-0" />
        }
        <div>
          <p className={`font-semibold text-sm ${isBalanced ? "text-green-800" : "text-red-800"}`}>
            {isBalanced ? "Reconciliation Balanced" : `Variance Detected — ${layer1.varianceDirection.replace("_", " ")}`}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            {layer1.productName} · {layer1.portfolioLedgerName} (GL {layer1.portfolioLedgerGlCode}) · {layer1.periodStart} to {layer1.periodEnd}
          </p>
        </div>
        {!isBalanced && (
          <Badge className="ml-auto bg-red-600 text-white text-sm px-3">
            {formatNGN(Math.abs(layer1.varianceAmount))} {isOver ? "over-posted" : "under-posted"}
          </Badge>
        )}
      </div>

      {/* Balance comparison */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Expected Balance</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatNGN(layer1.expectedBalance)}</p>
          <p className="text-xs text-gray-400 mt-1">Sum of account balances from CBS master</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Actual GL Balance</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatNGN(layer1.actualGlBalance)}</p>
          <p className="text-xs text-gray-400 mt-1">Credits minus debits on portfolio ledger</p>
        </div>
      </div>

      {/* GL activity breakdown */}
      <div className="rounded-xl border bg-white p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">GL Activity Breakdown ({layer1.currencyCode})</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <div>
              <p className="text-xs text-gray-500">GL Credits</p>
              <p className="font-semibold text-sm">{formatNGN(layer1.glCredits)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-red-500" />
            <div>
              <p className="text-xs text-gray-500">GL Debits</p>
              <p className="font-semibold text-sm">{formatNGN(layer1.glDebits)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-blue-500" />
            <div>
              <p className="text-xs text-gray-500">CBS Deposits</p>
              <p className="font-semibold text-sm">{formatNGN(layer1.savingsDeposits)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-orange-500" />
            <div>
              <p className="text-xs text-gray-500">CBS Withdrawals</p>
              <p className="font-semibold text-sm">{formatNGN(layer1.savingsWithdrawals)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Layer 2 trigger */}
      <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${layer1.layer2Triggered ? "bg-orange-50 border border-orange-200 text-orange-800" : "bg-green-50 border border-green-200 text-green-800"}`}>
        <Layers className="h-4 w-4 shrink-0" />
        {layer1.layer2Triggered
          ? "Variance exceeds threshold — Layer 2 exception classifier triggered automatically."
          : "Balance within threshold — Layer 2 not triggered."}
      </div>
    </div>
  );
}

function ExceptionRow({ exc, layer3 }: { exc: Layer2Exception; layer3?: Layer3Result }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${categoryColor(exc.exceptionCategory)}`}>
          {categoryLabel(exc.exceptionCategory)}
        </span>
        <span className="text-sm font-mono text-gray-600 shrink-0">GL #{exc.glEntryId}</span>
        <span className="text-sm font-semibold text-gray-900 ml-1">{formatNGN(exc.glEntryAmount)}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${exc.glEntryType === "CREDIT" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
          {exc.glEntryType}
        </span>
        <span className="text-xs text-gray-400 ml-1">{exc.glEntryDate}</span>
        {layer3 && (
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-semibold ${priorityColor(layer3.priorityLevel)}`}>
            {layer3.priorityLevel}
          </span>
        )}
        <span className="ml-2 text-gray-400">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t bg-gray-50 px-4 py-4 space-y-3">
          {/* Layer 2 details */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-500 font-medium">Manual Entry Flag</p>
              <p className="font-semibold">{exc.manualEntryFlag ? "Yes" : "No"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 font-medium">Reference</p>
              <p className="font-mono text-xs">{exc.refNum ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 font-medium">Linked Savings Txn</p>
              <p className="font-mono text-xs">{exc.linkedSavingsTxnId ?? "None"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 font-medium">Product Match</p>
              <p className={`font-semibold text-xs ${exc.productMatch === null ? "text-gray-400" : exc.productMatch ? "text-green-600" : "text-red-600"}`}>
                {exc.productMatch === null ? "N/A" : exc.productMatch ? "Yes" : "No — mis-posting"}
              </p>
            </div>
            {exc.description && (
              <div className="col-span-2">
                <p className="text-xs text-gray-500 font-medium">GL Description</p>
                <p className="text-xs text-gray-700">{exc.description}</p>
              </div>
            )}
          </div>

          {/* Layer 3 agent output */}
          {layer3 && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">AI Agent Analysis</p>
                  <span className="text-xs text-gray-400 ml-auto">Confidence: {layer3.agentConfidence}%</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed bg-white rounded-lg p-3 border">
                  {layer3.agentExplanation}
                </p>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800 mb-1">Recommended Action</p>
                  <p className="text-sm text-amber-900">{layer3.recommendedAction}</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WoodcorePOC() {
  const [pocResult, setPocResult] = useState<POCResult | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  const statsQuery = trpc.woodcore.stats.useQuery();
  const runsQuery = trpc.woodcore.getRuns.useQuery();

  const runPOC = trpc.woodcore.runPOC.useMutation({
    onSuccess: (data) => {
      setPocResult(data as POCResult);
      setActiveTab("layer1");
      runsQuery.refetch();
    },
  });

  const stats = statsQuery.data;
  const isRunning = runPOC.isPending;

  // Build layer3 lookup map by exceptionId
  // We'll match by index since layer3 results correspond to layer2 exceptions in order
  const layer3ByIndex = pocResult?.layer3Results ?? [];

  // Exception category summary
  const categoryCount = new Map<string, number>();
  for (const exc of pocResult?.layer2Exceptions ?? []) {
    categoryCount.set(exc.exceptionCategory, (categoryCount.get(exc.exceptionCategory) ?? 0) + 1);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-indigo-600" />
            <h1 className="text-xl font-bold text-gray-900">Woodcore CBS — Reconciliation POC</h1>
            <Badge variant="outline" className="text-xs border-indigo-300 text-indigo-700 bg-indigo-50">Live Dataset</Badge>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">
            Three-layer reconciliation engine running against real Woodcore production data (August 2025 dump)
          </p>
        </div>
        <Button
          onClick={() => runPOC.mutate({
            productId: 2,
            productType: "SAVINGS",
            currencyCode: "NGN",
            periodStart: "2025-04-01",
            periodEnd: "2025-07-31",
            varianceThreshold: 1.0,
          })}
          disabled={isRunning}
          className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
        >
          {isRunning
            ? <><RefreshCw className="h-4 w-4 animate-spin" /> Running…</>
            : <><Play className="h-4 w-4" /> Run POC</>
          }
        </Button>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">

        {/* Dataset stats */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard
            label="GL Journal Entries"
            value={stats?.glEntries ?? "—"}
            sub="wc_acc_gl_journal_entry"
            icon={FileText}
            color="bg-white border text-gray-800"
          />
          <StatCard
            label="Savings Transactions"
            value={stats?.savingsTransactions ?? "—"}
            sub="wc_m_savings_account_transaction"
            icon={TrendingUp}
            color="bg-white border text-gray-800"
          />
          <StatCard
            label="Savings Accounts"
            value={stats?.savingsAccounts ?? "—"}
            sub="wc_m_savings_account"
            icon={Database}
            color="bg-white border text-gray-800"
          />
        </div>

        {/* Run history */}
        {(runsQuery.data?.length ?? 0) > 0 && !pocResult && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-gray-700">Previous Runs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {runsQuery.data?.slice(0, 5).map((run: Record<string, unknown>) => (
                  <div key={String(run.id)} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                    <span className="font-mono text-gray-500 text-xs">Run #{String(run.id)}</span>
                    <span className="text-gray-700">{String(run.productName)}</span>
                    <span className="text-gray-400">{String(run.periodStart)} → {String(run.periodEnd)}</span>
                    <Badge className={`ml-auto text-xs ${String(run.status) === "BALANCED" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                      {String(run.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* POC results */}
        {pocResult && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-white border">
              <TabsTrigger value="layer1" className="gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                Layer 1 — Balance
              </TabsTrigger>
              <TabsTrigger value="layer2" className="gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                Layer 2 — Exceptions
                {pocResult.layer2Exceptions.length > 0 && (
                  <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold">
                    {pocResult.layer2Exceptions.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="layer3" className="gap-1.5">
                <Bot className="h-3.5 w-3.5" />
                Layer 3 — AI Agent
                {pocResult.layer3Results.length > 0 && (
                  <span className="ml-1 bg-indigo-500 text-white text-xs rounded-full px-1.5 py-0.5 font-bold">
                    {pocResult.layer3Results.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Layer 1 */}
            <TabsContent value="layer1" className="mt-4">
              <Layer1Panel layer1={pocResult.layer1} />
            </TabsContent>

            {/* Layer 2 */}
            <TabsContent value="layer2" className="mt-4 space-y-4">
              {pocResult.layer2Exceptions.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-400" />
                  <p className="font-medium">No exceptions found</p>
                  <p className="text-sm mt-1">All GL entries traced successfully to CBS transactions</p>
                </div>
              ) : (
                <>
                  {/* Category summary */}
                  <div className="flex flex-wrap gap-2">
                    {Array.from(categoryCount.entries()).map(([cat, count]) => (
                      <span key={cat} className={`text-xs font-semibold px-3 py-1 rounded-full border ${categoryColor(cat)}`}>
                        {categoryLabel(cat)}: {count}
                      </span>
                    ))}
                  </div>

                  {/* Exception list */}
                  <div className="space-y-2">
                    {pocResult.layer2Exceptions.map((exc, idx) => (
                      <ExceptionRow
                        key={exc.glEntryId}
                        exc={exc}
                        layer3={layer3ByIndex[idx]}
                      />
                    ))}
                  </div>
                </>
              )}
            </TabsContent>

            {/* Layer 3 */}
            <TabsContent value="layer3" className="mt-4 space-y-4">
              {pocResult.layer3Results.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <Bot className="h-10 w-10 mx-auto mb-3 text-indigo-300" />
                  <p className="font-medium">No AI analysis generated</p>
                  <p className="text-sm mt-1">Layer 3 only runs when Layer 2 detects exceptions</p>
                </div>
              ) : (
                <>
                  <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-start gap-3">
                    <Bot className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-indigo-800">Context-Aware Agent Report</p>
                      <p className="text-xs text-indigo-600 mt-0.5">
                        {pocResult.layer3Results.length} exception{pocResult.layer3Results.length !== 1 ? "s" : ""} analysed ·
                        Plain-English explanations and recommended actions generated for each
                      </p>
                    </div>
                  </div>

                  {/* Priority breakdown */}
                  <div className="grid grid-cols-4 gap-3">
                    {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((p) => {
                      const count = pocResult.layer3Results.filter((r) => r.priorityLevel === p).length;
                      return (
                        <div key={p} className={`rounded-xl p-3 text-center ${priorityColor(p)}`}>
                          <p className="text-2xl font-bold">{count}</p>
                          <p className="text-xs font-medium opacity-80 mt-0.5">{p}</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Full agent results */}
                  <div className="space-y-3">
                    {pocResult.layer3Results.map((r, idx) => {
                      const exc = pocResult.layer2Exceptions[idx];
                      return (
                        <div key={r.exceptionId} className="border rounded-xl overflow-hidden bg-white">
                          <div className="px-4 py-3 flex items-center gap-3 bg-gray-50 border-b">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${priorityColor(r.priorityLevel)}`}>
                              {r.priorityLevel}
                            </span>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${categoryColor(r.agentClassification)}`}>
                              {categoryLabel(r.agentClassification)}
                            </span>
                            <span className="text-sm font-mono text-gray-500">Exception #{r.exceptionId}</span>
                            {exc && (
                              <span className="text-sm font-semibold text-gray-700 ml-1">{formatNGN(exc.glEntryAmount)}</span>
                            )}
                            <span className="ml-auto text-xs text-gray-400">Confidence: {r.agentConfidence}%</span>
                          </div>
                          <div className="px-4 py-4 space-y-3">
                            <p className="text-sm text-gray-700 leading-relaxed">{r.agentExplanation}</p>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                              <p className="text-xs font-semibold text-amber-800 mb-1">Recommended Action</p>
                              <p className="text-sm text-amber-900">{r.recommendedAction}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
        )}

        {/* Initial state — no run yet */}
        {!pocResult && (runsQuery.data?.length ?? 0) === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Play className="h-12 w-12 mx-auto mb-4 text-indigo-300" />
            <p className="text-lg font-semibold text-gray-600">Ready to run</p>
            <p className="text-sm mt-2 max-w-md mx-auto">
              Click <strong>Run POC</strong> to execute all three layers of the reconciliation engine
              against the real Woodcore CBS dataset. The engine will analyse {stats?.glEntries ?? "62"} GL
              entries and {stats?.savingsTransactions ?? "35"} savings transactions.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
