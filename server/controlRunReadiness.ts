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

  // Bounded by the business day under assessment, NOT by the clock. Keyed on
  // `evaluatedAt`, a source that took effect on the 9th was required for the
  // 8th as soon as the 8th was assessed on the 10th — and since no manifest for
  // the 8th can ever exist for a source that did not exist then, an otherwise
  // complete past day was blocked permanently. `evaluatedAt` remains the clock
  // for judging receipts and deadlines, which is what it is for.
  //
  // This predicate is a deliberate SUPERSET: cut-offs are per contract, in each
  // contract's own approved zone, so the exact test belongs where that zone is
  // known (assessPersistedControlEvidence). Here it only keeps the fetch
  // bounded without excluding any row that could still be eligible.
  const contracts = (await db
    .select(SOURCE_CONTRACT_FIELDS)
    .from(controlSourceContracts)
    .where(
      and(
        eq(controlSourceContracts.organizationId, params.organizationId),
        inArray(controlSourceContracts.status, [...ELIGIBLE_CONTRACT_STATUSES]),
        lte(
          controlSourceContracts.effectiveAt,
          contractEligibilityHorizon(params.controlPeriod) ?? evaluatedAt
        )
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

  const supplied = Array.isArray(params.sourceContracts)
    ? params.sourceContracts
    : [];
  const periodManifests = Array.isArray(params.batchManifests)
    ? params.batchManifests.filter(
        manifest => manifest?.controlPeriod === params.controlPeriod
      )
    : [];

  /**
   * Each contract with the cut-off instant it defines for THIS business day,
   * resolved in its own approved zone.
   *
   * A contract is required for the day only if it was already in effect at that
   * day's cut-off — the deadline the control is judged against. A source that
   * took effect after the cut-off had nothing to deliver, so requiring it would
   * manufacture a shortfall no one can ever clear.
   *
   * A contract whose cut-off cannot be resolved at all is NOT filtered out: it
   * is kept so `invalid_source_cutoff` still fires. Dropping it would turn a
   * misconfigured source into a silently absent one.
   */
  const dated = supplied.map(contract => ({
    contract,
    cutoffAt: cutoffAtFor(
      params.controlPeriod,
      contract?.timeZone,
      contract?.cutoffMinutes
    ),
  }));
  const contracts = dated
    .filter(({ contract, cutoffAt }) => isInEffectBy(contract, cutoffAt))
    .map(({ contract }) => contract);
  /**
   * Evidence belonging to the sources this day actually requires.
   *
   * The query deliberately over-fetches around the day boundary, and
   * `recordControlBatchManifest` lets a contract carry a manifest for a period
   * it was not yet in effect for — so without this, an EXCLUDED source's
   * manifest still reached `policyVersions` and `batchManifestCount`. One
   * October-9 source with its own policy version could raise
   * `mixed_reconciliation_policy_version` and block an October-8 day that was
   * otherwise ready: the same false, unclearable block as the bug above, by a
   * second route.
   */
  const eligibleContractIds = new Set(
    contracts.map(contract => contract?.id).filter(id => id !== undefined)
  );
  const manifests = periodManifests.filter(manifest =>
    eligibleContractIds.has(manifest?.sourceContractId)
  );

  const cutoffByContract = new Map(
    dated.map(({ contract, cutoffAt }) => [contract, cutoffAt])
  );

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

    const cutoffAt = cutoffByContract.get(contract) ?? null;
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

/**
 * Was this contract already in effect at the business day's cut-off?
 *
 * Fails OPEN — keeps the contract — when either side is unusable: an
 * unresolvable cut-off is reported as `invalid_source_cutoff` elsewhere, and a
 * missing or malformed `effectiveAt` must not let a source quietly drop out of
 * a control it may well belong to. Both of those end in a blocked assessment a
 * human can see, which is the safe direction for a control.
 */
function isInEffectBy(
  contract: PersistedSourceContract | undefined,
  cutoffAt: Date | null
): boolean {
  if (!cutoffAt) return true;
  const effectiveAt = contract?.effectiveAt;
  if (!(effectiveAt instanceof Date) || Number.isNaN(effectiveAt.getTime())) {
    return true;
  }
  return effectiveAt.getTime() <= cutoffAt.getTime();
}

/**
 * The latest instant any contract's cut-off for this business day could fall
 * on, used only to bound the query.
 *
 * The day ends last in the most western zone in use (UTC−12), and a cut-off may
 * sit as late as 23:59 local, so nothing eligible can have an `effectiveAt`
 * beyond the day after in UTC plus 12 hours. Two further hours of margin cost
 * nothing — over-fetching is filtered exactly by `isInEffectBy`, while
 * under-fetching would silently drop a required source.
 */
function contractEligibilityHorizon(controlPeriod: string): Date | null {
  if (!isIsoCalendarDate(controlPeriod)) return null;
  const [year, month, day] = controlPeriod.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1) + 14 * 60 * 60 * 1_000);
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
