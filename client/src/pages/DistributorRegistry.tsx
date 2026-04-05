import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Building2, Search, Plus, CheckCircle2, AlertTriangle, Clock, XCircle,
  Users, Tag, Phone, Mail, MapPin, CreditCard, Edit2, ChevronRight,
  RefreshCw, ShieldCheck, Layers,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────

interface Distributor {
  id: number;
  canonicalId: string;
  canonicalName: string;
  registeredBusinessName?: string | null;
  taxId?: string | null;
  primaryBankAccount?: string | null;
  primaryBankName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  zone?: string | null;
  status: "active" | "inactive" | "pending_confirmation" | "flagged";
  nameVariants?: string[] | null;
  totalPaymentsMatched: number;
  totalAmountMatched: string;
  lastPaymentAt?: Date | string | null;
  notes?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ─── Status Badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Distributor["status"] }) {
  const config = {
    active: { label: "Active", className: "bg-green-100 text-green-700 border-green-200", icon: <CheckCircle2 className="h-3 w-3" /> },
    inactive: { label: "Inactive", className: "bg-gray-100 text-gray-600 border-gray-200", icon: <XCircle className="h-3 w-3" /> },
    pending_confirmation: { label: "Pending", className: "bg-amber-100 text-amber-700 border-amber-200", icon: <Clock className="h-3 w-3" /> },
    flagged: { label: "Flagged", className: "bg-red-100 text-red-700 border-red-200", icon: <AlertTriangle className="h-3 w-3" /> },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${config.className}`}>
      {config.icon} {config.label}
    </span>
  );
}

// ─── Create / Edit Dialog ─────────────────────────────────────────────

function DistributorDialog({
  open, onClose, distributor, onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  distributor?: Distributor | null;
  onSuccess: () => void;
}) {
  const isEdit = !!distributor;
  const [form, setForm] = useState({
    canonicalName: distributor?.canonicalName || "",
    registeredBusinessName: distributor?.registeredBusinessName || "",
    taxId: distributor?.taxId || "",
    primaryBankAccount: distributor?.primaryBankAccount || "",
    primaryBankName: distributor?.primaryBankName || "",
    contactEmail: distributor?.contactEmail || "",
    contactPhone: distributor?.contactPhone || "",
    zone: distributor?.zone || "",
    status: distributor?.status || "active",
    notes: distributor?.notes || "",
  });

  const createMutation = trpc.distributor.create.useMutation({
    onSuccess: () => { toast.success("Distributor created"); onSuccess(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.distributor.update.useMutation({
    onSuccess: () => { toast.success("Distributor updated"); onSuccess(); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = () => {
    if (!form.canonicalName.trim()) { toast.error("Canonical name is required"); return; }
    if (isEdit && distributor) {
      updateMutation.mutate({ id: distributor.id, ...form, status: form.status as "active" | "inactive" | "pending_confirmation" | "flagged" });
    } else {
      createMutation.mutate(form);
    }
  };

  const isLoading = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            {isEdit ? "Edit Distributor" : "Add New Distributor"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs font-semibold">Canonical Name *</Label>
            <Input className="mt-1" placeholder="e.g. Kola Ventures Ltd" value={form.canonicalName} onChange={(e) => setForm({ ...form, canonicalName: e.target.value })} />
            <p className="text-[11px] text-muted-foreground mt-1">The single authoritative name used in all matching. All aliases map to this.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Registered Business Name</Label>
              <Input className="mt-1" placeholder="CAC registered name" value={form.registeredBusinessName} onChange={(e) => setForm({ ...form, registeredBusinessName: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs font-semibold">Tax ID (TIN)</Label>
              <Input className="mt-1" placeholder="e.g. 12345678-0001" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Bank Account Number</Label>
              <Input className="mt-1" placeholder="e.g. 0123456789" value={form.primaryBankAccount} onChange={(e) => setForm({ ...form, primaryBankAccount: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs font-semibold">Bank Name</Label>
              <Input className="mt-1" placeholder="e.g. GTBank" value={form.primaryBankName} onChange={(e) => setForm({ ...form, primaryBankName: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Contact Email</Label>
              <Input className="mt-1" type="email" placeholder="finance@kola.ng" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs font-semibold">Contact Phone</Label>
              <Input className="mt-1" placeholder="+234 801 234 5678" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Zone / Territory</Label>
              <Input className="mt-1" placeholder="e.g. Lagos Zone A" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} />
            </div>
            {isEdit && (
              <div>
                <Label className="text-xs font-semibold">Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as "active" | "inactive" | "pending_confirmation" | "flagged" })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="pending_confirmation">Pending Confirmation</SelectItem>
                    <SelectItem value="flagged">Flagged</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs font-semibold">Notes</Label>
            <Textarea className="mt-1 resize-none h-16 text-sm" placeholder="Internal notes about this distributor..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? "Saving..." : isEdit ? "Save Changes" : "Create Distributor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Distributor Detail Panel ─────────────────────────────────────────

function DistributorDetail({
  distributor, onEdit, onConfirm, onClose,
}: {
  distributor: Distributor;
  onEdit: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [newVariant, setNewVariant] = useState("");
  const utils = trpc.useUtils();
  const addVariantMutation = trpc.distributor.addVariant.useMutation({
    onSuccess: () => { toast.success("Alias added"); setNewVariant(""); utils.distributor.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const variants = (distributor.nameVariants as string[]) || [];

  return (
    <div className="border-l bg-background h-full overflow-y-auto p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{distributor.canonicalId}</span>
            <StatusBadge status={distributor.status} />
          </div>
          <h2 className="text-lg font-bold text-foreground">{distributor.canonicalName}</h2>
          {distributor.registeredBusinessName && (
            <p className="text-sm text-muted-foreground">{distributor.registeredBusinessName}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">✕</Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Payments Matched</p>
          <p className="text-xl font-bold text-foreground">{distributor.totalPaymentsMatched.toLocaleString()}</p>
        </div>
        <div className="bg-muted/40 rounded-lg p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Total Amount</p>
          <p className="text-xl font-bold text-foreground">₦{parseFloat(distributor.totalAmountMatched || "0").toLocaleString()}</p>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Contact & Banking</h3>
        {[
          { icon: CreditCard, label: "Bank Account", value: distributor.primaryBankAccount ? `${distributor.primaryBankAccount} (${distributor.primaryBankName || "—"})` : null },
          { icon: Mail, label: "Email", value: distributor.contactEmail },
          { icon: Phone, label: "Phone", value: distributor.contactPhone },
          { icon: MapPin, label: "Zone", value: distributor.zone },
          { icon: Tag, label: "TIN", value: distributor.taxId },
        ].map(({ icon: Icon, label, value }) => value ? (
          <div key={label} className="flex items-center gap-3 text-sm">
            <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-muted-foreground w-24 flex-shrink-0">{label}</span>
            <span className="text-foreground font-medium truncate">{value}</span>
          </div>
        ) : null)}
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          Known Aliases ({variants.length})
        </h3>
        <p className="text-xs text-muted-foreground">All name variations that map to this canonical distributor record.</p>
        <div className="flex flex-wrap gap-2">
          {variants.map((v) => (
            <span key={v} className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2.5 py-1">{v}</span>
          ))}
          {variants.length === 0 && <span className="text-xs text-muted-foreground italic">No aliases recorded yet</span>}
        </div>
        <div className="flex gap-2">
          <Input
            className="h-8 text-xs"
            placeholder="Add a new alias..."
            value={newVariant}
            onChange={(e) => setNewVariant(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newVariant.trim()) addVariantMutation.mutate({ id: distributor.id, variant: newVariant.trim() }); }}
          />
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!newVariant.trim() || addVariantMutation.isPending}
            onClick={() => addVariantMutation.mutate({ id: distributor.id, variant: newVariant.trim() })}
          >
            Add
          </Button>
        </div>
      </div>

      {distributor.notes && (
        <>
          <Separator />
          <div>
            <h3 className="text-sm font-semibold mb-2">Notes</h3>
            <p className="text-sm text-muted-foreground">{distributor.notes}</p>
          </div>
        </>
      )}

      <Separator />

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={onEdit}>
          <Edit2 className="h-3.5 w-3.5" /> Edit
        </Button>
        {distributor.status === "pending_confirmation" && (
          <Button size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700" onClick={onConfirm}>
            <ShieldCheck className="h-3.5 w-3.5" /> Confirm Identity
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function DistributorRegistry() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<Distributor | null>(null);

  const utils = trpc.useUtils();

  const { data: stats } = trpc.distributor.stats.useQuery();
  const { data: distributors = [], isLoading, refetch } = trpc.distributor.list.useQuery({
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });

  const confirmMutation = trpc.distributor.confirm.useMutation({
    onSuccess: () => { toast.success("Distributor identity confirmed"); utils.distributor.list.invalidate(); utils.distributor.stats.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const selectedDistributor = distributors.find((d) => d.id === selectedId) as Distributor | undefined;

  const handleRefresh = () => {
    utils.distributor.list.invalidate();
    utils.distributor.stats.invalidate();
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b bg-background">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <Building2 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-primary">Distributor Identity Registry</h1>
              <p className="text-xs text-muted-foreground">Master file of all distributor identities — the proprietary data asset that powers AI matching</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefresh}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Distributor
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4 mb-4">
          {[
            { label: "Total Distributors", value: stats?.total ?? 0, icon: Users, color: "text-primary" },
            { label: "Active", value: stats?.active ?? 0, icon: CheckCircle2, color: "text-green-600" },
            { label: "Pending Confirmation", value: stats?.pendingConfirmation ?? 0, icon: Clock, color: "text-amber-600" },
            { label: "Flagged", value: stats?.flagged ?? 0, icon: AlertTriangle, color: "text-red-600" },
          ].map((s) => (
            <div key={s.label} className="bg-muted/30 rounded-lg px-4 py-3 flex items-center gap-3">
              <s.icon className={`h-5 w-5 ${s.color} flex-shrink-0`} />
              <div>
                <p className="text-xl font-bold text-foreground">{s.value}</p>
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9 h-9 text-sm"
              placeholder="Search by name, ID, or zone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44 h-9 text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending_confirmation">Pending</SelectItem>
              <SelectItem value="flagged">Flagged</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Table */}
        <div className={`flex-1 overflow-y-auto ${selectedDistributor ? "border-r" : ""}`}>
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading distributors...
            </div>
          ) : distributors.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center px-6">
              <Building2 className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-sm font-medium text-muted-foreground mb-1">No distributors found</p>
              <p className="text-xs text-muted-foreground mb-4">
                {search || statusFilter !== "all" ? "Try adjusting your filters" : "Add your first distributor to start building the identity registry"}
              </p>
              {!search && statusFilter === "all" && (
                <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" /> Add First Distributor
                </Button>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b sticky top-0">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Distributor</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Zone</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bank</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aliases</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Matched</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {distributors.map((d) => {
                  const dist = d as Distributor;
                  const isSelected = dist.id === selectedId;
                  return (
                    <tr
                      key={dist.id}
                      className={`cursor-pointer transition-colors ${isSelected ? "bg-primary/5" : "hover:bg-muted/30"}`}
                      onClick={() => setSelectedId(isSelected ? null : dist.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{dist.canonicalName}</div>
                        <div className="text-xs text-muted-foreground font-mono">{dist.canonicalId}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{dist.zone || "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {dist.primaryBankName ? (
                          <div>
                            <div className="font-medium text-foreground">{dist.primaryBankName}</div>
                            <div className="font-mono">{dist.primaryBankAccount || "—"}</div>
                          </div>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground">
                          {((dist.nameVariants as string[]) || []).length} aliases
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {dist.totalPaymentsMatched > 0 ? (
                          <div>
                            <div className="font-medium text-foreground">{dist.totalPaymentsMatched} payments</div>
                            <div>₦{parseFloat(dist.totalAmountMatched || "0").toLocaleString()}</div>
                          </div>
                        ) : <span className="italic">No payments yet</span>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={dist.status} />
                      </td>
                      <td className="px-4 py-3">
                        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isSelected ? "rotate-90" : ""}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail Panel */}
        {selectedDistributor && (
          <div className="w-96 flex-shrink-0">
            <DistributorDetail
              distributor={selectedDistributor}
              onEdit={() => setEditTarget(selectedDistributor)}
              onConfirm={() => confirmMutation.mutate({ id: selectedDistributor.id })}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <DistributorDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={handleRefresh}
      />

      {/* Edit Dialog */}
      {editTarget && (
        <DistributorDialog
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          distributor={editTarget}
          onSuccess={handleRefresh}
        />
      )}
    </div>
  );
}
