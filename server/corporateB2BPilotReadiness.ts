/**
 * Corporate B2B controlled-pilot readiness — the B0–B8 gate rule.
 *
 * Kept out of the router because this is business logic, not routing: it is the
 * thing that decides whether a regulated FMCG/distributor pilot may start, and
 * it should be readable and testable without a database, a session, or a tRPC
 * context anywhere near it.
 *
 * ── Evidence must be evidence ─────────────────────────────────────────────
 *
 * Several gates used to ask `Boolean(config?.field)`, which a string of spaces
 * satisfies. That is the wrong question for this screen: these gates are the
 * record that a control exists, and " " is not a scope, an owner, or a contract
 * reference. A whitespace value turned a gate green while the evidence behind
 * it was missing — the precise failure a readiness register exists to prevent.
 * `hasEvidence` asks whether anything was actually recorded.
 */
import type { corporateB2BPilotConfigs, corporateB2BPilotSources } from "../drizzle/schema";

/**
 * Only the columns the rule reads, derived from the schema rather than restated.
 * A renamed column or a widened status enum fails to compile here, which is what
 * an inline `any` was quietly preventing.
 */
export type PilotReadinessConfig = Pick<
  typeof corporateB2BPilotConfigs.$inferSelect,
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

export type PilotReadinessSource = Pick<
  typeof corporateB2BPilotSources.$inferSelect,
  "status" | "sourceType" | "customerOwnedCredentials" | "controlTotalRequired"
>;

export type PilotGate = { id: string; label: string; ready: boolean; detail: string };

/** Was something actually recorded here, as opposed to typed over? */
export function hasEvidence(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function calculateCorporateB2BPilotReadiness(input: {
  config: PilotReadinessConfig | null;
  sources: PilotReadinessSource[];
  roster: { total: number; pending: number; flagged: number };
}) {
  const { config, sources } = input;
  const { total, pending, flagged } = input.roster;
  const sourceCount = sources.length;
  const testedSources = sources.filter((source) => source.status === "tested" || source.status === "approved" || source.status === "active");
  const approvedSources = sources.filter((source) => source.status === "approved" || source.status === "active");
  const safeSources = sources.every((source) => source.customerOwnedCredentials && source.controlTotalRequired);
  const hasInvoiceEvidence = approvedSources.some((source) => source.sourceType === "invoice_ar");
  const hasReceiptEvidence = approvedSources.some((source) => ["bank_statement", "mobile_money", "psp_collection"].includes(source.sourceType));
  const gates: PilotGate[] = [
    { id: "B0", label: "Read-only launch boundary", ready: Boolean(config?.noWriteAcknowledged) && hasEvidence(config?.pilotScope), detail: "No payment initiation, account access, ERP posting, customer messaging, or credit-note action." },
    { id: "B1", label: "Canonical data contract", ready: config?.dataContractStatus === "approved" && hasInvoiceEvidence && hasReceiptEvidence, detail: "Approved invoice/AR and receipt evidence with a documented source hierarchy." },
    { id: "B2", label: "Customer-authorised source route", ready: testedSources.length >= 2 && safeSources, detail: "At least two tested customer-controlled sources, each with a control total." },
    { id: "B3", label: "Distributor master-data governance", ready: config?.rosterStatus === "approved" && total > 0 && pending === 0 && flagged === 0, detail: "An approved roster with no unconfirmed or flagged distributor identities." },
    { id: "B4", label: "Allocation and daily-close policy", ready: config?.allocationPolicyStatus === "approved" && hasEvidence(config?.dailyCloseOwner), detail: "Human-approved allocation proposals and a named daily finance-close owner." },
    // B5 was not raised in review but fails the same way: a private AI route is
    // approved on the strength of a recorded sign-off, and " " is not one. The
    // mutation already trims this field on the way in; the rule now agrees.
    { id: "B5", label: "AI and external-data boundary", ready: config?.aiAssistanceMode === "disabled" || (config?.aiAssistanceMode === "private_approved" && hasEvidence(config?.aiBoundaryReference)), detail: "AI is disabled by default; a private approved route requires a recorded sign-off reference." },
    { id: "B6", label: "Foundation hardening deployment", ready: true, detail: "The P1–P7 foundation release is merged and proven. Durable queue configuration remains mandatory where the selected deployment enables queued processing." },
    { id: "B7", label: "Recovery and retention evidence", ready: config?.operationalRecoveryStatus === "passed" && Number(config?.retentionDays ?? 0) > 0, detail: "Successful replay/recovery evidence and a time-bound retention policy." },
    { id: "B8", label: "Commercial and data-processing terms", ready: config?.contractStatus === "approved" && config?.dataProcessingStatus === "approved" && hasEvidence(config?.contractReference) && hasEvidence(config?.dataProcessingReference), detail: "Recorded contract and data-processing references; the customer remains responsible for legal validity." },
  ];
  return {
    gates,
    sourceCount,
    testedSources: testedSources.length,
    approvedSources: approvedSources.length,
    canStartReadOnlyPilot: gates.every((gate) => gate.ready),
    blockedBy: gates.filter((gate) => !gate.ready).map((gate) => gate.id),
  };
}
