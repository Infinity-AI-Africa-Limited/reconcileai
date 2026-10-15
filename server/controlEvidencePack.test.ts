import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));

import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";
import { buildGovernedControlEvidencePack, governedAdmissionOf } from "./controlEvidencePack";

const organizationId = 42;
const job = {
  id: 91,
  organizationId,
  engineConfig: JSON.stringify({
    governedDailyControl: {
      controlPeriod: "2026-10-09",
      assessedAt: "2026-10-10T08:00:00.000Z",
      sourceContractCount: 2,
      batchManifestCount: 2,
      reconciliationPolicyVersions: ["settlement-ledger-v1"],
      settlement: { channelId: 11, manifestId: 701, uploadBatchId: 901 },
      register: { channelId: 12, manifestId: 702, uploadBatchId: 902 },
    },
  }),
  sourceChannelId: 11,
  targetChannelId: 12,
  status: "completed",
  createdAt: new Date("2026-10-10T08:01:00.000Z"),
  startedAt: new Date("2026-10-10T08:02:00.000Z"),
  completedAt: new Date("2026-10-10T08:03:00.000Z"),
  totalSourceTxns: 2,
  totalTargetTxns: 2,
  matchedCount: 1,
  exceptionCount: 2,
  unmatchedCount: 0,
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 701,
  sourceContractId: 501,
  sourceContractVersion: 1,
  controlPeriod: "2026-10-09",
  uploadBatchId: 901,
  receivedAt: new Date("2026-10-09T20:00:00.000Z"),
  mappingVersion: "mapping-v1",
  reconciliationPolicyVersion: "settlement-ledger-v1",
  schemaState: "accepted",
  duplicateDelivery: "none",
  invalidRowCount: 0,
  receivedRecordCount: 2,
  role: "settlement",
  channelId: 11,
  contractVersion: 1,
  ...overrides,
});

type AuditsByKind = { job?: unknown[]; manifests?: unknown[]; contracts?: unknown[]; workflows?: unknown[] };
const audit = (sequenceNumber: number, entityType: string, action = "recorded") => ({
  id: sequenceNumber,
  action,
  entityType,
  createdAt: new Date("2026-10-10T08:00:00.000Z"),
  sequenceNumber,
  signed: `h${sequenceNumber}`,
});

type EvidenceJobRow = typeof job;

/**
 * `run` is the job row as the pack reads it INSIDE its snapshot; pass `[]`
 * for a run that is gone by then. It defaults to the row the router read.
 */
function evidenceDb(options: { run?: EvidenceJobRow | []; manifests?: unknown[]; progress?: unknown[]; workflowEvents?: unknown[]; workflowStates?: unknown[]; audits?: AuditsByKind } = {}) {
  const run = options.run ?? job;
  const fake = scriptedDb({
    select: {
      reconciliation_jobs: [Array.isArray(run) ? run : [run]],
      control_batch_manifests: [options.manifests ?? [manifest(), manifest({ id: 702, sourceContractId: 502, uploadBatchId: 902, role: "internal_register", channelId: 12 })]],
      job_progress_events: [options.progress ?? [{ phase: "completed", progress: 100, createdAt: new Date("2026-10-10T08:03:00.000Z") }]],
      exception_workflow_events: [options.workflowEvents ?? [{ eventType: "decision_approved", outcome: null, createdAt: new Date("2026-10-10T08:04:00.000Z") }]],
      exception_workflows: [options.workflowStates ?? [{ status: "approved", count: 1 }]],
      // One read per kind of record, in this order: the job, its manifests,
      // their source contracts, then the job's governed workflows.
      audit_logs: [
        options.audits?.job ?? [audit(31, "reconciliation_job", "create_governed_daily_control_run")],
        options.audits?.manifests ?? [audit(30, "control_batch_manifest", "control_batch_manifest_recorded")],
        options.audits?.contracts ?? [audit(5, "control_source_contract", "control_source_contract_recorded")],
        options.audits?.workflows ?? [audit(40, "exception_workflow", "exception_workflow_started")],
      ],
    },
  });
  state.db = fake.db;
  return fake;
}

beforeEach(() => {
  state.db = null;
});

