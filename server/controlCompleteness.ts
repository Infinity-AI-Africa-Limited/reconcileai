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
 *
 * It fails CLOSED on anything it cannot vouch for. Manifests will be loaded
 * from storage, so the declared types are not trusted at runtime: a missing
 * field, a number where a string belongs, or a state it does not recognise
 * blocks the source. It never throws, and it never lets the input pass.
 */

import { exactDecimalsEqual, parseExactDecimal } from "../shared/money";

export type ControlSourceRole =
  | "settlement"
  | "internal_register"
  | "bank_or_gl";

export type SourceSchemaState = "accepted" | "rejected" | "unknown";
export type DuplicateDeliveryState = "none" | "deduplicated" | "rejected";

export interface SourceControlTotal {
  /** Number of records in the agreed source population. */
  recordCount: number;
  /**
   * Canonical decimal string, for example `125000.00`; never a JS float. Any
   * number of decimal places, compared exactly (shared/money.ts).
   */
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
  /** Unique within one control definition. */
  sourceKey: string;
  role: ControlSourceRole;
  /** Only an explicit `false` makes a source optional; anything else is required. */
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
  | "invalid_source_manifest"
  | "missing_source_key"
  | "invalid_source_role"
  | "invalid_received_manifest"
  | "source_not_received"
  | "invalid_evaluation_time"
  | "invalid_cutoff"
  | "invalid_received_at"
  | "received_after_evaluation_time"
  | "received_after_cutoff"
  | "missing_batch_identity"
  | "missing_source_contract_version"
  | "missing_mapping_version"
  | "schema_not_accepted"
  | "invalid_rows_present"
  | "duplicate_delivery_rejected"
  | "unknown_duplicate_delivery_state"
  | "control_total_not_required"
  | "missing_expected_control_total"
  | "invalid_expected_control_total"
  | "invalid_control_total"
  | "record_count_mismatch"
  | "currency_mismatch"
  | "monetary_total_mismatch";

/**
 * What each reason does to a source. `blocks`: the evidence or its definition
 * is unusable, whatever else is true. `population_shortfall`: the evidence is
 * sound but does not (yet) add up to the agreed population.
 *
 * A source with ANY blocking reason is `blocked`, even when it is also late or
 * short — a shortfall must never be the headline for evidence that cannot be
 * trusted. Typed as a full Record, so a reason added without a class here is a
 * compile error rather than a silent default.
 */
export const SOURCE_REASON_EFFECT: Readonly<
  Record<SourceReadinessReason, "blocks" | "population_shortfall">
> = {
  // Awaiting or incomplete, decided by the clock against the cut-off.
  source_not_received: "population_shortfall",
  received_after_cutoff: "population_shortfall",
  record_count_mismatch: "population_shortfall",
  currency_mismatch: "population_shortfall",
  monetary_total_mismatch: "population_shortfall",
  // The entry cannot be read, named or placed, so nothing it says can be used.
  invalid_source_manifest: "blocks",
  missing_source_key: "blocks",
  invalid_source_role: "blocks",
  invalid_received_manifest: "blocks",
  invalid_evaluation_time: "blocks",
  invalid_cutoff: "blocks",
  invalid_received_at: "blocks",
  // Evidence dated after the moment it is judged at is a clock or replay
  // error, never a delivery that may still count.
  received_after_evaluation_time: "blocks",
  missing_batch_identity: "blocks",
  missing_source_contract_version: "blocks",
  missing_mapping_version: "blocks",
  schema_not_accepted: "blocks",
  invalid_rows_present: "blocks",
  duplicate_delivery_rejected: "blocks",
  unknown_duplicate_delivery_state: "blocks",
  control_total_not_required: "blocks",
  missing_expected_control_total: "blocks",
  invalid_expected_control_total: "blocks",
  invalid_control_total: "blocks",
};

export type SourceReadinessWarning = "duplicate_delivery_deduplicated";

export interface SourceReadinessAssessment {
  /** Null when the manifest did not name itself usably; such a source is blocked. */
  sourceKey: string | null;
  /** Null when the manifest's role is not one this policy knows; blocked too. */
  role: ControlSourceRole | null;
  required: boolean;
  status: SourceReadiness;
  reasons: SourceReadinessReason[];
  warnings: SourceReadinessWarning[];
}

export type ControlRunReadiness =
  | "ready_to_reconcile"
  | "awaiting_sources"
  | "incomplete"
  | "blocked";

export type ControlRunReadinessReason =
  | "invalid_control_definition"
  | "no_required_sources"
  | "invalid_evaluation_time"
  | "duplicate_source_key";

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
 * invalid/unsafe inputs block a run; a late or short source makes it
 * incomplete; a source not yet due is awaiting. An optional source is assessed
 * for visibility but never prevents the defined two-source control from
 * proceeding.
 */
export function assessControlRunReadiness(
  manifests: RequiredSourceManifest[],
  now: Date
): ControlRunAssessment {
  if (!Array.isArray(manifests)) {
    return {
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      reasons: ["invalid_control_definition"],
      sourceAssessments: [],
    };
  }
  const sourceAssessments = manifests.map(manifest =>
    assessSourceReadiness(manifest, now)
  );
  const required = sourceAssessments.filter(assessment => assessment.required);

  const reasons: ControlRunReadinessReason[] = [];
  if (required.length === 0) reasons.push("no_required_sources");
  if (!isValidDate(now)) reasons.push("invalid_evaluation_time");
  // Two entries under one key leave a persisted assessment ambiguous about
  // which delivery it describes, so the definition itself is unusable.
  // Unnamed sources are already blocked; only the named ones can collide.
  const keys = sourceAssessments
    .map(assessment => assessment.sourceKey?.trim())
    .filter((key): key is string => key !== undefined);
  if (new Set(keys).size !== keys.length) reasons.push("duplicate_source_key");

  const status: ControlRunReadiness =
    reasons.length > 0 ||
    required.some(assessment => assessment.status === "blocked")
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
    reasons,
    sourceAssessments,
  };
}

