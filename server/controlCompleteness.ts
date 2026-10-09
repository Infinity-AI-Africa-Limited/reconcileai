/**
 * Population-completeness gate for governed daily controls.
 *
 * A reconciliation engine can match every row it receives and still produce a
 * misleading conclusion when a required source is late, malformed, duplicated
 * without idempotency, or disagrees with its own control totals. This pure
 * policy is the shared precondition for a future persisted source-manifest
 * workflow: it decides whether a run may be interpreted at all.
 *
 * It deliberately does not read a database, enqueue work, or make a financial
 * decision. Callers must persist the source contract, batch manifest, mapping
 * version, policy version, and resulting assessment separately. Until that
 * integration exists, no route may claim this module proves a customer run.
 */

export type ControlSourceRole =
  | "settlement"
  | "internal_register"
  | "bank_or_gl";

export type SourceSchemaState = "accepted" | "rejected" | "unknown";
export type DuplicateDeliveryState = "none" | "deduplicated" | "rejected";

export interface SourceControlTotal {
  /** Number of records in the agreed source population. */
  recordCount: number;
  /** Canonical decimal string, for example `125000.00`; never use a JS float. */
  monetaryTotal: string;
  /** ISO 4217 currency code for the contractual monetary total. */
  currency: string;
}

export interface ReceivedSourceManifest extends SourceControlTotal {
  batchId: string;
  receivedAt: Date;
  sourceContractVersion: string;
  mappingVersion: string;
  schemaState: SourceSchemaState;
  /** Rows the mapper refused. Any rejected row blocks a complete-population claim. */
  invalidRowCount: number;
  duplicateDelivery: DuplicateDeliveryState;
}

export interface RequiredSourceManifest {
  sourceKey: string;
  role: ControlSourceRole;
  required: boolean;
  /** The approved source-delivery cut-off for the control period. */
  cutoffAt: Date;
  /** Required only when the source contract states a count/value control total. */
  controlTotalRequired: boolean;
  expected?: SourceControlTotal;
  received?: ReceivedSourceManifest;
}

export type SourceReadiness =
  | "ready"
  | "awaiting_source"
  | "incomplete"
  | "blocked";

/** Stable machine reasons: safe to store, translate, trend, and use in policy tests. */
export type SourceReadinessReason =
  | "source_not_received"
  | "invalid_cutoff"
  | "invalid_received_at"
  | "received_after_cutoff"
  | "missing_batch_identity"
  | "missing_source_contract_version"
  | "missing_mapping_version"
  | "schema_not_accepted"
  | "invalid_rows_present"
  | "duplicate_delivery_rejected"
  | "control_total_not_required"
  | "missing_expected_control_total"
  | "invalid_expected_control_total"
  | "invalid_control_total"
  | "record_count_mismatch"
  | "currency_mismatch"
  | "monetary_total_mismatch";

export interface SourceReadinessAssessment {
  sourceKey: string;
  role: ControlSourceRole;
  required: boolean;
  status: SourceReadiness;
  reasons: SourceReadinessReason[];
  warnings: Array<"duplicate_delivery_deduplicated">;
}

export type ControlRunReadiness =
  | "ready_to_reconcile"
  | "awaiting_sources"
  | "incomplete"
  | "blocked";

export type ControlRunReadinessReason =
  | "no_required_sources"
  | "invalid_evaluation_time";

export interface ControlRunAssessment {
  status: ControlRunReadiness;
  /** A match rate or control conclusion is meaningful only in this state. */
  canReconcile: boolean;
  /** Same as canReconcile; this makes report/UI callers state the policy explicitly. */
  mayPublishMatchRate: boolean;
  reasons: ControlRunReadinessReason[];
  sourceAssessments: SourceReadinessAssessment[];
}

/**
 * Evaluate every required source before matching. Precedence is intentional:
 * invalid/unsafe inputs block a run; a late source makes it incomplete; a source
 * not yet due is awaiting. An optional source is assessed for visibility but
 * never prevents the defined two-source control from proceeding.
 */
export function assessControlRunReadiness(
  manifests: RequiredSourceManifest[],
  now: Date
): ControlRunAssessment {
  const sourceAssessments = manifests.map(manifest =>
    assessSourceReadiness(manifest, now)
  );
  const required = sourceAssessments.filter(assessment => assessment.required);

  const noRequiredSources = required.length === 0;
  const invalidEvaluationTime =
    !(now instanceof Date) || Number.isNaN(now.getTime());
  const status: ControlRunReadiness =
    noRequiredSources || invalidEvaluationTime
      ? "blocked"
      : required.some(assessment => assessment.status === "blocked")
        ? "blocked"
        : required.some(assessment => assessment.status === "incomplete")
          ? "incomplete"
          : required.some(assessment => assessment.status === "awaiting_source")
            ? "awaiting_sources"
            : "ready_to_reconcile";

  return {
    status,
    canReconcile: status === "ready_to_reconcile",
    mayPublishMatchRate: status === "ready_to_reconcile",
    reasons: [
      ...(noRequiredSources ? ["no_required_sources" as const] : []),
      ...(invalidEvaluationTime ? ["invalid_evaluation_time" as const] : []),
    ],
    sourceAssessments,
  };
}

