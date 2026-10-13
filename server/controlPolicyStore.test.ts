import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { getDbMock, auditMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: getDbMock }));
vi.mock("./routers/shared", () => ({ logAuditStrict: auditMock }));

import { controlPolicies } from "../drizzle/schema";
import {
  activateControlPolicy,
  approveControlPolicy,
  canonicalPolicyDefinition,
  createControlPolicy,
  policyDefinitionDigest,
  retireControlPolicy,
} from "./controlPolicyStore";
import { assertControlPolicyWriter } from "./controlPolicySchema";
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
const basePolicy = {
  id: 7,
  organizationId: 42,
  policyType: "reconciliation" as const,
  policyKey: "settlement-to-register",
  version: 1,
  status: "draft" as const,
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

describe("control policy registry", () => {
  beforeEach(() => {
    getDbMock.mockReset();
    auditMock.mockReset().mockResolvedValue(undefined);
  });

  it("canonicalizes definitions before deriving their integrity digest", () => {
    const left = {
      thresholds: { amount: "0.00", days: 0 },
      statuses: ["posted", "pending"],
    };
    const right = {
      statuses: ["posted", "pending"],
      thresholds: { days: 0, amount: "0.00" },
    };
    expect(canonicalPolicyDefinition(left)).toBe(
      canonicalPolicyDefinition(right)
    );
    expect(policyDefinitionDigest(left)).toBe(policyDefinitionDigest(right));
  });

  it("records a draft with a digest and never includes the definition in the audit event", async () => {
    const fake = scriptedDb();
    getDbMock.mockResolvedValue(fake.db);
    const definition = { amountTolerance: "0.00", dateWindowDays: 0 };

    await expect(
      createControlPolicy({
        actor,
        organizationId: 42,
        input: {
          organizationId: 42,
          policyType: "reconciliation",
          policyKey: "settlement-to-register",
          version: 1,
          displayName: "Daily settlement to register",
          description: "Exact daily settlement control.",
          definition,
          effectiveAt,
        },
        client,
      })
    ).resolves.toEqual({
      id: 1000,
      status: "draft",
      definitionDigest: policyDefinitionDigest(definition),
    });

    const insert = fake.writes("insert", "control_policies")[0];
    expect(rowOf(insert)).toMatchObject({
      organizationId: 42,
      status: "draft",
      definitionDigest: policyDefinitionDigest(definition),
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "control_policy_drafted",
        details: expect.objectContaining({
          definitionDigest: policyDefinitionDigest(definition),
        }),
      })
    );
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain(
      "amountTolerance"
    );
  });

  it("allows only a draft to be approved and retains the approval reference", async () => {
    const fake = scriptedDb({ standing: { control_policies: [basePolicy] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      approveControlPolicy({
        actor,
        organizationId: 42,
        input: { policyId: 7, approvalReference: "CAB-2026-10-13" },
        client,
      })
    ).resolves.toEqual({ id: 7, status: "approved" });

    expect(rowOf(fake.writes("update", "control_policies")[0])).toMatchObject({
      status: "approved",
      approvalReference: "CAB-2026-10-13",
      approvedByUserId: 71,
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "control_policy_approved" })
    );
  });

  it("refuses to activate a policy before its approved effective date", async () => {
    const future = {
      ...basePolicy,
      status: "approved" as const,
      effectiveAt: new Date("2999-01-01T00:00:00.000Z"),
    };
    const fake = scriptedDb({ standing: { control_policies: [future] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() =>
        activateControlPolicy({
          actor,
          organizationId: 42,
          input: { policyId: 7 },
          client,
        })
      )
    ).resolves.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/effective date/i),
    });
    expect(fake.writes("update", "control_policies")).toHaveLength(0);
  });

  it("activates only an approved policy with one tenant-scoped active slot", async () => {
    const approved = { ...basePolicy, status: "approved" as const };
    const fake = scriptedDb({ standing: { control_policies: [approved] } });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      activateControlPolicy({
        actor,
        organizationId: 42,
        input: { policyId: 7 },
        client,
      })
    ).resolves.toEqual({ id: 7, status: "active" });

    expect(rowOf(fake.writes("update", "control_policies")[0])).toMatchObject({
      status: "active",
      activeSlot: "42:reconciliation:settlement-to-register",
    });
  });

  it("maps duplicate active-slot or version protection to a conflict instead of replacing history", async () => {
    const approved = { ...basePolicy, status: "approved" as const };
    const fake = scriptedDb({
      standing: { control_policies: [approved] },
      update: { control_policies: [duplicateKeyError()] },
    });
    getDbMock.mockResolvedValue(fake.db);

    await expect(
      errorOf(() =>
        activateControlPolicy({
          actor,
          organizationId: 42,
          input: { policyId: 7 },
          client,
        })
      )
    ).resolves.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/active/i),
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("retires an approved or active policy with a dated audit trail", async () => {
    const active = { ...basePolicy, status: "active" as const };
    const fake = scriptedDb({ standing: { control_policies: [active] } });
    getDbMock.mockResolvedValue(fake.db);
    const retiredAt = new Date("2026-10-14T00:00:00.000Z");

    await expect(
      retireControlPolicy({
        actor,
        organizationId: 42,
        input: {
          policyId: 7,
          retirementReference: "CAB-2026-10-14",
          retiredAt,
        },
        client,
      })
    ).resolves.toEqual({ id: 7, status: "retired" });

    expect(rowOf(fake.writes("update", "control_policies")[0])).toMatchObject({
      status: "retired",
      activeSlot: null,
      retiredByUserId: 71,
      retirementReference: "CAB-2026-10-14",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "control_policy_retired" })
    );
  });

  it("fails closed for guest and ordinary user policy writes", () => {
    expect(() =>
      assertControlPolicyWriter({ ...actor, isGuest: true })
    ).toThrow(TRPCError);
    expect(() => assertControlPolicyWriter({ ...actor, role: "user" })).toThrow(
      TRPCError
    );
  });
});

void controlPolicies;
