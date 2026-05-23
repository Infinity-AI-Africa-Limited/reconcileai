import { useState, useEffect } from "react";
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
  CheckCircle2,
  XCircle,
  Download,
  Clock,
  User,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ComplianceBadge({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
      <CheckCircle2 className="w-4 h-4 shrink-0" />
      <span>{label}</span>
    </div>
  ) : (
    <div className="flex items-center gap-2 text-sm font-medium text-red-600">
      <XCircle className="w-4 h-4 shrink-0" />
      <span>Not confirmed</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    low: "bg-blue-100 text-blue-700 border-blue-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    high: "bg-orange-100 text-orange-700 border-orange-200",
    critical: "bg-red-100 text-red-700 border-red-200",
  };
  return (
    <Badge variant="outline" className={`${map[severity] ?? "bg-gray-100 text-gray-700"} capitalize text-xs`}>
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
      toast.success("Incident reported");
      setShowIncidentDialog(false);
      refetchIncidents();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Local form state (initialised from server data) ──
  const [dpoName, setDpoName] = useState("");
  const [dpoEmail, setDpoEmail] = useState("");
  const [dpoPhone, setDpoPhone] = useState("");
  const [breachEmail, setBreachEmail] = useState("");
  const [retentionDays, setRetentionDays] = useState("1825");
  const [ndpa, setNdpa] = useState(false);
  const [ndpr, setNdpr] = useState(false);
  const [ropa, setRopa] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (settings) {
      setDpoName(settings.dpoName ?? "");
      setDpoEmail(settings.dpoEmail ?? "");
      setDpoPhone(settings.dpoPhone ?? "");
      setBreachEmail(settings.breachNotificationEmail ?? "");
      setRetentionDays(String(settings.retentionPeriodDays ?? 1825));
      setNdpa(settings.ndpaCompliant ?? false);
      setNdpr(settings.ndprCompliant ?? false);
      setRopa(settings.ropaCompleted ?? false);
      setNotes(settings.notes ?? "");
    }
  }, [settings]);

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

  const complianceFrameworks = [
    { key: "ndpa", label: "NDPA 2023", description: "Nigeria Data Protection Act", value: ndpa, set: setNdpa },
    { key: "ndpr", label: "NDPR 2019", description: "Nigeria Data Protection Regulation", value: ndpr, set: setNdpr },
    { key: "ropa", label: "ROPA", description: "Records of Processing Activities", value: ropa, set: setRopa },
  ];

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Data Protection</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              NDPR/GDPR data protection settings, DPO details, and breach notification management
            </p>
          </div>
        </div>

        {/* Data Minimisation Notice */}
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-800">
            <span className="font-semibold">Data Minimisation:</span> Upload only the minimum transaction data necessary for reconciliation. Do not include customer PII (names, BVN, NIN, phone numbers) in transaction files unless strictly required. ReconcileAI processes financial reference data only.
          </p>
        </div>

        {/* Compliance Status Row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {complianceFrameworks.map(({ key, label, description, value }) => (
            <div key={key} className="rounded-lg border bg-card px-5 py-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <ShieldCheck className={`w-5 h-5 ${value ? "text-emerald-500" : "text-muted-foreground/40"}`} />
              </div>
              <ComplianceBadge ok={value} label="Confirmed" />
            </div>
          ))}
        </div>

        {/* Two-column layout: DPO Settings | Data Retention */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* DPO Settings — 2/3 width */}
          <div className="lg:col-span-2 rounded-lg border bg-card p-6 space-y-5">
            <div className="flex items-center gap-2 pb-1 border-b">
              <User className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Data Protection Officer</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Full Name</label>
                <Input value={dpoName} onChange={e => setDpoName(e.target.value)} placeholder="e.g. Amaka Obi" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Email Address</label>
                <Input value={dpoEmail} onChange={e => setDpoEmail(e.target.value)} placeholder="dpo@organisation.com" type="email" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Phone Number</label>
                <Input value={dpoPhone} onChange={e => setDpoPhone(e.target.value)} placeholder="+234 800 000 0000" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Breach Notification Email</label>
              <Input value={breachEmail} onChange={e => setBreachEmail(e.target.value)} placeholder="security@organisation.com" type="email" />
              <p className="text-xs text-muted-foreground">This address receives alerts when a security incident is reported.</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Notes / Programme Reference</label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Privacy policy URL, ROPA document reference, DPA registration number..." rows={2} />
            </div>

            {/* Compliance checkboxes inline */}
            <div className="flex flex-wrap gap-6 pt-1">
              {complianceFrameworks.map(({ key, label, value, set }) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={e => set(e.target.checked)}
                    className="w-4 h-4 accent-[#1B365D] rounded"
                  />
                  <span className="text-foreground">{label} confirmed</span>
                </label>
              ))}
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

          {/* Data Retention — 1/3 width */}
          <div className="rounded-lg border bg-card p-6 space-y-5">
            <div className="flex items-center gap-2 pb-1 border-b">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Data Retention</h2>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Retention Period (days)</label>
              <Input value={retentionDays} onChange={e => setRetentionDays(e.target.value)} type="number" min={1} max={3650} />
              <p className="text-xs text-muted-foreground">
                {Number(retentionDays) ? `${Math.round(Number(retentionDays) / 365 * 10) / 10} years` : "—"}
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-3 space-y-1">
              <p className="text-xs font-medium text-foreground">Default: 5 years (1,825 days)</p>
              <p className="text-xs text-muted-foreground">Aligned with CBN records retention guidelines for financial institutions.</p>
            </div>
          </div>
        </div>

        {/* Data Deletion */}
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-500" />
              <h2 className="text-sm font-semibold text-foreground">Data Deletion</h2>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
              Request Deletion
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Permanently delete transaction data from the platform. A signed deletion certificate is generated upon completion and can be downloaded for your records.
          </p>

          {deletionRequests.length > 0 && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Deletion History</p>
              <div className="divide-y rounded-lg border overflow-hidden">
                {deletionRequests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-4 py-3 text-sm bg-background">
                    <div className="flex items-center gap-3">
                      <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div>
                        <span className="font-medium capitalize">{r.scope.replace(/_/g, " ")}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {r.recordsDeleted?.toLocaleString() ?? 0} records
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className={r.status === "completed" ? "text-emerald-700 border-emerald-200 bg-emerald-50" : "text-amber-700 border-amber-200 bg-amber-50"}>
                        {r.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(r.requestedAt).toLocaleDateString()}
                      </span>
                      {r.certificateText && (
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setCertText(r.certificateText!); setShowCert(true); }}>
                          <Download className="w-3.5 h-3.5" />
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
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-orange-500" />
              <h2 className="text-sm font-semibold text-foreground">Security Incidents</h2>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowIncidentDialog(true)}>
              Report Incident
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Report any security breach, unauthorised access, or data disclosure. Reporting automatically notifies the platform owner and creates an auditable record.
          </p>

          {incidents.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-4 py-3 border border-emerald-200">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              No security incidents on record.
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-hidden">
              {incidents.map((inc) => (
                <div key={inc.id} className="flex items-start justify-between px-4 py-3 text-sm bg-background gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium capitalize">{inc.incidentType.replace(/_/g, " ")}</span>
                      <SeverityBadge severity={inc.severity} />
                      <Badge variant="outline" className={inc.status === "resolved" ? "text-emerald-700 border-emerald-200 bg-emerald-50 text-xs" : "text-amber-700 border-amber-200 bg-amber-50 text-xs"}>
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
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-500" /> Request Data Deletion
            </DialogTitle>
            <DialogDescription>
              This action is <strong>irreversible</strong>. All data within the selected scope will be permanently deleted and a signed deletion certificate will be issued.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Deletion Scope</label>
              <Select value={deleteScope} onValueChange={(v) => setDeleteScope(v as typeof deleteScope)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all_transactions">Transactions only</SelectItem>
                  <SelectItem value="all_data">All data (transactions, jobs, uploads)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Textarea value={deleteNotes} onChange={e => setDeleteNotes(e.target.value)} placeholder="e.g. End of POC engagement, data subject request..." rows={3} />
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
              <FileText className="w-4 h-4 text-[#1B365D]" /> Deletion Certificate
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
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-orange-500" /> Report Security Incident
            </DialogTitle>
            <DialogDescription>
              Reporting this incident will automatically notify the platform owner and log a permanent record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
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
              <div className="space-y-1.5">
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
            <div className="space-y-1.5">
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
              className="bg-[#1B365D] text-white hover:bg-[#1B365D]/90"
              onClick={() => reportIncident.mutate({ incidentType, severity: incidentSeverity, description: incidentDesc })}
              disabled={reportIncident.isPending || incidentDesc.length < 10}
            >
              {reportIncident.isPending ? "Submitting..." : "Submit Report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
