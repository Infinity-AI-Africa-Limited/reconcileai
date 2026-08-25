import { describe, expect, it } from "vitest";
import { requirePilotManager } from "./routers/corporateB2BPilot";
import {
  calculateCorporateB2BPilotReadiness,
  type PilotReadinessConfig,
  type PilotReadinessSource,
} from "./corporateB2BPilotReadiness";

// Typed against the schema rather than left to inference, so a renamed column
// or a widened status enum fails here instead of passing through an `any`.
const approvedConfig: PilotReadinessConfig = {
  noWriteAcknowledged: true,
  pilotScope: "Distributor receipts against approved invoices",
  dataContractStatus: "approved",
  rosterStatus: "approved",
  allocationPolicyStatus: "approved",
  dailyCloseOwner: "Finance Controller",
  aiAssistanceMode: "disabled",
  aiBoundaryReference: null,
  operationalRecoveryStatus: "passed",
  retentionDays: 90,
  contractStatus: "approved",
  dataProcessingStatus: "approved",
  contractReference: "SOW-001",
  dataProcessingReference: "DPA-001",
};

const twoGoodSources: PilotReadinessSource[] = [
  { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
  { sourceType: "bank_statement", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
];

describe("Corporate B2B pilot readiness", () => {
  it("allows a CFO to manage audited pilot controls while retaining the explicit role boundary", () => {
    expect(() => requirePilotManager("cfo")).not.toThrow();
    expect(() => requirePilotManager("admin")).not.toThrow();
    expect(() => requirePilotManager("super_admin")).not.toThrow();
    expect(() => requirePilotManager("operations")).toThrow(/Only a CFO, administrator, or Infinity AI staff member/);
  });

  it("recognises the merged and proven P1–P7 foundation release while retaining all tenant evidence gates", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: approvedConfig,
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "bank_statement", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
      ],
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.gates.filter((gate) => !gate.ready).map((gate) => gate.id)).toEqual([]);
    expect(readiness.canStartReadOnlyPilot).toBe(true);
  });

  it("rejects a source route that lacks a customer-owned credential or control total", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: approvedConfig,
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "bank_statement", status: "tested", customerOwnedCredentials: false, controlTotalRequired: true },
      ],
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B1");
    expect(readiness.blockedBy).toContain("B2");
  });

  it("keeps unconfirmed distributor identities from passing B3", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: approvedConfig,
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "mobile_money", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
      ],
      roster: { total: 10, pending: 1, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B3");
  });

  it("requires an evidence reference before private AI assistance is permitted", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: { ...approvedConfig, aiAssistanceMode: "private_approved", aiBoundaryReference: "" },
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "bank_statement", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
      ],
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B5");
  });
});

describe("when evidence is only whitespace", () => {
  // A gate is the record that a control EXISTS. `Boolean(" ")` is true, so a
  // space bar satisfied B0, B4 and B8 and the workspace showed green gates for
  // evidence nobody had supplied — the precise failure a readiness register is
  // there to prevent. B5 was not raised in review but failed the same way.
  const blank = "   ";

  it("should not accept a blank pilot scope as the read-only boundary (B0)", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: { ...approvedConfig, pilotScope: blank },
      sources: twoGoodSources,
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B0");
    expect(readiness.canStartReadOnlyPilot).toBe(false);
  });

  it("should not accept a blank daily-close owner (B4)", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: { ...approvedConfig, dailyCloseOwner: blank },
      sources: twoGoodSources,
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B4");
  });

  it("should not accept blank contract or data-processing references (B8)", () => {
    for (const field of ["contractReference", "dataProcessingReference"] as const) {
      const readiness = calculateCorporateB2BPilotReadiness({
        config: { ...approvedConfig, [field]: blank },
        sources: twoGoodSources,
        roster: { total: 10, pending: 0, flagged: 0 },
      });
      expect(readiness.blockedBy, `${field} blank must block B8`).toContain("B8");
    }
  });

  it("should not accept a blank AI boundary reference for a private approved route (B5)", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: { ...approvedConfig, aiAssistanceMode: "private_approved", aiBoundaryReference: blank },
      sources: twoGoodSources,
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toContain("B5");
  });

  it("should still pass every gate when the same evidence is real", () => {
    // The control: these tests must fail because the value is blank, not
    // because the fixture drifted into being unreadable.
    const readiness = calculateCorporateB2BPilotReadiness({
      config: approvedConfig,
      sources: twoGoodSources,
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.blockedBy).toEqual([]);
    expect(readiness.canStartReadOnlyPilot).toBe(true);
  });
});
