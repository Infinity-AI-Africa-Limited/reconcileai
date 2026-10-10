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
  channelId: 101,
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

describe("when stored evidence is read for one tenant and control period", () => {
  it("should scope both queries to that organisation and period", async () => {
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
});

describe("when the business day assessed is not the day it is assessed on", () => {
  it("should bound the contract query by that business day, not by the clock", async () => {
    // Bounded by `evaluatedAt`, a contract that began AFTER the day under
    // assessment was still fetched and then required — and a day whose sources
    // did not yet exist can never be completed. The bound is the end of the
    // day anywhere on earth; the exact per-zone test happens in memory, where
    // each contract's own time zone is known.
    const fake = readinessDb();

    await assessPersistedControlRun({
      organizationId,
      controlPeriod: "2026-10-08",
      evaluatedAt: new Date("2026-10-10T09:00:00.000Z"),
    });

    const contractQuery = fake.ops.find(
      op => op.kind === "select" && op.table === CONTRACTS
    );
    // The rendered parameter, read as the driver sends it. Re-parsing it with
    // `new Date()` would reinterpret it in the machine's own zone and make this
    // assertion pass or fail depending on where it runs; drizzle renders in
    // UTC, so the string itself is the stable thing to compare.
    expect(contractQuery?.where?.params.at(-1)).toBe("2026-10-09 14:00:00.000");
  });
});

describe("when the tenant has no eligible source contract", () => {
  it("should fail closed and not look for manifests at all", async () => {
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
});

describe("when evidence storage is unavailable", () => {
  it("should answer a safe infrastructure error rather than an empty assessment", async () => {
    await expect(
      assessPersistedControlRun({ organizationId, controlPeriod: period })
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable",
    } satisfies Partial<TRPCError>);
  });
});
