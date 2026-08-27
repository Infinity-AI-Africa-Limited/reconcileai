/**
 * POC Hub (super-admin) — a single place that lists every company POC built on
 * ReconcileAI. Each POC has its own public page; the hub is the operator's index.
 *
 * The "LAPO Uploads" tab shows every file anonymously uploaded by prospects on
 * the LAPO MFB POC page, with download links and visitor metadata.
 */
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Database, Sparkles, ExternalLink, FlaskConical, CreditCard,
  FileSpreadsheet, FileText, File as FileIcon, Download, RefreshCw,
  Clock, User, HardDrive, AlertCircle, Copy, Check, History, ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import PocRunHistory from "@/components/PocRunHistory";

// ─── POC index ────────────────────────────────────────────────────────────────
type Poc = {
  name: string;
  pocKey: string;
  blurb: string;
  path: string;
  icon: typeof Database;
  accent: string;
  status: "Live" | "Active";
};
const POCS: Poc[] = [
  {
    name: "Woodcore CBS",
    pocKey: "woodcore",
    blurb: "GL-to-CBS reconciliation against the live Woodcore/Fineract test tenant (savings + loan portfolios).",
    path: "/woodcore-poc",
    icon: Database,
    accent: "from-[#1a2f6e] to-[#2563eb]",
    status: "Live",
  },
  {
    name: "Salad Africa",
    pocKey: "salad_africa",
    blurb: "Self-service ledger ↔ bank statement reconciliation. Upload Excel/CSV and run the 3-layer engine.",
    path: "/salad-africa-poc",
    icon: Sparkles,
    accent: "from-emerald-700 to-lime-600",
    status: "Active",
  },
  {
    name: "LAPO MFB — Interswitch Card Settlement",
    pocKey: "lapo_mfb",
    blurb: "CBS vs Interswitch card settlement reconciliation. Pre-loaded demo dataset with chargebacks, settlement shortfalls, late presentments, duplicate RRNs, and amount mismatches. Supports Mastercard, Visa, and Verve.",
    path: "/lapo-poc",
    icon: CreditCard,
    accent: "from-[#0E3622] to-[#00954B]",
    status: "Active",
  },
  {
    name: "Technical Handover & Architecture",
    pocKey: "technical_handover",
    blurb: "Private, read-only handover for an incoming technical team — plain-English product overview, full system architecture, stack, workflows, and onboarding checklist. Share the invite link; the recipient needs no login.",
    path: "/technical-handover",
    icon: FileText,
    accent: "from-[#1B365D] to-[#F4758C]",
    status: "Live",
  },
  {
    name: "Local Deployment & Model Training — Runbook",
    pocKey: "deployment_runbook",
    blurb: "The on-premise deployment and model-training runbook, shared privately with prospects, partner IT teams and bank security reviewers. Document only — no uploads or reconciliation runs.",
    path: "/deployment-runbook",
    icon: FileText,
    accent: "from-[#1B365D] to-[#F47458]",
    status: "Live",
  },
  {
    name: "SHOPLINE App Review Workspace",
    pocKey: "shopline_review",
    blurb: "No-login, read-only Dev Store portal for SHOPLINE App Store review. The super-admin public-review switch is the immediate kill switch; no credentials or write controls are exposed.",
    path: "/shopline-review",
    icon: ShieldCheck,
    accent: "from-sky-700 to-cyan-500",
    status: "Active",
  },
];

// Per-POC access link: shows the invite link (with token), copy, and regenerate.
function PocAccessLink({ pocKey, path }: { pocKey: string; path: string }) {
  const utils = trpc.useUtils();
  const cfg = trpc.poc.getAccessConfig.useQuery({ pocKey });
  const regen = trpc.poc.regenerateAccessToken.useMutation({
    onSuccess: () => utils.poc.getAccessConfig.invalidate({ pocKey }),
  });
  const [copied, setCopied] = useState(false);
  const link = cfg.data?.token ? `${window.location.origin}${path}?key=${cfg.data.token}` : "";

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };

  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-2.5">
      <p className="text-[11px] font-medium text-muted-foreground mb-1">Invite link (access-protected)</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate text-[11px] text-gray-700">{cfg.isLoading ? "Loading…" : link}</code>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={copy} disabled={!link}>
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm" variant="outline" className="h-7 gap-1 text-xs"
          onClick={() => { if (confirm("Regenerate the access link? The current link will stop working.")) regen.mutate({ pocKey }); }}
          disabled={regen.isPending}
          title="Invalidate the current link and create a new one"
        >
          <RefreshCw className={`h-3 w-3 ${regen.isPending ? "animate-spin" : ""}`} /> Regenerate
        </Button>
      </div>
    </div>
  );
}

