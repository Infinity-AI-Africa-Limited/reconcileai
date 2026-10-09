import { describe, expect, it } from "vitest";
import {
  ControlManifestValidationError,
  type ControlBatchManifestInput,
  type ControlSourceContractInput,
  type StoredControlSourceContract,
  validateBatchManifest,
  validateSourceContract,
} from "./controlManifest";

const effectiveAt = new Date("2026-10-09T08:00:00.000Z");
const receivedAt = new Date("2026-10-09T16:45:00.000Z");

function contractInput(
  overrides: Partial<ControlSourceContractInput> = {}
): ControlSourceContractInput {
  return {
    sourceKey: "switch-settlement",
    version: 1,
    role: "settlement",
    displayName: "Switch settlement report",
    systemName: "Approved Switch",
    controlPurpose: "Daily settlement-to-register completeness control",
    accountableOwner: "Settlement Operations",
    escalationOwner: "Financial Controller",
    deliveryRoute: "sftp",
    timeZone: "Africa/Lagos",
    cutoffMinutes: 1_020,
    schemaVersion: "settlement-v1",
    controlTotalRequired: true,
    expectedCurrency: "NGN",
    status: "approved",
    approvalReference: "CAB-2026-10-09",
    effectiveAt,
    ...overrides,
  };
}

function storedContract(
  overrides: Partial<StoredControlSourceContract> = {}
): StoredControlSourceContract {
  return {
    id: 41,
    organizationId: 42,
    sourceKey: "switch-settlement",
    version: 1,
    status: "active",
    controlTotalRequired: true,
    expectedCurrency: "NGN",
    ...overrides,
  };
}

function manifestInput(
  overrides: Partial<ControlBatchManifestInput> = {}
): ControlBatchManifestInput {
  return {
    sourceContractId: 41,
    controlPeriod: "2026-10-09",
    deliveryIdentity: "switch-settlement-2026-10-09-v1",
    uploadBatchId: 88,
    receivedAt,
    mappingVersion: "mapping-v1",
    reconciliationPolicyVersion: "reconciliation-v1",
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

describe("control source contract validation", () => {
  it("accepts an approved, versioned source contract with an approval reference", () => {
    expect(() => validateSourceContract(contractInput())).not.toThrow();
  });

  it("requires an approval reference before a contract leaves draft", () => {
    expect(() =>
      validateSourceContract(contractInput({ approvalReference: null }))
    ).toThrow(/approval reference/i);
  });

  it("does not allow a contract to claim required totals without a currency", () => {
    expect(() =>
      validateSourceContract(contractInput({ expectedCurrency: null }))
    ).toThrow(/expected currency/i);
  });

  it("does not permit an expected currency where the contract says no total is required", () => {
    expect(() =>
      validateSourceContract(contractInput({ controlTotalRequired: false }))
    ).toThrow(/must be omitted/i);
  });
});

describe("control batch manifest validation", () => {
  it("accepts exact expected and received totals bound to an active source contract", () => {
    expect(() =>
      validateBatchManifest(manifestInput(), storedContract())
    ).not.toThrow();
  });

  it("rejects a manifest against a draft source contract", () => {
    expect(() =>
      validateBatchManifest(
        manifestInput(),
        storedContract({ status: "draft" })
      )
    ).toThrow(/approved, tested, or active/i);
  });

  it("rejects an expected currency that disagrees with the approved contract", () => {
    expect(() =>
      validateBatchManifest(
        manifestInput({ expectedCurrency: "USD" }),
        storedContract()
      )
    ).toThrow(/match the approved source contract/i);
  });

  it("rejects a JavaScript-number style total that is not an exact decimal string", () => {
    expect(() =>
      validateBatchManifest(
        manifestInput({ receivedMonetaryTotal: "1,250.10" }),
        storedContract()
      )
    ).toThrow(ControlManifestValidationError);
  });

  it("rejects expected totals when the contract does not require them", () => {
    expect(() =>
      validateBatchManifest(
        manifestInput(),
        storedContract({ controlTotalRequired: false, expectedCurrency: null })
      )
    ).toThrow(/cannot be recorded/i);
  });
});
