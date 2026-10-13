/**
 * The policy registry's procedures, called through their real base procedures:
 * role gates, input parsing and tenant resolution run as in production, and
 * only the store is replaced. The store's own rules are pinned in
 * controlPolicyStore.test.ts (scripted) and controlPolicyStore.db.test.ts (real
 * MySQL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const store = vi.hoisted(() => ({
  createControlPolicy: vi.fn(),
  approveControlPolicy: vi.fn(),
  activateControlPolicy: vi.fn(),
  retireControlPolicy: vi.fn(),
  listControlPolicies: vi.fn(),
  getControlPolicy: vi.fn(),
}));

vi.mock("../controlPolicyStore", () => store);

import { controlPoliciesRouter } from "./controlPolicies";

type User = {
  id: number;
  role: string;
  organizationId: number | null;
  isGuest: boolean;
  isReadOnly: boolean;
  email: string;
};

const operations: User = { id: 7, role: "operations", organizationId: 42, isGuest: false, isReadOnly: false, email: "ops@example.com" };
const staff: User = { ...operations, id: 1, role: "super_admin", organizationId: 1, email: "staff@example.com" };

function callerAs(user: User, viewingAs: number | null = null) {
  return controlPoliciesRouter.createCaller({
    user,
    viewingAs,
    req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" },
    res: {},
  } as never);
}

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error =>
      error instanceof TRPCError ? { code: error.code, message: error.message } : { code: "UNKNOWN", message: String(error) }
  );
}

const draftInput = {
  policyType: "mapping" as const,
  policyKey: "settlement-csv-v1",
  version: 1,
  displayName: "Settlement CSV mapping",
  description: "Maps approved settlement columns.",
  definition: { transactionReference: "reference" },
  effectiveAt: "2026-10-13T00:00:00.000Z",
};

type Caller = ReturnType<typeof callerAs>;
/** Every write, with a valid input, and the store function it should reach. */
const WRITES: ReadonlyArray<
  readonly [string, keyof typeof store, (caller: Caller, organizationId?: number) => Promise<unknown>]
> = [
  ["createDraft", "createControlPolicy", (caller, organizationId) => caller.createDraft({ ...draftInput, organizationId })],
  ["approve", "approveControlPolicy", (caller, organizationId) => caller.approve({ organizationId, policyId: 9, approvalReference: "CAB-1" })],
  ["activate", "activateControlPolicy", (caller, organizationId) => caller.activate({ organizationId, policyId: 9 })],
  ["retire", "retireControlPolicy", (caller, organizationId) => caller.retire({ organizationId, policyId: 9, retirementReference: "CAB-2" })],
];

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset().mockResolvedValue({ ok: true });
});

describe("when an operations owner writes to their own tenant's registry", () => {
  it.each(WRITES)("should pass %s to the store for their organisation, with who and from where", async (_name, target, call) => {
    await expect(call(callerAs(operations))).resolves.toEqual({ ok: true });

    expect(store[target]).toHaveBeenCalledTimes(1);
    expect(store[target]).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 42,
        actor: expect.objectContaining({ id: 7, role: "operations" }),
        client: expect.objectContaining({ ua: "vitest" }),
      })
    );
  });

  it("should hand the store a parsed draft: the effective date as a Date, the definition as plain JSON", async () => {
    await callerAs(operations).createDraft(draftInput);

    const { input } = store.createControlPolicy.mock.calls[0][0];
    expect(input.effectiveAt).toEqual(new Date(draftInput.effectiveAt));
    expect(input.definition).toEqual(draftInput.definition);
  });
});

