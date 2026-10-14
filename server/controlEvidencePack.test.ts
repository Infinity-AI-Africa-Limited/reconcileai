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
  role: "settlement",
  channelId: 11,
  contractVersion: 1,
  ...overrides,
});

function evidenceDb(options: { manifests?: unknown[]; progress?: unknown[]; workflowEvents?: unknown[]; workflowStates?: unknown[]; audits?: unknown[] } = {}) {
  const fake = scriptedDb({
    select: {
      control_batch_manifests: [options.manifests ?? [manifest(), manifest({ id: 702, sourceContractId: 502, uploadBatchId: 902, role: "internal_register", channelId: 12 })]],
      job_progress_events: [options.progress ?? [{ phase: "completed", progress: 100, createdAt: new Date("2026-10-10T08:03:00.000Z") }]],
      exception_workflow_events: [options.workflowEvents ?? [{ eventType: "decision_approved", outcome: null, createdAt: new Date("2026-10-10T08:04:00.000Z") }]],
      exception_workflows: [options.workflowStates ?? [{ status: "approved" }]],
      audit_logs: [options.audits ?? [
        { action: "control_batch_manifest_recorded", entityType: "control_batch_manifest", createdAt: new Date("2026-10-09T20:00:00.000Z"), sequenceNumber: 30, signed: "h1" },
        { action: "create_governed_daily_control_run", entityType: "reconciliation_job", createdAt: new Date("2026-10-10T08:01:00.000Z"), sequenceNumber: 31, signed: "h2" },
      ]],
    },
  });
  state.db = fake.db;
  return fake;
}

beforeEach(() => {
  state.db = null;
});

describe("governed admission snapshots", () => {
  it("accepts only a complete two-source governed snapshot", () => {
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
  ])("refuses %s", (_label, config) => {
    expect(governedAdmissionOf(config)).toBeNull();
  });
});

describe("when an eligible reader opens a governed evidence pack", () => {
  it("reconstructs bounded non-payload evidence from tenant-scoped rows", async () => {
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
    const auditRead = fake.ops.find(op => op.kind === "select" && op.table === "audit_logs");
    expect(auditRead?.where?.params).toEqual(expect.arrayContaining([organizationId, job.id, 701, 702]));
    expect(fake.writes("insert", "audit_logs")).toHaveLength(0);
  });

  it("reports evidence gaps instead of reconstructing a plausible pass", async () => {
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

  it("refuses an ordinary or legacy job rather than returning another run's records", async () => {
    await expect(buildGovernedControlEvidencePack({ ...job, engineConfig: "{}" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(buildGovernedControlEvidencePack({ ...job, organizationId: null })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
