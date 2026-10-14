/**
 * Every exception-workflow procedure, called through its real base procedure:
 * role gates, the writer rule, input parsing and tenant resolution run as in
 * production; only the service and the after-close effects are replaced. The
 * service's own rules are pinned in ../exceptionWorkflow.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const service = vi.hoisted(() => ({
  getExceptionWorkflow: vi.fn(),
  listExceptionWorkflowOwners: vi.fn(),
  startExceptionWorkflow: vi.fn(),
  updateExceptionWorkflowOwnership: vi.fn(),
  escalateExceptionWorkflow: vi.fn(),
  recordExceptionWorkflowDecision: vi.fn(),
  approveExceptionWorkflowDecision: vi.fn(),
  resolveExceptionWorkflow: vi.fn(),
}));
const effects = vi.hoisted(() => ({ afterExceptionClosed: vi.fn() }));

vi.mock("../exceptionWorkflow", () => service);
vi.mock("../exceptionClosureEffects", () => effects);

import { exceptionWorkflowRouter } from "./exceptionWorkflow";

type User = { id: number; role: string; organizationId: number | null; isGuest: boolean; isReadOnly: boolean; email: string };

const operations: User = { id: 7, role: "operations", organizationId: 42, isGuest: false, isReadOnly: false, email: "ops@example.com" };
const staff: User = { ...operations, id: 1, role: "super_admin", organizationId: 1, email: "staff@example.com" };

function callerAs(user: User, viewingAs: number | null = null) {
  return exceptionWorkflowRouter.createCaller({
    user,
    viewingAs,
    req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" },
    res: {},
  } as never);
}

function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => ({ code: null, message: null }),
    error => (error instanceof TRPCError ? { code: error.code, message: error.message } : { code: "UNKNOWN", message: String(error) })
  );
}

const DUE = new Date("2099-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");
type Caller = ReturnType<typeof callerAs>;

/** Every write, with a valid input, and the service function it must reach. */
const WRITES: ReadonlyArray<readonly [string, keyof typeof service, (caller: Caller, organizationId?: number) => Promise<unknown>]> = [
  ["start", "startExceptionWorkflow", (c, organizationId) => c.start({ organizationId, exceptionId: 5, ownerUserId: 8, dueAt: FUTURE, approvalRequired: true })],
  ["updateOwnership", "updateExceptionWorkflowOwnership", (c, organizationId) => c.updateOwnership({ organizationId, exceptionId: 5, ownerUserId: 8, dueAt: FUTURE })],
  ["escalate", "escalateExceptionWorkflow", (c, organizationId) => c.escalate({ organizationId, exceptionId: 5, note: "Overdue" })],
  ["recordDecision", "recordExceptionWorkflowDecision", (c, organizationId) => c.recordDecision({ organizationId, exceptionId: 5, rationale: "Timing", evidenceReference: "CASE-1" })],
  ["approveDecision", "approveExceptionWorkflowDecision", (c, organizationId) => c.approveDecision({ organizationId, exceptionId: 5, approvalNote: "Checked" })],
  ["resolve", "resolveExceptionWorkflow", (c, organizationId) => c.resolve({ organizationId, exceptionId: 5, outcome: "resolved", resolutionNotes: "Done" })],
];
/** The owner list is read-only but writer-only: it lists colleagues' email addresses. */
const WRITER_ONLY = [...WRITES, ["owners", "listExceptionWorkflowOwners", (c: Caller, organizationId?: number) => c.owners({ organizationId })] as const];

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true });
  effects.afterExceptionClosed.mockReset().mockResolvedValue(undefined);
});

describe("when an operations owner works their own tenant's workflow", () => {
  it.each(WRITES)("should pass %s to the service for their organisation, with who and from where", async (_name, target, call) => {
    await expect(call(callerAs(operations))).resolves.toEqual({ ok: true });
    expect(service[target]).toHaveBeenCalledTimes(1);
    expect(service[target]).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 42,
        exceptionId: 5,
        actor: expect.objectContaining({ id: 7 }),
        client: expect.objectContaining({ ua: "vitest" }),
      })
    );
  });

  it("should list eligible owners for their organisation", async () => {
    await callerAs(operations).owners({});
    expect(service.listExceptionWorkflowOwners).toHaveBeenCalledWith(42);
  });

  it("should read a workflow for their organisation", async () => {
    await callerAs(operations).get({ exceptionId: 5 });
    expect(service.getExceptionWorkflow).toHaveBeenCalledWith(42, 5);
  });
});

