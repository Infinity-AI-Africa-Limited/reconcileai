import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Loader2, Network, ShieldCheck, Share2, Download, RefreshCw, Info, TrendingUp, Brain, Layers } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePortalContext } from "@/contexts/PortalContext";

// Simple inline bar-chart (no library dependency).
function MiniBarChart({ data }: { data: { label: string; value: number }[] }) {
  if (!data.length) return <p className="text-xs text-muted-foreground italic">No data yet — patterns will appear here as exceptions are resolved.</p>;
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map(d => (
        <div key={d.label} className="flex flex-col items-center gap-1 flex-1 min-w-0">
          <span className="text-[10px] text-muted-foreground font-medium">{d.value}</span>
          <div
            className="w-full bg-primary/80 rounded-sm transition-all"
            style={{ height: `${Math.max(4, Math.round((d.value / max) * 56))}px` }}
          />
          <span className="text-[9px] text-muted-foreground truncate w-full text-center">{d.label.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export default function ExceptionIntelligencePage() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.exceptionIntelligence.getSettings.useQuery();
  const { data: status } = trpc.exceptionIntelligence.status.useQuery();
  const { data: flywheel } = trpc.exceptionIntelligence.flywheelStats.useQuery();
  const update = trpc.exceptionIntelligence.updateSettings.useMutation({
    onSuccess: () => {
      utils.exceptionIntelligence.getSettings.invalidate();
      toast.success("Preferences updated");
    },
    onError: (e) => toast.error(e.message || "Update failed"),
  });
  const sync = trpc.exceptionIntelligence.sync.useMutation({
    onSuccess: (r) => {
      utils.exceptionIntelligence.status.invalidate();
      toast.success(`Pool refreshed — ${r.aggregatedPatterns} patterns aggregated`);
    },
    onError: (e) => toast.error(e.message || "Sync failed"),
  });

  // Regulator engagement asset: signed, k-anonymous industry pattern report
  // (CBN Payments Policy Department deliverable). Downloads as CSV with the
  // methodology header and Ed25519 signature block embedded.
  const regulatorReport = trpc.exceptionIntelligence.regulatorReport.useMutation({
    onSuccess: (r) => {
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines: string[] = [
        `# ${r.methodology.title}`,
        `# Prepared for: ${r.methodology.preparedFor}`,
        `# Generated: ${r.methodology.generatedAt}`,
        `# Contributing institutions (consented): ${r.methodology.contributingInstitutions}`,
        `# k-anonymity threshold: ${r.methodology.kAnonymityThreshold} (every row corroborated by at least this many institutions)`,
        `# Patterns: ${r.methodology.patternCount}`,
        `# Privacy: ${r.methodology.privacyStatement}`,
        "#",
        ["exceptionCategory", "amountBucket", "counterpartyType", "deductionType", "resolutionActionClass", "outcome", "contributorCount", "observationCount"].join(","),
        ...r.patterns.map((p) =>
          [p.exceptionCategory, p.amountBucket, p.counterpartyType, p.deductionType ?? "", p.resolutionActionClass, p.outcome, p.contributorCount, p.observationCount].map(esc).join(","),
        ),
        "#",
        `# Signature (Ed25519): ${r.signature.signature}`,
        `# Content hash: ${r.signature.contentHash}`,
        `# Signing key fingerprint: ${r.signature.signingKeyFingerprint}`,
        `# Signed at: ${r.signature.signedAt}`,
      ];
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ReconcileAI_Industry_Exception_Patterns_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Regulator report generated — ${r.methodology.patternCount} patterns`, {
        description: "Signed CSV downloaded. Share with the CBN Payments Policy Department.",
      });
    },
    onError: (e) => toast.error(e.message || "Report generation failed"),
  });

  const participating = !!(settings?.shareEnabled || settings?.consumeEnabled);

  const { user } = useAuth();
  const { isViewingAs } = usePortalContext();
  const isSuperAdminPortal = user?.role === "super_admin" && !isViewingAs;

  const monthlyChartData = (flywheel?.monthlyGrowth ?? []).map(r => ({
    label: r.month,
    value: r.count,
  }));

  const totalPatterns = flywheel?.totalPatterns ?? 0;
  const categoriesCovered = flywheel?.categoryCoverage?.length ?? 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Network className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Exception Intelligence Layer</h1>
          <p className="text-muted-foreground mt-1">
            Your system learns from every reconciliation job — and can learn from how other institutions resolve similar exceptions.
          </p>
        </div>
      </div>

      {/* ── Learning Flywheel ─────────────────────────────────────────── */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" /> Per-Institution Learning Flywheel
          </CardTitle>
          <CardDescription>
            Every exception your team resolves teaches the AI how your institution handles similar issues. The system gets more accurate with each reconciliation job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border bg-card p-3 text-center">
              <Brain className="h-4 w-4 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-primary">{totalPatterns}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Patterns learned</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <Layers className="h-4 w-4 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-primary">{categoriesCovered}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Exception categories</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <RefreshCw className="h-4 w-4 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-primary">
                {monthlyChartData.length > 0 ? monthlyChartData[monthlyChartData.length - 1].value : 0}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">This month</p>
            </div>
          </div>

          {/* Growth chart */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Patterns captured — last 6 months</p>
            <MiniBarChart data={monthlyChartData} />
          </div>

          {/* Category breakdown */}
          {(flywheel?.categoryCoverage ?? []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Coverage by exception category</p>
              <div className="flex flex-wrap gap-1.5">
                {flywheel!.categoryCoverage.map(c => (
                  <span key={c.category} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {c.category.replace(/_/g, " ")}
                    <span className="text-primary/60">{c.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {totalPatterns === 0 && (
            <p className="text-sm text-muted-foreground text-center py-2">
              Resolve your first exception to start building your institution's AI knowledge base.
            </p>
          )}

          {/* Value narrative */}
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary/80 space-y-1">
            <p className="font-medium">How value accumulates:</p>
            <p>Each resolved exception adds a pattern to your institution's private knowledge base. The Super Agent uses these as few-shot examples when classifying and recommending resolutions for new exceptions — so accuracy compounds with every reconciliation run.</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Cross-institution sharing ──────────────────────────────────── */}
      <Card className="border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" /> Cross-institution intelligence (privacy-first)
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-emerald-900/80 dark:text-emerald-200/80 space-y-2">
          <p>
            Only <strong>anonymized pattern signatures</strong> are shared — a fixed set of coarse categories
            ({(settings?.sharedFields ?? []).join(", ") || "category, amount bucket, counterparty type, deduction type, resolution action, outcome"}).
            Never amounts, references, names, account numbers, or free text.
          </p>
          <p>
            A pattern is only ever shown to you once it has been independently corroborated by at least{" "}
            <strong>{settings?.kAnonymityThreshold ?? 3} different institutions</strong> (k-anonymity), so no single party can be singled out.
            In on-premise mode this is the only egress, and it passes the data-residency guard plus a runtime PII scrub.
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center h-24"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cross-institution participation</CardTitle>
            <CardDescription>Off by default — you opt in. Both options move together (see below).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900/80 dark:text-amber-200/80">
              <Info className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
              <p>
                <strong>Contributing and benefiting go together.</strong> If you turn one on, the other turns on
                too; turn one off, and both turn off. It's a fair exchange — you can draw on the shared pool only
                if you also help build it, and if you choose to benefit, you contribute in return.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Share2 className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Contribute anonymized patterns</p>
                  <p className="text-xs text-muted-foreground">Share the de-identified resolution patterns your team produces.</p>
                </div>
              </div>
              <Switch
                checked={participating}
                onCheckedChange={(v) => update.mutate({ shareEnabled: v, consumeEnabled: v })}
                disabled={update.isPending}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Download className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Benefit from the shared pool</p>
                  <p className="text-xs text-muted-foreground">Let the Super Agent suggest actions other institutions used for similar exceptions.</p>
                </div>
              </div>
              <Switch
                checked={participating}
                onCheckedChange={(v) => update.mutate({ shareEnabled: v, consumeEnabled: v })}
                disabled={update.isPending}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pool stats — super-admin (platform operator) portal only. */}
      {isSuperAdminPortal && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Card><CardContent className="pt-6">
              <p className="text-2xl font-bold text-primary">{status?.localSignatures ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-1">Local pattern signatures</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-2xl font-bold text-primary">{status?.localObservations ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-1">Resolutions observed</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-2xl font-bold text-primary">{status?.sharedPatternsAvailable ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-1">Pool patterns available (k≥{settings?.kAnonymityThreshold ?? 3})</p>
            </CardContent></Card>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="outline" className="gap-2" disabled={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh shared pool
            </Button>
            <Button className="gap-2" disabled={regulatorReport.isPending} onClick={() => regulatorReport.mutate()}>
              {regulatorReport.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Generate CBN regulator report
            </Button>
            <span className="text-xs text-muted-foreground">
              {settings?.endpointConfigured ? "On-premise sync endpoint configured." : "Cloud mode — patterns aggregated in-place."}
            </span>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            The regulator report packages the k-anonymous industry pattern pool into a signed CSV (methodology +
            Ed25519 provenance) for the CBN Payments Policy Department — the concrete contribution behind the
            "reference implementation" engagement strategy.
          </p>
        </>
      )}
    </div>
  );
}