export function assessSourceReadiness(
  manifest: RequiredSourceManifest,
  now: Date
): SourceReadinessAssessment {
  const reasons: SourceReadinessReason[] = [];
  const warnings: Array<"duplicate_delivery_deduplicated"> = [];

  if (
    !(manifest.cutoffAt instanceof Date) ||
    Number.isNaN(manifest.cutoffAt.getTime())
  ) {
    return assessment(manifest, "blocked", ["invalid_cutoff"], warnings);
  }

  const received = manifest.received;
  if (!received) {
    return assessment(
      manifest,
      now.getTime() > manifest.cutoffAt.getTime()
        ? "incomplete"
        : "awaiting_source",
      ["source_not_received"],
      warnings
    );
  }

  if (
    !(received.receivedAt instanceof Date) ||
    Number.isNaN(received.receivedAt.getTime())
  ) {
    reasons.push("invalid_received_at");
  } else if (received.receivedAt.getTime() > manifest.cutoffAt.getTime()) {
    reasons.push("received_after_cutoff");
  }
  if (!hasMeaningfulValue(received.batchId))
    reasons.push("missing_batch_identity");
  if (!hasMeaningfulValue(received.sourceContractVersion))
    reasons.push("missing_source_contract_version");
  if (!hasMeaningfulValue(received.mappingVersion))
    reasons.push("missing_mapping_version");
  if (received.schemaState !== "accepted") reasons.push("schema_not_accepted");
  if (
    !isNonNegativeInteger(received.invalidRowCount) ||
    received.invalidRowCount > 0
  )
    reasons.push("invalid_rows_present");
  if (received.duplicateDelivery === "rejected")
    reasons.push("duplicate_delivery_rejected");
  if (received.duplicateDelivery === "deduplicated")
    warnings.push("duplicate_delivery_deduplicated");

  if (!isValidControlTotal(received)) reasons.push("invalid_control_total");

  if (!manifest.controlTotalRequired) {
    reasons.push("control_total_not_required");
  } else {
    if (!manifest.expected) {
      reasons.push("missing_expected_control_total");
    } else if (!isValidControlTotal(manifest.expected)) {
      reasons.push("invalid_expected_control_total");
    } else if (isValidControlTotal(received)) {
      if (received.recordCount !== manifest.expected.recordCount)
        reasons.push("record_count_mismatch");
      if (
        received.currency.toUpperCase() !==
        manifest.expected.currency.toUpperCase()
      ) {
        reasons.push("currency_mismatch");
      } else if (
        toMinorUnits(received.monetaryTotal) !==
        toMinorUnits(manifest.expected.monetaryTotal)
      ) {
        reasons.push("monetary_total_mismatch");
      }
    }
  }

  if (reasons.length > 0) {
    const hasPopulationMismatch = reasons.some(reason =>
      [
        "received_after_cutoff",
        "record_count_mismatch",
        "currency_mismatch",
        "monetary_total_mismatch",
      ].includes(reason)
    );
    return assessment(
      manifest,
      hasPopulationMismatch ? "incomplete" : "blocked",
      reasons,
      warnings
    );
  }

  return assessment(manifest, "ready", reasons, warnings);
}

function assessment(
  manifest: RequiredSourceManifest,
  status: SourceReadiness,
  reasons: SourceReadinessReason[],
  warnings: Array<"duplicate_delivery_deduplicated">
): SourceReadinessAssessment {
  return {
    sourceKey: manifest.sourceKey,
    role: manifest.role,
    required: manifest.required,
    status,
    reasons,
    warnings,
  };
}

function hasMeaningfulValue(value: string): boolean {
  return value.trim().length > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidControlTotal(total: SourceControlTotal): boolean {
  return (
    isNonNegativeInteger(total.recordCount) &&
    /^[A-Za-z]{3}$/.test(total.currency) &&
    toMinorUnits(total.monetaryTotal) !== null
  );
}

/** Parse decimal money exactly; use BigInt so control totals cannot drift on JS floats. */
function toMinorUnits(value: string): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const units = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return sign === "-" ? -units : units;
}
