import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  controlBatchManifests,
  reconciliationJobs,
  transactions,
  uploadBatches,
  type Transaction,
} from "../drizzle/schema";
import { exactDecimalsEqual, parseExactDecimal } from "../shared/money";
import { getDb, type DbExecutor } from "./db";
import {
  assessPersistedControlRun,
  businessDayWindow,
  type PersistedControlRunAssessment,
} from "./controlRunReadiness";

/**
 * The first governed control pack uses the product's existing sub-cent tolerance.
 * It is deliberately not caller-supplied: a policy-versioned configuration record
 * will replace this value in the next control-kernel increment.
 */
export const GOVERNED_DAILY_CONTROL_AMOUNT_TOLERANCE = 0.005;

/**
 * The date allowance for a governed run, in days. Same standing as the amount
 * tolerance above, and replaced by the same policy-versioned record.
 *
 * One day, not zero. The window cannot widen a governed population — that is
 * pinned to the approved upload batches, by identifier, and `loadGovernedPopulation`
 * re-proves it. So the window only decides whether two rows ALREADY inside the
 * approved day may pair, and one day is what lets them: the two legs of one
 * payment routinely carry timestamps hours apart, and an approved local
 * business day straddles a UTC date boundary for most time zones we serve.
 *
 * Zero demanded that the two legs carry the identical instant. Pass 1 matches
 * on reference and was unaffected, but every amount-based pair in a governed
 * run would have failed to match and been reported as an exception — a control
 * that manufactures breaks. It also made `timing_difference` unreachable, since
 * that classification needs `dateDiff > window`.
 */
export const GOVERNED_DAILY_CONTROL_DATE_WINDOW_DAYS = 1;

/**
 * Why a governed run may not start. Stable and payload-free: the same codes are
 * shown by the Daily Control preflight, refused by admission, and raised by the
 * worker, so the three cannot disagree about what "ready to run" means.
 */
export type GovernedAdmissionReason =
  | "evidence_not_ready"
  | "settlement_source_count"
  | "internal_register_source_count"
  | "unmapped_channel"
  | "same_channel"
  | "mixed_time_zones"
  | "invalid_business_day_window"
  | "manifest_without_upload_batch"
  | "manifest_unavailable"
  | "upload_batch_unavailable"
  | "upload_batch_channel_mismatch"
  | "population_off_channel"
  | "population_not_unmatched"
  | "population_currency_mismatch"
  | "population_count_mismatch"
  | "population_total_mismatch";

/**
 * One side of a governed run: its channel and the exact evidence that approved
 * it. Identifiers only — the run re-reads the immutable manifest for its totals,
 * so no monetary value is copied into job configuration.
 */
export type GovernedSide = {
  channelId: number;
  manifestId: number;
  uploadBatchId: number;
};

/**
 * Immutable, non-payload snapshot attached to a reconciliation job that was
 * admitted through the governed daily-control path.
 */
export type GovernedControlAdmission = {
  controlPeriod: string;
  assessedAt: string;
  sourceChannelId: number;
  targetChannelId: number;
  dateFrom: Date;
  dateTo: Date;
  sourceContractCount: number;
  batchManifestCount: number;
  reconciliationPolicyVersions: string[];
  settlement: GovernedSide;
  register: GovernedSide;
};

export type GovernedAdmissionVerdict =
  | { admissible: true; admission: GovernedControlAdmission; reasons: [] }
  | { admissible: false; reasons: GovernedAdmissionReason[] };

/**
 * The rules readable from the assessment alone: a ready day, exactly one
 * settlement and one internal-register source, each bound to its own channel
 * and to one upload batch, in one time zone with a resolvable business day.
 * Exported so the policy is unit-testable without a database.
 */
