import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Webhook, Key, Plus, Trash2, Copy, Check, AlertTriangle,
  Globe, Shield, Clock, ExternalLink,
} from "lucide-react";

// ─── Webhook Management ─────────────────────────────────────────────

function WebhookSection() {
  const { data: webhookList, refetch } = trpc.webhooks.list.useQuery();
  const createWebhook = trpc.webhooks.create.useMutation({
    onSuccess: (data) => {
      toast.success(`Webhook created. Save the signing secret!`);
      setNewSecret(data.secret);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const deleteWebhook = trpc.webhooks.delete.useMutation({
    onSuccess: () => { toast.success("Webhook deleted"); refetch(); },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([
    "reconciliation.completed",
    "exception.created",
  ]);

  const availableEvents = [
    "upload.completed",
    "reconciliation.completed",
    "reconciliation.failed",
    "exception.created",
    "exception.resolved",
    "exception.escalated",
  ];

  const handleCreate = () => {
    if (!name || !url) return;
    createWebhook.mutate({ name, url, events: selectedEvents });
    setShowCreate(false);
    setName("");
    setUrl("");
  };

  const copySecret = () => {
    if (newSecret) {
      navigator.clipboard.writeText(newSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              Webhooks
            </CardTitle>
            <CardDescription className="mt-1">
              Receive real-time notifications when reconciliation events occur. Integrate with your core banking system, ERP, or monitoring tools.
            </CardDescription>
          </div>
          <Button onClick={() => setShowCreate(!showCreate)} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Webhook
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {newSecret && (
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-amber-800 dark:text-amber-200">Save Your Signing Secret</p>
                <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  This secret is used to verify webhook payloads via HMAC-SHA256. It will not be shown again.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="bg-amber-100 dark:bg-amber-900 px-3 py-1 rounded text-sm font-mono break-all">
                    {newSecret}
                  </code>
                  <Button variant="outline" size="sm" onClick={copySecret}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showCreate && (
          <div className="border rounded-lg p-4 space-y-3">
            <Input placeholder="Webhook name (e.g., Core Banking Notifier)" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="https://your-system.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
            <div>
              <p className="text-sm font-medium mb-2">Events:</p>
              <div className="flex flex-wrap gap-2">
                {availableEvents.map((event) => (
                  <button
                    key={event}
                    onClick={() => setSelectedEvents((prev) =>
                      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
                    )}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      selectedEvents.includes(event)
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {event}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={!name || !url || selectedEvents.length === 0}>
                Create Webhook
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {webhookList && webhookList.length > 0 ? (
          <div className="space-y-2">
            {webhookList.map((wh: any) => (
              <div key={wh.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-sm">{wh.name}</p>
                    <p className="text-xs text-muted-foreground truncate max-w-[300px]">{wh.url}</p>
                  </div>
                  <div className={`px-2 py-0.5 rounded-full text-xs ${
                    wh.isActive ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" : "bg-red-100 text-red-800"
                  }`}>
                    {wh.isActive ? "Active" : "Inactive"}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => deleteWebhook.mutate({ id: wh.id })}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No webhooks configured. Add one to receive real-time notifications.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── API Key Management ─────────────────────────────────────────────

function ApiKeySection() {
  const { data: keyList, refetch } = trpc.apiKeys.list.useQuery();
  const createKey = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      toast.success("API key created");
      setNewKey(data.key);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const revokeKey = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => { toast.success("API key revoked"); refetch(); },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedPerms, setSelectedPerms] = useState<string[]>(["read:transactions"]);

  const availablePermissions = [
    "read:transactions",
    "write:upload",
    "read:reconciliation",
    "write:reconciliation",
    "read:exceptions",
    "write:exceptions",
    "read:reports",
    "admin",
  ];

  const handleCreate = () => {
    if (!name) return;
    createKey.mutate({ name, permissions: selectedPerms });
    setShowCreate(false);
    setName("");
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              API Keys
            </CardTitle>
            <CardDescription className="mt-1">
              Generate API keys for programmatic access. Integrate ReconcileAI with your existing banking infrastructure via REST API.
            </CardDescription>
          </div>
          <Button onClick={() => setShowCreate(!showCreate)} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Generate Key
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {newKey && (
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-amber-800 dark:text-amber-200">Save Your API Key</p>
                <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  This key will not be shown again. Use it in the <code>Authorization: Bearer</code> header.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="bg-amber-100 dark:bg-amber-900 px-3 py-1 rounded text-xs font-mono break-all">
                    {newKey}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyKey}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showCreate && (
          <div className="border rounded-lg p-4 space-y-3">
            <Input placeholder="Key name (e.g., Core Banking Integration)" value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <p className="text-sm font-medium mb-2">Permissions:</p>
              <div className="flex flex-wrap gap-2">
                {availablePermissions.map((perm) => (
                  <button
                    key={perm}
                    onClick={() => setSelectedPerms((prev) =>
                      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
                    )}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      selectedPerms.includes(perm)
                        ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {perm}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={!name || selectedPerms.length === 0}>
                Generate Key
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {keyList && keyList.length > 0 ? (
          <div className="space-y-2">
            {keyList.map((key: any) => (
              <div key={key.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-sm">{key.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{key.keyPrefix}...</p>
                  </div>
                  <div className={`px-2 py-0.5 rounded-full text-xs ${
                    key.isActive ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" : "bg-red-100 text-red-800"
                  }`}>
                    {key.isActive ? "Active" : "Revoked"}
                  </div>
                  {key.lastUsedAt && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Last used: {new Date(key.lastUsedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {key.isActive && (
                  <Button variant="ghost" size="sm" onClick={() => revokeKey.mutate({ id: key.id })}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No API keys generated. Create one to enable programmatic access.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Integration Documentation ──────────────────────────────────────

function DocumentationSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ExternalLink className="h-5 w-5" />
          Integration Guide
        </CardTitle>
        <CardDescription>
          Connect ReconcileAI with your banking and payment systems across Africa.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border rounded-lg p-4">
            <h4 className="font-semibold text-sm mb-2">Webhook Payload Format</h4>
            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
{`POST /your-endpoint
Content-Type: application/json
X-ReconcileAI-Signature: <hmac-sha256>
X-ReconcileAI-Event: reconciliation.completed

{
  "event": "reconciliation.completed",
  "payload": {
    "jobId": 123,
    "matchedCount": 450,
    "exceptionCount": 12,
    "matchRate": 95.5
  },
  "timestamp": "2026-02-13T10:00:00Z"
}`}
            </pre>
          </div>
          <div className="border rounded-lg p-4">
            <h4 className="font-semibold text-sm mb-2">API Authentication</h4>
            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
{`# Upload transactions via API
curl -X POST /api/trpc/upload.createBatch \\
  -H "Authorization: Bearer rai_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelCode": "nibss",
    "fileName": "daily_txns.csv",
    "transactions": [...]
  }'`}
            </pre>
          </div>
          <div className="border rounded-lg p-4">
            <h4 className="font-semibold text-sm mb-2">Supported Channels</h4>
            <div className="text-xs space-y-1 text-muted-foreground">
              <p><strong>Nigeria:</strong> NIBSS (NIP/NEFT), POS, ATM, Mobile Banking, USSD, Agent Banking</p>
              <p><strong>Kenya:</strong> M-Pesa, PesaLink, RTGS, EFT</p>
              <p><strong>Ghana:</strong> GhIPSS, Mobile Money, ACH</p>
              <p><strong>South Africa:</strong> BankservAfrica, RTC, EFT</p>
              <p><strong>Pan-African:</strong> SWIFT, RTGS, Card Payments, QR Payments</p>
            </div>
          </div>
          <div className="border rounded-lg p-4">
            <h4 className="font-semibold text-sm mb-2">Supported Currencies</h4>
            <div className="text-xs space-y-1 text-muted-foreground">
              <p><strong>West Africa:</strong> NGN, GHS, XOF</p>
              <p><strong>East Africa:</strong> KES, TZS, UGX, RWF, ETB</p>
              <p><strong>Southern Africa:</strong> ZAR</p>
              <p><strong>North Africa:</strong> EGP, MAD</p>
              <p><strong>Central Africa:</strong> XAF</p>
              <p><strong>International:</strong> USD, EUR, GBP</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Integrations Page ─────────────────────────────────────────

export default function Integrations() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground mt-1">
          Connect ReconcileAI with your banking infrastructure. Manage webhooks, API keys, and export data for external systems.
        </p>
      </div>
      <WebhookSection />
      <ApiKeySection />
      <DocumentationSection />
    </div>
  );
}
