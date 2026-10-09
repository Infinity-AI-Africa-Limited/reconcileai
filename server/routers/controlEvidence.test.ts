import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

const state = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(),
}));

vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => state.db),
}));
vi.mock("./shared", async importOriginal => ({
  ...(await importOriginal<typeof import("./shared")>()),
  getClientInfo: vi.fn(() => ({
    ip: "127.0.0.1",
    ua: "control-evidence-test",
  })),
  logAuditStrict: state.audit,
}));

import { controlEvidenceRouter } from "./controlEvidence";

const organizationId = 42;
const contract = {
  id: 41,
  organizationId,
  sourceKey: "switch-settlement",
  version: 1,
  status: "active" as const,
  controlTotalRequired: true,
  expectedCurrency: "NGN",
};

const caller = (role = "operations", isGuest = false) =>
  controlEvidenceRouter.createCaller({
    user: { id: 7, role, organizationId, isGuest, isReadOnly: false },
    viewingAs: null,
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
  } as never);

const sourceContractInput = {
  sourceKey: "switch-settlement",
  version: 1,
  role: "settlement" as const,
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
  status: "approved" as const,
  approvalReference: "CAB-2026-10-09",
  effectiveAt: "2026-10-09T08:00:00.000Z",
};

const batchManifestInput = {
  sourceContractId: 41,
  controlPeriod: "2026-10-09",
  deliveryIdentity: "switch-settlement-2026-10-09-v1",
  uploadBatchId: null,
  receivedAt: "2026-10-09T16:45:00.000Z",
  mappingVersion: "mapping-v1",
  reconciliationPolicyVersion: "reconciliation-v1",
  schemaState: "accepted" as const,
  duplicateDelivery: "none" as const,
  invalidRowCount: 0,
  expectedRecordCount: 2,
  expectedMonetaryTotal: "1250.10",
  expectedCurrency: "NGN",
  receivedRecordCount: 2,
  receivedMonetaryTotal: "1250.10",
  receivedCurrency: "NGN",
};

function sourceContractDb() {
  const values = vi.fn(async () => [{ insertId: 71 }]);
  const insert = vi.fn(() => ({ values }));
  const tx = { insert };
  return {
    db: {
      transaction: vi.fn(
        async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)
      ),
    },
    insert,
    values,
  };
}

function batchManifestDb() {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [contract]),
      })),
    })),
  }));
  const values = vi.fn(async () => [{ insertId: 72 }]);
  const insert = vi.fn(() => ({ values }));
  const tx = { select, insert };
  return {
    db: {
      transaction: vi.fn(
        async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)
      ),
    },
    select,
    insert,
    values,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
});

describe("control evidence write boundary", () => {
  it("records a tenant-owned source contract and its audit evidence in one transaction", async () => {
    const { db, insert, values } = sourceContractDb();
    state.db = db;

    await expect(
      caller().createSourceContract(sourceContractInput)
    ).resolves.toEqual({ id: 71 });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        createdByUserId: 7,
        sourceKey: "switch-settlement",
        version: 1,
        effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
      })
    );
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        action: "control_source_contract_recorded",
        entityId: 71,
        executor: expect.anything(),
      })
    );
  });

  it("records a batch manifest only against a same-tenant active source contract and audits it", async () => {
    const { db, select, insert, values } = batchManifestDb();
    state.db = db;

    await expect(
      caller().recordBatchManifest(batchManifestInput)
    ).resolves.toEqual({ id: 72 });

    expect(select).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
      organizationId,
      recordedByUserId: 7,
      sourceContractId: 41,
      sourceContractVersion: 1,
      deliveryIdentity: "switch-settlement-2026-10-09-v1",
      })
    );
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        action: "control_batch_manifest_recorded",
        entityId: 72,
        executor: expect.anything(),
      })
    );
  });

  it("refuses non-operational roles before it accesses the database", async () => {
    const refusal = await caller("compliance")
      .createSourceContract(sourceContractInput)
      .catch(error => error);
    expect(refusal).toBeInstanceOf(TRPCError);
    expect((refusal as TRPCError).code).toBe("FORBIDDEN");
    expect(state.db).toBeNull();
  });

  it("returns a stable validation code rather than the control-policy detail", async () => {
    const refusal = await caller()
      .createSourceContract({ ...sourceContractInput, approvalReference: null })
      .catch(error => error);
    expect(refusal).toBeInstanceOf(TRPCError);
    expect((refusal as TRPCError).code).toBe("BAD_REQUEST");
    expect((refusal as TRPCError).message).toBe("invalid_control_evidence");
    expect(state.db).toBeNull();
  });

  it("does not let an ordinary tenant user choose another organization", async () => {
    const refusal = await caller("operations")
      .createSourceContract({ ...sourceContractInput, organizationId: 60001 })
      .catch(error => error);
    expect(refusal).toBeInstanceOf(TRPCError);
    expect((refusal as TRPCError).code).toBe("FORBIDDEN");
    expect(state.db).toBeNull();
  });
});
