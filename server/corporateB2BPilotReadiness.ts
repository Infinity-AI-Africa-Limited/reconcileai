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
 *
 * ── An attestation is not a verification ──────────────────────────────────
 *
 * Most of these gates are green because a customer owner ticked a box on this
 * screen. A few are green because the PLATFORM checked something. Those are not
 * the same claim, and a register that renders them identically invites the
 * reading the closure register explicitly forbids — "a toggle in Pilot Controls
 * does not [close C3/C8]". So every gate carries its `basis`, and the caller is
 * expected to say which is which rather than showing nine identical ticks.
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

/**
 * Where a green gate's confidence comes from.
 *
 * `customer_attested` — someone with authority recorded a claim on this screen.
 *   Auditable (every save is logged) but unverified by the platform.
 * `platform_verified` — the platform read the state it is reporting: roster
 *   rows, source-contract rows, the live AI boundary, the live queue backend.
 */
export type PilotGateBasis = "customer_attested" | "platform_verified";

export type PilotGate = {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
  basis: PilotGateBasis;
};

/**
 * The pilot lifecycle, in order. `suspended` is deliberately outside the
 * sequence — stopping is never gated.
 */
export const PILOT_STATE_SEQUENCE = [
  "preparation",
  "data_validation",
  "dry_run",
  "parallel_run",
  "limited_control",
] as const;

export type PilotState = (typeof PILOT_STATE_SEQUENCE)[number] | "suspended";

/**
 * Deployment evidence for the durable job queue, mirroring the three states
 * `/api/health` reports. `configured_unverified` is NOT evidence of durability:
 * a wrong or unreachable REDIS_URL looks exactly like it.
 */
export type QueueDurability = "confirmed" | "configured_unverified" | "fallback";

