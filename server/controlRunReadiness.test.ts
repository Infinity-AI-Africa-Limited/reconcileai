import { describe, expect, it } from "vitest";
import {
  assessPersistedControlEvidence,
  type PersistedBatchManifest,
  type PersistedSourceContract,
} from "./controlRunReadiness";

const organizationId = 42;
const period = "2026-10-09";
const evaluatedAt = new Date("2026-10-09T17:05:00.000Z");

function contract(
  overrides: Partial<PersistedSourceContract> = {}
): PersistedSourceContract {
  return {
    id: 41,
    organizationId,
    sourceKey: "switch-settlement",
    version: 1,
    role: "settlement",
    timeZone: "Africa/Lagos",
    cutoffMinutes: 1_080,
    controlTotalRequired: true,
    status: "active",
    effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
    ...overrides,
  };
}

function manifest(
  overrides: Partial<PersistedBatchManifest> = {}
): PersistedBatchManifest {
  return {
    id: 71,
    organizationId,
    sourceContractId: 41,
    sourceContractVersion: 1,
    controlPeriod: period,
    deliveryIdentity: "switch-settlement-2026-10-09-v1",
    receivedAt: new Date("2026-10-09T16:45:00.000Z"),
    mappingVersion: "switch-map-v1",
    reconciliationPolicyVersion: "settlement-ledger-v1",
    schemaState: "accepted",
    duplicateDelivery: "none",
    invalidRowCount: 0,
    expectedRecordCount: 2,
    expectedMonetaryTotal: "1250.10",
    expectedCurrency: "NGN",
    receivedRecordCount: 2,
    receivedMonetaryTotal: "1250.10",
    receivedCurrency: "NGN",
    ...overrides,
  };
}

function assess(
  sourceContracts: PersistedSourceContract[] = [contract()],
  batchManifests: PersistedBatchManifest[] = [manifest()],
  controlPeriod = period
) {
  return assessPersistedControlEvidence({
    organizationId,
    controlPeriod,
    evaluatedAt,
    sourceContracts,
    batchManifests,
  });
}

describe("when persisted control evidence is complete", () => {
  it("should translate approved source and batch evidence into a ready-to-reconcile preflight", () => {
    const result = assess();

    expect(result).toMatchObject({
      status: "ready_to_reconcile",
      canReconcile: true,
      mayPublishMatchRate: true,
      persistenceReasons: [],
      sourceContractCount: 1,
      batchManifestCount: 1,
    });
    expect(result.sourceAssessments[0]).toMatchObject({
      sourceKey: "switch-settlement",
      status: "ready",
    });
  });

  it("should derive the Lagos cut-off from the approved local source contract", () => {
    const result = assess();

    expect(result.sourceAssessments[0]?.status).toBe("ready");
    expect(result.persistenceReasons).not.toContain("invalid_source_cutoff");
  });
});

describe("when evidence is not yet complete", () => {
  it("should block before cut-off when no persisted population total exists", () => {
    const result = assess([contract({ cutoffMinutes: 1_140 })], []);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      persistenceReasons: [],
    });
    expect(result.sourceAssessments[0]?.reasons).toEqual([
      "missing_expected_control_total",
      "source_not_received",
    ]);
  });

  it("should remain blocked after cut-off when no persisted population total exists", () => {
    const result = assess([contract({ cutoffMinutes: 1_020 })], []);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.sourceAssessments[0]?.reasons).toContain(
      "missing_expected_control_total"
    );
  });

  it("should not change evidence assessment into execution", () => {
    const result = assess();

    expect(Object.keys(result)).not.toContain("jobId");
    expect(Object.keys(result)).not.toContain("runId");
    expect(Object.keys(result)).not.toContain("publishedMatchRate");
  });
});

describe("when persisted control evidence is unsafe or ambiguous", () => {
  it("should block a source contract with a malformed time zone", () => {
    const result = assess([contract({ timeZone: "not/a-zone" })]);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.persistenceReasons).toContain("invalid_source_cutoff");
  });

  it("should block an unknown or invalid daily period instead of normalizing it", () => {
    const result = assess(
      [contract()],
      [manifest({ controlPeriod: "2026-10-32" })],
      "2026-10-32"
    );

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.persistenceReasons).toContain("invalid_control_period");
  });

  it("should block multiple eligible contract versions for one source key", () => {
    const result = assess([
      contract(),
      contract({
        id: 42,
        version: 2,
        effectiveAt: new Date("2026-10-09T09:00:00.000Z"),
      }),
    ]);

    expect(result.status).toBe("blocked");
    expect(result.persistenceReasons).toContain("ambiguous_source_contract");
  });

  it("should block multiple admitted batches for a source and control period", () => {
    const result = assess(
      [contract()],
      [
        manifest(),
        manifest({
          id: 72,
          deliveryIdentity: "switch-settlement-2026-10-09-rerun",
        }),
      ]
    );

    expect(result.status).toBe("blocked");
    expect(result.persistenceReasons).toContain("multiple_batch_manifests");
  });

  it("should block evidence recorded against a different source-contract version", () => {
    const result = assess(
      [contract({ version: 2 })],
      [manifest({ sourceContractVersion: 1 })]
    );

    expect(result.status).toBe("blocked");
    expect(result.persistenceReasons).toContain(
      "source_contract_version_mismatch"
    );
  });

  it("should block mixed reconciliation policy versions before a conclusion can be published", () => {
    const register = contract({
      id: 42,
      sourceKey: "internal-settlement-register",
      role: "internal_register",
    });
    const registerManifest = manifest({
      id: 72,
      sourceContractId: 42,
      deliveryIdentity: "register-2026-10-09-v1",
      reconciliationPolicyVersion: "settlement-ledger-v2",
    });

    const result = assess(
      [contract(), register],
      [manifest(), registerManifest]
    );

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.persistenceReasons).toContain(
      "mixed_reconciliation_policy_version"
    );
  });

  it("should block a malformed persisted policy version rather than treating it as unversioned", () => {
    const result = assess(
      [contract()],
      [manifest({ reconciliationPolicyVersion: "  " })]
    );

    expect(result.status).toBe("blocked");
    expect(result.persistenceReasons).toContain(
      "invalid_reconciliation_policy_version"
    );
  });

  it("should block an empty approved-source definition", () => {
    const result = assess([], []);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
    });
    expect(result.persistenceReasons).toContain("no_eligible_source_contracts");
    expect(result.reasons).toContain("no_required_sources");
  });
});
