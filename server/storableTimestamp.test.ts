/**
 * Dates bound for a TIMESTAMP column, refused at the edge when the column
 * cannot hold them. The engine side of the bound (that MySQL stores both edges
 * and refuses one second past) is proven in controlPolicyStore.db.test.ts.
 */
import { describe, expect, it } from "vitest";
import { controlBatchManifestInput, controlSourceContractInput } from "./controlEvidenceSchema";
import { createControlPolicyInput } from "./controlPolicySchema";
import { isStorableTimestamp, storableDateInput, TIMESTAMP_MAX, TIMESTAMP_MIN } from "./storableTimestamp";

describe("when a date is checked against the TIMESTAMP range", () => {
  it("should admit both edges and refuse anything past them, to the millisecond", () => {
    expect(isStorableTimestamp(TIMESTAMP_MIN)).toBe(true);
    expect(isStorableTimestamp(TIMESTAMP_MAX)).toBe(true);
    expect(isStorableTimestamp(new Date(TIMESTAMP_MIN.getTime() - 1))).toBe(false);
    // 03:14:07.001 would round to :07 here, but .5 would round to :08: refuse past the whole second.
    expect(isStorableTimestamp(new Date(TIMESTAMP_MAX.getTime() + 1))).toBe(false);
  });

  it.each(["2099-01-01T00:00:00.000Z", "2038-01-19T03:14:08.000Z", "1969-12-31T23:59:59.000Z", "1970-01-01T00:00:00.000Z"])(
    "should refuse %s with the reason, not let it reach the database",
    value => {
      const result = storableDateInput.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toMatch(/range the database can store/);
    }
  );

  it("should still refuse a value that is not an ISO date-time", () => {
    expect(storableDateInput.safeParse("13/10/2026").success).toBe(false);
  });
});

describe("when a control input carries a date the column cannot hold", () => {
  it("should refuse a policy effective date in 2099", () => {
    const result = createControlPolicyInput.safeParse({
      policyType: "mapping",
      policyKey: "settlement-csv-v1",
      version: 1,
      displayName: "Settlement CSV mapping",
      description: "Maps approved settlement columns.",
      definition: { reference: "ref" },
      effectiveAt: "2099-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("should refuse a source-contract effective date in 2099 (the same column type, the same defect)", () => {
    const result = controlSourceContractInput.safeParse({
      channelId: 1,
      sourceKey: "switch-settlement",
      version: 1,
      role: "settlement",
      displayName: "Switch settlement",
      systemName: "Switch",
      controlPurpose: "Daily settlement",
      accountableOwner: "Ops",
      escalationOwner: "Finance",
      deliveryRoute: "sftp",
      timeZone: "Africa/Lagos",
      cutoffMinutes: 1080,
      schemaVersion: "v1",
      controlTotalRequired: true,
      expectedCurrency: "NGN",
      status: "approved",
      approvalReference: "CAB-1",
      effectiveAt: "2099-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("should refuse a manifest received before 1970", () => {
    const result = controlBatchManifestInput.safeParse({
      sourceContractId: 1,
      controlPeriod: "2026-10-09",
      deliveryIdentity: "delivery-1",
      uploadBatchId: null,
      receivedAt: "1969-12-31T00:00:00.000Z",
      mappingVersion: "v1",
      reconciliationPolicyVersion: "v1",
      schemaState: "accepted",
      duplicateDelivery: "none",
      invalidRowCount: 0,
      expectedRecordCount: 1,
      expectedMonetaryTotal: "1.00",
      expectedCurrency: "NGN",
      receivedRecordCount: 1,
      receivedMonetaryTotal: "1.00",
      receivedCurrency: "NGN",
    });
    expect(result.success).toBe(false);
  });
});
