import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, LockKeyhole, Plus, RefreshCcw, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

type PilotForm = {
  country: "uganda" | "nigeria"; pilotState: "preparation" | "data_validation" | "dry_run" | "parallel_run" | "limited_control" | "suspended";
  pilotScope: string; noWriteAcknowledged: boolean; aiAssistanceMode: "disabled" | "private_approved"; aiBoundaryReference: string;
  dataContractStatus: "draft" | "approved"; rosterStatus: "draft" | "approved"; allocationPolicyStatus: "draft" | "approved"; dailyCloseOwner: string;
  operationalRecoveryStatus: "not_tested" | "passed"; retentionDays: number; contractStatus: "draft" | "approved"; dataProcessingStatus: "draft" | "approved";
  contractReference: string; dataProcessingReference: string;
};

const initialForm: PilotForm = {
  country: "nigeria", pilotState: "preparation", pilotScope: "", noWriteAcknowledged: false, aiAssistanceMode: "disabled", aiBoundaryReference: "",
  dataContractStatus: "draft", rosterStatus: "draft", allocationPolicyStatus: "draft", dailyCloseOwner: "", operationalRecoveryStatus: "not_tested",
  retentionDays: 90, contractStatus: "draft", dataProcessingStatus: "draft", contractReference: "", dataProcessingReference: "",
};

const Select = ({ value, onChange, children }: { value: string; onChange: (value: any) => void; children: React.ReactNode }) => (
  <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
    {children}
  </select>
);

