import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, CheckCircle2, AlertCircle, Info, Building2, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { modulesForSegment } from "@shared/moduleScope";
import { useOrgSegment } from "@/hooks/useOrgSegment";

type ModuleType = "settlement" | "account_level";

// ─── Module definitions (Transaction Integrity merged into Settlement) ─────────
const MODULE_INFO: Record<ModuleType, {
  title: string;
  description: string;
  features: string[];
  metrics: string[];
  badge?: string;
}> = {
  settlement: {
    title: "Settlement Reconciliation",
    description:
      "Validate bulk settlement amounts match detailed transaction reports and ensure all transactions are fully accounted for within internal systems.",
    badge: "Includes Transaction Integrity",
    features: [
      "Multi-processor reconciliation (Interswitch, UPSL, eTranzact, etc.)",
      "Unified portal orchestration",
      "Settlement window scheduling (3–4× per day)",
      "Pre-settlement reconciliation",
      "Lump sum vs. detailed report validation",
      "Merchant-level grouping",
      "Multi-source transaction ingestion",
      "Intelligent matching across 5–6 internal systems",
      "Duplicate detection (unidirectional and bidirectional)",
      "Timestamp normalisation",
      "Amount denomination correction",
      "False positive classification",
    ],
    metrics: [
      "Reduce settlement officer workload by 60%",
      "Enable pre-settlement reconciliation",
      "Eliminate 5+ daily portal logins",
      "Process 3–4 settlement windows per day automatically",
      "Reduce false positive rate from 35–65% to <2%",
      "Reduce manual matching time by 60%",
      "99.9%+ transaction accounting accuracy",
    ],
  },
  account_level: {
    title: "Account-Level Reconciliation",
    description:
      "Match money hitting bank accounts to transaction reports justifying the money, with full general ledger integration and regulatory audit trail.",
    features: [
      "Multi-account reconciliation",
      "Account balance validation against transaction reports",
      "General ledger integration",
      "Multi-currency support",
      "Month-end close automation",
      "Audit trail generation for regulatory reporting",
    ],
    metrics: [
      "Increase audit confidence from 6.5/10 to 9+/10",
      "Reduce month-end close time from 5–7 days to 1–2 days",
      "100% audit trail completeness for CBN compliance",
      "Zero licence revocations due to reconciliation failures",
    ],
  },
};

