import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(async () => state.db),
}));

import { scriptedDb } from "./connectors/shopify/scriptedDb.testkit";
import { assessPersistedControlRun } from "./controlRunReadiness";

const organizationId = 42;
const period = "2026-10-09";
const CONTRACTS = "control_source_contracts";
const MANIFESTS = "control_batch_manifests";

const contract = {
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
};

const manifest = {
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
};

function readinessDb(
  options: { contracts?: unknown[]; manifests?: unknown[] } = {}
) {
  const fake = scriptedDb({
    select: {
      [CONTRACTS]: [options.contracts ?? [contract]],
      [MANIFESTS]: [options.manifests ?? [manifest]],
    },
  });
  state.db = fake.db;
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
});

describe("assessPersistedControlRun", () => {
  it("should query contracts and manifests within one organisation and control period", async () => {
    const fake = readinessDb();

    const result = await assessPersistedControlRun({
      organizationId,
      controlPeriod: period,
      evaluatedAt: new Date("2026-10-09T17:05:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "ready_to_reconcile",
      canReconcile: true,
      mayPublishMatchRate: true,
      organizationId,
      controlPeriod: period,
    });
    const contractQuery = fake.ops.find(
      op => op.kind === "select" && op.table === CONTRACTS
    );
    const manifestQuery = fake.ops.find(
      op => op.kind === "select" && op.table === MANIFESTS
    );
    expect(contractQuery?.where?.params).toContain(organizationId);
    expect(manifestQuery?.where?.params).toEqual(
      expect.arrayContaining([organizationId, period, contract.id])
    );
  });

  it("should fail closed without an eligible tenant source contract and avoid a manifest lookup", async () => {
    const fake = readinessDb({ contracts: [] });

    const result = await assessPersistedControlRun({
      organizationId,
      controlPeriod: period,
      evaluatedAt: new Date("2026-10-09T17:05:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "blocked",
      canReconcile: false,
      mayPublishMatchRate: false,
      sourceContractCount: 0,
      batchManifestCount: 0,
    });
    expect(result.persistenceReasons).toContain("no_eligible_source_contracts");
    expect(
      fake.ops.some(op => op.kind === "select" && op.table === MANIFESTS)
    ).toBe(false);
  });

  it("should return a safe infrastructure error when evidence storage is unavailable", async () => {
    await expect(
      assessPersistedControlRun({ organizationId, controlPeriod: period })
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    } satisfies Partial<TRPCError>);
  });
});