export function governedAdmissionPlan(
  assessment: PersistedControlRunAssessment
):
  | { ok: true; admission: GovernedControlAdmission }
  | { ok: false; reasons: GovernedAdmissionReason[] } {
  const reasons = new Set<GovernedAdmissionReason>();
  if (!assessment.canReconcile || assessment.status !== "ready_to_reconcile") {
    reasons.add("evidence_not_ready");
  }

  const bindings = assessment.sourceContractBindings;
  const settlements = bindings.filter(binding => binding.role === "settlement");
  const registers = bindings.filter(binding => binding.role === "internal_register");
  if (settlements.length !== 1) reasons.add("settlement_source_count");
  if (registers.length !== 1) reasons.add("internal_register_source_count");
  const settlement = settlements.length === 1 ? settlements[0] : undefined;
  const register = registers.length === 1 ? registers[0] : undefined;

  for (const binding of [settlement, register]) {
    if (!binding) continue;
    if (!isPositiveId(binding.channelId)) reasons.add("unmapped_channel");
    if (!isPositiveId(binding.manifestId) || !isPositiveId(binding.uploadBatchId)) {
      // Without an upload batch there is no population to bind the run to,
      // and a run over "whatever is in the window" is not the approved one.
      reasons.add("manifest_without_upload_batch");
    }
  }
  if (
    settlement &&
    register &&
    isPositiveId(settlement.channelId) &&
    settlement.channelId === register.channelId
  ) {
    reasons.add("same_channel");
  }

  const timeZones = new Set(bindings.map(binding => binding.timeZone));
  const [timeZone] = [...timeZones];
  // No sources at all is already reported above; this is about disagreement.
  if (timeZones.size > 1) reasons.add("mixed_time_zones");
  const window =
    timeZones.size === 1 && typeof timeZone === "string"
      ? businessDayWindow(assessment.controlPeriod, timeZone)
      : null;
  if (timeZones.size === 1 && !window) reasons.add("invalid_business_day_window");

  const settlementSide = sideOf(settlement);
  const registerSide = sideOf(register);
  if (reasons.size > 0 || !window || !settlementSide || !registerSide) {
    return { ok: false, reasons: [...reasons] };
  }
  return {
    ok: true,
    admission: {
      controlPeriod: assessment.controlPeriod,
      assessedAt: assessment.evaluatedAt.toISOString(),
      sourceChannelId: settlementSide.channelId,
      targetChannelId: registerSide.channelId,
      dateFrom: window.dateFrom,
      dateTo: window.dateTo,
      sourceContractCount: assessment.sourceContractCount,
      batchManifestCount: assessment.batchManifestCount,
      reconciliationPolicyVersions: assessment.reconciliationPolicyVersions,
      settlement: settlementSide,
      register: registerSide,
    },
  };
}

/** What a batch's rows add up to, read in one aggregate pass. */
export type PopulationSummary = {
  rowCount: number;
  /** Rows on another channel or another (or no) tenant: not this side's population. */
  offChannelCount: number;
  /** Rows already matched, excepted or reversed: the approved population has moved on. */
  notUnmatchedCount: number;
  currencies: string[];
  /** Exact DECIMAL sum as MySQL returns it; null for an empty batch. */
  total: string | null;
};

export type ManifestTotals = {
  receivedRecordCount: number;
  receivedMonetaryTotal: string;
  receivedCurrency: string;
};

/**
 * Does the population a run would match agree with the manifest that approved
 * it — same rows, same currency, same exact total? Pure; the money is compared
 * as exact decimals, never as floats.
 */
export function populationReasons(
  summary: PopulationSummary,
  manifest: ManifestTotals
): GovernedAdmissionReason[] {
  const reasons: GovernedAdmissionReason[] = [];
  if (summary.offChannelCount > 0) reasons.push("population_off_channel");
  if (summary.notUnmatchedCount > 0) reasons.push("population_not_unmatched");
  const currency = manifest.receivedCurrency.trim().toUpperCase();
  if (summary.currencies.some(found => found.trim().toUpperCase() !== currency)) {
    reasons.push("population_currency_mismatch");
  }
  if (summary.rowCount !== manifest.receivedRecordCount) reasons.push("population_count_mismatch");
  const total = parseExactDecimal(summary.total ?? "0");
  const expected = parseExactDecimal(manifest.receivedMonetaryTotal);
  if (!total || !expected || !exactDecimalsEqual(total, expected)) {
    reasons.push("population_total_mismatch");
  }
  return reasons;
}

