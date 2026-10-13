import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { getDbMock, auditMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: getDbMock }));
vi.mock("./routers/shared", () => ({ logAuditStrict: auditMock }));

import {
  activateControlPolicy,
  approveControlPolicy,
  canonicalPolicyDefinition,
  createControlPolicy,
  getControlPolicy,
  listControlPolicies,
  policyDefinitionDigest,
  retireControlPolicy,
} from "./controlPolicyStore";
import {
  duplicateKeyError,
  rowOf,
  scriptedDb,
} from "./connectors/shopify/scriptedDb.testkit";

const actor = {
  id: 71,
  role: "operations",
  organizationId: 42,
  isGuest: false,
};
const client = { ip: "127.0.0.1", ua: "policy-test" };
const effectiveAt = new Date("2026-10-13T00:00:00.000Z");
const NOW = new Date("2026-10-13T12:00:00.000Z");
const basePolicy = {
  id: 7,
  organizationId: 42,
  policyType: "reconciliation" as const,
  policyKey: "settlement-to-register",
  version: 1,
  status: "draft" as const,
  effectiveAt,
};
const tenant42 = { organizations: [{ id: 42 }] };
const draftInput = {
  organizationId: 42,
  policyType: "reconciliation" as const,
  policyKey: "settlement-to-register",
  version: 1,
  displayName: "Daily settlement to register",
  description: "Exact daily settlement control.",
  definition: { amountTolerance: "0.00", dateWindowDays: 0 },
  effectiveAt,
};

function errorOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error =>
      error instanceof TRPCError
        ? { code: error.code, message: error.message }
        : { code: "UNKNOWN", message: String(error) }
  );
}

