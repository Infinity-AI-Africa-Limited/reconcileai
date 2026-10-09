import { describe, expect, it } from "vitest";
import {
  assessControlRunReadiness,
  type RequiredSourceManifest,
  type ReceivedSourceManifest,
} from "./controlCompleteness";

const NOW = new Date("2026-10-09T17:00:00.000Z");
const CUTOFF = new Date("2026-10-09T16:00:00.000Z");

function received(
  overrides: Partial<ReceivedSourceManifest> = {}
): ReceivedSourceManifest {
  return {
    batchId: "batch-settlement-20261009",
    receivedAt: new Date("2026-10-09T15:55:00.000Z"),
    sourceContractVersion: "settlement-contract-v1",
    mappingVersion: "settlement-map-v1",
    schemaState: "accepted",
    invalidRowCount: 0,
    duplicateDelivery: "none",
    recordCount: 2,
    monetaryTotal: "1250.10",
    currency: "NGN",
    ...overrides,
  };
}

function source(
  overrides: Partial<RequiredSourceManifest> = {}
): RequiredSourceManifest {
  return {
    sourceKey: "processor_settlement",
    role: "settlement",
    required: true,
    cutoffAt: CUTOFF,
    controlTotalRequired: true,
    expected: { recordCount: 2, monetaryTotal: "1250.1", currency: "NGN" },
    received: received(),
    ...overrides,
  };
}

describe("assessControlRunReadiness", () => {
  it("permits reconciliation only when every required source is complete and valid", () => {
    const result = assessControlRunReadiness(
      [
        source(),
        source({
          sourceKey: "internal_settlement_register",
          role: "internal_register",
          received: received({
            batchId: "batch-register-20261009",
            sourceContractVersion: "register-contract-v2",
            mappingVersion: "register-map-v3",
          }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("ready_to_reconcile");
    expect(result.canReconcile).toBe(true);
    expect(result.mayPublishMatchRate).toBe(true);
    expect(
      result.sourceAssessments.every(
        assessment => assessment.status === "ready"
      )
    ).toBe(true);
  });

  it("does not treat a not-yet-due missing source as a completed control", () => {
    const result = assessControlRunReadiness(
      [
        source({
          cutoffAt: new Date("2026-10-09T18:00:00.000Z"),
          received: undefined,
        }),
      ],
      NOW
    );

    expect(result.status).toBe("awaiting_sources");
    expect(result.canReconcile).toBe(false);
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "awaiting_source",
      reasons: ["source_not_received"],
    });
  });

  it("marks a required source missing after cutoff as incomplete and suppresses match-rate publication", () => {
    const result = assessControlRunReadiness(
      [source({ received: undefined })],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.canReconcile).toBe(false);
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "incomplete",
      reasons: ["source_not_received"],
    });
  });

  it("marks a source delivered after its approved cutoff incomplete", () => {
    const result = assessControlRunReadiness(
      [
        source({
          received: received({
            receivedAt: new Date("2026-10-09T16:00:01.000Z"),
          }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.mayPublishMatchRate).toBe(false);
    expect(result.sourceAssessments[0].reasons).toContain(
      "received_after_cutoff"
    );
  });

  it("blocks a rejected schema rather than allowing invalid rows into a routine reconciliation result", () => {
    const result = assessControlRunReadiness(
      [
        source({
          received: received({ schemaState: "rejected", invalidRowCount: 4 }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "blocked",
      reasons: expect.arrayContaining([
        "schema_not_accepted",
        "invalid_rows_present",
      ]),
    });
  });

  it("marks a source-control-total mismatch incomplete rather than calling its population reconciled", () => {
    const result = assessControlRunReadiness(
      [
        source({
          received: received({ recordCount: 3, monetaryTotal: "1249.10" }),
        }),
      ],
      NOW
    );

    expect(result.status).toBe("incomplete");
    expect(result.sourceAssessments[0]).toMatchObject({
      status: "incomplete",
      reasons: expect.arrayContaining([
        "record_count_mismatch",
        "monetary_total_mismatch",
      ]),
    });
  });

  it("allows a recorded deduplicated delivery but fails a delivery the source could not deduplicate", () => {
    const deduplicated = assessControlRunReadiness(
      [source({ received: received({ duplicateDelivery: "deduplicated" }) })],
      NOW
    );
    const rejected = assessControlRunReadiness(
      [source({ received: received({ duplicateDelivery: "rejected" }) })],
      NOW
    );

    expect(deduplicated.status).toBe("ready_to_reconcile");
    expect(deduplicated.sourceAssessments[0].warnings).toEqual([
      "duplicate_delivery_deduplicated",
    ]);
    expect(rejected.status).toBe("blocked");
    expect(rejected.sourceAssessments[0].reasons).toContain(
      "duplicate_delivery_rejected"
    );
  });

  it("does not let an optional third source block a defined two-source daily control", () => {
    const result = assessControlRunReadiness(
      [
        source(),
        source({
          sourceKey: "internal_settlement_register",
          role: "internal_register",
          received: received({ batchId: "batch-register-20261009" }),
        }),
        source({
          sourceKey: "bank_credit_evidence",
          role: "bank_or_gl",
          required: false,
          received: undefined,
        }),
      ],
      NOW
    );

    expect(result.status).toBe("ready_to_reconcile");
    expect(result.sourceAssessments[2].status).toBe("incomplete");
  });

  it("refuses to label an empty control definition ready", () => {
    const result = assessControlRunReadiness([], NOW);

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      reasons: ["no_required_sources"],
    });
  });

  it("fails closed when the evaluation clock is invalid", () => {
    const result = assessControlRunReadiness(
      [source()],
      new Date("not a timestamp")
    );

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      reasons: ["invalid_evaluation_time"],
    });
  });

  it("requires contractual count and value totals for the first control template", () => {
    const result = assessControlRunReadiness(
      [source({ controlTotalRequired: false })],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].reasons).toContain(
      "control_total_not_required"
    );
  });

  it("fails malformed monetary totals closed without relying on floating-point parsing", () => {
    const result = assessControlRunReadiness(
      [source({ received: received({ monetaryTotal: "1,250.10" }) })],
      NOW
    );

    expect(result.status).toBe("blocked");
    expect(result.sourceAssessments[0].reasons).toContain(
      "invalid_control_total"
    );
  });
});