describe("when someone without write authority calls a write", () => {
  const refused: ReadonlyArray<readonly [string, User]> = [
    ["a guest", { ...operations, isGuest: true }],
    ["a CFO", { ...operations, role: "cfo" }],
    ["a compliance officer", { ...operations, role: "compliance" }],
    ["an ordinary user", { ...operations, role: "user" }],
  ];

  for (const [who, user] of refused) {
    it.each(WRITES)(`should refuse %s from ${who} before the store is reached`, async (_name, target, call) => {
      expect(await failureOf(() => call(callerAs(user)))).toMatchObject({ code: "FORBIDDEN" });
      expect(store[target]).not.toHaveBeenCalled();
    });
  }

  it.each(WRITES)("should refuse %s from a read-only reviewer session", async (_name, target, call) => {
    expect(await failureOf(() => call(callerAs({ ...operations, isReadOnly: true })))).toMatchObject({ code: "FORBIDDEN" });
    expect(store[target]).not.toHaveBeenCalled();
  });
});

describe("when a write names an organisation", () => {
  it.each(WRITES)("should refuse %s naming another tenant from a non-staff user", async (_name, target, call) => {
    expect(await failureOf(() => call(callerAs(operations), 99))).toEqual({
      code: "FORBIDDEN",
      message: "Only super admins can act on another organization",
    });
    expect(store[target]).not.toHaveBeenCalled();
  });

  it.each(WRITES)("should pass %s to the named tenant for staff outside any portal", async (_name, target, call) => {
    await call(callerAs(staff), 99);

    expect(store[target]).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 99 }));
  });

  it.each(WRITES)("should refuse %s naming another tenant from inside a portal", async (_name, target, call) => {
    const inPortal = { ...staff, organizationId: 42 };
    expect(await failureOf(() => call(callerAs(inPortal, 42), 99))).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/portal/i),
    });
    expect(store[target]).not.toHaveBeenCalled();
  });
});

describe("when a write's input is not what the registry accepts", () => {
  it("should refuse a retirement date: retirement is recorded when it happens", async () => {
    const caller = callerAs(operations);
    const result = await failureOf(() =>
      caller.retire({ policyId: 9, retirementReference: "CAB-2", retiredAt: "2026-11-01T00:00:00.000Z" } as never)
    );
    expect(result).toMatchObject({ code: "BAD_REQUEST" });
    expect(store.retireControlPolicy).not.toHaveBeenCalled();
  });

  it("should refuse a definition holding a Date, as superjson would deliver one", async () => {
    const result = await failureOf(() =>
      callerAs(operations).createDraft({ ...draftInput, definition: { cutoff: new Date("2026-10-13") } as never })
    );
    expect(result).toMatchObject({ code: "BAD_REQUEST" });
    expect(store.createControlPolicy).not.toHaveBeenCalled();
  });

  it("should refuse a policy key the database collation could not compare as written", async () => {
    const result = await failureOf(() => callerAs(operations).createDraft({ ...draftInput, policyKey: "Settlement CSV" }));
    expect(result).toMatchObject({ code: "BAD_REQUEST" });
    expect(store.createControlPolicy).not.toHaveBeenCalled();
  });
});

describe("when the registry is read", () => {
  it("should list only the caller's tenant, passing the cursor and version through", async () => {
    await callerAs({ ...operations, role: "cfo" }).list({
      policyType: "reconciliation",
      version: 2,
      cursor: { effectiveAt: "2026-10-12T00:00:00.000Z", id: 8 },
    });

    expect(store.listControlPolicies).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        policyType: "reconciliation",
        version: 2,
        cursor: { effectiveAt: new Date("2026-10-12T00:00:00.000Z"), id: 8 },
      })
    );
  });

  it("should read one policy within the caller's tenant", async () => {
    await callerAs(operations).get({ policyId: 9 });
    expect(store.getControlPolicy).toHaveBeenCalledWith(42, 9);
  });

  it("should refuse a read naming another tenant from a non-staff user", async () => {
    expect(await failureOf(() => callerAs(operations).get({ policyId: 9, organizationId: 99 }))).toMatchObject({ code: "FORBIDDEN" });
    expect(store.getControlPolicy).not.toHaveBeenCalled();
  });
});
