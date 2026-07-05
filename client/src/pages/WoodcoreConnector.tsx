/**
 * WoodCore Connector — health dashboard + configuration.
 *
 * Written for two audiences:
 *  - The institution's IT admin: Overview tab (status, sync runs, webhooks, DLQ).
 *  - A non-technical compliance officer: Configuration + Field Mapping tabs use
 *    plain-language labels, inline explanations, and a paste-a-sample preview
 *    instead of asking anyone to write code.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  PlayCircle,
  Plug,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";

type Entity = "savings_transaction" | "loan_transaction" | "journal_entry";

const ENTITY_LABELS: Record<Entity, string> = {
  savings_transaction: "Savings transactions",
  loan_transaction: "Loan transactions",
  journal_entry: "GL journal entries",
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
    ok: { cls: "bg-green-100 text-green-800", icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: "Healthy" },
    degraded: { cls: "bg-amber-100 text-amber-800", icon: <AlertTriangle className="h-3.5 w-3.5" />, label: "Degraded" },
    down: { cls: "bg-red-100 text-red-800", icon: <XCircle className="h-3.5 w-3.5" />, label: "Down" },
    unknown: { cls: "bg-gray-100 text-gray-600", icon: <Activity className="h-3.5 w-3.5" />, label: "Not yet tested" },
  };
  const s = map[status] ?? map.unknown;
  return (
    <Badge className={`${s.cls} gap-1 hover:${s.cls}`}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

function runStatusBadge(status: string) {
  const cls =
    status === "completed" ? "bg-green-100 text-green-800"
    : status === "running" ? "bg-blue-100 text-blue-800"
    : status === "partial" ? "bg-amber-100 text-amber-800"
    : "bg-red-100 text-red-800";
  return <Badge className={cls}>{status}</Badge>;
}

export default function WoodcoreConnector() {
  const utils = trpc.useUtils();
  const { data: config, isLoading: configLoading } = trpc.woodcoreConnector.getConfig.useQuery();
  const { data: health } = trpc.woodcoreConnector.getHealth.useQuery(
    { probe: false },
    { enabled: Boolean(config), refetchInterval: 30_000 },
  );
  const { data: syncRuns } = trpc.woodcoreConnector.listSyncRuns.useQuery(
    { limit: 30 },
    { enabled: Boolean(config), refetchInterval: 15_000 },
  );
  const { data: webhookEvents } = trpc.woodcoreConnector.listWebhookEvents.useQuery(
    { limit: 50 },
    { enabled: Boolean(config), refetchInterval: 30_000 },
  );
  const { data: deadLetters } = trpc.woodcoreConnector.listDeadLetters.useQuery(
    { limit: 50 },
    { enabled: Boolean(config), refetchInterval: 30_000 },
  );
  const { data: mappings } = trpc.woodcoreConnector.getFieldMappings.useQuery(undefined, {
    enabled: Boolean(config),
  });

  const saveConfig = trpc.woodcoreConnector.saveConfig.useMutation();
  const testConn = trpc.woodcoreConnector.testConnection.useMutation();
  const triggerSync = trpc.woodcoreConnector.triggerSync.useMutation();
  const replayDlq = trpc.woodcoreConnector.replayDeadLetter.useMutation();
  const discardDlq = trpc.woodcoreConnector.discardDeadLetter.useMutation();
  const retryAllDlq = trpc.woodcoreConnector.retryDeadLettersNow.useMutation();
  const previewMapping = trpc.woodcoreConnector.previewMapping.useMutation();

  // ── Config form state (initialized from server on first render of the tab) ──
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});
  const [formReady, setFormReady] = useState(false);
  if (!formReady && config !== undefined && !configLoading) {
    setForm({
      baseUrl: config?.baseUrl ?? "",
      tenantId: config?.tenantId ?? "default",
      authMode: config?.authMode ?? "oauth2",
      oauthClientId: config?.oauthClientId ?? "",
      oauthClientSecret: "",
      oauthTokenUrl: config?.oauthTokenUrl ?? "",
      apiKey: "",
      apiKeyHeader: config?.apiKeyHeader ?? "x-api-key",
      basicUsername: config?.basicUsername ?? "",
      basicPassword: "",
      webhookSecret: "",
      webhookEnabled: config?.webhookEnabled ?? true,
      batchSyncEnabled: config?.batchSyncEnabled ?? true,
      batchSyncHourUtc: config?.batchSyncHourUtc ?? 2,
      isEnabled: config?.isEnabled ?? false,
    });
    setFormReady(true);
  }
  const f = (k: string) => form[k];
  const setF = (k: string, v: string | number | boolean) => setForm((p) => ({ ...p, [k]: v }));

  const [previewEntity, setPreviewEntity] = useState<Entity>("savings_transaction");
  const [previewSample, setPreviewSample] = useState("");
  const [previewResult, setPreviewResult] = useState<
    | { ok: boolean; errors: string[]; preview: Record<string, unknown> | null }
    | null
  >(null);

  const handleSave = async () => {
    if (!form.baseUrl) {
      toast.error("Please enter the WoodCore API address before saving");
      return;
    }
    try {
      await saveConfig.mutateAsync({
        baseUrl: String(form.baseUrl),
        tenantId: String(form.tenantId || "default"),
        authMode: form.authMode as "oauth2" | "api_key" | "basic",
        oauthClientId: String(form.oauthClientId || "") || undefined,
        oauthClientSecret: form.oauthClientSecret === "" ? undefined : String(form.oauthClientSecret),
        oauthTokenUrl: String(form.oauthTokenUrl || "") || undefined,
        apiKey: form.apiKey === "" ? undefined : String(form.apiKey),
        apiKeyHeader: String(form.apiKeyHeader || "x-api-key"),
        basicUsername: String(form.basicUsername || "") || undefined,
        basicPassword: form.basicPassword === "" ? undefined : String(form.basicPassword),
        webhookSecret: form.webhookSecret === "" ? undefined : String(form.webhookSecret),
        webhookEnabled: Boolean(form.webhookEnabled),
        batchSyncEnabled: Boolean(form.batchSyncEnabled),
        batchSyncHourUtc: Number(form.batchSyncHourUtc),
        writeBackEnabled: false,
        pageSize: 500,
        maxRetries: 3,
        requestTimeoutMs: 30000,
        isEnabled: Boolean(form.isEnabled),
      });
      toast.success("Connector settings saved");
      utils.woodcoreConnector.getConfig.invalidate();
      utils.woodcoreConnector.getHealth.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save settings");
    }
  };

  const handleTest = async () => {
    try {
      const r = await testConn.mutateAsync();
      if (r.ok) {
        toast.success(
          `Connected in ${r.latencyMs}ms using ${r.authModeUsed}${r.authDegraded ? " (fallback mode — check OAuth settings)" : ""}`,
        );
      } else {
        toast.error(`Connection failed: ${r.error ?? "unknown error"}`);
      }
      utils.woodcoreConnector.getHealth.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connection test failed");
    }
  };

  const handlePreview = async () => {
    try {
      const r = await previewMapping.mutateAsync({ entity: previewEntity, samplePayload: previewSample });
      setPreviewResult(r as typeof previewResult);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    }
  };

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Plug className="h-7 w-7" /> WoodCore Connector
          </h1>
          <p className="text-muted-foreground mt-1">
            Live link between your WoodCore core banking system and ReconcileAI.
          </p>
        </div>
        {health && <StatusBadge status={health.status} />}
      </div>

      <Tabs defaultValue={config ? "overview" : "configuration"}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="mapping">Field Mapping</TabsTrigger>
          <TabsTrigger value="runs">Sync Runs</TabsTrigger>
          <TabsTrigger value="dlq">Failed Items</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          {!config ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                The WoodCore connector has not been set up yet. Open the{" "}
                <strong>Configuration</strong> tab to connect.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Connection</CardDescription>
                    <CardTitle className="text-lg flex items-center gap-2">
                      {health?.connectivity.ok ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-600" />
                      )}
                      {health?.connectivity.ok ? "Reachable" : "Unreachable"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Auth: {health?.authMode ?? config.authMode}
                    {health?.authDegraded ? " (fallback active)" : ""}
                    <br />
                    Last checked: {health?.connectivity.checkedAt === "never" ? "never" : new Date(health?.connectivity.checkedAt ?? "").toLocaleString()}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Last sync</CardDescription>
                    <CardTitle className="text-lg">
                      {health?.lastSync ? `${health.lastSync.inserted.toLocaleString()} new` : "—"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {health?.lastSync
                      ? `${health.lastSync.status} · ${health.lastSync.trigger} · ${health.lastSync.finishedAt ? new Date(health.lastSync.finishedAt).toLocaleString() : "running"}`
                      : "No sync has run yet"}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Webhooks (24h)</CardDescription>
                    <CardTitle className="text-lg">{health?.webhooks24h.received ?? 0}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {health?.webhooks24h.processed ?? 0} processed · {health?.webhooks24h.failed ?? 0} failed ·{" "}
                    {health?.webhooks24h.duplicates ?? 0} duplicates
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>30-day volume</CardDescription>
                    <CardTitle className="text-lg">{(health?.volume30d.inserted ?? 0).toLocaleString()}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    transactions ingested · capacity 500K+/month
                  </CardContent>
                </Card>
              </div>

              {health && health.reasons.length > 0 && (
                <Card className="border-amber-300">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" /> Needs attention
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {health.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={handleTest} disabled={testConn.isPending}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${testConn.isPending ? "animate-spin" : ""}`} />
                  Test connection now
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await triggerSync.mutateAsync({ scope: "all" });
                      toast.success("Sync started — watch the Sync Runs tab");
                      utils.woodcoreConnector.listSyncRuns.invalidate();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Could not start sync");
                    }
                  }}
                  disabled={triggerSync.isPending || !config.isEnabled}
                >
                  <PlayCircle className="h-4 w-4 mr-2" /> Run sync now
                </Button>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Configuration ────────────────────────────────────────────────── */}
        <TabsContent value="configuration" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" /> Connection settings
              </CardTitle>
              <CardDescription>
                These details come from the WoodCore team. If you are unsure of a value, leave it as
                it is and contact ReconcileAI support — nothing here can delete or change data in
                WoodCore; the connector only reads transactions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>WoodCore API address</Label>
                  <Input
                    placeholder="https://api.yourbank.woodcore.app/api/v1"
                    value={String(f("baseUrl") ?? "")}
                    onChange={(e) => setF("baseUrl", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">The web address of your WoodCore system's API.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Institution tenant ID</Label>
                  <Input value={String(f("tenantId") ?? "")} onChange={(e) => setF("tenantId", e.target.value)} />
                  <p className="text-xs text-muted-foreground">Usually "default" unless WoodCore told you otherwise.</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Sign-in method</Label>
                <Select value={String(f("authMode") ?? "oauth2")} onValueChange={(v) => setF("authMode", v)}>
                  <SelectTrigger className="w-full md:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oauth2">OAuth2 (recommended — automatic secure sessions)</SelectItem>
                    <SelectItem value="api_key">API key (a single long password)</SelectItem>
                    <SelectItem value="basic">Username &amp; password</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  If OAuth2 ever fails, the connector automatically falls back to the API key when one
                  is saved — you'll see a "degraded" notice on the Overview tab if that happens.
                </p>
              </div>

              {String(f("authMode")) === "oauth2" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>OAuth2 Client ID</Label>
                    <Input value={String(f("oauthClientId") ?? "")} onChange={(e) => setF("oauthClientId", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>OAuth2 Client Secret</Label>
                    <Input
                      type="password"
                      placeholder={config?.oauthClientSecretMasked ?? "enter secret"}
                      value={String(f("oauthClientSecret") ?? "")}
                      onChange={(e) => setF("oauthClientSecret", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Leave blank to keep the saved secret.</p>
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>API key {String(f("authMode")) !== "api_key" && "(fallback — optional)"}</Label>
                  <Input
                    type="password"
                    placeholder={config?.apiKeyMasked ?? "enter API key"}
                    value={String(f("apiKey") ?? "")}
                    onChange={(e) => setF("apiKey", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Leave blank to keep the saved key.</p>
                </div>
                {String(f("authMode")) === "basic" && (
                  <>
                    <div className="space-y-1.5">
                      <Label>Username</Label>
                      <Input value={String(f("basicUsername") ?? "")} onChange={(e) => setF("basicUsername", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Password</Label>
                      <Input
                        type="password"
                        placeholder={config?.basicPasswordSet ? "••••••••" : "enter password"}
                        value={String(f("basicPassword") ?? "")}
                        onChange={(e) => setF("basicPassword", e.target.value)}
                      />
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How transactions arrive</CardTitle>
              <CardDescription>
                Real-time updates come in through a webhook; a daily sync catches anything missed.
                Both are on by default and safe to leave on.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="font-medium text-sm">Real-time webhook</p>
                  <p className="text-xs text-muted-foreground">
                    WoodCore pushes each transaction to ReconcileAI the moment it posts.
                  </p>
                  {config && (
                    <div className="flex items-center gap-2 mt-2">
                      <code className="text-xs bg-muted px-2 py-1 rounded">{config.webhookUrl}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(config.webhookUrl);
                          toast.success("Webhook address copied — share it with the WoodCore team");
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
                <Switch checked={Boolean(f("webhookEnabled"))} onCheckedChange={(v) => setF("webhookEnabled", v)} />
              </div>

              <div className="space-y-1.5">
                <Label>Webhook signing secret</Label>
                <Input
                  type="password"
                  placeholder={config?.webhookSecretSet ? "••••••••  (saved)" : "shared secret from WoodCore"}
                  value={String(f("webhookSecret") ?? "")}
                  onChange={(e) => setF("webhookSecret", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Both sides use this secret to prove each message really came from WoodCore. Leave blank to keep the saved one.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="font-medium text-sm">Daily catch-up sync</p>
                  <p className="text-xs text-muted-foreground">
                    Once a day the connector re-pulls recent transactions so nothing is ever missed, even if webhooks were down.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Select
                    value={String(f("batchSyncHourUtc") ?? 2)}
                    onValueChange={(v) => setF("batchSyncHourUtc", Number(v))}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, h) => (
                        <SelectItem key={h} value={String(h)}>
                          {String(h).padStart(2, "0")}:00 UTC
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Switch checked={Boolean(f("batchSyncEnabled"))} onCheckedChange={(v) => setF("batchSyncEnabled", v)} />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/40">
                <div>
                  <p className="font-medium text-sm">Connector enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Master switch. Turn on after a successful connection test.
                  </p>
                </div>
                <Switch checked={Boolean(f("isEnabled"))} onCheckedChange={(v) => setF("isEnabled", v)} />
              </div>

              <div className="flex gap-2 pt-2">
                <Button onClick={handleSave} disabled={saveConfig.isPending}>
                  Save settings
                </Button>
                <Button variant="outline" onClick={handleTest} disabled={testConn.isPending || !config}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${testConn.isPending ? "animate-spin" : ""}`} />
                  Test connection
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Field Mapping ────────────────────────────────────────────────── */}
        <TabsContent value="mapping" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>How WoodCore fields become ReconcileAI fields</CardTitle>
              <CardDescription>
                ReconcileAI ships with a standard mapping for every WoodCore transaction type — you
                normally never need to change it. To confirm it works with your data, paste one sample
                transaction below and press Preview.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                {(Object.keys(ENTITY_LABELS) as Entity[]).map((entity) => (
                  <Card key={entity} className="bg-muted/30">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{ENTITY_LABELS[entity]}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground space-y-1">
                      {(mappings?.defaults[entity] ?? []).slice(0, 6).map((r) => (
                        <div key={r.target} className="flex justify-between gap-2">
                          <code>{r.source}</code>
                          <span>→ {r.target}</span>
                        </div>
                      ))}
                      {mappings?.overrides[entity] && (
                        <Badge variant="outline" className="mt-1">
                          customised (v{mappings.overrides[entity]?.version})
                        </Badge>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="space-y-2 border-t pt-4">
                <Label>Try it with a sample transaction</Label>
                <div className="flex gap-2 items-center">
                  <Select value={previewEntity} onValueChange={(v) => setPreviewEntity(v as Entity)}>
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ENTITY_LABELS) as Entity[]).map((e) => (
                        <SelectItem key={e} value={e}>
                          {ENTITY_LABELS[e]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" onClick={handlePreview} disabled={previewMapping.isPending || !previewSample}>
                    Preview
                  </Button>
                </div>
                <Textarea
                  placeholder='Paste one transaction as JSON, e.g. {"id": 123, "amount": 5000, "transactionType": {"id": 1, "value": "Deposit"}, "date": [2026, 7, 4], ...}'
                  className="font-mono text-xs min-h-28"
                  value={previewSample}
                  onChange={(e) => setPreviewSample(e.target.value)}
                />
                {previewResult && (
                  <Card className={previewResult.ok ? "border-green-300" : "border-red-300"}>
                    <CardContent className="pt-4 text-sm">
                      {previewResult.ok && previewResult.preview ? (
                        <div className="grid gap-1 md:grid-cols-2">
                          {Object.entries(previewResult.preview).map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-3 border-b py-1">
                              <span className="text-muted-foreground">{k}</span>
                              <span className="font-mono text-xs">{String(v ?? "—")}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <ul className="list-disc pl-5 text-red-700">
                          {previewResult.errors.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                )}
                <p className="text-xs text-muted-foreground">
                  If a field maps incorrectly, contact ReconcileAI support with the sample — custom
                  mapping rules are applied per institution without a software update.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Sync Runs ────────────────────────────────────────────────────── */}
        <TabsContent value="runs">
          <Card>
            <CardHeader>
              <CardTitle>Sync history</CardTitle>
              <CardDescription>Every batch pull from WoodCore, newest first.</CardDescription>
            </CardHeader>
            <CardContent>
              {!syncRuns?.length ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No syncs yet.</p>
              ) : (
                <div className="space-y-2">
                  {syncRuns.map((run) => (
                    <div key={run.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                      <div className="flex items-center gap-3">
                        {runStatusBadge(run.status)}
                        <span className="text-muted-foreground">#{run.id}</span>
                        <span>{run.trigger}</span>
                        <span className="text-muted-foreground">
                          {new Date(run.windowFrom).toLocaleDateString()} → {new Date(run.windowTo).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {run.fetched.toLocaleString()} fetched · {run.inserted.toLocaleString()} new ·{" "}
                        {run.duplicates.toLocaleString()} already known
                        {run.failed > 0 && <span className="text-red-600"> · {run.failed} failed</span>}
                        {run.durationMs != null && <> · {(run.durationMs / 1000).toFixed(1)}s</>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Dead letters ─────────────────────────────────────────────────── */}
        <TabsContent value="dlq" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Failed items</CardTitle>
                <CardDescription>
                  Transactions that could not be processed. The connector retries them automatically
                  with increasing delays; you can also retry or dismiss them here.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const r = await retryAllDlq.mutateAsync();
                    toast.success(`Retried ${r.processed}: ${r.resolved} fixed, ${r.failedAgain + r.exhausted} still failing`);
                    utils.woodcoreConnector.listDeadLetters.invalidate();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Retry failed");
                  }
                }}
                disabled={retryAllDlq.isPending}
              >
                <RotateCcw className="h-4 w-4 mr-2" /> Retry all due now
              </Button>
            </CardHeader>
            <CardContent>
              {!deadLetters?.length ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  Nothing here — all transactions processed cleanly. 🎉
                </p>
              ) : (
                <div className="space-y-2">
                  {deadLetters.map((dl) => (
                    <div key={dl.id} className="rounded-lg border p-3 text-sm space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge
                            className={
                              dl.status === "exhausted" || dl.status === "discarded"
                                ? "bg-red-100 text-red-800"
                                : dl.status === "resolved"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-amber-100 text-amber-800"
                            }
                          >
                            {dl.status}
                          </Badge>
                          <span className="text-muted-foreground">
                            {dl.source} · {dl.refType ?? "?"} · attempt {dl.attempts}/{dl.maxAttempts}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Retry now"
                            onClick={async () => {
                              try {
                                await replayDlq.mutateAsync({ id: dl.id });
                                toast.success("Queued for immediate retry");
                                utils.woodcoreConnector.listDeadLetters.invalidate();
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : "Replay failed");
                              }
                            }}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Dismiss permanently"
                            onClick={async () => {
                              const note = prompt("Why is this item safe to dismiss? (kept for audit)");
                              if (!note) return;
                              try {
                                await discardDlq.mutateAsync({ id: dl.id, note });
                                toast.success("Dismissed (kept in the audit trail)");
                                utils.woodcoreConnector.listDeadLetters.invalidate();
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : "Dismiss failed");
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-red-700 font-mono truncate">{dl.error}</p>
                      {dl.nextRetryAt && dl.status !== "resolved" && (
                        <p className="text-xs text-muted-foreground">
                          Next automatic retry: {new Date(dl.nextRetryAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