beforeEach(() => {
  getDbMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when a definition is reduced to its digest", () => {
  it("should give the same digest whatever order the keys arrived in", () => {
    const left = { thresholds: { amount: "0.00", days: 0 }, statuses: ["posted", "pending"] };
    const right = { statuses: ["posted", "pending"], thresholds: { days: 0, amount: "0.00" } };
    expect(canonicalPolicyDefinition(left)).toBe(canonicalPolicyDefinition(right));
    expect(policyDefinitionDigest(left)).toBe(policyDefinitionDigest(right));
  });

  it("should order keys by code unit, so the digest cannot change with the host's locale", () => {
    // localeCompare would put "a" before "B" in most locales; code units put "B" (66) first.
    expect(canonicalPolicyDefinition({ a: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"a":1}');
  });

  it("should give different dates different digests once they are JSON, and refuse a raw Date", () => {
    expect(policyDefinitionDigest({ cutoff: "2026-10-13" })).not.toBe(
      policyDefinitionDigest({ cutoff: "2026-10-14" })
    );
    expect(() => canonicalPolicyDefinition({ cutoff: new Date("2026-10-13") })).toThrow(TypeError);
    expect(() => canonicalPolicyDefinition({ holes: [1, , 3] })).toThrow(TypeError);
  });
});

describe("when a draft is recorded", () => {
  it("should store the definition it hashed, and keep the definition out of the audit event", async () => {
    const fake = scriptedDb({ standing: tenant42 });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      createControlPolicy({ actor, organizationId: 42, input: draftInput, client })
    ).resolves.toEqual({
      id: 1000,
      status: "draft",
      definitionDigest: policyDefinitionDigest(draftInput.definition),
    });

    const insert = rowOf(fake.writes("insert", "control_policies")[0]);
    expect(insert).toMatchObject({ organizationId: 42, status: "draft", definition: draftInput.definition });
    expect(insert?.definitionDigest).toBe(policyDefinitionDigest(insert?.definition));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "control_policy_drafted",
        details: expect.objectContaining({ definitionDigest: policyDefinitionDigest(draftInput.definition) }),
      })
    );
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain("amountTolerance");
  });

  it("should refuse a definition that is not plain JSON even when a caller skips the router", async () => {
    const fake = scriptedDb({ standing: tenant42 });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() =>
        createControlPolicy({
          actor,
          organizationId: 42,
          input: { ...draftInput, definition: { cutoff: new Date("2026-10-13") } as never },
          client,
        })
      )
    ).resolves.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/is Date/) });
    expect(fake.ops).toHaveLength(0);
  });

  it("should refuse an organisation that does not exist, creating no policy and no audit", async () => {
    const fake = scriptedDb({ standing: { organizations: [] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => createControlPolicy({ actor, organizationId: 4242, input: draftInput, client }))
    ).resolves.toEqual({ code: "NOT_FOUND", message: "Organisation not found" });
    expect(fake.writes("insert", "control_policies")).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
    const lookup = fake.ops.find(op => op.table === "organizations");
    expect(lookup?.where?.params).toEqual([4242]);
    // In the same transaction as the insert it guards.
    expect(lookup?.txId).not.toBeNull();
  });

  it("should answer a repeated version as a conflict naming the version, not a server error", async () => {
    const fake = scriptedDb({ standing: tenant42, insert: { control_policies: [duplicateKeyError()] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => createControlPolicy({ actor, organizationId: 42, input: draftInput, client }))
    ).resolves.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Version 1 of this policy key already exists/) });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("when a draft is approved", () => {
  it("should record the approver, the server's time and the reference", async () => {
    const fake = scriptedDb({ standing: { control_policies: [basePolicy] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      approveControlPolicy({ actor, organizationId: 42, input: { policyId: 7, approvalReference: "CAB-2026-10-13" }, client })
    ).resolves.toEqual({ id: 7, status: "approved" });

    const update = fake.writes("update", "control_policies")[0];
    expect(rowOf(update)).toEqual({
      status: "approved",
      approvalReference: "CAB-2026-10-13",
      approvedByUserId: 71,
      approvedAt: NOW,
    });
    // Conditioned on the tenant and on the state that was checked.
    expect(update.where?.params).toEqual([7, 42, "draft"]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "control_policy_approved" }));
  });

  it.each(["approved", "active", "retired"] as const)("should refuse a policy that is already %s", async status => {
    const fake = scriptedDb({ standing: { control_policies: [{ ...basePolicy, status }] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => approveControlPolicy({ actor, organizationId: 42, input: { policyId: 7, approvalReference: "CAB-1" }, client }))
    ).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.writes("update", "control_policies")).toHaveLength(0);
  });

  it("should answer another tenant's policy id as not found, reading it only through a tenant-scoped lock", async () => {
    const fake = scriptedDb({ standing: { control_policies: [] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => approveControlPolicy({ actor, organizationId: 42, input: { policyId: 7, approvalReference: "CAB-1" }, client }))
    ).resolves.toEqual({ code: "NOT_FOUND", message: "Control policy not found" });
    const read = fake.ops.find(op => op.kind === "select" && op.table === "control_policies");
    expect(read?.where?.params).toEqual([7, 42]);
    expect(read?.locked).toBe(true);
  });
});

describe("when an approved policy is activated", () => {
  it("should refuse before its effective date", async () => {
    const future = { ...basePolicy, status: "approved" as const, effectiveAt: new Date("2037-12-31T00:00:00.000Z") };
    const fake = scriptedDb({ standing: { control_policies: [future] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => activateControlPolicy({ actor, organizationId: 42, input: { policyId: 7 }, client }))
    ).resolves.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/effective date/i) });
    expect(fake.writes("update", "control_policies")).toHaveLength(0);
  });

  it("should claim the tenant-scoped active slot", async () => {
    const fake = scriptedDb({ standing: { control_policies: [{ ...basePolicy, status: "approved" as const }] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      activateControlPolicy({ actor, organizationId: 42, input: { policyId: 7 }, client })
    ).resolves.toEqual({ id: 7, status: "active" });

    const update = fake.writes("update", "control_policies")[0];
    expect(rowOf(update)).toEqual({ status: "active", activeSlot: "42:reconciliation:settlement-to-register" });
    expect(update.where?.params).toEqual([7, 42, "approved"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "control_policy_activated", details: expect.objectContaining({ activatedAt: NOW.toISOString() }) })
    );
  });

  it("should answer a taken active slot as a conflict telling the operator to retire the other version", async () => {
    const fake = scriptedDb({
      standing: { control_policies: [{ ...basePolicy, status: "approved" as const }] },
      update: { control_policies: [duplicateKeyError()] },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => activateControlPolicy({ actor, organizationId: 42, input: { policyId: 7 }, client }))
    ).resolves.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already active.*Retire it/) });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each(["draft", "active", "retired"] as const)("should refuse a %s policy", async status => {
    const fake = scriptedDb({ standing: { control_policies: [{ ...basePolicy, status }] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => activateControlPolicy({ actor, organizationId: 42, input: { policyId: 7 }, client }))
    ).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("when a policy is retired", () => {
  it("should retire an active policy at the server's time and free its slot", async () => {
    const fake = scriptedDb({ standing: { control_policies: [{ ...basePolicy, status: "active" as const }] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      retireControlPolicy({ actor, organizationId: 42, input: { policyId: 7, retirementReference: "CAB-2026-10-14" }, client })
    ).resolves.toEqual({ id: 7, status: "retired" });

    const update = fake.writes("update", "control_policies")[0];
    expect(rowOf(update)).toEqual({
      status: "retired",
      activeSlot: null,
      retirementReference: "CAB-2026-10-14",
      retiredByUserId: 71,
      retiredAt: NOW,
    });
    expect(update.where?.params).toEqual([7, 42, "active"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "control_policy_retired",
        details: expect.objectContaining({ previousStatus: "active", retiredAt: NOW.toISOString() }),
      })
    );
  });

  it("should withdraw an approved policy whose effective date has not yet arrived", async () => {
    const notYetEffective = { ...basePolicy, status: "approved" as const, effectiveAt: new Date("2026-12-01T00:00:00.000Z") };
    const fake = scriptedDb({ standing: { control_policies: [notYetEffective] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      retireControlPolicy({ actor, organizationId: 42, input: { policyId: 7, retirementReference: "CAB-withdrawn" }, client })
    ).resolves.toEqual({ id: 7, status: "retired" });
    expect(rowOf(fake.writes("update", "control_policies")[0])).toMatchObject({ retiredAt: NOW });
  });

  it.each(["draft", "retired"] as const)("should refuse a %s policy", async status => {
    const fake = scriptedDb({ standing: { control_policies: [{ ...basePolicy, status }] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() => retireControlPolicy({ actor, organizationId: 42, input: { policyId: 7, retirementReference: "CAB-1" }, client }))
    ).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.writes("update", "control_policies")).toHaveLength(0);
  });
});

describe("when the policy history is listed", () => {
  const summary = (id: number, at: string) => ({ ...basePolicy, id, effectiveAt: new Date(at) });

  it("should return a bounded page and the cursor that continues after it", async () => {
    const fake = scriptedDb({
      select: {
        control_policies: [[summary(9, "2026-10-13T00:00:00Z"), summary(8, "2026-10-12T00:00:00Z"), summary(7, "2026-10-11T00:00:00Z")]],
      },
    });
    getDbMock.mockResolvedValue(fake.db);

    const result = await listControlPolicies(42, { limit: 2 });

    expect(result.rows.map(row => row.id)).toEqual([9, 8]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual({ effectiveAt: "2026-10-12T00:00:00.000Z", id: 8 });
    // One row beyond the page is fetched purely to answer "is there more?".
    expect(fake.ops[0].limit).toBe(3);
  });

  it("should continue strictly after the cursor and filter by version, within the tenant", async () => {
    const fake = scriptedDb({ select: { control_policies: [[]] } });
    getDbMock.mockResolvedValue(fake.db);

    const result = await listControlPolicies(42, {
      policyKey: "settlement-to-register",
      version: 3,
      cursor: { effectiveAt: new Date("2026-10-12T00:00:00.000Z"), id: 8 },
    });

    expect(result).toEqual({ organizationId: 42, rows: [], hasMore: false, nextCursor: null });
    const where = fake.ops[0].where;
    expect(where?.sql).toMatch(/`organizationId` = \?/);
    expect(where?.sql).toMatch(/`version` = \?/);
    expect(where?.sql).toMatch(/`effectiveAt` < \? or \(`control_policies`.`effectiveAt` = \? and `control_policies`.`id` < \?\)/);
    expect(where?.params).toEqual(expect.arrayContaining([42, "settlement-to-register", 3, 8]));
  });

  it("should leave definitions out of the listing", async () => {
    const fake = scriptedDb({ select: { control_policies: [[]] } });
    getDbMock.mockResolvedValue(fake.db);

    await listControlPolicies(42, {});

    expect(fake.ops[0].fields).toContain("definitionDigest");
    expect(fake.ops[0].fields).not.toContain("definition");
    expect(fake.ops[0].fields).not.toContain("activeSlot");
  });
});

describe("when one policy is read in full", () => {
  it("should return its definition, read within the tenant", async () => {
    const stored = { ...basePolicy, definition: { amountTolerance: "0.00" } };
    const fake = scriptedDb({ select: { control_policies: [[stored]] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(getControlPolicy(42, 7)).resolves.toEqual(stored);
    expect(fake.ops[0].fields).toContain("definition");
    expect(fake.ops[0].where?.params).toEqual([7, 42]);
  });

  it("should answer another tenant's id as not found", async () => {
    const fake = scriptedDb({ select: { control_policies: [[]] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(errorOf(() => getControlPolicy(42, 7))).resolves.toEqual({
      code: "NOT_FOUND",
      message: "Control policy not found",
    });
  });
});
