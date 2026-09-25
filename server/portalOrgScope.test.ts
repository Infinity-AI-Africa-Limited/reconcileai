/**
 * An explicit organizationId override, inside a tenant's portal.
 *
 * PR #141 narrowed staff by-id reach to the tenant on screen (canActOnTenant,
 * assertCanManageUsers, tenancy.assertSameOrg), but resolveOrgScope — the gate
 * every "act on this organisation" override passes through — still let a super
 * admin name ANY tenant from inside a portal. A stale link or stale client
 * state naming tenant B, sent from tenant A's portal, then read or wrote B's
 * data under A's banner. resolveOrgScope now applies the same portal rule.
 *
 * Two layers:
 *   - the GATE, as a truth table, inside real request scopes — this is the rule
 *     for every caller, present and future;
 *   - each router that calls it, through its REAL base procedure, which is what
 *     binds the portal into the request scope. A router whose procedures did not
 *     bind it would pass the gate tests and still be open.
 *
 * SHOPLINE's override-taking procedures are rostered in shoplinePortalScope.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import { runInRequestScope } from "./_core/requestScope";
import { resolveOrgScope } from "./_core/tenancy";
import { controlFitRouter } from "./routers/controlFit";
import { corporateB2BPilotRouter } from "./routers/corporateB2BPilot";
import { lapoRouter } from "./routers/lapo";
import { ugandaRouter } from "./routers/uganda";

const TENANT_A = 42;
const TENANT_B = 60001;
const PORTAL_REFUSAL = /portal/i;

/** Run inside a request scope, as the base procedure does for every tRPC call. */
function inScope<T>(portal: number | null, run: () => T): T {
  return runInRequestScope({ portalOrganizationId: portal, auditOrganizationId: portal }, run);
}

function failureOf(run: () => unknown): { code: string | null; message: string | null } {
  try {
    run();
    return { code: null, message: null };
  } catch (err) {
    return err instanceof TRPCError ? { code: err.code, message: err.message } : { code: "NON_TRPC", message: String(err) };
  }
}

async function asyncFailureOf(run: () => Promise<unknown>): Promise<{ code: string | null; message: string | null }> {
  try {
    await run();
    return { code: null, message: null };
  } catch (err) {
    return err instanceof TRPCError ? { code: err.code, message: err.message } : { code: "NON_TRPC", message: String(err) };
  }
}

const staff = (organizationId: number | null) => ({ role: "super_admin", organizationId });

describe("resolveOrgScope — the gate", () => {
  describe("when staff are inside a tenant's portal", () => {
    // applyPortalView has already made the portal tenant their organisation.
    it("should refuse an override naming a different organisation", () => {
      const refusal = failureOf(() => inScope(TENANT_A, () => resolveOrgScope(staff(TENANT_A), TENANT_B)));
      expect(refusal.code).toBe("FORBIDDEN");
      expect(refusal.message).toMatch(PORTAL_REFUSAL);
    });

    it("should honour an override naming the tenant on screen", () => {
      expect(inScope(TENANT_A, () => resolveOrgScope(staff(TENANT_A), TENANT_A))).toBe(TENANT_A);
    });

    it("should resolve to the tenant on screen when no override is given", () => {
      expect(inScope(TENANT_A, () => resolveOrgScope(staff(TENANT_A)))).toBe(TENANT_A);
    });
  });

  describe("when staff are outside any portal", () => {
    it("should honour an override naming any organisation, as before", () => {
      expect(inScope(null, () => resolveOrgScope(staff(1), TENANT_B))).toBe(TENANT_B);
    });

    it("should behave the same outside any tRPC call (no request scope at all)", () => {
      // Background jobs and non-tRPC routes have no scope; nothing narrows them.
      expect(resolveOrgScope(staff(1), TENANT_B)).toBe(TENANT_B);
    });
  });

  describe("when the caller is not staff", () => {
    it.each(["admin", "user", "operations", "cfo", "compliance"])(
      "should refuse %s any override, inside a portal scope or not",
      (role) => {
        for (const portal of [null, TENANT_A]) {
          const refusal = failureOf(() => inScope(portal, () => resolveOrgScope({ role, organizationId: TENANT_A }, TENANT_B)));
          expect(refusal.code).toBe("FORBIDDEN");
          expect(refusal.message).toMatch(/only super admins/i);
        }
      },
    );

    it("should lock them to their own organisation without an override", () => {
      expect(inScope(null, () => resolveOrgScope({ role: "admin", organizationId: TENANT_A }))).toBe(TENANT_A);
    });

    it("should refuse an account with no organisation rather than resolve to something", () => {
      expect(failureOf(() => resolveOrgScope({ role: "admin", organizationId: null })).code).toBe("PRECONDITION_FAILED");
    });
  });
});

type Ctx = { user: Record<string, unknown> | null; viewingAs: number | null };

/** What the context would be for staff inside `portal` (applyPortalView sets both). */
const staffInPortal = (portal: number): Ctx => ({
  user: { id: 7, role: "super_admin", organizationId: portal, isReadOnly: false, email: "staff@example.com" },
  viewingAs: portal,
});
const staffOutsidePortal = (): Ctx => ({
  user: { id: 7, role: "super_admin", organizationId: 1, isReadOnly: false, email: "staff@example.com" },
  viewingAs: null,
});