/**
 * Check one side against the database: the manifest is this tenant's, still
 * names this batch; the batch is this tenant's, completed, on this side's
 * channel; and its rows are exactly the population the manifest recorded.
 */
export async function verifyGovernedSide(
  executor: DbExecutor,
  organizationId: number,
  side: GovernedSide
): Promise<GovernedAdmissionReason[]> {
  const [manifest] = await executor
    .select({
      uploadBatchId: controlBatchManifests.uploadBatchId,
      receivedRecordCount: controlBatchManifests.receivedRecordCount,
      receivedMonetaryTotal: controlBatchManifests.receivedMonetaryTotal,
      receivedCurrency: controlBatchManifests.receivedCurrency,
    })
    .from(controlBatchManifests)
    .where(
      and(
        eq(controlBatchManifests.id, side.manifestId),
        eq(controlBatchManifests.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!manifest || manifest.uploadBatchId !== side.uploadBatchId) return ["manifest_unavailable"];

  const [batch] = await executor
    .select({ channelId: uploadBatches.channelId, status: uploadBatches.status })
    .from(uploadBatches)
    .where(
      and(
        eq(uploadBatches.id, side.uploadBatchId),
        eq(uploadBatches.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!batch || batch.status !== "completed") return ["upload_batch_unavailable"];
  if (batch.channelId !== side.channelId) return ["upload_batch_channel_mismatch"];

  return populationReasons(await summarizePopulation(executor, organizationId, side), manifest);
}

async function summarizePopulation(
  executor: DbExecutor,
  organizationId: number,
  side: GovernedSide
): Promise<PopulationSummary> {
  // Every row of the batch, whatever its channel or tenant, so a stray row is
  // seen and refused rather than silently left out of the count.
  const inBatch = eq(transactions.batchId, side.uploadBatchId);
  const [row] = await executor
    .select({
      rowCount: sql<number>`COUNT(*)`,
      offChannelCount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.channelId} <> ${side.channelId} OR ${transactions.organizationId} IS NULL OR ${transactions.organizationId} <> ${organizationId} THEN 1 ELSE 0 END), 0)`,
      notUnmatchedCount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.status} <> ${"unmatched"} THEN 1 ELSE 0 END), 0)`,
      // SUM over DECIMAL is exact in MySQL and TiDB; it comes back as a string.
      total: sql<string | null>`SUM(${transactions.amount})`,
    })
    .from(transactions)
    .where(inBatch);
  const currencies = await executor
    .selectDistinct({ currency: transactions.currency })
    .from(transactions)
    .where(inBatch)
    .limit(5);
  return {
    rowCount: Number(row?.rowCount ?? 0),
    offChannelCount: Number(row?.offChannelCount ?? 0),
    notUnmatchedCount: Number(row?.notUnmatchedCount ?? 0),
    currencies: currencies.map(found => found.currency),
    total: row?.total == null ? null : String(row.total),
  };
}

/**
 * The full verdict: the assessment's rules, then both sides against the
 * database. The Daily Control preflight shows it, and admission enforces it,
 * so the Start button is enabled exactly when admission would accept.
 */
export async function evaluateGovernedAdmission(
  assessment: PersistedControlRunAssessment
): Promise<GovernedAdmissionVerdict> {
  const plan = governedAdmissionPlan(assessment);
  if (!plan.ok) return { admissible: false, reasons: plan.reasons };
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const reasons = unique([
    ...(await verifyGovernedSide(db, assessment.organizationId, plan.admission.settlement)),
    ...(await verifyGovernedSide(db, assessment.organizationId, plan.admission.register)),
  ]);
  return reasons.length > 0
    ? { admissible: false, reasons }
    : { admissible: true, admission: plan.admission, reasons: [] };
}

/**
 * Refuse a governed reconciliation unless the persisted evidence is ready AND
 * its approved populations are exactly what a run would match, re-evaluated
 * immediately before job admission.
 */
export async function requireGovernedControlAdmission(params: {
  organizationId: number;
  controlPeriod: string;
}): Promise<GovernedControlAdmission> {
  const assessment = await assessPersistedControlRun(params);
  const verdict = await evaluateGovernedAdmission(assessment);
  if (!verdict.admissible) {
    // The codes are payload-free, so they can be logged; the caller sees a
    // stable message and reads the reasons in the Daily Control preflight.
    console.warn("[governed-control] admission refused", {
      organizationId: params.organizationId,
      controlPeriod: params.controlPeriod,
      reasons: verdict.reasons,
    });
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Daily control is not ready for reconciliation.",
    });
  }
  return verdict.admission;
}

