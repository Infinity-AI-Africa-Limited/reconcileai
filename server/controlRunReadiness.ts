import { TRPCError } from "@trpc/server";
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  controlBatchManifests,
  controlSourceContracts,
} from "../drizzle/schema";
import {
  assessControlRunReadiness,
  type ControlRunAssessment,
  type ControlSourceRole,
  type ReceivedSourceManifest,
  type RequiredSourceManifest,
} from "./controlCompleteness";
import { getDb } from "./db";

/**
 * Storage-backed preflight for a governed daily control.
 *
 * The initial completeness policy is deliberately pure. This module is the
 * narrow adapter from the approved source contracts and immutable batch
 * manifests introduced in the preceding increment into that policy. It only
 * assesses evidence. It does not create a reconciliation job, invoke a
 * connector, calculate a match rate, or publish a control conclusion.
 */

export type PersistedControlReadinessReason =
  | "invalid_control_period"
  | "no_eligible_source_contracts"
  | "ambiguous_source_contract"
  | "invalid_source_cutoff"
  | "multiple_batch_manifests"
  | "source_contract_version_mismatch"
  | "invalid_reconciliation_policy_version"
  | "mixed_reconciliation_policy_version";

export type PersistedControlRunAssessment = ControlRunAssessment & {
  organizationId: number;
  controlPeriod: string;
  evaluatedAt: Date;
  /**
   * Conditions discovered while translating persisted evidence. These are kept
   * separate from the pure policy's reasons so no caller mistakes a repository
   * integrity failure for a source-population shortfall.
   */
  persistenceReasons: PersistedControlReadinessReason[];
  sourceContractCount: number;
  batchManifestCount: number;
};

export type PersistedSourceContract = {
  id: number;
  organizationId: number;
  sourceKey: string;
  version: number;
  role: string;
  timeZone: string;
  cutoffMinutes: number;
  controlTotalRequired: boolean;
  status: string;
  effectiveAt: Date;
};

export type PersistedBatchManifest = {
  id: number;
  organizationId: number;
  sourceContractId: number;
  sourceContractVersion: number;
  controlPeriod: string;
  deliveryIdentity: string;
  receivedAt: Date;
  mappingVersion: string;
  reconciliationPolicyVersion: string;
  schemaState: string;
  duplicateDelivery: string;
  invalidRowCount: number;
  expectedRecordCount: number | null;
  expectedMonetaryTotal: string | null;
  expectedCurrency: string | null;
  receivedRecordCount: number;
  receivedMonetaryTotal: string;
  receivedCurrency: string;
};

const ELIGIBLE_CONTRACT_STATUSES = ["approved", "tested", "active"] as const;

const SOURCE_CONTRACT_FIELDS = {
  id: controlSourceContracts.id,
  organizationId: controlSourceContracts.organizationId,
  sourceKey: controlSourceContracts.sourceKey,
  version: controlSourceContracts.version,
  role: controlSourceContracts.role,
  timeZone: controlSourceContracts.timeZone,
  cutoffMinutes: controlSourceContracts.cutoffMinutes,
  controlTotalRequired: controlSourceContracts.controlTotalRequired,
  status: controlSourceContracts.status,
  effectiveAt: controlSourceContracts.effectiveAt,
} as const;

const BATCH_MANIFEST_FIELDS = {
  id: controlBatchManifests.id,
  organizationId: controlBatchManifests.organizationId,
  sourceContractId: controlBatchManifests.sourceContractId,
  sourceContractVersion: controlBatchManifests.sourceContractVersion,
  controlPeriod: controlBatchManifests.controlPeriod,
  deliveryIdentity: controlBatchManifests.deliveryIdentity,
  receivedAt: controlBatchManifests.receivedAt,
  mappingVersion: controlBatchManifests.mappingVersion,
  reconciliationPolicyVersion:
    controlBatchManifests.reconciliationPolicyVersion,
  schemaState: controlBatchManifests.schemaState,
  duplicateDelivery: controlBatchManifests.duplicateDelivery,
  invalidRowCount: controlBatchManifests.invalidRowCount,
  expectedRecordCount: controlBatchManifests.expectedRecordCount,
  expectedMonetaryTotal: controlBatchManifests.expectedMonetaryTotal,
  expectedCurrency: controlBatchManifests.expectedCurrency,
  receivedRecordCount: controlBatchManifests.receivedRecordCount,
  receivedMonetaryTotal: controlBatchManifests.receivedMonetaryTotal,
  receivedCurrency: controlBatchManifests.receivedCurrency,
} as const;