describe("when a governed workflow closes", () => {
  it("should run the closure's after-effects once the service has committed", async () => {
    await callerAs(operations).resolve({ exceptionId: 5, outcome: "dismissed", resolutionNotes: "Duplicate" });
    expect(effects.afterExceptionClosed).toHaveBeenCalledWith({
      organizationId: 42, exceptionId: 5, userId: 7, outcome: "dismissed", resolutionNotes: "Duplicate",
    });
    expect(service.resolveExceptionWorkflow.mock.invocationCallOrder[0]).toBeLessThan(effects.afterExceptionClosed.mock.invocationCallOrder[0]);
  });

  it("should run no after-effects when the service refuses the closure", async () => {
    service.resolveExceptionWorkflow.mockRejectedValue(new TRPCError({ code: "PRECONDITION_FAILED", message: "Not ready" }));
    expect(await failureOf(() => callerAs(operations).resolve({ exceptionId: 5, outcome: "resolved", resolutionNotes: "x" }))).toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(effects.afterExceptionClosed).not.toHaveBeenCalled();
  });
});

describe("when someone without write authority calls a writer-only procedure", () => {
  const refused: ReadonlyArray<readonly [string, User]> = [
    ["a guest", { ...operations, isGuest: true }],
    ["a CFO", { ...operations, role: "cfo" }],
    ["a compliance officer", { ...operations, role: "compliance" }],
    ["an ordinary user", { ...operations, role: "user" }],
    ["a read-only reviewer session", { ...operations, isReadOnly: true }],
  ];

  for (const [who, user] of refused) {
    it.each(WRITER_ONLY)(`should refuse %s from ${who} before the service is reached`, async (_name, target, call) => {
      expect(await failureOf(() => call(callerAs(user)))).toMatchObject({ code: "FORBIDDEN" });
      expect(service[target]).not.toHaveBeenCalled();
    });
  }

  it("should still let a read-only role read the workflow itself", async () => {
    await callerAs({ ...operations, role: "cfo" }).get({ exceptionId: 5 });
    expect(service.getExceptionWorkflow).toHaveBeenCalledWith(42, 5);
  });
});

describe("when a call names an organisation", () => {
  it.each(WRITES)("should refuse %s naming another tenant from a non-staff user", async (_name, target, call) => {
    expect(await failureOf(() => call(callerAs(operations), 99))).toEqual({
      code: "FORBIDDEN",
      message: "Only super admins can act on another organization",
    });
    expect(service[target]).not.toHaveBeenCalled();
  });

  it.each(WRITES)("should pass %s to the named tenant for staff outside any portal", async (_name, target, call) => {
    await call(callerAs(staff), 99);
    expect(service[target]).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 99 }));
  });

  it.each(WRITES)("should refuse %s naming another tenant from inside a portal", async (_name, target, call) => {
    expect(await failureOf(() => call(callerAs({ ...staff, organizationId: 42 }, 42), 99))).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/portal/i),
    });
    expect(service[target]).not.toHaveBeenCalled();
  });

  it("should refuse a read naming another tenant from a non-staff user", async () => {
    expect(await failureOf(() => callerAs(operations).get({ exceptionId: 5, organizationId: 99 }))).toMatchObject({ code: "FORBIDDEN" });
    expect(service.getExceptionWorkflow).not.toHaveBeenCalled();
  });

  it("should refuse conflicting organisation and portal-view scopes", async () => {
    expect(await failureOf(() => callerAs(staff).get({ exceptionId: 5, organizationId: 98, viewAsOrgId: 99 }))).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("when a write's input is not what a workflow accepts", () => {
  it("should refuse a due date the database cannot store, before the service", async () => {
    expect(await failureOf(() => callerAs(operations).start({ exceptionId: 5, ownerUserId: 8, dueAt: DUE, approvalRequired: true }))).toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(service.startExceptionWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty escalation note", (c: Caller) => c.escalate({ exceptionId: 5, note: "   " })],
    ["an empty evidence reference", (c: Caller) => c.recordDecision({ exceptionId: 5, rationale: "r", evidenceReference: "" })],
    ["an unknown outcome", (c: Caller) => c.resolve({ exceptionId: 5, outcome: "deleted" as never, resolutionNotes: "x" })],
  ])("should refuse %s", async (_label, call) => {
    expect(await failureOf(() => call(callerAs(operations)))).toMatchObject({ code: "BAD_REQUEST" });
  });
});