/** A governed run whose approved population no longer holds at run time. */
export class GovernedPopulationError extends Error {
  constructor(readonly reasons: GovernedAdmissionReason[]) {
    super(`Governed control population does not match its approved evidence: ${reasons.join(", ")}`);
    this.name = "GovernedPopulationError";
  }
}

export type GovernedSides = { settlement: GovernedSide; register: GovernedSide };

/** A run already holds the approved batches this one was admitted for. */
export class GovernedRunInFlightError extends Error {
  constructor(readonly jobId: number) {
    super(`A governed run is already in flight for these approved batches (job ${jobId})`);
    this.name = "GovernedRunInFlightError";
  }
}

/**
 * Refuse a second governed run over batches a run already holds.
 *
 * Call this INSIDE the job-insert transaction, which holds a `FOR UPDATE` lock
 * on the tenant's organisation row (`insertJobUnderTenantLock`). That lock is
 * what makes the check atomic: without it two Start requests — two clicks, or
 * two instances behind the same queue — both pass the check, both create a
 * job, and both load the same `unmatched` rows, because
 * `loadGovernedPopulation` reads under a transaction that closes long before
 * the worker saves anything. The two runs then write matches for the same
 * transactions. Duplicate matches are the failure this platform can least
 * afford, and nothing downstream would have reported it.
 *
 * Keyed on the approved upload batches rather than on the control period: the
 * batch is the resource being consumed, so this also catches a run admitted
 * for a different period that resolved to the same batch.
 *
 * Only `pending` and `running` block — the same pair the dashboard counts as
 * active. A run that completed, failed or was cancelled releases its batches by
 * reaching a terminal status, so a day can always be re-run; a claim that
 * outlived its run would make a failed control permanently unrepeatable, which
 * is the opposite trap.
 */
export async function assertGovernedBatchesNotInFlight(
  executor: DbExecutor,
  organizationId: number,
  sides: GovernedSides
): Promise<void> {
  const inFlight = await executor
    .select({
      id: reconciliationJobs.id,
      engineConfig: reconciliationJobs.engineConfig,
    })
    .from(reconciliationJobs)
    .where(
      and(
        eq(reconciliationJobs.organizationId, organizationId),
        inArray(reconciliationJobs.status, ["pending", "running"])
      )
    );
  const wanted = new Set([
    sides.settlement.uploadBatchId,
    sides.register.uploadBatchId,
  ]);
  for (const job of inFlight) {
    for (const batchId of governedBatchIdsOf(job.engineConfig)) {
      if (wanted.has(batchId)) throw new GovernedRunInFlightError(job.id);
    }
  }
}

/**
 * The approved batch ids a job holds, or none for an ordinary job.
 *
 * Unreadable config yields none rather than throwing: this runs over every
 * in-flight job in the tenant, and one malformed row must not be able to stop
 * an unrelated control from starting. `loadGovernedPopulation` is where an
 * unreadable governed config is refused, for the run it actually belongs to.
 */
