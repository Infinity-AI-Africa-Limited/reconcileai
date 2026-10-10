import { describe, expect, it } from "vitest";
import {
  GovernedPopulationError,
  governedAdmissionPlan,
  governedSidesOf,
  populationReasons,
  type PopulationSummary,
} from "./controlRunAdmission";
import type { PersistedControlRunAssessment } from "./controlRunReadiness";

type Binding = PersistedControlRunAssessment["sourceContractBindings"][number];

const settlement = (overrides: Partial<Binding> = {}): Binding => ({
  id: 11,
  sourceKey: "switch-settlement",
  role: "settlement",
  version: 1,
  channelId: 101,
  timeZone: "Africa/Lagos",
  manifestId: 701,
  uploadBatchId: 901,
  ...overrides,
});

const register = (overrides: Partial<Binding> = {}): Binding => ({
  id: 12,
  sourceKey: "internal-settlement-register",
  role: "internal_register",
  version: 1,
  channelId: 102,
  timeZone: "Africa/Lagos",
  manifestId: 702,
  uploadBatchId: 902,
  ...overrides,
});

function assessment(
  overrides: Partial<PersistedControlRunAssessment> = {}
): PersistedControlRunAssessment {
  return {
    organizationId: 42,
    controlPeriod: "2026-10-10",
    evaluatedAt: new Date("2026-10-10T18:05:00.000Z"),
    status: "ready_to_reconcile",
    canReconcile: true,
    mayPublishMatchRate: true,
    reasons: [],
    persistenceReasons: [],
    sourceAssessments: [],
    sourceContractCount: 2,
    batchManifestCount: 2,
    reconciliationPolicyVersions: ["settlement-ledger-v1"],
    sourceContractBindings: [settlement(), register()],
    ...overrides,
  };
}

function reasonsOf(input: PersistedControlRunAssessment) {
  const plan = governedAdmissionPlan(input);
  return plan.ok ? [] : plan.reasons;
}

describe("when the day's evidence is ready and bound to one batch per side", () => {
  it("should admit it, deriving the channels, the business day and the exact batches", () => {
    const plan = governedAdmissionPlan(assessment());

    expect(plan).toEqual({
      ok: true,
      admission: {
        controlPeriod: "2026-10-10",
        assessedAt: "2026-10-10T18:05:00.000Z",
        sourceChannelId: 101,
        targetChannelId: 102,
        dateFrom: new Date("2026-10-09T23:00:00.000Z"),
        dateTo: new Date("2026-10-10T22:59:59.999Z"),
        sourceContractCount: 2,
        batchManifestCount: 2,
        reconciliationPolicyVersions: ["settlement-ledger-v1"],
        settlement: { channelId: 101, manifestId: 701, uploadBatchId: 901 },
        register: { channelId: 102, manifestId: 702, uploadBatchId: 902 },
      },
    });
  });
});

describe("when the evidence is not ready", () => {
  it.each(["awaiting_sources", "incomplete", "blocked"] as const)(
    "should refuse a %s day",
    status => {
      expect(reasonsOf(assessment({ status, canReconcile: false }))).toContain("evidence_not_ready");
    }
  );

  it("should refuse a ready label that does not grant reconciliation", () => {
    expect(reasonsOf(assessment({ canReconcile: false }))).toContain("evidence_not_ready");
  });
});

