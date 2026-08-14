/**
 * Email-forward ingestion configuration.
 *
 * The transport a non-technical merchant will actually adopt: one forwarding
 * rule in their mail client and every provider that emails a payout report
 * works — no API, no credentials, no per-provider integration.
 *
 * Three things this screen deliberately does NOT let the user get wrong:
 *
 *   - It never prints an address that cannot receive mail. Until MX records and
 *     the signing secret exist, the endpoint fails closed; an address copied
 *     into a mail rule in that state would drop every message and look like a
 *     product fault, so the banner replaces the address rather than sitting
 *     above it.
 *   - It never accepts an empty allow-list. The inbound path fails closed, so a
 *     source saved without one would appear configured and refuse everything.
 *   - It never rotates an address without saying what rotation costs: mail to
 *     the old one stops arriving immediately, so the mail rule must be updated
 *     in the same sitting.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Mail, Plus, Trash2, Copy, Check, AlertTriangle, Loader2, RefreshCw, Inbox, ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

/** Rejection codes written by the inbound handler, in the operator's language. */
const REJECTION_LABELS: Record<string, string> = {
  unknown_address: "Unknown address",
  sender_not_allowed: "Sender not on the allow-list",
  no_ingestible_attachment: "No usable attachment",
  attachment_too_large: "Attachment over the size cap",
  duplicate_content: "Already ingested (same content)",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  success: "default",
  partial: "secondary",
  skipped: "outline",
  rejected: "destructive",
  failed: "destructive",
};

const MB = 1_048_576;

const EMPTY = {
  name: "",
  channelId: 0,
  allowedSenders: "",
  maxAttachmentMb: 10,
};