function governedBatchIdsOf(engineConfig: unknown): number[] {
  let parsed: unknown = engineConfig;
  if (typeof engineConfig === "string") {
    try {
      parsed = JSON.parse(engineConfig);
    } catch {
      return [];
    }
  }
  const governed = isRecord(parsed) ? parsed.governedDailyControl : undefined;
  if (!isRecord(governed)) return [];
  return [asSide(governed.settlement), asSide(governed.register)]
    .filter((side): side is GovernedSide => side !== null)
    .map(side => side.uploadBatchId);
}

/**
 * The approved sides a job was admitted with, read back from its engine
 * config. Null for an ordinary job. A job that claims to be governed but whose
 * snapshot is unreadable, or names other channels than the run, is refused:
 * falling back to the date window would run exactly what governance forbids.
 */
export function governedSidesOf(
  engineConfig: unknown,
  run: { sourceChannelId: number; targetChannelId: number }
): GovernedSides | null {
  // A JSON column: written as JSON text it reads back as a string, written as
  // an object it reads back parsed. Accept both.
  let parsed: unknown = engineConfig;
  if (typeof engineConfig === "string") {
    try {
      parsed = JSON.parse(engineConfig);
    } catch {
      // Unreadable config cannot be told apart from a governed one: refuse.
      throw new GovernedPopulationError(["manifest_unavailable"]);
    }
  }
  const governed = isRecord(parsed) ? parsed.governedDailyControl : undefined;
  if (governed === undefined) return null;
  const settlement = isRecord(governed) ? asSide(governed.settlement) : null;
  const register = isRecord(governed) ? asSide(governed.register) : null;
  if (
    !settlement ||
    !register ||
    settlement.channelId !== run.sourceChannelId ||
    register.channelId !== run.targetChannelId
  ) {
    throw new GovernedPopulationError(["manifest_unavailable"]);
  }
  return { settlement, register };
}

/**
 * Load exactly the approved rows for a governed run, after proving again —
 * in the same transaction, so one snapshot — that they are still the
 * population the manifests recorded. Never a date window: rows imported later,
 * or from another batch, are not what was approved.
 */
export async function loadGovernedPopulation(
  organizationId: number,
  sides: GovernedSides
): Promise<{ sourceTxns: Transaction[]; targetTxns: Transaction[] }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.transaction(async tx => {
    const reasons = unique([
      ...(await verifyGovernedSide(tx, organizationId, sides.settlement)),
      ...(await verifyGovernedSide(tx, organizationId, sides.register)),
    ]);
    if (reasons.length > 0) throw new GovernedPopulationError(reasons);
    const load = (side: GovernedSide) =>
      tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.batchId, side.uploadBatchId),
            eq(transactions.channelId, side.channelId),
            eq(transactions.organizationId, organizationId),
            eq(transactions.status, "unmatched")
          )
        )
        .orderBy(asc(transactions.transactionDate));
    return { sourceTxns: await load(sides.settlement), targetTxns: await load(sides.register) };
  });
}

function sideOf(
  binding:
    | { channelId: number | null; manifestId: number | null; uploadBatchId: number | null }
    | undefined
): GovernedSide | null {
  if (
    !binding ||
    !isPositiveId(binding.channelId) ||
    !isPositiveId(binding.manifestId) ||
    !isPositiveId(binding.uploadBatchId)
  ) {
    return null;
  }
  return {
    channelId: binding.channelId,
    manifestId: binding.manifestId,
    uploadBatchId: binding.uploadBatchId,
  };
}

function asSide(value: unknown): GovernedSide | null {
  if (!isRecord(value)) return null;
  return sideOf({
    channelId: typeof value.channelId === "number" ? value.channelId : null,
    manifestId: typeof value.manifestId === "number" ? value.manifestId : null,
    uploadBatchId: typeof value.uploadBatchId === "number" ? value.uploadBatchId : null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveId(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

