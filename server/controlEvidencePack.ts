import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  controlBatchManifests,
  controlSourceContracts,
  exceptionWorkflowEvents,
  exceptionWorkflows,
  exceptions,
  jobProgressEvents,
} from "../drizzle/schema";
import { isControlPeriod } from "../shared/controlPeriod";
import type { GovernedControlPackIssue } from "../shared/governedControlEvidence";
import { getDb, type DbExecutor } from "./db";

/**
 * A read-only reconstruction of the evidence already attached to one governed
 * daily-control run. It is intentionally not a report, a new conclusion, or a
 * source-data export. The response contains only control metadata: timestamps,
 * versions, lifecycle states and aggregate counts. It never returns transaction
 * rows, source payloads, evidence narratives, workflow notes, IPs, user agents,
 * audit details, file locations, or source-system credentials.
 */

const MAX_PROGRESS_EVENTS = 200;
const MAX_WORKFLOW_EVENTS = 200;
const MAX_AUDIT_EVENTS = 20;

type SafeGovernedSide = {
  channelId: number;
  manifestId: number;
  uploadBatchId: number;
};

type SafeAdmission = {
  controlPeriod: string;
  assessedAt: string;
  sourceContractCount: number;
  batchManifestCount: number;
  reconciliationPolicyVersions: string[];
  settlement: SafeGovernedSide;
  register: SafeGovernedSide;
};

type EvidenceJob = {
  id: number;
  organizationId: number | null;
  engineConfig: unknown;
  /** The channels the run actually reconciled; the snapshot names the admitted ones. */
  sourceChannelId: number;
  targetChannelId: number;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  totalSourceTxns: number;
  totalTargetTxns: number;
  matchedCount: number;
  exceptionCount: number;
  unmatchedCount: number;
};

export type { GovernedControlPackIssue };

export type GovernedControlPackState = "reconstructable" | "evidence_gap";

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asDateIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sideOf(value: unknown): SafeGovernedSide | null {
  const record = recordOf(value);
  if (!record) return null;
  const { channelId, manifestId, uploadBatchId } = record;
  return positiveId(channelId) && positiveId(manifestId) && positiveId(uploadBatchId)
    ? { channelId, manifestId, uploadBatchId }
    : null;
}

/**
 * Parse the admission snapshot strictly. A job that merely looks governed must
 * not get a plausible-looking evidence pack: partial snapshot means evidence
 * gap, not a best-effort reconstruction.
 */
export function governedAdmissionOf(engineConfig: unknown): SafeAdmission | null {
  let parsed = engineConfig;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  const root = recordOf(parsed);
  const governed = root ? recordOf(root.governedDailyControl) : null;
  if (!governed) return null;

  const controlPeriod = governed.controlPeriod;
  const assessedAt = asDateIso(governed.assessedAt);
  const sourceContractCount = governed.sourceContractCount;
  const batchManifestCount = governed.batchManifestCount;
  const policyVersions = governed.reconciliationPolicyVersions;
  const settlement = sideOf(governed.settlement);
  const register = sideOf(governed.register);
  if (
    typeof controlPeriod !== "string" ||
    !isControlPeriod(controlPeriod) ||
    !assessedAt ||
    sourceContractCount !== 2 ||
    batchManifestCount !== 2 ||
    !Array.isArray(policyVersions) ||
    policyVersions.length === 0 ||
    policyVersions.some(version => typeof version !== "string" || version.trim().length === 0 || version.length > 128) ||
    !settlement ||
    !register ||
    settlement.channelId === register.channelId ||
    settlement.manifestId === register.manifestId ||
    settlement.uploadBatchId === register.uploadBatchId
  ) {
    return null;
  }
  return {
    controlPeriod,
    assessedAt,
    sourceContractCount,
    batchManifestCount,
    reconciliationPolicyVersions: [...new Set(policyVersions.map(version => (version as string).trim()))].sort(),
    settlement,
    register,
  };
}

function addIssue(issues: Set<GovernedControlPackIssue>, issue: GovernedControlPackIssue) {
  issues.add(issue);
}