export default function EmailForwarding() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [copied, setCopied] = useState<number | null>(null);
  const [rotating, setRotating] = useState<{ id: number; name: string } | null>(null);
  const [logSourceId, setLogSourceId] = useState<number | undefined>(undefined);

  const { data: status } = trpc.emailIngestion.inboundStatus.useQuery();
  const { data: sources, refetch, isLoading } = trpc.emailIngestion.list.useQuery();
  const { data: channels } = trpc.channels.list.useQuery();
  const { data: logs, refetch: refetchLogs } = trpc.emailIngestion.logs.useQuery({
    sourceId: logSourceId,
    limit: 50,
  });

  const createMutation = trpc.emailIngestion.create.useMutation();
  const deleteMutation = trpc.emailIngestion.delete.useMutation();
  const rotateMutation = trpc.emailIngestion.rotateAddress.useMutation();
  const updateMutation = trpc.emailIngestion.update.useMutation();

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Deliberately NOT `domainConfigured && webhookSecretConfigured`. Both are set
  // in production on a channel that has never received a single message, so
  // configuration is not evidence — only a delivery is. See CLAUDE.md §19.4.
  const readiness = status?.readiness;

  const copy = async (address: string, id: number) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      toast.error("Could not copy — select the address and copy manually");
    }
  };

  const handleCreate = async () => {
    if (!form.name || !form.channelId || !form.allowedSenders.trim()) {
      toast.error("Name, channel and at least one allowed sender are required");
      return;
    }
    try {
      const r = await createMutation.mutateAsync({
        name: form.name,
        channelId: form.channelId,
        allowedSenders: form.allowedSenders,
        maxAttachmentBytes: form.maxAttachmentMb * MB,
      });
      toast.success(r.address ? `Forwarding address created — ${r.address}` : "Source created");
      setForm({ ...EMPTY });
      setShowForm(false);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create source");
    }
  };

  const handleRotate = async () => {
    if (!rotating) return;
    try {
      const r = await rotateMutation.mutateAsync({ id: rotating.id });
      toast.success(r.address ? `New address: ${r.address}` : "Address rotated");
      setRotating(null);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rotate address");
    }
  };

  const handleDelete = async (id: number, name: string) => {
    try {
      await deleteMutation.mutateAsync({ id });
      toast.success(`Removed "${name}"`);
      refetch();
      refetchLogs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove source");
    }
  };

  const handleToggleActive = async (id: number, isActive: boolean) => {
    try {
      await updateMutation.mutateAsync({ id, isActive });
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update source");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">Email Forwarding</h1>
          <p className="text-muted-foreground mt-1">
            Forward settlement and payout emails to a private address — the attachments are ingested
            automatically, whoever the provider is.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4 mr-2" />
          {showForm ? "Cancel" : "New forwarding address"}
        </Button>
      </div>

      {status && readiness === "unconfigured" && (
        <Card className="border-amber-500/50">
          <CardContent className="py-4 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Inbound mail is not configured.</p>
              <p className="text-muted-foreground mt-1">
                {!status.domainConfigured
                  ? "The inbound mail domain is not set, so no forwarding address can be issued."
                  : "The webhook signing secret is not set, so deliveries are refused."}{" "}
                Verification fails closed by design — an unsigned delivery is never accepted.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {status && readiness === "unproven" && (
        <Card className="border-amber-500/50">
          <CardContent className="py-4 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Configured, but no message has ever arrived.</p>
              <p className="text-muted-foreground mt-1">
                The settings are in place, which is not the same as working: nothing has been
                received on this deployment yet, so the path from your mail provider to here is
                unproven. Send one test email to a forwarding address below and confirm it appears
                under Recent deliveries — even a rejection counts, because it proves the message
                reached us. Until then, treat this channel as not yet live.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New forwarding address</CardTitle>
            <CardDescription>
              A private address is generated for you. Attachments are matched, de-duplicated by content
              hash and parsed exactly like a manual upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Stripe daily payouts"
                />
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
              <Field label="Maximum attachment size (MB)">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={form.maxAttachmentMb}
                  onChange={(e) => set("maxAttachmentMb", Number(e.target.value))}
                />
              </Field>
            </div>

            <Field label="Allowed senders (required)">
              <Textarea
                value={form.allowedSenders}
                onChange={(e) => set("allowedSenders", e.target.value)}
                placeholder={"payouts@stripe.com\n@dhl.com"}
                rows={4}
                className="font-mono text-sm"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              One per line — a full address (<code>payouts@stripe.com</code>) or a whole domain
              (<code>@dhl.com</code>). Domains match exactly, so <code>@stripe.com</code> never
              accepts <code>evil-stripe.com</code>. This list is required and is the control that
              matters: forwarding addresses end up in mail rules, shared inboxes and screenshots, so
              knowing the address is deliberately not enough to deliver to it.
            </p>

            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create address
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Card><CardContent className="py-12 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></CardContent></Card>
      ) : !sources || sources.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Inbox className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No forwarding addresses yet.</p>
            <p className="text-sm mt-1">
              Create one, then add a rule in your mail client forwarding your provider's settlement
              emails to it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => (
            <Card key={s.id}>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{s.name}</span>
                      {!s.isActive && <Badge variant="outline">Paused</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {s.totalFilesProcessed} file(s) processed
                      {s.lastReceivedAt
                        ? ` · last delivery ${new Date(s.lastReceivedAt).toLocaleString()}`
                        : " · nothing received yet"}
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
                      onClick={() => handleToggleActive(s.id, !s.isActive)}
                      disabled={updateMutation.isPending}
                    >
                      {s.isActive ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setRotating({ id: s.id, name: s.name })}
                      title="Issue a new address"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => handleDelete(s.id, s.name)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {s.address ? (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                    <code className="text-sm break-all flex-1">{s.address}</code>
                    <Button variant="ghost" size="sm" onClick={() => copy(s.address!, s.id)}>
                      {copied === s.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    No address can be shown until the inbound mail domain is configured.
                  </div>
                )}

                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span className="break-words">
                    Accepts from: <span className="font-mono">{s.allowedSenders?.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).join(", ")}</span>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Recent deliveries</CardTitle>
            <CardDescription>
              Refused deliveries are listed too — a run of rejections from one sender is how a leaked
              address makes itself visible.
            </CardDescription>
          </div>
          <Select
            value={logSourceId ? String(logSourceId) : "all"}
            onValueChange={(v) => setLogSourceId(v === "all" ? undefined : Number(v))}
          >
            <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {sources?.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {!logs || logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No deliveries recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {logs.map((l) => (
                <div key={l.id} className="flex items-start justify-between gap-3 border-b last:border-0 pb-2 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={STATUS_VARIANTS[l.status] ?? "outline"}>{l.status}</Badge>
                      <span className="text-sm truncate">{l.attachmentName ?? l.subject ?? "(no attachment)"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 break-all">
                      {l.fromAddress ?? "unknown sender"}
                      {l.rejectionReason ? ` · ${REJECTION_LABELS[l.rejectionReason] ?? l.rejectionReason}` : ""}
                      {l.validRows !== null && l.validRows !== undefined ? ` · ${l.validRows} row(s) imported` : ""}
                    </p>
                    {l.errorMessage && (
                      <p className="text-xs text-amber-600 mt-0.5 break-words">{l.errorMessage}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(l.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={rotating !== null} onOpenChange={(o) => !o && setRotating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issue a new address for "{rotating?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The current address stops working immediately, and anything still forwarding to it will
              be silently refused. Update the forwarding rule in your mail client as soon as the new
              address is issued. Do this if the address has been shared outside your team.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRotate} disabled={rotateMutation.isPending}>
              {rotateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Issue new address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