/**
 * Load exactly the approved source definitions and delivered evidence for one
 * tenant and business day. The database predicates are part of the security
 * boundary: no control may be assessed from another tenant's evidence.
 */
export async function assessPersistedControlRun(params: {
  organizationId: number;
  controlPeriod: string;
  evaluatedAt?: Date;
}): Promise<PersistedControlRunAssessment> {
  const evaluatedAt = params.evaluatedAt ?? new Date();
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    });
  }

  const contracts = (await db
    .select(SOURCE_CONTRACT_FIELDS)
    .from(controlSourceContracts)
    .where(
      and(
        eq(controlSourceContracts.organizationId, params.organizationId),
        inArray(controlSourceContracts.status, [...ELIGIBLE_CONTRACT_STATUSES]),
        lte(controlSourceContracts.effectiveAt, evaluatedAt)
      )
    )) as PersistedSourceContract[];

  if (contracts.length === 0) {
    return assessPersistedControlEvidence({
      organizationId: params.organizationId,
      controlPeriod: params.controlPeriod,
      evaluatedAt,
      sourceContracts: [],
      batchManifests: [],
    });
  }

  const manifests = (await db
    .select(BATCH_MANIFEST_FIELDS)
    .from(controlBatchManifests)
    .where(
      and(
        eq(controlBatchManifests.organizationId, params.organizationId),
        eq(controlBatchManifests.controlPeriod, params.controlPeriod),
        inArray(
          controlBatchManifests.sourceContractId,
          contracts.map(contract => contract.id)
        )
      )
    )) as PersistedBatchManifest[];

  return assessPersistedControlEvidence({
    organizationId: params.organizationId,
    controlPeriod: params.controlPeriod,
    evaluatedAt,
    sourceContracts: contracts,
    batchManifests: manifests,
  });
}

/**
 * Deterministically translates persisted evidence into the existing pure
 * completeness policy. Exported for exhaustive unit testing; it is not an
 * external API and cannot cause a reconciliation to start.
 */
export function assessPersistedControlEvidence(params: {
  organizationId: number;
  controlPeriod: string;
  evaluatedAt: Date;
  sourceContracts: PersistedSourceContract[];
  batchManifests: PersistedBatchManifest[];
}): PersistedControlRunAssessment {
  const persistenceReasons: PersistedControlReadinessReason[] = [];
  if (!isIsoCalendarDate(params.controlPeriod)) {
    persistenceReasons.push("invalid_control_period");
  }

  const contracts = Array.isArray(params.sourceContracts)
    ? params.sourceContracts
    : [];
  const manifests = Array.isArray(params.batchManifests)
    ? params.batchManifests.filter(
        manifest => manifest?.controlPeriod === params.controlPeriod
      )
    : [];

  if (contracts.length === 0) {
    persistenceReasons.push("no_eligible_source_contracts");
  }

  const contractsByKey = new Map<string, PersistedSourceContract[]>();
  for (const contract of contracts) {
    const key =
      typeof contract?.sourceKey === "string" ? contract.sourceKey.trim() : "";
    const grouped = contractsByKey.get(key) ?? [];
    grouped.push(contract);
    contractsByKey.set(key, grouped);
  }

  const requiredSources: RequiredSourceManifest[] = [];
  for (const contract of contracts) {
    const key =
      typeof contract?.sourceKey === "string" ? contract.sourceKey.trim() : "";
    if ((contractsByKey.get(key)?.length ?? 0) > 1) {
      addReason(persistenceReasons, "ambiguous_source_contract");
    }

    const sourceManifests = manifests.filter(
      manifest => manifest?.sourceContractId === contract?.id
    );
    if (sourceManifests.length > 1) {
      addReason(persistenceReasons, "multiple_batch_manifests");
    }
    const manifest =
      sourceManifests.length === 1 ? sourceManifests[0] : undefined;

    const cutoffAt = cutoffAtFor(
      params.controlPeriod,
      contract?.timeZone,
      contract?.cutoffMinutes
    );
    if (!cutoffAt) addReason(persistenceReasons, "invalid_source_cutoff");

    if (manifest) {
      if (manifest.sourceContractVersion !== contract.version) {
        addReason(persistenceReasons, "source_contract_version_mismatch");
      }
      if (!isMeaningfulText(manifest.reconciliationPolicyVersion)) {
        addReason(persistenceReasons, "invalid_reconciliation_policy_version");
      }
    }

    requiredSources.push({
      sourceKey: key,
      role: contract?.role as ControlSourceRole,
      required: true,
      cutoffAt: cutoffAt ?? new Date(Number.NaN),
      controlTotalRequired: contract?.controlTotalRequired,
      expected: manifest ? expectedTotal(manifest) : undefined,
      received: manifest ? receivedManifest(manifest) : undefined,
    });
  }

  const policyVersions = new Set(
    manifests
      .map(manifest => manifest?.reconciliationPolicyVersion)
      .filter(isMeaningfulText)
      .map(version => version.trim())
  );
  if (policyVersions.size > 1) {
    addReason(persistenceReasons, "mixed_reconciliation_policy_version");
  }

  const policyAssessment = assessControlRunReadiness(
    requiredSources,
    params.evaluatedAt
  );
  const blockedByPersistence = persistenceReasons.length > 0;
  const status = blockedByPersistence ? "blocked" : policyAssessment.status;

  return {
    ...policyAssessment,
    status,
    canReconcile: status === "ready_to_reconcile",
    mayPublishMatchRate: status === "ready_to_reconcile",
    organizationId: params.organizationId,
    controlPeriod: params.controlPeriod,
    evaluatedAt: params.evaluatedAt,
    persistenceReasons,
    sourceContractCount: contracts.length,
    batchManifestCount: manifests.length,
  };
}