/** Was something actually recorded here, as opposed to typed over? */
export function hasEvidence(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export type PilotRoster = {
  total: number;
  /** Distributors the customer has signed off as reconcilable today. */
  active: number;
  pending: number;
  flagged: number;
  /** Canonical names shared by more than one roster row. */
  duplicateNames: number;
};

export function calculateCorporateB2BPilotReadiness(input: {
  config: PilotReadinessConfig | null;
  sources: PilotReadinessSource[];
  roster: PilotRoster;
  /**
   * What the live deployment's job queue actually is. Required: B6 used to be
   * hardcoded `ready: true` while its own detail text said durable queueing
   * "remains mandatory where the selected deployment enables queued
   * processing" — a gate that states a condition and then does not test it is
   * decoration. Reconciliation runs go through that queue, so a pilot on the
   * in-process fallback loses queued work on restart.
   */
  queueDurability: QueueDurability;
}) {
  const { config, sources, queueDurability } = input;
  const { total, active, pending, flagged, duplicateNames } = input.roster;
  const sourceCount = sources.length;
  const testedSources = sources.filter((source) => source.status === "tested" || source.status === "approved" || source.status === "active");
  const approvedSources = sources.filter((source) => source.status === "approved" || source.status === "active");
  const safeSources = sources.every((source) => source.customerOwnedCredentials && source.controlTotalRequired);
  const hasInvoiceEvidence = approvedSources.some((source) => source.sourceType === "invoice_ar");
  const hasReceiptEvidence = approvedSources.some((source) => ["bank_statement", "mobile_money", "psp_collection"].includes(source.sourceType));
  const gates: PilotGate[] = [
    { id: "B0", label: "Read-only launch boundary", ready: Boolean(config?.noWriteAcknowledged) && hasEvidence(config?.pilotScope), detail: "No payment initiation, account access, ERP posting, customer messaging, or credit-note action.", basis: "customer_attested" },
    { id: "B1", label: "Canonical data contract", ready: config?.dataContractStatus === "approved" && hasInvoiceEvidence && hasReceiptEvidence, detail: "Approved invoice/AR and receipt evidence with a documented source hierarchy.", basis: "customer_attested" },
    // The COUNT and TYPES are platform-read; `customerOwnedCredentials` and
    // `controlTotalRequired` are attestations — nothing here compares a control
    // total to an ingested batch. The basis is therefore the weaker of the two.
    { id: "B2", label: "Customer-authorised source route", ready: testedSources.length >= 2 && safeSources, detail: "At least two tested customer-controlled sources, each attested to carry a control total. The platform does not itself verify a delivered control total — that is dry-run evidence (C3), not a toggle.", basis: "customer_attested" },
    // Roster counts come from the distributors table, so the population half of
    // this gate IS verified. Duplicate canonical names are included because
    // ungoverned aliases are what produce false match candidates.
    { id: "B3", label: "Distributor master-data governance", ready: config?.rosterStatus === "approved" && total > 0 && active > 0 && pending === 0 && flagged === 0 && duplicateNames === 0, detail: "An approved roster with at least one active identity, and no unconfirmed, flagged or duplicated distributor names.", basis: "platform_verified" },
    { id: "B4", label: "Allocation and daily-close policy", ready: config?.allocationPolicyStatus === "approved" && hasEvidence(config?.dailyCloseOwner), detail: "Human-approved allocation proposals and a named daily finance-close owner.", basis: "customer_attested" },
    // B5 was not raised in review but fails the same way: a private AI route is
    // approved on the strength of a recorded sign-off, and " " is not one. The
    // mutation already trims this field on the way in; the rule now agrees.
    //
    // Platform-verified rather than attested: server/aiGate.ts refuses EVERY
    // org-scoped model entry point for a corporate_b2b tenant that has not
    // recorded a private approved route, so this gate reports live behaviour.
    { id: "B5", label: "AI and external-data boundary", ready: config?.aiAssistanceMode === "disabled" || (config?.aiAssistanceMode === "private_approved" && hasEvidence(config?.aiBoundaryReference)), detail: "AI is disabled by default and enforced server-side at every model entry point; a private approved route requires a recorded sign-off reference.", basis: "platform_verified" },
    {
      id: "B6",
      label: "Foundation hardening deployment",
      ready: queueDurability === "confirmed",
      detail: queueDurabilityDetail(queueDurability),
      basis: "platform_verified",
    },
    { id: "B7", label: "Recovery and retention evidence", ready: config?.operationalRecoveryStatus === "passed" && Number(config?.retentionDays ?? 0) > 0, detail: "Successful replay/recovery evidence and a time-bound retention policy. Recording 'passed' here is the customer's attestation that the drill was executed, not proof that it was.", basis: "customer_attested" },
    { id: "B8", label: "Commercial and data-processing terms", ready: config?.contractStatus === "approved" && config?.dataProcessingStatus === "approved" && hasEvidence(config?.contractReference) && hasEvidence(config?.dataProcessingReference), detail: "Recorded contract and data-processing references; the customer remains responsible for legal validity.", basis: "customer_attested" },
  ];
  const blockedBy = gates.filter((gate) => !gate.ready).map((gate) => gate.id);
  return {
    gates,
    sourceCount,
    testedSources: testedSources.length,
    approvedSources: approvedSources.length,
    canStartReadOnlyPilot: gates.every((gate) => gate.ready),
    blockedBy,
    /**
     * How many of the GREEN gates rest on a customer attestation rather than
     * something the platform checked. Surfaced so the workspace can say so out
     * loud instead of rendering nine identical ticks — see the closure
     * register's "a toggle in Pilot Controls does not close C3/C8".
     */
    attestedGatesGreen: gates.filter((gate) => gate.ready && gate.basis === "customer_attested").length,
    queueDurability,
  };
}

function queueDurabilityDetail(durability: QueueDurability): string {
  switch (durability) {
    case "confirmed":
      return "The P1–P7 foundation release is merged and proven, and this deployment's reconciliation queue is running on the durable (Redis/BullMQ) backend.";
    case "configured_unverified":
      return "REDIS_URL is configured but no queue has connected yet, so durability is unverified — a wrong or unreachable URL looks identical. Run a reconciliation job and re-check before treating this as closed.";
    case "fallback":
      return "This deployment is running the in-process queue fallback: queued reconciliation work is lost on restart. Provision Redis (REDIS_URL) before a customer pilot depends on a daily close.";
  }
}

export type PilotReadinessSummary = ReturnType<typeof calculateCorporateB2BPilotReadiness>;

/**
 * May this pilot move into `next`?
 *
 * The closure register is explicit that a live parallel reconciliation run is
 * NOT permitted until C0–C9 are closed with evidence, and that failure "never
 * means silently widen scope". Without this rule the register could be set to
 * `limited_control` while eight of its own gates were red — a state field that
 * contradicts the gates printed directly above it.
 *
 * Returns null when the transition is allowed, or the reason it is refused.
 */
export function pilotStateTransitionRefusal(
  next: PilotState,
  current: PilotState | null,
  readiness: Pick<PilotReadinessSummary, "gates" | "canStartReadOnlyPilot">,
): string | null {
  // Stopping is never gated. A control that can be entered but not left is not
  // a safety control.
  if (next === "suspended") return null;
  // Reversing to an earlier state is always allowed, for the same reason.
  const rank = (state: PilotState | null) =>
    state === null || state === "suspended" ? -1 : PILOT_STATE_SEQUENCE.indexOf(state);
  if (rank(next) <= rank(current)) return null;

  const openIds = (ids: string[]) =>
    readiness.gates.filter((gate) => ids.includes(gate.id) && !gate.ready).map((gate) => gate.id);

  if (next === "dry_run") {
    // Closure register §4: "Ingest masked / approved historical samples — Yes —
    // C1–C3 and legal approval for the selected data route."
    const open = openIds(["B0", "B1", "B2", "B8"]);
    if (open.length > 0) {
      return `A dry run needs the read-only boundary, data contract, source routes and legal terms recorded first. Open: ${open.join(", ")}.`;
    }
    return null;
  }

  if (next === "parallel_run" || next === "limited_control") {
    if (!readiness.canStartReadOnlyPilot) {
      const open = readiness.gates.filter((gate) => !gate.ready).map((gate) => gate.id).join(", ");
      return `A ${next.replace(/_/g, " ")} requires every release gate to be closed with evidence. Open: ${open}.`;
    }
    if (next === "limited_control" && current !== "parallel_run") {
      return "Limited control follows an accepted parallel run. Move the pilot to parallel run and complete the agreed observation period first.";
    }
    return null;
  }

  return null;
}