describe("when a governed admission snapshot is read", () => {
  it("should accept only a complete two-source governed snapshot", () => {
    expect(governedAdmissionOf(job.engineConfig)).toMatchObject({
      controlPeriod: "2026-10-09",
      settlement: { manifestId: 701 },
      register: { manifestId: 702 },
    });
  });

  it.each([
    ["unparseable JSON", "{"],
    ["a caller-chosen date", JSON.stringify({ governedDailyControl: { controlPeriod: "not-a-day" } })],
    ["a partial evidence set", JSON.stringify({ governedDailyControl: { controlPeriod: "2026-10-09", assessedAt: "2026-10-10T08:00:00Z", sourceContractCount: 1, batchManifestCount: 1, reconciliationPolicyVersions: ["v1"], settlement: { channelId: 1, manifestId: 1, uploadBatchId: 1 }, register: { channelId: 2, manifestId: 2, uploadBatchId: 2 } } })],
    ["the same batch on both sides", JSON.stringify({ governedDailyControl: { controlPeriod: "2026-10-09", assessedAt: "2026-10-10T08:00:00Z", sourceContractCount: 2, batchManifestCount: 2, reconciliationPolicyVersions: ["v1"], settlement: { channelId: 1, manifestId: 1, uploadBatchId: 1 }, register: { channelId: 2, manifestId: 2, uploadBatchId: 1 } } })],
  ])("should refuse %s", (_label, config) => {
    expect(governedAdmissionOf(config)).toBeNull();
  });
});