export default function CorporateB2BPilotControls() {
  const readiness = trpc.corporateB2BPilot.readiness.useQuery();
  const updateConfig = trpc.corporateB2BPilot.updateConfig.useMutation({ onSuccess: () => { toast.success("Pilot controls saved and audited"); readiness.refetch(); } });
  const createSource = trpc.corporateB2BPilot.createSource.useMutation({ onSuccess: () => { toast.success("Source contract added"); readiness.refetch(); } });
  const updateSource = trpc.corporateB2BPilot.updateSourceStatus.useMutation({ onSuccess: () => readiness.refetch() });
  const [form, setForm] = useState<PilotForm>(initialForm);
  const [sourceName, setSourceName] = useState("");
  const [sourceType, setSourceType] = useState<"invoice_ar" | "bank_statement" | "mobile_money" | "psp_collection" | "erp_export">("invoice_ar");
  const [deliveryMethod, setDeliveryMethod] = useState<"manual_export" | "sftp" | "bucket" | "api">("manual_export");

  useEffect(() => {
    if (!readiness.data?.config) return;
    const config = readiness.data.config;
    setForm({ ...initialForm, ...config, pilotScope: config.pilotScope ?? "", aiBoundaryReference: config.aiBoundaryReference ?? "", dailyCloseOwner: config.dailyCloseOwner ?? "", contractReference: config.contractReference ?? "", dataProcessingReference: config.dataProcessingReference ?? "" });
  }, [readiness.data?.config]);

  const set = <K extends keyof PilotForm>(key: K, value: PilotForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => updateConfig.mutate(form);
  const addSource = () => {
    if (!sourceName.trim()) return toast.error("Give the source contract a clear name");
    createSource.mutate({ displayName: sourceName.trim(), sourceType, deliveryMethod });
    setSourceName("");
  };

  if (readiness.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading pilot controls…</div>;
  if (readiness.error) return <div className="p-6 text-sm text-destructive">{readiness.error.message}</div>;
  const data = readiness.data!;

  return <div className="space-y-6 p-4 md:p-6">
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <p className="text-sm font-semibold text-primary">Corporate B2B · controlled pilot</p>
        <h1 className="text-2xl font-bold tracking-tight">Pilot Controls</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Evidence register for a reconciliation-only FMCG/distributor pilot. This workspace cannot initiate payments, access accounts, post to an ERP, or send customer messages.</p>
      </div>
      <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${data.canStartReadOnlyPilot ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
        {data.canStartReadOnlyPilot ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {data.canStartReadOnlyPilot ? "Read-only pilot eligible" : `${data.blockedBy.length} gate${data.blockedBy.length === 1 ? "" : "s"} open`}
      </div>
    </div>

    <div className="grid gap-3 md:grid-cols-3">
      <Card><CardHeader className="pb-2"><CardDescription>Roster</CardDescription><CardTitle className="text-2xl">{data.roster.total}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{data.roster.pending} pending · {data.roster.flagged} flagged</CardContent></Card>
      <Card><CardHeader className="pb-2"><CardDescription>Source contracts</CardDescription><CardTitle className="text-2xl">{data.sourceCount}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{data.approvedSources} approved · {data.testedSources} tested</CardContent></Card>
      <Card><CardHeader className="pb-2"><CardDescription>Non-negotiable boundary</CardDescription><CardTitle className="text-lg">No-write</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">Export and review only; customer systems remain authoritative.</CardContent></Card>
    </div>

    <Card><CardHeader><div className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-primary" /><CardTitle>B0–B8 release gates</CardTitle></div><CardDescription>Each green gate is evidence recorded in this tenant. B6 remains an external deployment gate until the reviewed foundation hardening is merged and proven.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.gates.map((gate) => <div key={gate.id} className={`rounded-lg border p-3 ${gate.ready ? "border-emerald-200 bg-emerald-50/70" : "border-amber-200 bg-amber-50/70"}`}><div className="flex items-center gap-2 text-sm font-semibold">{gate.ready ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}{gate.id} · {gate.label}</div><p className="mt-1 text-xs text-muted-foreground">{gate.detail}</p></div>)}</CardContent></Card>

    <div className="grid gap-6 xl:grid-cols-2">
      <Card><CardHeader><div className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-primary" /><CardTitle>Pilot policy and attestations</CardTitle></div><CardDescription>Only an authorised customer owner may mark these items approved. Saving creates an audit event; it does not replace legal, security or operational evidence.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2"><div><Label>Launch country</Label><Select value={form.country} onChange={(value) => set("country", value)}><option value="uganda">Uganda</option><option value="nigeria">Nigeria</option></Select></div><div><Label>Pilot state</Label><Select value={form.pilotState} onChange={(value) => set("pilotState", value)}>{["preparation", "data_validation", "dry_run", "parallel_run", "limited_control", "suspended"].map((value) => <option key={value} value={value}>{value.replace(/_/g, " ")}</option>)}</Select></div></div>
        <div><Label>Bounded reconciliation scope</Label><Input value={form.pilotScope} onChange={(event) => set("pilotScope", event.target.value)} placeholder="e.g., distributor receipts against approved invoices" /></div>
        <div className="flex items-start justify-between rounded-md border p-3"><div><p className="text-sm font-medium">Read-only, no-write acknowledgement</p><p className="text-xs text-muted-foreground">No payment, account, ERP, customer-message or credit-note action can be represented as enabled in this pilot.</p></div><Switch checked={form.noWriteAcknowledged} onCheckedChange={(checked) => set("noWriteAcknowledged", checked)} /></div>
        <div className="grid gap-3 md:grid-cols-2"><div><Label>Data contract</Label><Select value={form.dataContractStatus} onChange={(value) => set("dataContractStatus", value)}><option value="draft">Draft</option><option value="approved">Approved</option></Select></div><div><Label>Roster sign-off</Label><Select value={form.rosterStatus} onChange={(value) => set("rosterStatus", value)}><option value="draft">Draft</option><option value="approved">Approved</option></Select></div><div><Label>Allocation policy</Label><Select value={form.allocationPolicyStatus} onChange={(value) => set("allocationPolicyStatus", value)}><option value="draft">Draft</option><option value="approved">Approved</option></Select></div><div><Label>Recovery/replay test</Label><Select value={form.operationalRecoveryStatus} onChange={(value) => set("operationalRecoveryStatus", value)}><option value="not_tested">Not tested</option><option value="passed">Passed</option></Select></div></div>
        <div><Label>Daily close owner</Label><Input value={form.dailyCloseOwner} onChange={(event) => set("dailyCloseOwner", event.target.value)} placeholder="Finance Controller / role" /></div>
        <div className="grid gap-3 md:grid-cols-2"><div><Label>Commercial reference</Label><Input value={form.contractReference} onChange={(event) => set("contractReference", event.target.value)} placeholder="e.g., pilot SOW reference" /></div><div><Label>Data-processing reference</Label><Input value={form.dataProcessingReference} onChange={(event) => set("dataProcessingReference", event.target.value)} placeholder="e.g., DPA reference" /></div></div>
        <div className="grid gap-3 md:grid-cols-2"><div><Label>Commercial terms</Label><Select value={form.contractStatus} onChange={(value) => set("contractStatus", value)}><option value="draft">Draft</option><option value="approved">Approved</option></Select></div><div><Label>Data-processing terms</Label><Select value={form.dataProcessingStatus} onChange={(value) => set("dataProcessingStatus", value)}><option value="draft">Draft</option><option value="approved">Approved</option></Select></div></div>
        <div className="grid gap-3 md:grid-cols-2"><div><Label>AI assistance</Label><Select value={form.aiAssistanceMode} onChange={(value) => set("aiAssistanceMode", value)}><option value="disabled">Disabled</option><option value="private_approved">Private approved route</option></Select></div><div><Label>Approved AI-boundary reference</Label><Input value={form.aiBoundaryReference} onChange={(event) => set("aiBoundaryReference", event.target.value)} disabled={form.aiAssistanceMode === "disabled"} /></div></div>
        <div className="flex justify-end"><Button onClick={save} disabled={updateConfig.isPending}>{updateConfig.isPending ? <RefreshCcw className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Save audited pilot policy</Button></div>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Source contracts</CardTitle><CardDescription>Register the metadata for authorised evidence sources. Do not paste provider credentials, account numbers, statements or customer files here.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="e.g., AR invoice export" /><Select value={sourceType} onChange={setSourceType}><option value="invoice_ar">Invoice / AR</option><option value="bank_statement">Bank statement</option><option value="mobile_money">Mobile money</option><option value="psp_collection">PSP collection</option><option value="erp_export">ERP export</option></Select><Select value={deliveryMethod} onChange={setDeliveryMethod}><option value="manual_export">Manual export</option><option value="sftp">SFTP</option><option value="bucket">Bucket</option><option value="api">API</option></Select></div><Button variant="outline" onClick={addSource} disabled={createSource.isPending}><Plus className="mr-2 h-4 w-4" />Add source contract</Button><div className="space-y-2">{data.sources.length === 0 ? <p className="text-sm text-muted-foreground">No source contracts recorded.</p> : data.sources.map((source) => <div key={source.id} className="flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center md:justify-between"><div><p className="text-sm font-medium">{source.displayName}</p><p className="text-xs text-muted-foreground">{source.sourceType.replace(/_/g, " ")} · {source.deliveryMethod} · credentials customer-owned · control total required</p></div><Select value={source.status} onChange={(status) => updateSource.mutate({ id: source.id, status, customerOwnedCredentials: source.customerOwnedCredentials, controlTotalRequired: source.controlTotalRequired })}><option value="draft">Draft</option><option value="tested">Tested</option><option value="approved">Approved</option><option value="active">Active</option><option value="suspended">Suspended</option></Select></div>)}</div></CardContent></Card>
    </div>
  </div>;
}
