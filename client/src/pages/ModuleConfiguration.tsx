import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function ModuleConfiguration() {
  const utils = trpc.useUtils();

  // Fetch module configurations
  const { data: modules, isLoading } = trpc.modules.list.useQuery();

  // Toggle module mutation
  const toggleModule = trpc.modules.toggle.useMutation({
    onSuccess: () => {
      toast.success("Module configuration updated successfully");
      utils.modules.list.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update module configuration");
    },
  });

  const handleToggle = (moduleType: "transaction_integrity" | "settlement" | "account_level", isEnabled: boolean) => {
    toggleModule.mutate({ moduleType, isEnabled });
  };

  // Module information
  const moduleInfo = {
    transaction_integrity: {
      title: "Transaction Integrity Reconciliation",
      description: "Ensure all transactions are accounted for (successful/failed/duplicates) within internal systems",
      features: [
        "Multi-source transaction ingestion",
        "Intelligent matching across 5-6 internal systems",
        "Duplicate detection (unidirectional and bidirectional)",
        "Timestamp normalization",
        "Amount denomination correction",
        "False positive classification",
      ],
      metrics: [
        "Reduce false positive rate from 35-65% to <2%",
        "Reduce manual matching time by 60%",
        "99.9%+ transaction accounting accuracy",
      ],
    },
    settlement: {
      title: "Settlement Reconciliation",
      description: "Validate bulk settlement amounts match detailed transaction reports",
      features: [
        "Multi-processor reconciliation (Interswitch, UPSL, eTranzact, etc.)",
        "Unified portal orchestration",
        "Settlement window scheduling (3-4x per day)",
        "Pre-settlement reconciliation",
        "Lump sum vs. detailed report validation",
        "Merchant-level grouping",
      ],
      metrics: [
        "Reduce settlement officer workload by 60%",
        "Enable pre-settlement reconciliation",
        "Eliminate 5+ daily portal logins",
        "Process 3-4 settlement windows per day automatically",
      ],
    },
    account_level: {
      title: "Account-Level Reconciliation",
      description: "Match money hitting bank accounts to transaction reports justifying the money",
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
        "Reduce month-end close time from 5-7 days to 1-2 days",
        "100% audit trail completeness for CBN compliance",
        "Zero license revocations due to reconciliation failures",
      ],
    },
  };

  // Get enabled status for a module
  const getModuleStatus = (moduleType: string) => {
    const config = modules?.find((m) => m.moduleType === moduleType);
    return config?.isEnabled ?? true; // Default to enabled if not configured
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
          Enable or disable reconciliation modules based on your organization's needs. Each module can be deployed independently or combined.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Modular Architecture</AlertTitle>
        <AlertDescription>
          ReconcileAI is built around three core modular reconciliation types identified through discovery interviews with Nigerian financial institutions.
          Each module addresses specific reconciliation challenges and can be turned on or off based on your requirements.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6">
        {(Object.keys(moduleInfo) as Array<keyof typeof moduleInfo>).map((moduleType) => {
          const info = moduleInfo[moduleType];
          const isEnabled = getModuleStatus(moduleType);
          const isToggling = toggleModule.isPending;

          return (
            <Card key={moduleType} className="border-2">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <CardTitle className="text-xl text-[#1B365D]">{info.title}</CardTitle>
                      <Badge variant={isEnabled ? "default" : "secondary"} className={isEnabled ? "bg-green-600" : ""}>
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
                    </div>
                    <CardDescription className="text-base">{info.description}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">{isEnabled ? "Enabled" : "Disabled"}</span>
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => handleToggle(moduleType, checked)}
                      disabled={isToggling}
                    />
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
                        <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
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

      <Alert className="bg-blue-50 border-blue-200">
        <Info className="h-4 w-4 text-blue-600" />
        <AlertTitle className="text-blue-900">Need Help?</AlertTitle>
        <AlertDescription className="text-blue-800">
          Contact your account manager to discuss which modules are best suited for your organization's reconciliation needs.
          Modules can be enabled or disabled at any time based on your operational requirements.
        </AlertDescription>
      </Alert>
    </div>
  );
}