function safeTime(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Build the pack from records that were already persisted by the governed path.
 * All reads are explicitly tenant-scoped. The job itself must have been
 * visibility-checked by the router before it reaches this service.
 */
export async function buildGovernedControlEvidencePack(job: EvidenceJob) {
  if (!positiveId(job.organizationId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This run has no tenant-scoped governed control evidence.",
    });
  }
  const admission = governedAdmissionOf(job.engineConfig);
  if (!admission) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This job has no readable governed daily-control admission evidence.",
    });
  }
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

  // Every read below is one snapshot. Read separately, a pack built while a
  // workflow closed or a manifest changed could mix the states before and
  // after — evidence that never existed at any single moment.
  return db.transaction(tx => readEvidencePack(tx, job, job.organizationId as number, admission));
}

async function readEvidencePack(
  db: DbExecutor,
  job: EvidenceJob,
  organizationId: number,
  admission: SafeAdmission,
) {
  const expected = new Map<number, { role: "settlement" | "internal_register"; side: SafeGovernedSide }>([
    [admission.settlement.manifestId, { role: "settlement", side: admission.settlement }],
    [admission.register.manifestId, { role: "internal_register", side: admission.register }],
  ]);
  const manifestIds = [...expected.keys()];

  const manifests = await db
    .select({
      id: controlBatchManifests.id,
      sourceContractId: controlBatchManifests.sourceContractId,
      sourceContractVersion: controlBatchManifests.sourceContractVersion,
      controlPeriod: controlBatchManifests.controlPeriod,
      uploadBatchId: controlBatchManifests.uploadBatchId,
      receivedAt: controlBatchManifests.receivedAt,
      mappingVersion: controlBatchManifests.mappingVersion,
      reconciliationPolicyVersion: controlBatchManifests.reconciliationPolicyVersion,
      schemaState: controlBatchManifests.schemaState,
      duplicateDelivery: controlBatchManifests.duplicateDelivery,
      invalidRowCount: controlBatchManifests.invalidRowCount,
      receivedRecordCount: controlBatchManifests.receivedRecordCount,
      role: controlSourceContracts.role,
      channelId: controlSourceContracts.channelId,
      contractVersion: controlSourceContracts.version,
    })
    .from(controlBatchManifests)
    .innerJoin(
      controlSourceContracts,
      and(
        eq(controlSourceContracts.id, controlBatchManifests.sourceContractId),
        eq(controlSourceContracts.organizationId, controlBatchManifests.organizationId),
      ),
    )
    .where(and(eq(controlBatchManifests.organizationId, organizationId), inArray(controlBatchManifests.id, manifestIds)));

  const issues = new Set<GovernedControlPackIssue>();

  // The run must have reconciled the channels it was admitted for. The worker
  // refuses a mismatch before matching (governedSidesOf); the pack reports it
  // rather than vouching for evidence that belongs to other channels.
  if (job.sourceChannelId !== admission.settlement.channelId || job.targetChannelId !== admission.register.channelId) {
    addIssue(issues, "run_channel_mismatch");
  }

  const sourceEvidence = manifestIds.map(manifestId => {
    const expectedSide = expected.get(manifestId)!;
    const row = manifests.find(manifest => manifest.id === manifestId);
    if (!row) {
      addIssue(issues, "missing_source_evidence");
      return {
        role: expectedSide.role,
        receivedAt: null as string | null,
        sourceContractVersion: null as number | null,
        mappingVersion: null as string | null,
        reconciliationPolicyVersion: null as string | null,
        schemaState: null as string | null,
        deliveryState: "missing" as const,
        receivedRecords: null as number | null,
        verified: false,
      };
    }

    let verified = true;
    if (row.channelId !== expectedSide.side.channelId) {
      addIssue(issues, "source_contract_channel_mismatch");
      verified = false;
    }
    if (row.role !== expectedSide.role) {
      addIssue(issues, "source_contract_role_mismatch");
      verified = false;
    }
    if (row.contractVersion !== row.sourceContractVersion) {
      addIssue(issues, "source_contract_version_mismatch");
      verified = false;
    }
    if (row.controlPeriod !== admission.controlPeriod) {
      addIssue(issues, "manifest_control_period_mismatch");
      verified = false;
    }
    if (row.uploadBatchId !== expectedSide.side.uploadBatchId) {
      addIssue(issues, "manifest_batch_mismatch");
      verified = false;
    }
    if (row.schemaState !== "accepted") {
      addIssue(issues, "manifest_not_accepted");
      verified = false;
    }
    if (row.invalidRowCount !== 0) {
      addIssue(issues, "manifest_has_invalid_rows");
      verified = false;
    }
    if (row.duplicateDelivery !== "none") {
      addIssue(issues, "manifest_duplicate_delivery");
      verified = false;
    }
    if (!admission.reconciliationPolicyVersions.includes(row.reconciliationPolicyVersion)) {
      addIssue(issues, "manifest_policy_version_mismatch");
      verified = false;
    }
    // A completed run loaded exactly its approved batch, proven equal to the
    // manifest's received count before matching (populationReasons). Its
    // recorded totals must therefore equal those counts; if they do not, the
    // run did not reconcile the population this evidence describes. A run
    // that did not complete recorded no population to compare.
    if (job.status === "completed") {
      const runRecords = expectedSide.role === "settlement" ? job.totalSourceTxns : job.totalTargetTxns;
      if (runRecords !== row.receivedRecordCount) {
        addIssue(issues, "run_population_mismatch");
        verified = false;
      }
    }
    return {
      role: expectedSide.role,
      receivedAt: safeTime(row.receivedAt),
      sourceContractVersion: row.sourceContractVersion,
      mappingVersion: row.mappingVersion,
      reconciliationPolicyVersion: row.reconciliationPolicyVersion,
      schemaState: row.schemaState,
      deliveryState: row.duplicateDelivery,
      receivedRecords: row.receivedRecordCount,
      verified,
    };
  });

  const progressRows = await db
    .select({
      phase: jobProgressEvents.phase,
      progress: jobProgressEvents.progress,
      createdAt: jobProgressEvents.createdAt,
    })
    .from(jobProgressEvents)
    .where(eq(jobProgressEvents.jobId, job.id))
    .orderBy(asc(jobProgressEvents.createdAt), asc(jobProgressEvents.id))
    .limit(MAX_PROGRESS_EVENTS + 1);
  const progressTruncated = progressRows.length > MAX_PROGRESS_EVENTS;
  const progress = progressRows.slice(0, MAX_PROGRESS_EVENTS).map(row => ({
    phase: row.phase,
    progress: row.progress,
    at: row.createdAt.toISOString(),
  }));

  const workflowRows = await db
    .select({
      eventType: exceptionWorkflowEvents.eventType,
      outcome: exceptionWorkflowEvents.outcome,
      createdAt: exceptionWorkflowEvents.createdAt,
    })
    .from(exceptionWorkflowEvents)
    .innerJoin(
      exceptions,
      and(
        eq(exceptions.id, exceptionWorkflowEvents.exceptionId),
        eq(exceptions.organizationId, exceptionWorkflowEvents.organizationId),
      ),
    )
    .where(and(eq(exceptionWorkflowEvents.organizationId, organizationId), eq(exceptions.jobId, job.id)))
    .orderBy(asc(exceptionWorkflowEvents.createdAt), asc(exceptionWorkflowEvents.id))
    .limit(MAX_WORKFLOW_EVENTS + 1);
  const workflowEventsTruncated = workflowRows.length > MAX_WORKFLOW_EVENTS;
  const workflowEvents = workflowRows.slice(0, MAX_WORKFLOW_EVENTS).map(row => ({
    eventType: row.eventType,
    outcome: row.outcome,
    at: row.createdAt.toISOString(),
  }));

  const workflowStatuses = await db
    .select({ status: exceptionWorkflows.status, count: count() })
    .from(exceptionWorkflows)
    .innerJoin(
      exceptions,
      and(
        eq(exceptions.id, exceptionWorkflows.exceptionId),
        eq(exceptions.organizationId, exceptionWorkflows.organizationId),
      ),
    )
    .where(and(eq(exceptionWorkflows.organizationId, organizationId), eq(exceptions.jobId, job.id)))
    .groupBy(exceptionWorkflows.status);
  const materialWorkflowStatusCounts = Object.fromEntries(
    workflowStatuses.map(row => [row.status, Number(row.count)]),
  );

  const contractIds = [...new Set(manifests.map(manifest => manifest.sourceContractId))];
  // One bounded read per kind of record, merged here. A single read OR-ing
  // the four (with the workflow ids as a subquery) left the optimizer free to
  // walk this tenant's whole audit chain in sequence order: measured on MySQL
  // 8.4 against a 500,000-record chain, ~1.7s to return 21 rows once other
  // tenants' workflow audits existed. Each read below is an entity-index
  // lookup (the workflow read is driven from this job's exceptions), so the
  // cost follows the run, not the tenant's history. The merged first
  // MAX_AUDIT_EVENTS by sequence equal the single query's: each kind's first
  // MAX_AUDIT_EVENTS + 1 contain every one of its rows that could rank.
  const auditColumns = {
    id: auditLogs.id,
    action: auditLogs.action,
    entityType: auditLogs.entityType,
    createdAt: auditLogs.createdAt,
    sequenceNumber: auditLogs.sequenceNumber,
    signed: auditLogs.recordHash,
  };
  const auditFor = (entityType: string, entityIds: number[]) =>
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .select(auditColumns)
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              eq(auditLogs.entityType, entityType),
              inArray(auditLogs.entityId, entityIds),
            ),
          )
          .orderBy(asc(auditLogs.sequenceNumber), asc(auditLogs.id))
          .limit(MAX_AUDIT_EVENTS + 1);
  const auditByKind = [
    await auditFor("reconciliation_job", [job.id]),
    await auditFor("control_batch_manifest", manifestIds),
    await auditFor("control_source_contract", contractIds),
    await db
      .select(auditColumns)
      .from(auditLogs)
      .innerJoin(
        exceptionWorkflows,
        and(
          eq(exceptionWorkflows.id, auditLogs.entityId),
          eq(exceptionWorkflows.organizationId, auditLogs.organizationId),
        ),
      )
      .innerJoin(
        exceptions,
        and(
          eq(exceptions.id, exceptionWorkflows.exceptionId),
          eq(exceptions.organizationId, exceptionWorkflows.organizationId),
        ),
      )
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.entityType, "exception_workflow"),
          eq(exceptions.jobId, job.id),
        ),
      )
      .orderBy(asc(auditLogs.sequenceNumber), asc(auditLogs.id))
      .limit(MAX_AUDIT_EVENTS + 1),
  ];
  const auditRows = auditByKind
    .flat()
    .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0) || a.id - b.id);
  const auditEventsTruncated = auditRows.length > MAX_AUDIT_EVENTS;
  const auditEvents = auditRows.slice(0, MAX_AUDIT_EVENTS).map(row => ({
    action: row.action,
    entityType: row.entityType,
    at: row.createdAt.toISOString(),
    sequenceNumber: row.sequenceNumber,
    signed: Boolean(row.signed),
  }));

  return {
    schemaVersion: "governed-control-evidence-pack-v1",
    state: (issues.size === 0 ? "reconstructable" : "evidence_gap") as GovernedControlPackState,
    issues: [...issues].sort(),
    boundary: {
      rawSourceDataIncluded: false,
      sourcePayloadIncluded: false,
      financialDecisionMade: false,
      auditChainVerified: false,
      auditChainVerificationNote: "Use the administrator Audit Trail integrity check for a complete chain verification.",
    },
    admission: {
      controlPeriod: admission.controlPeriod,
      assessedAt: admission.assessedAt,
      admittedAt: job.createdAt.toISOString(),
      sourceContractCount: admission.sourceContractCount,
      batchManifestCount: admission.batchManifestCount,
      reconciliationPolicyVersions: admission.reconciliationPolicyVersions,
    },
    sourceEvidence,
    run: {
      status: job.status,
      startedAt: safeTime(job.startedAt),
      completedAt: safeTime(job.completedAt),
      totals: {
        sourceRecords: job.totalSourceTxns,
        targetRecords: job.totalTargetTxns,
        matchedRecords: job.matchedCount,
        exceptionRecords: job.exceptionCount,
        unmatchedRecords: job.unmatchedCount,
      },
      conclusion: "This pack records run evidence only; it does not publish a control conclusion or resolve an exception.",
    },
    processing: { events: progress, truncated: progressTruncated },
    governedExceptionWorkflow: {
      statusCounts: materialWorkflowStatusCounts,
      events: workflowEvents,
      truncated: workflowEventsTruncated,
    },
    auditEvidence: {
      events: auditEvents,
      truncated: auditEventsTruncated,
      integrityVerified: false,
    },
  };
}
