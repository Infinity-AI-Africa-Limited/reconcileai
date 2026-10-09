/**
 * controlEvidence — the tenant-scoped write boundary for a daily control.
 *
 * Every case runs through the REAL procedures and a scripted database that
 * models transactions, so a rollback is an actual rollback: `committed()`
 * excludes the operations of a transaction whose callback threw. The earlier
 * harness replaced `transaction` with a plain callback runner, which cannot
 * distinguish "saved" from "attempted and discarded" — the one property an
 * evidence store most needs to hold.
 *
 * Portal and cross-tenant override refusals for these same procedures are
 * rostered in server/portalOrgScope.test.ts, through their base procedure.
 */
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

import { rowOf, scriptedDb } from "../connectors/shopify/scriptedDb.testkit";
import { controlEvidenceRouter } from "./controlEvidence";

const organizationId = 42;
const OTHER_TENANT = 60001;
const CONTRACTS = "control_source_contracts";
const MANIFESTS = "control_batch_manifests";
const BATCHES = "upload_batches";

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
  uploadBatchId: null as number | null,
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

/** A database that answers the contract lookup, and optionally a batch lookup. */
function evidenceDb(options: { batch?: unknown[]; insertId?: number } = {}) {
  const fake = scriptedDb({
    select: {
      [CONTRACTS]: [[contract]],
      ...(options.batch === undefined ? {} : { [BATCHES]: [options.batch] }),
    },
    insert: {
      [CONTRACTS]: [options.insertId ?? 71],
      [MANIFESTS]: [options.insertId ?? 72],
    },
  });
  state.db = fake.db;
  return fake;
}

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof TRPCError ? error : new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: String(error) });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.audit.mockResolvedValue(undefined);
  state.db = null;
});

describe("when an operations owner records a source contract", () => {
  it("should save it against their own tenant and audit it inside the same transaction", async () => {
    const fake = evidenceDb();

    await expect(
      caller().createSourceContract(sourceContractInput)
    ).resolves.toEqual({ id: 71 });

    const write = fake.writes("insert", CONTRACTS);
    expect(write).toHaveLength(1);
    expect(rowOf(write[0])).toMatchObject({
      organizationId,
      createdByUserId: 7,
      sourceKey: "switch-settlement",
      version: 1,
      effectiveAt: new Date("2026-10-09T08:00:00.000Z"),
    });
    // The audit row must be written by the same executor, or a rollback of the
    // insert would leave an audit entry claiming evidence that is not there.
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        action: "control_source_contract_recorded",
        entityId: 71,
        executor: expect.anything(),
      })
    );
    expect(write[0]?.txId).not.toBeNull();
  });
});

describe("when an operations owner records a batch manifest", () => {
  it("should bind it to a same-tenant source contract and carry that contract's version", async () => {
    const fake = evidenceDb();

    await expect(
      caller().recordBatchManifest(batchManifestInput)
    ).resolves.toEqual({ id: 72 });

    const lookup = fake.ops.find(op => op.kind === "select" && op.table === CONTRACTS);
    // Scoped by tenant as well as id: an id alone would reach another tenant's
    // contract and bind this manifest to it.
    expect(lookup?.where?.params).toEqual(expect.arrayContaining([41, organizationId]));
    expect(rowOf(fake.writes("insert", MANIFESTS)[0])).toMatchObject({
      organizationId,
      recordedByUserId: 7,
      sourceContractId: 41,
      sourceContractVersion: 1,
      deliveryIdentity: "switch-settlement-2026-10-09-v1",
    });
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        action: "control_batch_manifest_recorded",
        entityId: 72,
        executor: expect.anything(),
      })
    );
  });

  it("should not look for an upload batch when the manifest names none", async () => {
    const fake = evidenceDb();

    await caller().recordBatchManifest({ ...batchManifestInput, uploadBatchId: null });

    expect(fake.ops.some(op => op.table === BATCHES)).toBe(false);
  });
});

