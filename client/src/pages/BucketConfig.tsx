/**
 * Bucket (object-storage) drop configuration.
 *
 * The S3-compatible counterpart to SFTP config. Many banks, PSPs and couriers
 * deliver settlement files to a bucket rather than an SFTP host, and several
 * prefer it — IAM-scoped access, no long-lived SSH keys, no host to patch.
 *
 * "Test connection" is offered before saving on purpose: a wrong bucket, prefix
 * or file pattern produces a source that looks configured and silently ingests
 * nothing, which is far harder to notice than an outright failure.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Cloud, Plus, Trash2, CheckCircle2, AlertTriangle, Loader2, RefreshCw, FileText,
} from "lucide-react";
import { toast } from "sonner";

type Provider = "s3" | "r2" | "minio" | "other";

const PROVIDER_LABELS: Record<Provider, string> = {
  s3: "AWS S3",
  r2: "Cloudflare R2",
  minio: "MinIO",
  other: "Other (S3-compatible)",
};

const EMPTY = {
  name: "",
  provider: "s3" as Provider,
  bucket: "",
  prefix: "",
  region: "auto",
  endpoint: "",
  accessKeyId: "",
  secretAccessKey: "",
  filePattern: "*.csv",
  archivePrefix: "",
  deleteAfterProcess: false,
  channelId: 0,
  pollingEnabled: true,
  pollingIntervalMinutes: 15,
};

export default function BucketConfig() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [testResult, setTestResult] = useState<{ success: boolean; matchedCount?: number; sample?: string[]; error?: string } | null>(null);

  const { data: sources, refetch, isLoading } = trpc.bucketIngestion.list.useQuery();
  const { data: channels } = trpc.channels.list.useQuery();
  const createMutation = trpc.bucketIngestion.create.useMutation();
  const deleteMutation = trpc.bucketIngestion.delete.useMutation();
  const testMutation = trpc.bucketIngestion.testConnection.useMutation();

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const needsEndpoint = form.provider !== "s3";

  const handleTest = async () => {
    setTestResult(null);
    try {
      const r = await testMutation.mutateAsync({
        provider: form.provider,
        bucket: form.bucket,
        prefix: form.prefix,
        region: form.region,
        endpoint: form.endpoint || undefined,
        accessKeyId: form.accessKeyId || undefined,
        secretAccessKey: form.secretAccessKey || undefined,
        filePattern: form.filePattern,
      });
      setTestResult(r);
      if (r.success) {
        toast.success(`Connected — ${r.matchedCount ?? 0} matching object(s) found`);
      } else {
        toast.error(r.error ?? "Connection failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connection failed");
    }
  };

  const handleCreate = async () => {
    if (!form.name || !form.bucket || !form.channelId) {
      toast.error("Name, bucket and channel are required");
      return;
    }
    if (needsEndpoint && !form.endpoint) {
      toast.error(`An endpoint is required for ${PROVIDER_LABELS[form.provider]}`);
      return;
    }
    try {
      await createMutation.mutateAsync({
        ...form,
        endpoint: form.endpoint || undefined,
        accessKeyId: form.accessKeyId || undefined,
        secretAccessKey: form.secretAccessKey || undefined,
        archivePrefix: form.archivePrefix || undefined,
      });
      toast.success("Bucket source created");
      setForm({ ...EMPTY });
      setTestResult(null);
      setShowForm(false);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create source");
    }
  };

  const handleDelete = async (id: number, name: string) => {
    try {
      await deleteMutation.mutateAsync({ id });
      toast.success(`Removed "${name}"`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove source");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Bucket Drops</h1>
          <p className="text-muted-foreground mt-1">
            Ingest settlement files delivered to an S3-compatible bucket — AWS S3, Cloudflare R2 or MinIO.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4 mr-2" />
          {showForm ? "Cancel" : "New bucket source"}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New bucket source</CardTitle>
            <CardDescription>
              Files are matched by pattern, ingested once by content hash, then archived or left in place.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Courier COD remittances" />
              </Field>
              <Field label="Provider">
                <Select value={form.provider} onValueChange={(v) => set("provider", v as Provider)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                      <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Bucket">
                <Input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} placeholder="bank-settlements" />
              </Field>
              <Field label="Prefix (folder)">
                <Input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="incoming/" />
              </Field>
              <Field label="Region">
                <Input value={form.region} onChange={(e) => set("region", e.target.value)} placeholder="auto" />
              </Field>
              <Field label={needsEndpoint ? "Endpoint (required)" : "Endpoint (AWS: leave blank)"}>
                <Input
                  value={form.endpoint}
                  onChange={(e) => set("endpoint", e.target.value)}
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                />
              </Field>
              <Field label="Access key ID">
                <Input value={form.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Secret access key">
                <Input
                  type="password"
                  value={form.secretAccessKey}
                  onChange={(e) => set("secretAccessKey", e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="File pattern">
                <Input value={form.filePattern} onChange={(e) => set("filePattern", e.target.value)} placeholder="*.csv" />
              </Field>
              <Field label="Channel">
                <Select
                  value={form.channelId ? String(form.channelId) : ""}
                  onValueChange={(v) => set("channelId", Number(v))}
                >
                  <SelectTrigger><SelectValue placeholder="Select a channel" /></SelectTrigger>
                  <SelectContent>
                    {channels?.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Archive prefix (optional)">
                <Input
                  value={form.archivePrefix}
                  onChange={(e) => set("archivePrefix", e.target.value)}
                  placeholder="processed/"
                />
              </Field>
              <Field label="Poll every (minutes)">
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={form.pollingIntervalMinutes}
                  onChange={(e) => set("pollingIntervalMinutes", Number(e.target.value))}
                />
              </Field>
            </div>

            <p className="text-xs text-muted-foreground">
              Leave the access keys blank to use the server's own IAM role — appropriate when the bucket
              is yours rather than the bank's. Files are de-duplicated by content hash, so leaving objects
              in place cannot double-count them.
            </p>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleTest} disabled={!form.bucket || testMutation.isPending}>
                {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Test connection
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save source
              </Button>
            </div>

            {testResult && (
              <div className="rounded-md border p-3 text-sm flex items-start gap-2">
                {testResult.success ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p>Connected — {testResult.matchedCount ?? 0} object(s) match <code>{form.filePattern}</code>.</p>
                      {testResult.sample && testResult.sample.length > 0 && (
                        <p className="text-xs text-muted-foreground font-mono mt-1 break-all">
                          {testResult.sample.join(", ")}
                        </p>
                      )}
                      {testResult.matchedCount === 0 && (
                        <p className="text-xs text-amber-600 mt-1">
                          The bucket is reachable but nothing matches — check the prefix and pattern,
                          or this source will silently ingest nothing.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <span className="break-words">{testResult.error}</span>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Card><CardContent className="py-12 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></CardContent></Card>
      ) : !sources || sources.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Cloud className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No bucket sources yet.</p>
            <p className="text-sm mt-1">Add one to ingest settlement files dropped by a bank, PSP or courier.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => (
            <Card key={s.id}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="secondary">{PROVIDER_LABELS[s.provider as Provider] ?? s.provider}</Badge>
                      {!s.isActive && <Badge variant="outline">Inactive</Badge>}
                      {!s.hasCredentials && <Badge variant="outline">IAM role</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground font-mono mt-1 break-all">
                      {s.bucket}/{s.prefix}{s.filePattern}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Every {s.pollingIntervalMinutes} min · {s.totalFilesProcessed} file(s) processed
                      {s.lastSuccessAt ? ` · last success ${new Date(s.lastSuccessAt).toLocaleString()}` : " · no successful run yet"}
                    </p>
                    {s.lastErrorMessage && (
                      <p className="text-xs text-amber-600 mt-1 break-words">
                        Last error: {s.lastErrorMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline" size="sm"
                      onClick={() => handleDelete(s.id, s.name)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="py-4 flex items-start gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            Bucket drops share the same ingestion pipeline as manual uploads and SFTP: CSV or Excel,
            the same column detection and the same money parsing. A file is ingested once, keyed on the
            hash of its bytes, so re-delivery or a renamed copy will not double-count.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}
