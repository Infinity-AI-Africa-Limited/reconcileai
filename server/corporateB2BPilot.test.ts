import { describe, expect, it } from "vitest";
import { calculateCorporateB2BPilotReadiness } from "./routers/corporateB2BPilot";

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
  it("fails closed until external B6 foundation evidence exists", () => {
    const readiness = calculateCorporateB2BPilotReadiness({
      config: approvedConfig,
      sources: [
        { sourceType: "invoice_ar", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
        { sourceType: "bank_statement", status: "approved", customerOwnedCredentials: true, controlTotalRequired: true },
      ],
      roster: { total: 10, pending: 0, flagged: 0 },
    });
    expect(readiness.gates.filter((gate) => !gate.ready).map((gate) => gate.id)).toEqual(["B6"]);
    expect(readiness.canStartReadOnlyPilot).toBe(false);
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
