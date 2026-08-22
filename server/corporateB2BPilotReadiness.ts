import type { CorporateB2BPilotConfig, CorporateB2BPilotSource } from "../drizzle/schema";

export const CORPORATE_B2B_SOURCE_TYPES = ["invoice_ar", "bank_statement", "mobile_money", "psp_collection", "erp_export"] as const;
export const CORPORATE_B2B_DELIVERY_METHODS = ["manual_export", "sftp", "bucket", "api"] as const;
export const CORPORATE_B2B_SOURCE_STATUSES = ["draft", "tested", "approved", "active", "suspended"] as const;

export type CorporateB2BPilotReadinessConfig = Pick<
  CorporateB2BPilotConfig,
  | "noWriteAcknowledged"
  | "pilotScope"
  | "dataContractStatus"
  | "rosterStatus"
  | "allocationPolicyStatus"
  | "dailyCloseOwner"
  | "aiAssistanceMode"
  | "aiBoundaryReference"
  | "operationalRecoveryStatus"
  | "retentionDays"
  | "contractStatus"
  | "dataProcessingStatus"
  | "contractReference"
  | "dataProcessingReference"
>;

export type CorporateB2BPilotReadinessSource = Pick<
  CorporateB2BPilotSource,
  "sourceType" | "status" | "customerOwnedCredentials" | "controlTotalRequired"
>;

export type CorporateB2BPilotGate = {
  id: `B${number}`;
  label: string;
  ready: boolean;
  detail: string;
};

export function hasEvidence(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

export function calculateCorporateB2BPilotReadiness(input: {
  config: CorporateB2BPilotReadinessConfig | null;
  sources: CorporateB2BPilotReadinessSource[];
  roster: { total: number; pending: number; flagged: number };
}) {
  const { config, sources } = input;
  const { total, pending, flagged } = input.roster;
  const testedSources = sources.filter((source) => ["tested", "approved", "active"].includes(source.status));
  const approvedSources = sources.filter((source) => ["approved", "active"].includes(source.status));
  const safeSources = sources.every((source) => source.customerOwnedCredentials && source.controlTotalRequired);
  const hasInvoiceEvidence = approvedSources.some((source) => source.sourceType === "invoice_ar");
  const hasReceiptEvidence = approvedSources.some((source) => ["bank_statement", "mobile_money", "psp_collection"].includes(source.sourceType));
  const gates: CorporateB2BPilotGate[] = [
    { id: "B0", label: "Read-only launch boundary", ready: Boolean(config?.noWriteAcknowledged && hasEvidence(config.pilotScope)), detail: "No payment initiation, account access, ERP posting, customer messaging, or credit-note action." },
    { id: "B1", label: "Canonical data contract", ready: config?.dataContractStatus === "approved" && hasInvoiceEvidence && hasReceiptEvidence, detail: "Approved invoice/AR and receipt evidence with a documented source hierarchy." },
    { id: "B2", label: "Customer-authorised source route", ready: testedSources.length >= 2 && safeSources, detail: "At least two tested customer-controlled sources, each with a control total." },
    { id: "B3", label: "Distributor master-data governance", ready: config?.rosterStatus === "approved" && total > 0 && pending === 0 && flagged === 0, detail: "An approved roster with no unconfirmed or flagged distributor identities." },
    { id: "B4", label: "Allocation and daily-close policy", ready: config?.allocationPolicyStatus === "approved" && hasEvidence(config.dailyCloseOwner), detail: "Human-approved allocation proposals and a named daily finance-close owner." },
    { id: "B5", label: "AI and external-data boundary", ready: config?.aiAssistanceMode === "disabled" || (config?.aiAssistanceMode === "private_approved" && hasEvidence(config.aiBoundaryReference)), detail: "AI is disabled by default; a private approved route requires a recorded sign-off reference." },
    { id: "B6", label: "Foundation hardening deployment", ready: true, detail: "The P1–P7 foundation release is merged and proven. Durable queue configuration remains mandatory where the selected deployment enables queued processing." },
    { id: "B7", label: "Recovery and retention evidence", ready: config?.operationalRecoveryStatus === "passed" && Number(config?.retentionDays ?? 0) > 0, detail: "Successful replay/recovery evidence and a time-bound retention policy." },
    { id: "B8", label: "Commercial and data-processing terms", ready: config?.contractStatus === "approved" && config?.dataProcessingStatus === "approved" && hasEvidence(config.contractReference) && hasEvidence(config.dataProcessingReference), detail: "Recorded contract and data-processing references; the customer remains responsible for legal validity." },
  ];
  return {
    gates,
    sourceCount: sources.length,
    testedSources: testedSources.length,
    approvedSources: approvedSources.length,
    canStartReadOnlyPilot: gates.every((gate) => gate.ready),
    blockedBy: gates.filter((gate) => !gate.ready).map((gate) => gate.id),
  };
}