const withReqRes = (ctx: Ctx) => ({ ...ctx, req: { headers: {}, ip: "127.0.0.1" }, res: {} }) as never;

/**
 * Every override-taking procedure these routers expose to staff, with a valid
 * input. Inputs are valid on purpose: a BAD_REQUEST would prove nothing about
 * scope. LAPO's and Uganda's ingestFile/ingestEvents are absent because
 * adminProcedure admits role "admin" only — a super admin never reaches their
 * override (see the PR description).
 */
const OVERRIDE_CALLS: ReadonlyArray<readonly [string, (ctx: Ctx, organizationId: number) => Promise<unknown>]> = [
  ["controlFit.get", (ctx, organizationId) => controlFitRouter.createCaller(withReqRes(ctx)).get({ organizationId })],
  [
    "controlFit.save",
    (ctx, organizationId) =>
      controlFitRouter.createCaller(withReqRes(ctx)).save({
        organizationId,
        workflowName: "Settlement break review",
        operationalProblem: "Breaks take too long to evidence at close.",
        accountableOwner: "Operations owner",
        decisionDeadline: "Before cut-off",
        approvedEvidence: ["Core-banking extract"],
        baseline: "To be confirmed",
        successMeasure: "Fewer unresolved breaks",
        status: "draft",
      }),
  ],
  ["corporateB2BPilot.readiness", (ctx, organizationId) => corporateB2BPilotRouter.createCaller(withReqRes(ctx)).readiness({ organizationId })],
  [
    "corporateB2BPilot.updateConfig",
    (ctx, organizationId) =>
      corporateB2BPilotRouter.createCaller(withReqRes(ctx)).updateConfig({
        organizationId,
        country: "nigeria",
        pilotState: "preparation",
        noWriteAcknowledged: true,
        aiAssistanceMode: "disabled",
        dataContractStatus: "draft",
        rosterStatus: "draft",
        allocationPolicyStatus: "draft",
        operationalRecoveryStatus: "not_tested",
        retentionDays: 30,
        contractStatus: "draft",
        dataProcessingStatus: "draft",
      }),
  ],
  [
    "corporateB2BPilot.createSource",
    (ctx, organizationId) =>
      corporateB2BPilotRouter
        .createCaller(withReqRes(ctx))
        .createSource({ organizationId, sourceType: "invoice_ar", displayName: "AR export", deliveryMethod: "manual_export" }),
  ],
  [
    "corporateB2BPilot.updateSourceStatus",
    (ctx, organizationId) =>
      corporateB2BPilotRouter
        .createCaller(withReqRes(ctx))
        .updateSourceStatus({ organizationId, id: 1, status: "draft", customerOwnedCredentials: false, controlTotalRequired: false }),
  ],
  ["corporateB2BPilot.deleteSource", (ctx, organizationId) => corporateB2BPilotRouter.createCaller(withReqRes(ctx)).deleteSource({ organizationId, id: 1 })],
  ["lapo.dailyCompleteness", (ctx, organizationId) => lapoRouter.createCaller(withReqRes(ctx)).dailyCompleteness({ date: "2026-09-22", organizationId })],
  ["uganda.dailyCompleteness", (ctx, organizationId) => ugandaRouter.createCaller(withReqRes(ctx)).dailyCompleteness({ date: "2026-09-22", organizationId })],
];

describe("each router's procedures, through their real base procedure", () => {
  it.each(OVERRIDE_CALLS)("should refuse %s naming another tenant from inside a portal", async (_name, run) => {
    const refusal = await asyncFailureOf(() => run(staffInPortal(TENANT_A), TENANT_B));
    expect(refusal.code).toBe("FORBIDDEN");
    // The portal refusal specifically — not a later check that happens to say FORBIDDEN.
    expect(refusal.message).toMatch(PORTAL_REFUSAL);
  });

  it.each(OVERRIDE_CALLS)("should not refuse %s on scope grounds for the tenant on screen", async (_name, run) => {
    const outcome = await asyncFailureOf(() => run(staffInPortal(TENANT_A), TENANT_A));
    expect(outcome.message ?? "").not.toMatch(PORTAL_REFUSAL);
    expect(outcome.message ?? "").not.toMatch(/only super admins/i);
  });

  it.each(OVERRIDE_CALLS)("should not refuse %s on scope grounds outside a portal", async (_name, run) => {
    const outcome = await asyncFailureOf(() => run(staffOutsidePortal(), TENANT_B));
    expect(outcome.message ?? "").not.toMatch(PORTAL_REFUSAL);
    expect(outcome.message ?? "").not.toMatch(/only super admins/i);
  });

  it("should refuse before the database is consulted, so an outage cannot turn FORBIDDEN into a 500", async () => {
    // DATABASE_URL is empty here: a handler that opened the connection first
    // would answer INTERNAL_SERVER_ERROR. Every refusal above is FORBIDDEN.
    for (const [name, run] of OVERRIDE_CALLS) {
      const refusal = await asyncFailureOf(() => run(staffInPortal(TENANT_A), TENANT_B));
      expect(refusal.code, name).toBe("FORBIDDEN");
    }
  });
});
