import { useEffect, useState, type ChangeEvent } from "react";
import { trpc } from "@/lib/trpc";
import { usePortalContext } from "@/contexts/PortalContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Loader2, Target, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

type Status = "draft" | "baseline_confirmed" | "parallel_run" | "accepted" | "stopped";
type Form = { workflowName: string; operationalProblem: string; accountableOwner: string; decisionDeadline: string; approvedEvidence: string; baseline: string; successMeasure: string; status: Status };
const blank: Form = { workflowName: "", operationalProblem: "", accountableOwner: "", decisionDeadline: "", approvedEvidence: "", baseline: "", successMeasure: "", status: "draft" };

export default function ControlFit() {
  const { viewAsOrg } = usePortalContext();
  const scope = { organizationId: viewAsOrg?.id };
  const brief = trpc.controlFit.get.useQuery(scope);
  const save = trpc.controlFit.save.useMutation({ onSuccess: () => { setDirty(false); toast.success("Control Fit Brief saved"); void brief.refetch(); } });
  const [form, setForm] = useState<Form>(blank);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    const saved = brief.data?.brief;
    const source = saved ?? brief.data?.template;
    if (!source) return;
    setForm({ workflowName: source.workflowName, operationalProblem: source.operationalProblem, accountableOwner: source.accountableOwner, decisionDeadline: source.decisionDeadline, approvedEvidence: (source.approvedEvidence as string[]).join("\n"), baseline: source.baseline, successMeasure: source.successMeasure, status: saved?.status ?? "draft" });
  }, [brief.data, dirty]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const text = (key: Exclude<keyof Form, "status">) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, event.target.value);
  const submit = () => save.mutate({ ...form, ...scope, approvedEvidence: form.approvedEvidence.split("\n").map((value) => value.trim()).filter(Boolean) });
  if (brief.isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  if (brief.error) return <div className="p-6 text-sm text-destructive">{brief.error.message}</div>;
  return <div className="space-y-6"><div><p className="text-sm font-semibold text-primary">{brief.data?.segment?.replace(/_/g, " ")} · evidence-led workflow</p><h1 className="text-2xl font-bold tracking-tight">Control Fit Brief</h1><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Define one bounded reconciliation workflow, the person who owns it, the decision deadline, approved evidence, baseline and customer-agreed success measure. This records a proposal; it does not claim customer results or authorise payment, posting or AI actions.</p></div><Card><CardHeader><div className="flex items-center gap-2"><Target className="h-5 w-5 text-primary" /><CardTitle>One workflow. One accountable outcome.</CardTitle></div><CardDescription>Start narrow enough to run alongside the current operation and evidence the result.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-2"><div className="md:col-span-2"><Label>Bounded workflow</Label><Input value={form.workflowName} onChange={text("workflowName")} /></div><div className="md:col-span-2"><Label>Operational problem</Label><Textarea value={form.operationalProblem} onChange={text("operationalProblem")} /></div><div><Label>Accountable owner</Label><Input value={form.accountableOwner} onChange={text("accountableOwner")} /></div><div><Label>Decision deadline / cut-off</Label><Input value={form.decisionDeadline} onChange={text("decisionDeadline")} /></div><div className="md:col-span-2"><Label>Approved evidence sources — one per line</Label><Textarea value={form.approvedEvidence} onChange={text("approvedEvidence")} /></div><div><Label>Baseline to confirm</Label><Textarea value={form.baseline} onChange={text("baseline")} /></div><div><Label>Customer-agreed success measure</Label><Textarea value={form.successMeasure} onChange={text("successMeasure")} /></div><div><Label>Evidence state</Label><Select value={form.status} onValueChange={(value) => set("status", value as Status)}><option value="draft">Draft</option><option value="baseline_confirmed">Baseline confirmed</option><option value="parallel_run">Parallel run</option><option value="accepted">Customer accepted</option><option value="stopped">Stopped</option></Select></div><div className="flex items-end justify-end"><Button onClick={submit} disabled={save.isPending}>{save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Save audited brief</Button></div></CardContent></Card></div>;
}