function expectedTotal(
  manifest: PersistedBatchManifest
): RequiredSourceManifest["expected"] {
  return {
    recordCount: manifest.expectedRecordCount as number,
    monetaryTotal: manifest.expectedMonetaryTotal as string,
    currency: manifest.expectedCurrency as string,
  };
}

function receivedManifest(
  manifest: PersistedBatchManifest
): ReceivedSourceManifest {
  return {
    batchId: asText(manifest.deliveryIdentity),
    receivedAt: validDateOrInvalid(manifest.receivedAt),
    sourceContractVersion: Number.isSafeInteger(manifest.sourceContractVersion)
      ? String(manifest.sourceContractVersion)
      : "",
    mappingVersion: asText(manifest.mappingVersion),
    schemaState: manifest.schemaState as ReceivedSourceManifest["schemaState"],
    invalidRowCount: manifest.invalidRowCount,
    duplicateDelivery:
      manifest.duplicateDelivery as ReceivedSourceManifest["duplicateDelivery"],
    recordCount: manifest.receivedRecordCount,
    monetaryTotal: asText(manifest.receivedMonetaryTotal),
    currency: asText(manifest.receivedCurrency),
  };
}

function validDateOrInvalid(value: unknown): Date {
  return value instanceof Date ? value : new Date(Number.NaN);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isMeaningfulText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCutoffMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_439
  );
}

function addReason(
  reasons: PersistedControlReadinessReason[],
  reason: PersistedControlReadinessReason
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** `YYYY-MM-DD`, including real calendar days only. */
function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Converts an approved local cut-off to a UTC instant without accepting a
 * nonexistent or ambiguous local time. The latter occurs around DST changes;
 * blocking is safer than guessing an instant for a control deadline.
 */
function cutoffAtFor(
  controlPeriod: string,
  timeZone: unknown,
  cutoffMinutes: unknown
): Date | null {
  if (
    !isIsoCalendarDate(controlPeriod) ||
    !isMeaningfulText(timeZone) ||
    !isValidCutoffMinutes(cutoffMinutes)
  ) {
    return null;
  }

  const [year, month, day] = controlPeriod.split("-").map(Number);
  const hour = Math.floor(cutoffMinutes / 60);
  const minute = cutoffMinutes % 60;
  const desired = { year, month, day, hour, minute };
  const rough = Date.UTC(year, month - 1, day, hour, minute);

  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const offsets = new Set<number>();
    for (let hours = -30; hours <= 30; hours += 1) {
      const instant = new Date(rough + hours * 60 * 60 * 1_000);
      const parts = readLocalParts(formatter, instant);
      offsets.add(
        Date.UTC(
          parts.year,
          parts.month - 1,
          parts.day,
          parts.hour,
          parts.minute
        ) - instant.getTime()
      );
    }

    const candidates = [...offsets]
      .map(offset => new Date(rough - offset))
      .filter(instant =>
        sameLocalParts(readLocalParts(formatter, instant), desired)
      );
    return candidates.length === 1 ? candidates[0] : null;
  } catch {
    return null;
  }
}

function readLocalParts(
  formatter: Intl.DateTimeFormat,
  instant: Date
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function sameLocalParts(
  left: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  right: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  }
): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}