export function assessSourceReadiness(
  manifest: RequiredSourceManifest,
  now: Date
): SourceReadinessAssessment {
  // Read nothing from an entry that is not an object: a null in a stored list
  // must come back blocked, not as an exception that leaves the caller with
  // no assessment at all. Unknown requiredness counts as required.
  if (!isRecord(manifest)) {
    return {
      sourceKey: null,
      role: null,
      required: true,
      status: "blocked",
      reasons: ["invalid_source_manifest"],
      warnings: [],
    };
  }

  const reasons: SourceReadinessReason[] = [];
  const warnings: SourceReadinessWarning[] = [];

  // An approval has to say WHAT it approved.
  const sourceKey = hasMeaningfulValue(manifest.sourceKey)
    ? manifest.sourceKey
    : null;
  if (sourceKey === null) reasons.push("missing_source_key");
  const role = isSourceRole(manifest.role) ? manifest.role : null;
  if (role === null) reasons.push("invalid_source_role");

  // The clock and the contract come first: neither depends on a delivery, so a
  // batch that has not arrived must not hide that the definition is unusable.
  const nowIsValid = isValidDate(now);
  const cutoffIsValid = isValidDate(manifest.cutoffAt);
  if (!nowIsValid) reasons.push("invalid_evaluation_time");
  if (!cutoffIsValid) reasons.push("invalid_cutoff");

  const expected =
    manifest.controlTotalRequired === true ? manifest.expected : undefined;
  if (manifest.controlTotalRequired !== true) {
    reasons.push("control_total_not_required");
  } else if (!manifest.expected) {
    reasons.push("missing_expected_control_total");
  } else if (!isValidControlTotal(manifest.expected)) {
    reasons.push("invalid_expected_control_total");
  }

  const received: unknown = manifest.received;
  if (received === undefined || received === null) {
    reasons.push("source_not_received");
  } else if (!isRecord(received)) {
    // Present but not a manifest: never reinterpret it as "not received".
    reasons.push("invalid_received_manifest");
  } else {
    if (!isValidDate(received.receivedAt)) {
      reasons.push("invalid_received_at");
    } else {
      if (nowIsValid && received.receivedAt.getTime() > now.getTime())
        reasons.push("received_after_evaluation_time");
      if (
        cutoffIsValid &&
        received.receivedAt.getTime() > manifest.cutoffAt.getTime()
      )
        reasons.push("received_after_cutoff");
    }
    if (!hasMeaningfulValue(received.batchId))
      reasons.push("missing_batch_identity");
    if (!hasMeaningfulValue(received.sourceContractVersion))
      reasons.push("missing_source_contract_version");
    if (!hasMeaningfulValue(received.mappingVersion))
      reasons.push("missing_mapping_version");
    if (received.schemaState !== "accepted")
      reasons.push("schema_not_accepted");
    if (
      !isNonNegativeInteger(received.invalidRowCount) ||
      received.invalidRowCount > 0
    )
      reasons.push("invalid_rows_present");
    // An allow-list: only the two states known to be safe pass.
    if (received.duplicateDelivery === "deduplicated")
      warnings.push("duplicate_delivery_deduplicated");
    else if (received.duplicateDelivery === "rejected")
      reasons.push("duplicate_delivery_rejected");
    else if (received.duplicateDelivery !== "none")
      reasons.push("unknown_duplicate_delivery_state");

    const receivedTotalIsValid = isValidControlTotal(received);
    if (!receivedTotalIsValid) reasons.push("invalid_control_total");

    if (expected && receivedTotalIsValid && isValidControlTotal(expected)) {
      if (received.recordCount !== expected.recordCount)
        reasons.push("record_count_mismatch");
      if (received.currency.toUpperCase() !== expected.currency.toUpperCase()) {
        reasons.push("currency_mismatch");
      } else if (!sameMonetaryTotal(received, expected)) {
        reasons.push("monetary_total_mismatch");
      }
    }
  }

  return {
    sourceKey,
    role,
    required: manifest.required !== false,
    status: sourceStatus(
      reasons,
      nowIsValid &&
        cutoffIsValid &&
        now.getTime() <= manifest.cutoffAt.getTime()
    ),
    reasons,
    warnings,
  };
}

