import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Loader2, Network, ShieldCheck, Share2, Download, RefreshCw, Info } from "lucide-react";
import { toast } from "sonner";

export default function ExceptionIntelligencePage() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.exceptionIntelligence.getSettings.useQuery();
  const { data: status } = trpc.exceptionIntelligence.status.useQuery();
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

  // Contribution and consumption are coupled (reciprocity) and default OFF.
  // Show "on" if either is set; toggling either applies the same value to both.
  const participating = !!(settings?.shareEnabled || settings?.consumeEnabled);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Network className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Exception Intelligence Layer</h1>
          <p className="text-muted-foreground mt-1">
            Learn from how other institutions resolve similar exceptions — without any transaction data or PII ever leaving your infrastructure.
          </p>
        </div>
      </div>

      {/* Privacy posture */}
      <Card className="border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" /> Privacy by design
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
            <CardTitle className="text-base">Participation</CardTitle>
            <CardDescription>Off by default — you opt in. Both options move together (see below).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Reciprocity: the two toggles are linked and always match. */}
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

      {/* Stats */}
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

      <div className="flex items-center gap-3">
        <Button variant="outline" className="gap-2" disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh shared pool
        </Button>
        <span className="text-xs text-muted-foreground">
          {settings?.endpointConfigured ? "On-premise sync endpoint configured." : "Cloud mode — patterns aggregated in-place."}
        </span>
      </div>
    </div>
  );
}