describe("when the evidence is ready but admission's own rules are not met", () => {
  // Each of these is "ready" to the completeness policy and still inadmissible:
  // the cases the Daily Control Start button used to enable and then fail.
  it.each<[string, Binding[], string]>([
    ["only a settlement source", [settlement()], "internal_register_source_count"],
    ["two settlement sources", [settlement(), settlement({ id: 13 }), register()], "settlement_source_count"],
    ["two register sources", [settlement(), register(), register({ id: 14 })], "internal_register_source_count"],
    ["a source with no channel", [settlement({ channelId: null }), register()], "unmapped_channel"],
    ["both sides on one channel", [settlement(), register({ channelId: 101 })], "same_channel"],
    ["two time zones", [settlement(), register({ timeZone: "Africa/Nairobi" })], "mixed_time_zones"],
    ["a manifest with no upload batch", [settlement({ uploadBatchId: null }), register()], "manifest_without_upload_batch"],
    ["no manifest at all", [settlement(), register({ manifestId: null, uploadBatchId: null })], "manifest_without_upload_batch"],
  ])("should refuse %s", (_label, bindings, reason) => {
    expect(reasonsOf(assessment({ sourceContractBindings: bindings }))).toContain(reason);
  });

  it("should refuse a business day the zone cannot resolve", () => {
    const bindings = [settlement({ timeZone: "Not/AZone" }), register({ timeZone: "Not/AZone" })];
    expect(reasonsOf(assessment({ sourceContractBindings: bindings }))).toContain(
      "invalid_business_day_window"
    );
  });

  it("should allow an optional bank or GL source beside the governed pair", () => {
    const bank = settlement({ id: 15, role: "bank_or_gl", channelId: 103, manifestId: 703, uploadBatchId: 903 });
    expect(governedAdmissionPlan(assessment({ sourceContractBindings: [settlement(), register(), bank] })).ok).toBe(true);
  });
});

describe("when a batch's rows are compared with the manifest that approved them", () => {
  const manifest = { receivedRecordCount: 2, receivedMonetaryTotal: "1250.10", receivedCurrency: "NGN" };
  const agreeing: PopulationSummary = {
    rowCount: 2,
    offChannelCount: 0,
    notUnmatchedCount: 0,
    currencies: ["NGN"],
    total: "1250.10",
  };

  it("should accept the exact population, comparing money as exact decimals", () => {
    expect(populationReasons(agreeing, manifest)).toEqual([]);
    expect(populationReasons({ ...agreeing, total: "1250.1" }, manifest)).toEqual([]);
  });

  it.each<[string, Partial<PopulationSummary>, string]>([
    ["a row on another channel or tenant", { offChannelCount: 1 }, "population_off_channel"],
    ["a row already matched", { notUnmatchedCount: 1 }, "population_not_unmatched"],
    ["a row in another currency", { currencies: ["NGN", "USD"] }, "population_currency_mismatch"],
    ["a row added after the manifest", { rowCount: 3 }, "population_count_mismatch"],
    ["a total a kobo out", { total: "1250.11" }, "population_total_mismatch"],
    ["an empty batch against a non-zero manifest", { rowCount: 0, total: null, currencies: [] }, "population_total_mismatch"],
  ])("should refuse %s", (_label, change, reason) => {
    expect(populationReasons({ ...agreeing, ...change }, manifest)).toContain(reason);
  });
});

describe("when the worker reads a job's governed snapshot", () => {
  const run = { sourceChannelId: 101, targetChannelId: 102 };
  const governed = {
    governedDailyControl: {
      settlement: { channelId: 101, manifestId: 701, uploadBatchId: 901 },
      register: { channelId: 102, manifestId: 702, uploadBatchId: 902 },
    },
  };

  it("should return null for an ordinary job, which keeps its date window", () => {
    expect(governedSidesOf(JSON.stringify({ amountTolerance: 0.01 }), run)).toBeNull();
    expect(governedSidesOf(null, run)).toBeNull();
  });

  it("should read the sides whether the column comes back as text or parsed", () => {
    const expected = { settlement: governed.governedDailyControl.settlement, register: governed.governedDailyControl.register };
    expect(governedSidesOf(JSON.stringify(governed), run)).toEqual(expected);
    expect(governedSidesOf(governed, run)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["unreadable text", "{not json"],
    ["a governed marker with no sides", { governedDailyControl: {} }],
    ["sides naming other channels than the run", {
      governedDailyControl: { ...governed.governedDailyControl, settlement: { channelId: 999, manifestId: 701, uploadBatchId: 901 } },
    }],
  ])("should refuse %s rather than fall back to the date window", (_label, config) => {
    expect(() => governedSidesOf(config, run)).toThrow(GovernedPopulationError);
  });
});
