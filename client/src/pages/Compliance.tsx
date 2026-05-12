import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  ShieldCheck,
  ShieldAlert,
  Trash2,
  AlertTriangle,
  FileText,
  User,
  Mail,
  Phone,
  CheckCircle2,
  XCircle,
  Download,
  Clock,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1">
      <CheckCircle2 className="w-3 h-3" /> {label}
    </Badge>
  ) : (
    <Badge className="bg-red-100 text-red-700 border-red-200 gap-1">
      <XCircle className="w-3 h-3" /> {label} — Not Confirmed
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    low: "bg-blue-100 text-blue-700",
    medium: "bg-amber-100 text-amber-700",
    high: "bg-orange-100 text-orange-700",
    critical: "bg-red-100 text-red-700",
  };
  return (
    <Badge className={`${map[severity] ?? "bg-gray-100 text-gray-700"} capitalize`}>
      {severity}
    </Badge>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Compliance() {
  // ── Server state ──
  const { data: settings, refetch: refetchSettings } = trpc.compliance.getSettings.useQuery();
  const { data: deletionRequests = [], refetch: refetchDeletions } = trpc.compliance.listDeletionRequests.useQuery();
  const { data: incidents = [], refetch: refetchIncidents } = trpc.compliance.listIncidents.useQuery();

  // ── Mutations ──
  const saveSettings = trpc.compliance.saveSettings.useMutation({
    onSuccess: () => { toast.success("Compliance settings saved"); refetchSettings(); },
    onError: (e) => toast.error(e.message),
  });
  const requestDeletion = trpc.compliance.requestDeletion.useMutation({
    onSuccess: (data) => {
      toast.success(`Data deleted — ${data.recordsDeleted.toLocaleString()} records removed`);
      setCertText(data.certificateText);
      setShowCert(true);
      setShowDeleteDialog(false);
      refetchDeletions();
    },
    onError: (e) => toast.error(e.message),
  });
  const reportIncident = trpc.compliance.reportIncident.useMutation({
    onSuccess: () => {
      toast.success("Incident reported and owner notified");
      setShowIncidentDialog(false);
      refetchIncidents();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Local form state ──
  const [dpoName, setDpoName] = useState(settings?.dpoName ?? "");
  const [dpoEmail, setDpoEmail] = useState(settings?.dpoEmail ?? "");
  const [dpoPhone, setDpoPhone] = useState(settings?.dpoPhone ?? "");
  const [breachEmail, setBreachEmail] = useState(settings?.breachNotificationEmail ?? "");
  const [retentionDays, setRetentionDays] = useState(String(settings?.retentionPeriodDays ?? 1825));
  const [ndpa, setNdpa] = useState(settings?.ndpaCompliant ?? false);
  const [ndpr, setNdpr] = useState(settings?.ndprCompliant ?? false);
  const [ropa, setRopa] = useState(settings?.ropaCompleted ?? false);
  const [notes, setNotes] = useState(settings?.notes ?? "");

  // ── Deletion dialog ──
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"all_transactions" | "all_data">("all_transactions");
  const [deleteNotes, setDeleteNotes] = useState("");

  // ── Certificate dialog ──
  const [showCert, setShowCert] = useState(false);
  const [certText, setCertText] = useState("");

  // ── Incident dialog ──
  const [showIncidentDialog, setShowIncidentDialog] = useState(false);
  const [incidentType, setIncidentType] = useState<"unauthorised_access" | "data_breach" | "unauthorised_disclosure" | "system_compromise" | "other">("other");
  const [incidentSeverity, setIncidentSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [incidentDesc, setIncidentDesc] = useState("");

  function downloadCert() {
    const blob = new Blob([certText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ReconcileAI_Deletion_Certificate_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-[#1B365D]" />
            Compliance Centre
          </h1>
          <p className="text-muted-foreground mt-1">
            NDPA / NDPR compliance management — NDA Clauses 7, 11 &amp; 12
          </p>
        </div>

        {/* Data Minimisation Notice */}
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-800">
            <span className="font-semibold">Data Minimisation Notice (NDPA 2023, s.24):</span> Upload only the minimum transaction data necessary for reconciliation. Do not include customer PII (names, BVN, NIN, phone numbers) in transaction files unless strictly required. ReconcileAI processes financial reference data only.
          </div>
        </div>

        {/* Compliance Status Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">NDPA 2023</p>
            <StatusBadge ok={settings?.ndpaCompliant ?? false} label="NDPA Compliant" />
          </div>
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">NDPR 2019</p>
            <StatusBadge ok={settings?.ndprCompliant ?? false} label="NDPR Compliant" />
          </div>
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">ROPA</p>
            <StatusBadge ok={settings?.ropaCompleted ?? false} label="ROPA Completed" />
          </div>
        </div>

        {/* DPO Settings */}
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <User className="w-4 h-4" /> Data Protection Officer (Clause 11)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">DPO Name</label>
              <Input value={dpoName} onChange={e => setDpoName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" /> DPO Email</label>
              <Input value={dpoEmail} onChange={e => setDpoEmail(e.target.value)} placeholder="dpo@organisation.com" type="email" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> DPO Phone</label>
              <Input value={dpoPhone} onChange={e => setDpoPhone(e.target.value)} placeholder="+234..." />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Breach Notification Email (Clause 12)</label>
              <Input value={breachEmail} onChange={e => setBreachEmail(e.target.value)} placeholder="security@organisation.com" type="email" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data Retention Period (days)</label>
              <Input value={retentionDays} onChange={e => setRetentionDays(e.target.value)} type="number" min={1} max={3650} />
            </div>
          </div>
          {/* Compliance checkboxes */}
          <div className="flex flex-wrap gap-6 pt-2">
            {[
              { label: "NDPA 2023 Compliant", value: ndpa, set: setNdpa },
              { label: "NDPR 2019 Compliant", value: ndpr, set: setNdpr },
              { label: "ROPA Completed", value: ropa, set: setRopa },
            ].map(({ label, value, set }) => (
              <label key={label} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={e => set(e.target.checked)}
                  className="w-4 h-4 accent-[#1B365D]"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Notes / Programme Reference</label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Link to privacy policy, ROPA document, DPA registration number..." rows={2} />
          </div>
          <Button
            className="bg-[#1B365D] hover:bg-[#1B365D]/90 text-white"
            onClick={() => saveSettings.mutate({
              dpoName: dpoName || undefined,
              dpoEmail: dpoEmail || undefined,
              dpoPhone: dpoPhone || undefined,
              breachNotificationEmail: breachEmail || undefined,
              retentionPeriodDays: Number(retentionDays) || 1825,
              ndpaCompliant: ndpa,
              ndprCompliant: ndpr,
              ropaCompleted: ropa,
              notes: notes || undefined,
            })}
            disabled={saveSettings.isPending}
          >
            {saveSettings.isPending ? "Saving..." : "Save Settings"}
          </Button>
        </div>

        {/* Data Deletion */}
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-600" /> Data Return &amp; Destruction (Clause 7)
            </h2>
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
              Request Data Deletion
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Under Clause 7 of the NDA, all Confidential Information must be returned or destroyed upon request or termination. Use this to permanently delete transaction data and receive a signed deletion certificate.
          </p>
          {deletionRequests.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Deletion History</p>
              <div className="divide-y rounded-lg border overflow-hidden">
                {deletionRequests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-4 py-3 text-sm bg-background">
                    <div className="flex items-center gap-3">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <span className="font-medium capitalize">{r.scope.replace(/_/g, " ")}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {r.recordsDeleted?.toLocaleString() ?? 0} records
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={r.status === "completed" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
                        {r.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(r.requestedAt).toLocaleDateString()}
                      </span>
                      {r.certificateText && (
                        <Button size="sm" variant="ghost" onClick={() => { setCertText(r.certificateText!); setShowCert(true); }}>
                          <Download className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Security Incidents */}
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-orange-600" /> Security Incident Log (Clause 12)
            </h2>
            <Button size="sm" variant="outline" onClick={() => setShowIncidentDialog(true)}>
              Report Incident
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Clause 12 requires immediate notification of any security breach or unauthorised disclosure. Reporting here automatically notifies the platform owner and creates an auditable record.
          </p>
          {incidents.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg p-3 border border-emerald-200">
              <CheckCircle2 className="w-4 h-4" /> No security incidents recorded.
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-hidden">
              {incidents.map((inc) => (
                <div key={inc.id} className="flex items-start justify-between px-4 py-3 text-sm bg-background gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium capitalize">{inc.incidentType.replace(/_/g, " ")}</span>
                      <SeverityBadge severity={inc.severity} />
                      <Badge className={inc.status === "resolved" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
                        {inc.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs line-clamp-2">{inc.description}</p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                    <Clock className="w-3 h-3" />
                    {new Date(inc.reportedAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Deletion Confirm Dialog ── */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="w-5 h-5" /> Request Data Deletion
            </DialogTitle>
            <DialogDescription>
              This action is <strong>irreversible</strong>. All selected data will be permanently deleted and a signed deletion certificate will be generated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Deletion Scope</label>
              <Select value={deleteScope} onValueChange={(v) => setDeleteScope(v as typeof deleteScope)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all_transactions">All Transactions Only</SelectItem>
                  <SelectItem value="all_data">All Data (transactions, jobs, uploads)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Reason / Notes</label>
              <Textarea value={deleteNotes} onChange={e => setDeleteNotes(e.target.value)} placeholder="NDA termination, end of POC, data subject request..." rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => requestDeletion.mutate({ scope: deleteScope, notes: deleteNotes })}
              disabled={requestDeletion.isPending}
            >
              {requestDeletion.isPending ? "Deleting..." : "Confirm Deletion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Certificate Dialog ── */}
      <Dialog open={showCert} onOpenChange={setShowCert}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-[#1B365D]" /> Deletion Certificate
            </DialogTitle>
          </DialogHeader>
          <pre className="text-xs bg-muted rounded-lg p-4 whitespace-pre-wrap font-mono max-h-72 overflow-y-auto">
            {certText}
          </pre>
          <DialogFooter>
            <Button onClick={downloadCert} className="bg-[#1B365D] text-white hover:bg-[#1B365D]/90">
              <Download className="w-4 h-4 mr-2" /> Download Certificate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Incident Report Dialog ── */}
      <Dialog open={showIncidentDialog} onOpenChange={setShowIncidentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-600">
              <ShieldAlert className="w-5 h-5" /> Report Security Incident
            </DialogTitle>
            <DialogDescription>
              Clause 12 requires immediate notification. This will automatically notify the platform owner.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Incident Type</label>
                <Select value={incidentType} onValueChange={(v) => setIncidentType(v as typeof incidentType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unauthorised_access">Unauthorised Access</SelectItem>
                    <SelectItem value="data_breach">Data Breach</SelectItem>
                    <SelectItem value="unauthorised_disclosure">Unauthorised Disclosure</SelectItem>
                    <SelectItem value="system_compromise">System Compromise</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Severity</label>
                <Select value={incidentSeverity} onValueChange={(v) => setIncidentSeverity(v as typeof incidentSeverity)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={incidentDesc}
                onChange={e => setIncidentDesc(e.target.value)}
                placeholder="Describe what happened, when it was discovered, and what data may be affected..."
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowIncidentDialog(false)}>Cancel</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={() => reportIncident.mutate({ incidentType, severity: incidentSeverity, description: incidentDesc })}
              disabled={reportIncident.isPending || incidentDesc.length < 10}
            >
              {reportIncident.isPending ? "Reporting..." : "Submit Report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