describe("when an eligible reader opens a governed evidence pack", () => {
  it("should reconstruct bounded non-payload evidence from tenant-scoped rows", async () => {
    const fake = evidenceDb();

    const result = await buildGovernedControlEvidencePack(job);

    expect(result).toMatchObject({
      schemaVersion: "governed-control-evidence-pack-v1",
      state: "reconstructable",
      issues: [],
      boundary: {
        rawSourceDataIncluded: false,
        sourcePayloadIncluded: false,
        financialDecisionMade: false,
        auditChainVerified: false,
      },
      admission: { controlPeriod: "2026-10-09", sourceContractCount: 2, batchManifestCount: 2 },
      run: { status: "completed", totals: { matchedRecords: 1, exceptionRecords: 2 } },
      governedExceptionWorkflow: { statusCounts: { approved: 1 } },
    });
    expect(result.sourceEvidence).toEqual([
      expect.objectContaining({ role: "settlement", verified: true, mappingVersion: "mapping-v1" }),
      expect.objectContaining({ role: "internal_register", verified: true, mappingVersion: "mapping-v1" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("sourceKey");
    expect(JSON.stringify(result)).not.toContain("deliveryIdentity");
    expect(JSON.stringify(result)).not.toContain("ipAddress");
    expect(JSON.stringify(result)).not.toContain("userAgent");

    const manifestRead = fake.ops.find(op => op.kind === "select" && op.table === "control_batch_manifests");
    expect(manifestRead?.where?.params).toEqual(expect.arrayContaining([organizationId, 701, 702]));
    const workflowRead = fake.ops.find(op => op.kind === "select" && op.table === "exception_workflow_events");
    expect(workflowRead?.where?.params).toEqual(expect.arrayContaining([organizationId, job.id]));
    // Four bounded audit reads, each this tenant's and each on one kind of record.
    const auditReads = fake.ops.filter(op => op.kind === "select" && op.table === "audit_logs");
    expect(auditReads).toHaveLength(4);
    for (const read of auditReads) {
      expect(read.where?.params).toContain(organizationId);
      expect(read.limit).toBe(21);
    }
    expect(auditReads[0].where?.params).toEqual(expect.arrayContaining(["reconciliation_job", job.id]));
    expect(auditReads[1].where?.params).toEqual(expect.arrayContaining(["control_batch_manifest", 701, 702]));
    expect(auditReads[2].where?.params).toEqual(expect.arrayContaining(["control_source_contract", 501, 502]));
    expect(auditReads[3].where?.params).toEqual(expect.arrayContaining(["exception_workflow", job.id]));
    // No OR across kinds: that shape let the optimizer walk the whole chain.
    for (const read of auditReads) expect(read.where?.sql).not.toMatch(/\bor\b/i);
    expect(result.auditEvidence.events.map(event => event.sequenceNumber)).toEqual([5, 30, 31, 40]);

    // Every read is one snapshot: the same transaction, so the pack never
    // mixes states from before and after a concurrent change.
    const reads = fake.ops.filter(op => op.kind === "select");
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map(op => op.txId)).size).toBe(1);
    expect(reads[0].txId).not.toBeNull();
    const workflowCountRead = fake.ops.find(op => op.kind === "select" && op.table === "exception_workflows");
    expect(workflowCountRead?.fields).toEqual(expect.arrayContaining(["status", "count"]));
    expect(fake.writes("insert", "audit_logs")).toHaveLength(0);
  });

  it("should report evidence gaps instead of reconstructing a plausible pass", async () => {
    evidenceDb({
      manifests: [
        manifest({ schemaState: "unknown", invalidRowCount: 3, duplicateDelivery: "rejected" }),
        manifest({ id: 702, sourceContractId: 502, uploadBatchId: 903, role: "settlement", channelId: 999, contractVersion: 2, reconciliationPolicyVersion: "unexpected-v9" }),
      ],
    });

    const result = await buildGovernedControlEvidencePack(job);

    expect(result.state).toBe("evidence_gap");
    expect(result.issues).toEqual(expect.arrayContaining([
      "manifest_not_accepted",
      "manifest_has_invalid_rows",
      "manifest_duplicate_delivery",
      "source_contract_channel_mismatch",
      "source_contract_role_mismatch",
      "source_contract_version_mismatch",
      "manifest_batch_mismatch",
      "manifest_policy_version_mismatch",
    ]));
    expect(result.sourceEvidence.every(source => source.verified === false)).toBe(true);
  });

  it("should report a run that reconciled channels other than the admitted ones", async () => {
    const run = { ...job, sourceChannelId: 99 };
    evidenceDb({ run });

    const result = await buildGovernedControlEvidencePack(run);

    expect(result.state).toBe("evidence_gap");
    expect(result.issues).toEqual(["run_channel_mismatch"]);
  });

  it("should report a completed run whose record counts differ from the admitted manifests'", async () => {
    const run = { ...job, totalSourceTxns: 3 };
    evidenceDb({ run });

    const result = await buildGovernedControlEvidencePack(run);

    expect(result.state).toBe("evidence_gap");
    expect(result.issues).toEqual(["run_population_mismatch"]);
    expect(result.sourceEvidence).toEqual([
      expect.objectContaining({ role: "settlement", receivedRecords: 2, verified: false }),
      expect.objectContaining({ role: "internal_register", receivedRecords: 2, verified: true }),
    ]);
  });

  it("should not compare counts for a run that did not complete, since it recorded none", async () => {
    const run = { ...job, status: "failed", totalSourceTxns: 0, totalTargetTxns: 0 };
    evidenceDb({ run });

    const result = await buildGovernedControlEvidencePack(run);

    expect(result.state).toBe("reconstructable");
    expect(result.issues).toEqual([]);
  });

  it("should list the earliest audit references across every kind, and say when there are more", async () => {
    // 15 job references and 10 workflow references: 25 in all, the first 20
    // by sequence shown, whichever kind each came from.
    const jobAudits = Array.from({ length: 15 }, (_, i) => audit(100 + i * 2, "reconciliation_job"));
    const workflowAudits = Array.from({ length: 10 }, (_, i) => audit(101 + i * 2, "exception_workflow"));
    evidenceDb({ audits: { job: jobAudits, manifests: [], contracts: [], workflows: workflowAudits } });

    const result = await buildGovernedControlEvidencePack(job);

    const shown = result.auditEvidence.events.map(event => event.sequenceNumber);
    expect(shown).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(result.auditEvidence.truncated).toBe(true);
  });

  it("should not call the audit list truncated when exactly the cap fits", async () => {
    // 12 + 8 = 20 references: all shown, and nothing hidden.
    const jobAudits = Array.from({ length: 12 }, (_, i) => audit(1 + i, "reconciliation_job"));
    const workflowAudits = Array.from({ length: 8 }, (_, i) => audit(50 + i, "exception_workflow"));
    evidenceDb({ audits: { job: jobAudits, manifests: [], contracts: [], workflows: workflowAudits } });

    const result = await buildGovernedControlEvidencePack(job);

    expect(result.auditEvidence.events).toHaveLength(20);
    expect(result.auditEvidence.truncated).toBe(false);
  });

  it("should read the run's own row first, inside the snapshot, within the authorised tenant", async () => {
    const fake = evidenceDb();

    await buildGovernedControlEvidencePack(job);

    const reads = fake.ops.filter(op => op.kind === "select");
    expect(reads[0].table).toBe("reconciliation_jobs");
    expect(reads[0].where?.params).toEqual(expect.arrayContaining([job.id, organizationId]));
    expect(reads[0].txId).not.toBeNull();
    expect(new Set(reads.map(op => op.txId)).size).toBe(1);
  });

  it("should report the run as the snapshot found it, not as the router read it", async () => {
    // Greptile (#198): the router's row predates the snapshot. A run that
    // finished in between must not show as running beside its completion
    // records.
    evidenceDb({ run: job });

    const result = await buildGovernedControlEvidencePack({
      ...job,
      status: "running",
      completedAt: null,
      totalSourceTxns: 0,
      totalTargetTxns: 0,
    });

    expect(result.run).toMatchObject({ status: "completed", totals: { sourceRecords: 2, targetRecords: 2 } });
    expect(result.run.completedAt).toBe(job.completedAt.toISOString());
    expect(result.issues).toEqual([]);
  });

  it("should answer not found when the run is gone by the time the snapshot starts", async () => {
    const fake = evidenceDb({ run: [] });

    await expect(buildGovernedControlEvidencePack(job)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.ops.filter(op => op.kind === "select").map(op => op.table)).toEqual(["reconciliation_jobs"]);
  });

  it("should refuse an ordinary or legacy job rather than returning another run's records", async () => {
    await expect(buildGovernedControlEvidencePack({ ...job, engineConfig: "{}" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(buildGovernedControlEvidencePack({ ...job, organizationId: null })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
