/**
 * Exception Age / Escalation Tracker — the ops control-centre view of how long
 * exceptions have been outstanding, which are over-aged (past SLA), and a
 * one-click escalation workflow. Built explicitly from discovery (named a top-3
 * feature by the operations buyer).
 */
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Loader2, Clock, AlertTriangle, ArrowUpCircle, ShieldAlert, CheckCircle2, Save, Timer,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const ngn = (n: number | string) =>
  `₦${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ESCALATION_STYLE: Record<string, { label: string; cls: string }> = {
  on_track: { label: "On track", cls: "bg-emerald-100 text-emerald-700" },
  watch: { label: "Watch", cls: "bg-amber-100 text-amber-700" },
  overdue: { label: "Overdue", cls: "bg-orange-100 text-orange-700" },
  breach: { label: "Breach", cls: "bg-red-100 text-red-700" },
};
const BUCKET_STYLE: Record<string, string> = {
  "0-2": "border-emerald-200",
  "3-7": "border-amber-200",
  "8-30": "border-orange-200",
  "30+": "border-red-300",
};
const CATEGORY_LABELS: Record<string, string> = {
  missing_counterparty: "Missing counterparty",
  amount_mismatch: "Amount mismatch",
  timing_difference: "Timing difference",
  duplicate_transaction: "Duplicate",
  unmatched: "Unmatched",
  reversal_unmatched: "Reversal unmatched",
  currency_mismatch: "Currency mismatch",
  format_error: "Format error",
};

function ageColor(days: number, sla: number) {
  if (days <= sla) return "text-emerald-600";
  if (days <= sla * 2) return "text-amber-600";
  if (days <= sla * 4) return "text-orange-600";
  return "text-red-600";
}

export default function AgeTracker() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [onlyOverAged, setOnlyOverAged] = useState(true);
  const [slaInput, setSlaInput] = useState<string>("");

  const summary = trpc.ageTracker.summary.useQuery();
  const settings = trpc.ageTracker.getSettings.useQuery();
  const list = trpc.ageTracker.list.useQuery({ onlyOverAged, limit: 200 });

  // Seed the SLA input once settings load (React Query v5 has no useQuery onSuccess).
  useEffect(() => {
    if (settings.data && slaInput === "") setSlaInput(String(settings.data.slaDays));
  }, [settings.data, slaInput]);

  const saveSettings = trpc.ageTracker.saveSettings.useMutation({
    onSuccess: () => { utils.ageTracker.invalidate(); toast.success("SLA updated"); },
    onError: (e) => toast.error(e.message || "Could not save SLA"),
  });
  const escalate = trpc.ageTracker.escalate.useMutation({
    onSuccess: () => { utils.ageTracker.invalidate(); toast.success("Exception escalated"); },
    onError: (e) => toast.error(e.message || "Escalation failed"),
  });
  const bulkEscalate = trpc.ageTracker.bulkEscalateOverAged.useMutation({
    onSuccess: (r) => { utils.ageTracker.invalidate(); toast.success(`Escalated ${r.count} over-aged exception(s)`); },
    onError: (e) => toast.error(e.message || "Bulk escalation failed"),
  });

  const s = summary.data;
  const sla = settings.data?.slaDays ?? 7;
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-primary">Age Tracker</h1>
            <p className="text-muted-foreground mt-1">How long exceptions have been outstanding — and which are over-aged and need escalation.</p>
          </div>
        </div>
        {/* SLA control */}
        <div className="flex items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Resolution SLA (days)</label>
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <Input type="number" min={1} max={365} value={slaInput} onChange={(e) => setSlaInput(e.target.value)} className="w-20 h-9" />
              <Button size="sm" variant="outline" className="gap-1.5"
                disabled={saveSettings.isPending || !slaInput}
                onClick={() => saveSettings.mutate({ slaDays: Math.max(1, Math.min(365, parseInt(slaInput) || 7)) })}>
                {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Headline + aging buckets */}
      {summary.isLoading ? (
        <div className="flex items-center justify-center h-24"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : s && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="border-red-200 bg-red-50/40">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-red-700"><ShieldAlert className="h-4 w-4" /><span className="text-xs font-semibold">Over-aged (past {sla}-day SLA)</span></div>
                <p className="text-2xl font-bold text-red-700 mt-1">{s.overAgedCount}</p>
                <p className="text-xs text-muted-foreground">{ngn(s.overAgedExposure)} at risk</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-muted-foreground"><AlertTriangle className="h-4 w-4" /><span className="text-xs font-semibold">Open exceptions</span></div>
                <p className="text-2xl font-bold mt-1">{s.totalOpen}</p>
                <p className="text-xs text-muted-foreground">{ngn(s.totalExposure)} total exposure</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" /><span className="text-xs font-semibold">Oldest open item</span></div>
                <p className="text-2xl font-bold mt-1">{s.oldestAgeDays} <span className="text-base font-normal text-muted-foreground">days</span></p>
                <p className="text-xs text-muted-foreground">{s.escalation.breach} in breach</p>
              </CardContent>
            </Card>
          </div>

          {/* Aging distribution */}
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            {s.buckets.map((b) => (
              <Card key={b.key} className={`border ${BUCKET_STYLE[b.key] ?? ""}`}>
                <CardContent className="pt-5">
                  <p className="text-xs text-muted-foreground">{b.label}</p>
                  <p className="text-xl font-bold mt-1">{b.count}</p>
                  <p className="text-xs text-muted-foreground">{ngn(b.exposure)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* List controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex rounded-lg border p-1 text-sm">
          <button onClick={() => setOnlyOverAged(true)} className={`px-3 py-1.5 rounded-md font-medium ${onlyOverAged ? "bg-[#1B365D] text-white" : "text-muted-foreground"}`}>Over-aged only</button>
          <button onClick={() => setOnlyOverAged(false)} className={`px-3 py-1.5 rounded-md font-medium ${!onlyOverAged ? "bg-[#1B365D] text-white" : "text-muted-foreground"}`}>All open</button>
        </div>
        <Button variant="outline" size="sm" className="gap-2 border-red-300 text-red-700 hover:bg-red-50"
          disabled={bulkEscalate.isPending || (s?.overAgedCount ?? 0) === 0}
          onClick={() => bulkEscalate.mutate()}>
          {bulkEscalate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
          Escalate all over-aged
        </Button>
      </div>

      {/* Aging list */}
      {list.isLoading ? (
        <div className="flex items-center justify-center h-24"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : items.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
          {onlyOverAged ? "No over-aged exceptions — everything is within SLA." : "No open exceptions."}
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-left">
                <th className="px-3 py-2 font-medium">Age</th>
                <th className="px-3 py-2 font-medium">Escalation</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium text-right">Amount</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const esc = ESCALATION_STYLE[e.escalationLevel] ?? ESCALATION_STYLE.on_track;
                return (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap"><span className={`font-bold ${ageColor(e.ageDays, sla)}`}>{e.ageDays}d</span></td>
                    <td className="px-3 py-2"><Badge className={esc.cls}>{esc.label}</Badge></td>
                    <td className="px-3 py-2">{CATEGORY_LABELS[e.category] ?? e.category}</td>
                    <td className="px-3 py-2 text-right font-mono">{ngn(e.amount)}</td>
                    <td className="px-3 py-2 font-mono text-xs max-w-[140px] truncate">{e.reference || "—"}</td>
                    <td className="px-3 py-2 max-w-[140px] truncate">{e.jobName || "—"}</td>
                    <td className="px-3 py-2">{e.assigneeName || <span className="text-muted-foreground">Unassigned</span>}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="capitalize">{String(e.status).replace("_", " ")}</Badge></td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {e.status !== "escalated" && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-orange-700"
                            disabled={escalate.isPending}
                            onClick={() => escalate.mutate({ id: e.id })}>
                            <ArrowUpCircle className="h-3.5 w-3.5" /> Escalate
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setLocation("/exceptions")}>Open</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
