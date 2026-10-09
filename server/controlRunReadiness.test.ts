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

/** Assess a different business day, or at a different clock, than the default. */
function assessOn(options: {
  controlPeriod: string;
  evaluatedAt: Date;
  sourceContracts: PersistedSourceContract[];
  batchManifests?: PersistedBatchManifest[];
}) {
  return assessPersistedControlEvidence({
    organizationId,
    controlPeriod: options.controlPeriod,
    evaluatedAt: options.evaluatedAt,
    sourceContracts: options.sourceContracts,
    batchManifests: options.batchManifests ?? [],
  });
}

describe("when a source contract took effect after the day being assessed", () => {
  // Lagos is UTC+1 year round, so a 18:00 local cut-off on the 8th is
  // 2026-10-08T17:00:00Z. The day is assessed on the 10th.
  const EIGHTH = "2026-10-08";
  const ON_THE_TENTH = new Date("2026-10-10T09:00:00.000Z");
  const cutoffOnTheEighth = new Date("2026-10-08T17:00:00.000Z");

  it("should not require a source that did not exist at that day's cut-off", () => {
    // Keyed on the clock instead of the day, this source counted as required
    // for the 8th — and no manifest for the 8th can ever exist for a source
    // that began on the 9th, so the day was blocked for good.
    const established = contract({
      id: 41,
      sourceKey: "switch-settlement",
      effectiveAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    const brandNew = contract({
      id: 42,
      sourceKey: "new-register",
      role: "internal_register",
      effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
    });

    const result = assessOn({
      controlPeriod: EIGHTH,
      evaluatedAt: ON_THE_TENTH,
      sourceContracts: [established, brandNew],
      batchManifests: [
        manifest({
          controlPeriod: EIGHTH,
          receivedAt: new Date("2026-10-08T16:45:00.000Z"),
        }),
      ],
    });

    expect(result.sourceContractCount).toBe(1);
    expect(result.sourceAssessments.map(source => source.sourceKey)).toEqual([
      "switch-settlement",
    ]);
    expect(result.persistenceReasons).toEqual([]);
    expect(result.status).toBe("ready_to_reconcile");
  });

  it("should still require a source that took effect during that day, before its cut-off", () => {
    const sameDay = contract({
      effectiveAt: new Date("2026-10-08T06:00:00.000Z"),
    });

    const result = assessOn({
      controlPeriod: EIGHTH,
      evaluatedAt: ON_THE_TENTH,
      sourceContracts: [sameDay],
    });

    expect(result.sourceContractCount).toBe(1);
    expect(result.status).toBe("blocked");
    expect(result.persistenceReasons).not.toContain(
      "no_eligible_source_contracts"
    );
  });

  it("should treat the day's cut-off as the boundary, to the minute", () => {
    const atTheCutoff = contract({ effectiveAt: cutoffOnTheEighth });
    const justAfter = contract({
      effectiveAt: new Date(cutoffOnTheEighth.getTime() + 60_000),
    });

    expect(
      assessOn({
        controlPeriod: EIGHTH,
        evaluatedAt: ON_THE_TENTH,
        sourceContracts: [atTheCutoff],
      }).sourceContractCount
    ).toBe(1);
    expect(
      assessOn({
        controlPeriod: EIGHTH,
        evaluatedAt: ON_THE_TENTH,
        sourceContracts: [justAfter],
      }).sourceContractCount
    ).toBe(0);
  });

  it("should not read a superseding version as ambiguous while it is not yet in effect", () => {
    // v2 begins on the 9th. For the 8th there is exactly one contract for this
    // source key, so the day is not ambiguous — it was, when eligibility was
    // judged by the clock.
    const v1 = contract({
      id: 41,
      version: 1,
      effectiveAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    const v2 = contract({
      id: 42,
      version: 2,
      effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
    });

    const result = assessOn({
      controlPeriod: EIGHTH,
      evaluatedAt: ON_THE_TENTH,
      sourceContracts: [v1, v2],
    });

    expect(result.persistenceReasons).not.toContain("ambiguous_source_contract");
    expect(result.sourceContractCount).toBe(1);
  });

  it("should ignore an excluded source's own manifest rather than let it block the day", () => {
    // The query over-fetches around the day boundary on purpose, and recording
    // a manifest does not check that its contract was in effect for the period
    // — so an October-9 source can hold an October-8 manifest. Counting that
    // manifest raised mixed_reconciliation_policy_version and blocked a day
    // that was otherwise ready: the same false, unclearable block by a second
    // route.
    const established = contract({
      id: 41,
      sourceKey: "switch-settlement",
      effectiveAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    const notYetInEffect = contract({
      id: 42,
      sourceKey: "new-register",
      role: "internal_register",
      effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
    });

    const result = assessOn({
      controlPeriod: EIGHTH,
      evaluatedAt: ON_THE_TENTH,
      sourceContracts: [established, notYetInEffect],
      batchManifests: [
        manifest({
          id: 71,
          sourceContractId: 41,
          controlPeriod: EIGHTH,
          receivedAt: new Date("2026-10-08T16:45:00.000Z"),
        }),
        manifest({
          id: 72,
          sourceContractId: 42,
          controlPeriod: EIGHTH,
          deliveryIdentity: "new-register-2026-10-08-v1",
          receivedAt: new Date("2026-10-08T16:50:00.000Z"),
          reconciliationPolicyVersion: "register-ledger-v9",
        }),
      ],
    });

    expect(result.persistenceReasons).not.toContain(
      "mixed_reconciliation_policy_version"
    );
    expect(result.persistenceReasons).toEqual([]);
    // The count reports the evidence this day is judged on, not what was read.
    expect(result.batchManifestCount).toBe(1);
    expect(result.status).toBe("ready_to_reconcile");
  });

  it("should keep a contract whose cut-off cannot be resolved, so the misconfiguration is still reported", () => {
    // Fails open: dropping it would turn a misconfigured source into a
    // silently absent one, which is the opposite of what a control wants.
    const unresolvable = contract({
      timeZone: "not/a-zone",
      effectiveAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const result = assessOn({
      controlPeriod: EIGHTH,
      evaluatedAt: ON_THE_TENTH,
      sourceContracts: [unresolvable],
    });

    expect(result.sourceContractCount).toBe(1);
    expect(result.persistenceReasons).toContain("invalid_source_cutoff");
    expect(result.status).toBe("blocked");
  });
});

describe("when a source cut-off falls in a daylight-saving transition", () => {
  // America/New_York, verified against Intl: the 2026 transitions are
  // 2026-03-08T07:00Z (−5 → −4) and 2026-11-01T06:00Z (−4 → −5).
  const NEW_YORK = "America/New_York";
  const newYorkContract = (overrides: Partial<PersistedSourceContract> = {}) =>
    contract({
      timeZone: NEW_YORK,
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    });

  it("should block a local cut-off that the spring change skips over", () => {
    // 02:30 never happens on 2026-03-08: the clocks jump 02:00 to 03:00. There
    // is no instant to judge a deadline against, so guessing one is not an
    // option a control may take.
    const result = assessOn({
      controlPeriod: "2026-03-08",
      evaluatedAt: new Date("2026-03-08T12:00:00.000Z"),
      sourceContracts: [newYorkContract({ cutoffMinutes: 150 })],
    });

    expect(result.persistenceReasons).toContain("invalid_source_cutoff");
    expect(result.status).toBe("blocked");
    expect(result.canReconcile).toBe(false);
  });

  it("should block a local cut-off that the autumn change repeats", () => {
    // 01:30 happens twice on 2026-11-01, at 05:30Z and again at 06:30Z. An
    // ambiguous deadline would make "late" depend on which one was meant.
    const result = assessOn({
      controlPeriod: "2026-11-01",
      evaluatedAt: new Date("2026-11-01T12:00:00.000Z"),
      sourceContracts: [newYorkContract({ cutoffMinutes: 90 })],
    });

    expect(result.persistenceReasons).toContain("invalid_source_cutoff");
    expect(result.status).toBe("blocked");
    expect(result.canReconcile).toBe(false);
  });

  it("should resolve a normal cut-off beside the change to the right UTC instant", () => {
    // 04:00 on 2026-03-08 is unambiguous and, after the change, EDT: 08:00Z.
    // Receipts a minute either side pin the conversion to the minute.
    const onTime = assessOn({
      controlPeriod: "2026-03-08",
      evaluatedAt: new Date("2026-03-08T12:00:00.000Z"),
      sourceContracts: [newYorkContract({ cutoffMinutes: 240 })],
      batchManifests: [
        manifest({
          controlPeriod: "2026-03-08",
          receivedAt: new Date("2026-03-08T07:59:00.000Z"),
        }),
      ],
    });
    const late = assessOn({
      controlPeriod: "2026-03-08",
      evaluatedAt: new Date("2026-03-08T12:00:00.000Z"),
      sourceContracts: [newYorkContract({ cutoffMinutes: 240 })],
      batchManifests: [
        manifest({
          controlPeriod: "2026-03-08",
          receivedAt: new Date("2026-03-08T08:01:00.000Z"),
        }),
      ],
    });

    expect(onTime.persistenceReasons).toEqual([]);
    expect(onTime.sourceAssessments[0]?.reasons).not.toContain(
      "received_after_cutoff"
    );
    expect(onTime.status).toBe("ready_to_reconcile");
    expect(late.sourceAssessments[0]?.reasons).toContain(
      "received_after_cutoff"
    );
  });

  it("should still resolve a cut-off in a zone that never changes its clocks", () => {
    // The guard must not reject the ordinary case it was written around.
    const result = assessOn({
      controlPeriod: "2026-03-08",
      evaluatedAt: new Date("2026-03-08T18:05:00.000Z"),
      sourceContracts: [
        contract({ effectiveAt: new Date("2026-01-01T00:00:00.000Z") }),
      ],
      batchManifests: [
        manifest({
          controlPeriod: "2026-03-08",
          receivedAt: new Date("2026-03-08T16:45:00.000Z"),
        }),
      ],
    });

    expect(result.persistenceReasons).toEqual([]);
    expect(result.status).toBe("ready_to_reconcile");
  });
});

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