// ─── Per-institution override dialog ─────────────────────────────────────────
function OrgOverrideDialog({
  open,
  onClose,
  moduleType,
  moduleTitle,
}: {
  open: boolean;
  onClose: () => void;
  moduleType: ModuleType;
  moduleTitle: string;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");

  const { data: overrides, isLoading } = trpc.modules.listOrgOverrides.useQuery(
    {},
    { enabled: open }
  );
  const { data: allOrgsRaw } = trpc.superAdmin.allOrganizations.useQuery(
    undefined,
    { enabled: open }
  );
  const allOrgs = { organisations: allOrgsRaw ?? [] };

  const setOverride = trpc.modules.setOrgModuleOverride.useMutation({
    onSuccess: () => {
      toast.success("Module override saved");
      utils.modules.listOrgOverrides.invalidate();
      setReason("");
    },
    onError: (e) => toast.error(e.message),
  });

  const clearOverride = trpc.modules.clearOrgModuleOverride.useMutation({
    onSuccess: () => {
      toast.success("Override cleared — org will use its own setting");
      utils.modules.listOrgOverrides.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const moduleOverrides = overrides?.filter((o) => o.moduleType === moduleType) ?? [];

  // Build a map of orgId → override for quick lookup
  const overrideMap = new Map(moduleOverrides.map((o) => [o.organizationId, o]));

  // Orgs that are NOT super_admin segment
  const tenantOrgs = allOrgs?.organisations?.filter(
    (o: { segment: string }) => o.segment !== "super_admin"
  ) ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#1B365D]" />
            Per-Institution Override — {moduleTitle}
          </DialogTitle>
          <DialogDescription>
            Force-enable or force-disable this module for specific institutions. If no override is
            set, the institution's own admin toggle applies.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="mb-2">
              <label className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Override reason (optional)
              </label>
              <Input
                placeholder="e.g. Pilot programme, compliance hold, custom pricing…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1"
              />
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Segment</TableHead>
                  <TableHead>Override</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantOrgs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                      No tenant organisations found
                    </TableCell>
                  </TableRow>
                )}
                {tenantOrgs.map((org: { id: number; name: string; segment: string }) => {
                  const override = overrideMap.get(org.id);
                  return (
                    <TableRow key={org.id}>
                      <TableCell className="font-medium">{org.name}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            org.segment === "financial_services"
                              ? "border-blue-300 text-blue-700"
                              : "border-emerald-300 text-emerald-700"
                          }
                        >
                          {org.segment === "financial_services" ? "Financial Services" : "Corporate B2B"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {override ? (
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={override.isEnabled ? "default" : "secondary"}
                              className={override.isEnabled ? "bg-green-600" : ""}
                            >
                              {override.isEnabled ? "Force ON" : "Force OFF"}
                            </Badge>
                            {override.reason && (
                              <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                                {override.reason}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Org default</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-green-700 border-green-300 hover:bg-green-50"
                            disabled={setOverride.isPending || clearOverride.isPending}
                            onClick={() =>
                              setOverride.mutate({
                                organizationId: org.id,
                                moduleType,
                                isEnabled: true,
                                reason: reason || undefined,
                              })
                            }
                          >
                            Force ON
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-red-700 border-red-300 hover:bg-red-50"
                            disabled={setOverride.isPending || clearOverride.isPending}
                            onClick={() =>
                              setOverride.mutate({
                                organizationId: org.id,
                                moduleType,
                                isEnabled: false,
                                reason: reason || undefined,
                              })
                            }
                          >
                            Force OFF
                          </Button>
                          {override && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-muted-foreground"
                              disabled={clearOverride.isPending}
                              onClick={() =>
                                clearOverride.mutate({ organizationId: org.id, moduleType })
                              }
                            >
                              <X className="h-3 w-3 mr-1" />
                              Clear
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ModuleConfiguration() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const segment = useOrgSegment();

  const [overrideDialog, setOverrideDialog] = useState<{
    open: boolean;
    moduleType: ModuleType;
  } | null>(null);

  const { data: modules, isLoading } = trpc.modules.list.useQuery();

  const toggleModule = trpc.modules.toggle.useMutation({
    onSuccess: () => {
      toast.success("Module configuration updated successfully");
      utils.modules.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update module configuration");
    },
  });

  const handleToggle = (moduleType: ModuleType, isEnabled: boolean) => {
    toggleModule.mutate({ moduleType, isEnabled });
  };

  const getModuleStatus = (moduleType: ModuleType) => {
    const config = modules?.find((m) => m.moduleType === moduleType);
    return config?.isEnabled ?? true;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-[#1B365D]" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#1B365D]">Module Configuration</h1>
        <p className="text-gray-600 mt-2">
          Enable or disable reconciliation modules based on your organisation's needs. Each module
          can be deployed independently or combined.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Two-Module Architecture</AlertTitle>
        <AlertDescription>
          ReconcileAI is built around two core reconciliation modules. Settlement Reconciliation now
          incorporates all transaction integrity capabilities, giving you a single unified engine for
          both settlement validation and internal transaction accounting.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6">
        {/* Only the modules this vertical can use. Account-Level reconciles a
            general ledger against a core banking system; a retail merchant
            operates neither, and the copy below promises "CBN compliance" and
            "zero licence revocations" to a reader who answers to no regulator
            and holds no licence. The server refuses it too — see
            assertModuleAvailable — so this is presentation, not the gate. */}
        {modulesForSegment(segment).map((moduleType) => {
          const info = MODULE_INFO[moduleType];
          const isEnabled = getModuleStatus(moduleType);
          const isToggling = toggleModule.isPending;

          return (
            <Card key={moduleType} className="border-2">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <CardTitle className="text-xl text-[#1B365D]">{info.title}</CardTitle>
                      <Badge
                        variant={isEnabled ? "default" : "secondary"}
                        className={isEnabled ? "bg-green-600" : ""}
                      >
                        {isEnabled ? (
                          <>
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Enabled
                          </>
                        ) : (
                          <>
                            <AlertCircle className="h-3 w-3 mr-1" />
                            Disabled
                          </>
                        )}
                      </Badge>
                      {info.badge && (
                        <Badge variant="outline" className="border-[#1B365D]/30 text-[#1B365D] text-xs">
                          {info.badge}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-base">{info.description}</CardDescription>
                  </div>
                  <div className="flex items-center gap-3 ml-4 shrink-0">
                    {isSuperAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs border-[#1B365D]/30 text-[#1B365D] hover:bg-[#1B365D]/5"
                        onClick={() =>
                          setOverrideDialog({ open: true, moduleType })
                        }
                      >
                        <Building2 className="h-3.5 w-3.5 mr-1.5" />
                        Per-Institution
                      </Button>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">{isEnabled ? "Enabled" : "Disabled"}</span>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(checked) => handleToggle(moduleType, checked)}
                        disabled={isToggling}
                      />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h4 className="font-semibold text-[#1B365D] mb-2">Key Capabilities:</h4>
                  <ul className="grid grid-cols-2 gap-2">
                    {info.features.map((feature, idx) => (
                      <li key={idx} className="text-sm text-gray-700 flex items-start gap-2">
                        <span className="text-[#F4758C] mt-1">•</span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold text-[#1B365D] mb-2">Success Metrics:</h4>
                  <ul className="space-y-1">
                    {info.metrics.map((metric, idx) => (
                      <li key={idx} className="text-sm text-gray-700 flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                        <span>{metric}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isSuperAdmin && (
        <Alert className="bg-violet-50 border-violet-200">
          <ShieldCheck className="h-4 w-4 text-violet-600" />
          <AlertTitle className="text-violet-900">Infinity AI Super Admin Controls</AlertTitle>
          <AlertDescription className="text-violet-800">
            As an Infinity AI staff member, you can use the <strong>Per-Institution</strong> button
            on each module to force-enable or force-disable it for specific institutions, overriding
            their own admin toggle. This is useful for pilot programmes, compliance holds, or custom
            pricing arrangements.
          </AlertDescription>
        </Alert>
      )}

      <Alert className="bg-blue-50 border-blue-200">
        <Info className="h-4 w-4 text-blue-600" />
        <AlertTitle className="text-blue-900">Need Help?</AlertTitle>
        <AlertDescription className="text-blue-800">
          Contact your account manager to discuss which modules are best suited for your
          organisation's reconciliation needs. Modules can be enabled or disabled at any time.
        </AlertDescription>
      </Alert>

      {/* Per-institution override dialog */}
      {overrideDialog && (
        <OrgOverrideDialog
          open={overrideDialog.open}
          onClose={() => setOverrideDialog(null)}
          moduleType={overrideDialog.moduleType}
          moduleTitle={MODULE_INFO[overrideDialog.moduleType].title}
        />
      )}
    </div>
  );
}
