/**
 * Public read-only view of a shared POC reconciliation run (via share token).
 */
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Scale, AlertTriangle, Sparkles } from "lucide-react";

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

export default function PocSharedReport() {
  const params = useParams();
  const token = (params as any).token as string;
  const { data, isLoading, error } = trpc.poc.getSharedReport.useQuery({ token }, { retry: false });

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center px-6">
        <div>
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">This shared report link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  const run: any = data.run;
  const summary = run.summary ?? {};
  const exceptions = (data.exceptions ?? []) as any[];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-r from-emerald-700 via-green-600 to-lime-600 px-6 py-3 flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-white" />
        <p className="text-white text-sm font-semibold">ReconcileAI — Shared Reconciliation Report</p>
      </div>
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-5">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2"><Scale className="h-4 w-4" /> Balance</h3>
              <Badge className={run.status === "BALANCED" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}>
                {run.status === "BALANCED" ? "Balanced" : "Variance detected"}
              </Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <Stat label="Ledger transactions" value={run.ledgerCount} />
              <Stat label="Statement transactions" value={run.statementCount} />
              <Stat label="Matched" value={run.matchedCount} />
              <Stat label="Ledger net" value={ngn(summary.ledgerNet ?? run.ledgerTotal)} />
              <Stat label="Statement net" value={ngn(summary.statementNet ?? run.statementTotal)} />
              <Stat label="Variance" value={ngn(run.varianceAmount)} highlight={run.status !== "BALANCED"} />
            </div>
          </CardContent>
        </Card>

        <h3 className="font-semibold text-sm">Exceptions ({exceptions.length})</h3>
        {exceptions.map((e, i) => (
          <Card key={i}>
            <CardContent className="pt-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline">{CATEGORY_LABELS[e.category] ?? e.category}</Badge>
                    <Badge className={PRIORITY_COLORS[e.priorityLevel] ?? ""}>{e.priorityLevel}</Badge>
                    <span className="text-xs text-muted-foreground">{e.side}</span>
                  </div>
                  <p className="text-sm mt-1">{e.description || e.reference || "—"}</p>
                  <p className="text-xs mt-1"><span className="font-medium">Why: </span>{e.agentExplanation}</p>
                  <p className="text-xs"><span className="font-medium text-emerald-700">Recommended: </span>{e.recommendedAction}</p>
                </div>
                <span className="font-mono text-sm font-semibold shrink-0">{ngn(e.amount)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
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