/**
 * Public-access kill switch for the SHOPLINE review portal.
 *
 * Four states, not a boolean. A read can fail, and for a control whose whole
 * job is answering "is this open to the internet right now?", reporting a
 * failed read as "Disabled" is the one wrong answer — an operator checking
 * whether the portal is closed would be told yes on no evidence. So `unknown`
 * is named and shown.
 *
 * From `unknown` only the CLOSING action is offered. Closing on a stale reading
 * costs a reviewer a page load; opening on one publishes Dev Store evidence
 * while nobody can see the current state. When the two error directions are not
 * symmetric, only the recoverable one should be reachable in the dark.
 */
type ReviewPortalState = "loading" | "unknown" | "public" | "closed";

function ShoplinePublicReviewControl({ pocKey, path }: { pocKey: string; path: string }) {
  const utils = trpc.useUtils();
  const cfg = trpc.poc.getAccessConfig.useQuery({ pocKey });
  const setProtection = trpc.poc.setAccessEnabled.useMutation({
    onSuccess: () => utils.poc.getAccessConfig.invalidate({ pocKey }),
  });
  const [confirming, setConfirming] = useState(false);

  const state: ReviewPortalState = cfg.isLoading
    ? "loading"
    : cfg.isError || !cfg.data
      ? "unknown"
      : cfg.data.enabled === false
        ? "public"
        : "closed";

  // `enabled` is the POC token-protection flag, so protection OFF is what makes
  // this portal public — closing it means turning protection back ON.
  const willOpen = state === "closed";
  const description: Record<ReviewPortalState, string> = {
    loading: "Checking portal state…",
    unknown: "Unknown — the portal state could not be read. Closing public access is still available.",
    public: "Enabled — no sign-in or URL token required.",
    closed: "Disabled — public reviewers cannot read Dev Store evidence.",
  };

  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">Public reviewer access</p>
      <p className={`mt-1 text-[11px] ${state === "unknown" ? "text-amber-600" : "text-muted-foreground"}`}>
        {description[state]}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <a href={path} target="_blank" rel="noopener noreferrer">
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"><ExternalLink className="h-3 w-3" /> Open portal</Button>
        </a>
        <Button
          size="sm"
          variant={willOpen ? "outline" : "destructive"}
          className="h-7 text-xs"
          onClick={() => setConfirming(true)}
          disabled={state === "loading" || setProtection.isPending}
        >
          {willOpen ? "Enable public access" : "Disable public access"}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {willOpen ? "Open the SHOPLINE review portal to the public?" : "Close public access to the SHOPLINE review portal?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {willOpen
                ? "Anyone with the link will be able to read ReconcileAI Dev Store connection, webhook and reconciliation evidence without signing in. No credentials, raw records or write controls are exposed, and you can close it again here at any time."
                : "Reviewers will immediately stop being able to read Dev Store evidence, and the portal will report itself unavailable."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setProtection.mutate({ pocKey, enabled: !willOpen })}>
              {willOpen ? "Enable public access" : "Disable public access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Per-recipient invite links. One link per party, so a shared document is
// watermarked with who it went to and any single recipient can be cut off
// without disturbing the others.
function RecipientInvites({ pocKey, path }: { pocKey: string; path: string }) {
  const utils = trpc.useUtils();
  const list = trpc.poc.listRecipientInvites.useQuery({ pocKey });
  const [recipient, setRecipient] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = () => utils.poc.listRecipientInvites.invalidate({ pocKey });
  const create = trpc.poc.createRecipientInvite.useMutation({
    onSuccess: () => { setRecipient(""); refresh(); },
    onError: (e) => alert(e.message),
  });
  const revoke = trpc.poc.revokeRecipientInvite.useMutation({ onSuccess: refresh });

  const linkFor = (token: string) => `${window.location.origin}${path}?key=${token}`;
  const copy = async (token: string, who: string) => {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      setCopied(who);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-2.5">
      <p className="text-[11px] font-medium text-muted-foreground mb-1.5">
        Per-recipient links (watermarked &amp; individually revocable)
      </p>

      <div className="flex items-center gap-2">
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && recipient.trim()) create.mutate({ pocKey, recipient: recipient.trim() });
          }}
          placeholder="recipient-name (e.g. acme-bank)"
          className="flex-1 rounded border px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
        <Button
          size="sm" variant="outline" className="h-7 gap-1 text-xs"
          disabled={!recipient.trim() || create.isPending}
          onClick={() => create.mutate({ pocKey, recipient: recipient.trim() })}
        >
          Issue link
        </Button>
      </div>

      {list.data && list.data.length > 0 && (
        <div className="mt-2 space-y-1">
          {list.data.map((inv) => (
            <div key={inv.recipient} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-[11px] font-medium text-gray-700">{inv.recipient}</span>
              <code className="flex-1 truncate text-[11px] text-gray-500">{linkFor(inv.token)}</code>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => copy(inv.token, inv.recipient)}>
                {copied === inv.recipient ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              </Button>
              <Button
                size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-red-600 hover:text-red-700"
                onClick={() => { if (confirm(`Revoke ${inv.recipient}'s link? It stops working immediately.`)) revoke.mutate({ pocKey, recipient: inv.recipient }); }}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function FileTypeIcon({ mime, name }: { mime: string; name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return <FileText className="h-4 w-4 text-red-500 shrink-0" />;
  if (["xlsx", "xls"].includes(ext)) return <FileSpreadsheet className="h-4 w-4 text-green-600 shrink-0" />;
  if (ext === "csv") return <FileSpreadsheet className="h-4 w-4 text-emerald-600 shrink-0" />;
  return <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />;
}

// ─── Prospect Uploads panel (per POC) ─────────────────────────────────────────
function PocUploads({
  pocSlug,
  name,
  roleLabels,
}: {
  pocSlug: string;
  name: string;
  roleLabels: { cbs: string; statement: string };
}) {
  const { data, isLoading, error, refetch, isFetching } =
    trpc.poc.listFiles.useQuery({ pocSlug });

  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const handleDownload = async (s3Key: string, originalName: string) => {
    setDownloadingKey(s3Key);
    try {
      const result = await utils.poc.getFileUrl.fetch({ s3Key });
      const url = result?.url;
      if (!url) {
        alert("Download URL unavailable — S3 may not be configured in this environment.");
        return;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = originalName;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setDownloadingKey(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <RefreshCw className="h-4 w-4 animate-spin" /> Loading uploads…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-red-600 py-8">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm">Failed to load uploads: {error.message}</span>
      </div>
    );
  }

  const files = data ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-base">{name} — Prospect Uploads</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every file anonymously uploaded by a prospect on the {name} POC page. No PII is stored.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total files", value: files.length },
          { label: roleLabels.cbs, value: files.filter((f) => f.fileRole === "cbs").length },
          { label: roleLabels.statement, value: files.filter((f) => f.fileRole === "statement").length },
          { label: "Unique sessions", value: new Set(files.map((f) => f.visitorId).filter(Boolean)).size },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-white p-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-xl font-bold text-gray-900">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      {files.length === 0 ? (
        <div className="rounded-lg border bg-white p-10 text-center text-muted-foreground text-sm">
          No files uploaded yet. When a prospect uploads a file on the {name} POC page, it will appear here.
        </div>
      ) : (
        <div className="rounded-lg border bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5 font-medium">File</th>
                  <th className="text-left px-4 py-2.5 font-medium">Role</th>
                  <th className="text-right px-4 py-2.5 font-medium">Size</th>
                  <th className="text-left px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-1"><User className="h-3 w-3" /> Visitor</span>
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Uploaded</span>
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium">Download</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileTypeIcon mime={f.mimeType} name={f.originalName} />
                        <span className="font-medium truncate max-w-[200px]" title={f.originalName}>
                          {f.originalName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={
                          f.fileRole === "cbs"
                            ? "border-emerald-300 text-emerald-700 text-[11px]"
                            : "border-sky-300 text-sky-700 text-[11px]"
                        }
                      >
                        {f.fileRole === "cbs" ? roleLabels.cbs : roleLabels.statement}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                      <span className="flex items-center justify-end gap-1">
                        <HardDrive className="h-3 w-3" />
                        {formatBytes(f.sizeBytes)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="font-mono text-xs text-muted-foreground truncate max-w-[120px] block"
                        title={f.visitorId ?? "unknown"}
                      >
                        {f.visitorId ? f.visitorId.slice(0, 8) + "…" : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(f.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-xs h-7"
                        onClick={() => handleDownload(f.s3Key, f.originalName)}
                        disabled={downloadingKey === f.s3Key}
                        title="Download file"
                      >
                        {downloadingKey === f.s3Key ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Download
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground px-4 py-2 border-t bg-muted/20">
            Showing {files.length} file{files.length !== 1 ? "s" : ""} · Stored anonymously in S3 · No PII retained
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Reconciliation runs panel (per POC, admin) ───────────────────────────────
// Generic across every self-service POC. Woodcore is excluded — it keeps its own
// run store (wc_reconciliation_runs) surfaced on its own page.
function PocRunsAdmin() {
  // Woodcore keeps its own run store; the Technical Handover and the Deployment
  // Runbook are documents, not runnable POCs.
  const runnablePocs = POCS.filter(
    (p) => p.pocKey !== "woodcore" && p.pocKey !== "technical_handover" && p.pocKey !== "deployment_runbook",
  );
  const [slug, setSlug] = useState(runnablePocs[0]?.pocKey ?? "salad_africa");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-base">Reconciliation Runs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every reconciliation a prospect runs is saved. Pick a POC to review and refer back to its run history.
          </p>
        </div>
        <Select value={slug} onValueChange={setSlug}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {runnablePocs.map((p) => (
              <SelectItem key={p.pocKey} value={p.pocKey}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* key remounts the history (fresh state) when switching POC */}
      <PocRunHistory key={slug} pocSlug={slug} admin />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function PocHub() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">POC Hub</h1>
          <p className="text-muted-foreground mt-1">
            Proof-of-concept environments built for prospective clients. Each opens in its own public page.
          </p>
        </div>
      </div>

      <Tabs defaultValue="pocs">
        <TabsList>
          <TabsTrigger value="pocs" className="gap-1.5">
            <FlaskConical className="h-4 w-4" /> POC Environments
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <History className="h-4 w-4" /> Reconciliation Runs
          </TabsTrigger>
          <TabsTrigger value="salad-uploads" className="gap-1.5">
            <Download className="h-4 w-4" /> Salad Uploads
          </TabsTrigger>
          <TabsTrigger value="lapo-uploads" className="gap-1.5">
            <Download className="h-4 w-4" /> LAPO Uploads
          </TabsTrigger>
        </TabsList>

        {/* POC index tab */}
        <TabsContent value="pocs" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {POCS.map((poc) => {
              const Icon = poc.icon;
              return (
                <Card key={poc.path} className="overflow-hidden">
                  <div className={`h-1.5 bg-gradient-to-r ${poc.accent}`} />
                  <CardContent className="pt-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Icon className="h-5 w-5 text-primary" />
                        <h2 className="font-semibold">{poc.name}</h2>
                      </div>
                      <Badge variant="outline" className="text-emerald-700 border-emerald-300">
                        {poc.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2 min-h-[40px]">{poc.blurb}</p>
                    <div className="mt-4 flex items-center gap-2">
                      <a href={poc.path} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" className="gap-2">
                          <ExternalLink className="h-4 w-4" /> Open POC
                        </Button>
                      </a>
                      <code className="text-xs text-muted-foreground">{poc.path}</code>
                    </div>
                    {poc.pocKey === "shopline_review" ? (
                      <ShoplinePublicReviewControl pocKey={poc.pocKey} path={poc.path} />
                    ) : (
                      <><PocAccessLink pocKey={poc.pocKey} path={poc.path} /><RecipientInvites pocKey={poc.pocKey} path={poc.path} /></>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            POC pages are public (no login) so prospects can use them directly. POC data is isolated from real tenant data.
          </p>
        </TabsContent>

        {/* Reconciliation runs tab */}
        <TabsContent value="runs" className="mt-4">
          <PocRunsAdmin />
        </TabsContent>

        {/* Salad uploads tab */}
        <TabsContent value="salad-uploads" className="mt-4">
          <PocUploads
            pocSlug="salad_africa"
            name="Salad Africa"
            roleLabels={{ cbs: "Ledger / Cashbook", statement: "Bank Statement" }}
          />
        </TabsContent>

        {/* LAPO uploads tab */}
        <TabsContent value="lapo-uploads" className="mt-4">
          <PocUploads
            pocSlug="lapo_mfb"
            name="LAPO MFB"
            roleLabels={{ cbs: "CBS Ledger", statement: "Settlement File" }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
