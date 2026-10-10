import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  admissionFromAssessment,
  type GovernedControlAdmission,
} from "./controlRunAdmission";
import type { PersistedControlRunAssessment } from "./controlRunReadiness";

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
    sourceContractBindings: [
      {
        id: 11,
        sourceKey: "switch-settlement",
        role: "settlement",
        version: 1,
        channelId: 101,
        timeZone: "Africa/Lagos",
      },
      {
        id: 12,
        sourceKey: "internal-settlement-register",
        role: "internal_register",
        version: 1,
        channelId: 102,
        timeZone: "Africa/Lagos",
      },
    ],
    ...overrides,
  };
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof TRPCError ? error.code : null;
  }
}

describe("governed daily-control reconciliation admission", () => {
  it("should admit only an explicitly ready persisted assessment", () => {
    const admission: GovernedControlAdmission =
      admissionFromAssessment(assessment());

    expect(admission).toEqual({
      controlPeriod: "2026-10-10",
      assessedAt: "2026-10-10T18:05:00.000Z",
      sourceChannelId: 101,
      targetChannelId: 102,
      dateFrom: new Date("2026-10-09T23:00:00.000Z"),
      dateTo: new Date("2026-10-10T22:59:59.999Z"),
      sourceContractCount: 2,
      batchManifestCount: 2,
      reconciliationPolicyVersions: ["settlement-ledger-v1"],
    });
  });

  it.each(["awaiting_sources", "incomplete", "blocked"] as const)(
    "should refuse a %s assessment",
    status => {
      expect(
        codeOf(() =>
          admissionFromAssessment(
            assessment({
              status,
              canReconcile: false,
              mayPublishMatchRate: false,
            })
          )
        )
      ).toBe("PRECONDITION_FAILED");
    }
  );

  it("should refuse a contradictory ready label without permission", () => {
    expect(
      codeOf(() => admissionFromAssessment(assessment({ canReconcile: false })))
    ).toBe("PRECONDITION_FAILED");
  });

  it("should refuse a ready assessment without one mapped settlement-register pair", () => {
    expect(
      codeOf(() =>
        admissionFromAssessment(
          assessment({
            sourceContractBindings: [
              {
                id: 11,
                sourceKey: "switch-settlement",
                role: "settlement",
                version: 1,
                channelId: 101,
                timeZone: "Africa/Lagos",
              },
            ],
          })
        )
      )
    ).toBe("PRECONDITION_FAILED");
  });

  it("should not return source-level reasons through the admission error", () => {
    try {
      admissionFromAssessment(
        assessment({
          status: "blocked",
          canReconcile: false,
          mayPublishMatchRate: false,
          persistenceReasons: ["invalid_source_cutoff"],
        })
      );
      throw new Error("Expected the admission boundary to refuse");
    } catch (error) {
      expect(error).toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Daily control is not ready for reconciliation.",
      });
    }
  });
});