/** Blocked first, always; then not-yet-due; then any shortfall. */
function sourceStatus(
  reasons: SourceReadinessReason[],
  stillDue: boolean
): SourceReadiness {
  if (reasons.some(reason => SOURCE_REASON_EFFECT[reason] === "blocks"))
    return "blocked";
  if (reasons.length === 0) return "ready";
  const onlyAwaitingDelivery =
    reasons.length === 1 && reasons[0] === "source_not_received";
  return onlyAwaitingDelivery && stillDue ? "awaiting_source" : "incomplete";
}

const SOURCE_ROLES: ReadonlySet<unknown> = new Set<ControlSourceRole>([
  "settlement",
  "internal_register",
  "bank_or_gl",
]);

function isSourceRole(value: unknown): value is ControlSourceRole {
  return SOURCE_ROLES.has(value);
}

/** A plain object, so its fields can be read; never null or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function hasMeaningfulValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidControlTotal(total: unknown): total is SourceControlTotal {
  return (
    isRecord(total) &&
    isNonNegativeInteger(total.recordCount) &&
    typeof total.currency === "string" &&
    /^[A-Za-z]{3}$/.test(total.currency) &&
    parseExactDecimal(total.monetaryTotal) !== null
  );
}

/** Both totals are already known to parse (isValidControlTotal). */
function sameMonetaryTotal(
  received: SourceControlTotal,
  expected: SourceControlTotal
): boolean {
  const left = parseExactDecimal(received.monetaryTotal);
  const right = parseExactDecimal(expected.monetaryTotal);
  return left !== null && right !== null && exactDecimalsEqual(left, right);
}
