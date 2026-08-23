import { describe, expect, it } from "vitest";
import { calculateCorporateB2BPilotReadiness, requirePilotManager } from "./routers/corporateB2BPilot";

const approvedConfig = {
  noWriteAcknowledged: true,
  pilotScope: "Distributor receipts against approved invoices",
  dataContractStatus: "approved",
  rosterStatus: "approved",
  allocationPolicyStatus: "approved",
  dailyCloseOwner: "Finance Controller",
  aiAssistanceMode: "disabled",
  operationalRecoveryStatus: "passed",
  retentionDays: 90,
  contractStatus: "approved",
  dataProcessingStatus: "approved",
  contractReference: "SOW-001",
  dataProcessingReference: "DPA-001",
};

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