describe("when a batch manifest names an upload batch", () => {
  it("should save it once that upload has completed", async () => {
    const fake = evidenceDb({ batch: [{ id: 88, status: "completed" }] });

    await expect(
      caller().recordBatchManifest({ ...batchManifestInput, uploadBatchId: 88 })
    ).resolves.toEqual({ id: 72 });

    expect(rowOf(fake.writes("insert", MANIFESTS)[0])).toMatchObject({ uploadBatchId: 88 });
  });

  it("should look the upload up by tenant as well as id, so another tenant's batch is simply absent", async () => {
    // The foreign-tenant case IS this query: scoped by organizationId, a batch
    // belonging to tenant 60001 returns no row at all.
    const fake = evidenceDb({ batch: [] });

    const refusal = await failureOf(() =>
      caller().recordBatchManifest({ ...batchManifestInput, uploadBatchId: 88 })
    );

    expect(refusal?.code).toBe("NOT_FOUND");
    const lookup = fake.ops.find(op => op.kind === "select" && op.table === BATCHES);
    expect(lookup?.where?.params).toEqual(expect.arrayContaining([88, organizationId]));
    expect(lookup?.where?.params).not.toContain(OTHER_TENANT);
    expect(fake.committed().some(op => op.kind === "insert")).toBe(false);
  });

  it("should refuse a missing upload batch and save nothing", async () => {
    const fake = evidenceDb({ batch: [] });

    const refusal = await failureOf(() =>
      caller().recordBatchManifest({ ...batchManifestInput, uploadBatchId: 404 })
    );

    expect(refusal?.code).toBe("NOT_FOUND");
    expect(refusal?.message).toBe("Upload batch not found");
    expect(fake.committed().some(op => op.kind === "insert")).toBe(false);
  });

  it.each(["pending", "processing", "failed"])(
    "should refuse an upload still in %s, because unfinished rows are not evidence",
    async status => {
      const fake = evidenceDb({ batch: [{ id: 88, status }] });

      const refusal = await failureOf(() =>
        caller().recordBatchManifest({ ...batchManifestInput, uploadBatchId: 88 })
      );

      expect(refusal?.code).toBe("PRECONDITION_FAILED");
      expect(refusal?.message).toMatch(/completed upload batch/i);
      expect(fake.committed().some(op => op.kind === "insert")).toBe(false);
      expect(state.audit).not.toHaveBeenCalled();
    }
  );
});

describe("when the audit entry for a piece of evidence cannot be written", () => {
  it("should leave no source contract saved", async () => {
    const fake = evidenceDb();
    state.audit.mockRejectedValue(new Error("audit chain unavailable"));

    expect(await failureOf(() => caller().createSourceContract(sourceContractInput))).not.toBeNull();

    // Attempted, then discarded: the operation is in `ops` but not in
    // `committed()`, which is exactly the distinction that matters here.
    expect(fake.writes("insert", CONTRACTS)).toHaveLength(0);
    expect(fake.ops.some(op => op.kind === "insert" && op.table === CONTRACTS)).toBe(true);
  });

  it("should leave no batch manifest saved", async () => {
    const fake = evidenceDb();
    state.audit.mockRejectedValue(new Error("audit chain unavailable"));

    expect(await failureOf(() => caller().recordBatchManifest(batchManifestInput))).not.toBeNull();

    expect(fake.writes("insert", MANIFESTS)).toHaveLength(0);
    expect(fake.ops.some(op => op.kind === "insert" && op.table === MANIFESTS)).toBe(true);
  });
});

describe("when the database does not report the row it inserted", () => {
  it("should refuse rather than audit evidence against a missing id", async () => {
    // An entityId of 0 would be an audit entry pointing at nothing, while the
    // caller was told the evidence had been recorded.
    const fake = evidenceDb({ insertId: 0 });

    const refusal = await failureOf(() => caller().createSourceContract(sourceContractInput));

    expect(refusal?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(state.audit).not.toHaveBeenCalled();
    expect(fake.committed().some(op => op.kind === "insert")).toBe(false);
  });
});

describe("when the caller may not record control evidence", () => {
  it("should refuse a non-operational role before it reaches the database", async () => {
    const refusal = await failureOf(() => caller("compliance").createSourceContract(sourceContractInput));

    expect(refusal?.code).toBe("FORBIDDEN");
    expect(state.db).toBeNull();
  });

  it("should refuse a guest even when their role would otherwise allow it", async () => {
    const refusal = await failureOf(() =>
      caller("admin", true).createSourceContract(sourceContractInput)
    );

    expect(refusal?.code).toBe("FORBIDDEN");
    expect(state.db).toBeNull();
  });

  it("should refuse an ordinary tenant user naming another organisation", async () => {
    const refusal = await failureOf(() =>
      caller("operations").createSourceContract({ ...sourceContractInput, organizationId: OTHER_TENANT })
    );

    expect(refusal?.code).toBe("FORBIDDEN");
    expect(state.db).toBeNull();
  });
});

describe("when control policy refuses the evidence itself", () => {
  it("should answer a stable code rather than the policy's wording", async () => {
    const refusal = await failureOf(() =>
      caller().createSourceContract({ ...sourceContractInput, approvalReference: null })
    );

    expect(refusal?.code).toBe("BAD_REQUEST");
    expect(refusal?.message).toBe("invalid_control_evidence");
    expect(state.db).toBeNull();
  });
});
