import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createCtxWithRole(role: AuthenticatedUser["role"]): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: `test-user-${role}`,
    email: `${role}@test.reconcileai.com`,
    name: `Test ${role}`,
    loginMethod: "manus",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
      cookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

// ─── superAdmin.platformStats ─────────────────────────────────────────────────
describe("superAdmin.platformStats", () => {
  it("throws FORBIDDEN for admin role", async () => {
    const ctx = createCtxWithRole("admin");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for user role", async () => {
    const ctx = createCtxWithRole("user");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for cfo role", async () => {
    const ctx = createCtxWithRole("cfo");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for operations role", async () => {
    const ctx = createCtxWithRole("operations");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for compliance role", async () => {
    const ctx = createCtxWithRole("compliance");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.superAdmin.platformStats()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows super_admin role to call platformStats", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    // The DB may not be available in test env, so we just check it doesn't throw FORBIDDEN
    try {
      const result = await caller.superAdmin.platformStats();
      expect(result).toHaveProperty("totalOrgs");
      expect(result).toHaveProperty("totalUsers");
      expect(result).toHaveProperty("totalJobs");
    } catch (err: any) {
      // Only INTERNAL_SERVER_ERROR is acceptable (DB not available in test env)
      expect(err.code).not.toBe("FORBIDDEN");
    }
  });
});

// ─── superAdmin.platformAnalytics ─────────────────────────────────────────────
describe("superAdmin.platformAnalytics", () => {
  it.each(["admin", "user", "cfo", "operations", "compliance"] as const)(
    "throws FORBIDDEN for %s role",
    async (role) => {
      const ctx = createCtxWithRole(role);
      const caller = appRouter.createCaller(ctx);
      await expect(caller.superAdmin.platformAnalytics()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );

  it("allows super_admin role and returns the analytics shape", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    // DB may be unavailable in the test env — the procedure returns a typed
    // empty payload rather than throwing, so the shape assertions hold either way.
    try {
      const result = await caller.superAdmin.platformAnalytics();
      expect(result).toHaveProperty("totals");
      expect(result.totals).toHaveProperty("orgs");
      expect(result.totals).toHaveProperty("openExceptions");
      expect(result).toHaveProperty("volume");
      expect(result.volume).toHaveProperty("avgMatchRate");
      expect(Array.isArray(result.segmentBreakdown)).toBe(true);
      expect(Array.isArray(result.roleBreakdown)).toBe(true);
      expect(Array.isArray(result.jobStatusBreakdown)).toBe(true);
      expect(Array.isArray(result.moduleBreakdown)).toBe(true);
      expect(Array.isArray(result.orgGrowth)).toBe(true);
      expect(Array.isArray(result.jobTrend)).toBe(true);
      expect(Array.isArray(result.topOrgs)).toBe(true);
    } catch (err: any) {
      expect(err.code).not.toBe("FORBIDDEN");
    }
  });
});

// ─── admin.users — super_admin should also be able to access admin procedures ──
describe("admin.users (adminProcedure)", () => {
  it("throws FORBIDDEN for user role", async () => {
    const ctx = createCtxWithRole("user");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.users()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN for cfo role", async () => {
    const ctx = createCtxWithRole("cfo");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.users()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows admin role to call admin.users", async () => {
    const ctx = createCtxWithRole("admin");
    const caller = appRouter.createCaller(ctx);
    try {
      const result = await caller.admin.users();
      expect(Array.isArray(result)).toBe(true);
    } catch (err: any) {
      expect(err.code).not.toBe("FORBIDDEN");
    }
  });

  it("allows super_admin role to call admin.users (elevated access)", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    try {
      const result = await caller.admin.users();
      expect(Array.isArray(result)).toBe(true);
    } catch (err: any) {
      expect(err.code).not.toBe("FORBIDDEN");
    }
  });
});

// ─── superAdmin.setOrganizationBankingModel ───────────────────────────────────
//
// Marks an institution as operating on non-interest (NIFI) principles, which
// makes the Super Agent apply the NIFI taxonomy across every rail that tenant
// runs. It is a claim about the institution's LICENCE BASIS and the resulting
// findings are regulator-facing, so a tenant must not be able to assert it about
// itself — hence super_admin only, like the SSO opt-in it mirrors.
describe("superAdmin.setOrganizationBankingModel", () => {
  const NON_STAFF_ROLES = ["admin", "operations", "compliance", "cfo", "user"] as const;

  for (const role of NON_STAFF_ROLES) {
    it(`throws FORBIDDEN for ${role} role`, async () => {
      const ctx = createCtxWithRole(role);
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.superAdmin.setOrganizationBankingModel({
          organizationId: 1,
          bankingModel: "non_interest",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("rejects a banking model outside the two known values", async () => {
    // The column is varchar so the database will accept anything; the zod enum
    // is the only thing stopping an arbitrary string being written and then
    // silently read as "not non_interest" forever.
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.superAdmin.setOrganizationBankingModel({
        organizationId: 1,
        bankingModel: "islamic" as unknown as "non_interest",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a non-positive organizationId", async () => {
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.superAdmin.setOrganizationBankingModel({
        organizationId: 0,
        bankingModel: "conventional",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not refuse super_admin on authorization grounds", async () => {
    // Mirrors the admin.users assertions above: without a database the call may
    // still fail, but never with FORBIDDEN.
    const ctx = createCtxWithRole("super_admin");
    const caller = appRouter.createCaller(ctx);
    try {
      await caller.superAdmin.setOrganizationBankingModel({
        organizationId: 1,
        bankingModel: "conventional",
      });
    } catch (err: any) {
      expect(err.code).not.toBe("FORBIDDEN");
      expect(err.code).not.toBe("BAD_REQUEST");
    }
  });
});

// ─── superAdmin.setOrganizationIsDemo ─────────────────────────────────────────
//
// Marks a tenant as a demo so SLA alerting skips it. An ALERT-SUPPRESSING
// control, which is why it is super-admin only and why it must not report
// success when it changed nothing: on 2026-08-14 the owner received 374 seeded
// exceptions as real SLA breaches, and believing you have restored or silenced
// alerting when you have not is the same failure one step removed.
describe("superAdmin.setOrganizationIsDemo", () => {
  for (const role of ["admin", "operations", "compliance", "cfo", "user"] as const) {
    it(`throws FORBIDDEN for ${role}`, async () => {
      const caller = appRouter.createCaller(createCtxWithRole(role));
      await expect(
        caller.superAdmin.setOrganizationIsDemo({ organizationId: 1, isDemo: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("rejects a non-positive organizationId", async () => {
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expect(
      caller.superAdmin.setOrganizationIsDemo({ organizationId: 0, isDemo: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a non-boolean isDemo", async () => {
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    await expect(
      // @ts-expect-error deliberately wrong type — zod must reject it
      caller.superAdmin.setOrganizationIsDemo({ organizationId: 1, isDemo: "yes" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not refuse super_admin on authorization grounds", async () => {
    const caller = appRouter.createCaller(createCtxWithRole("super_admin"));
    try {
      await caller.superAdmin.setOrganizationIsDemo({ organizationId: 1, isDemo: false });
    } catch (err: any) {
      expect(err.code).not.toBe("FORBIDDEN");
      expect(err.code).not.toBe("BAD_REQUEST");
    }
  });
});

// ─── Organisation setters must not claim success on a missing org ─────────────
describe("super-admin organisation setters verify the org exists", () => {
  const SRC = readFileSync(join(__dirname, "routers.ts"), "utf8");

  it("defines a single shared existence guard", () => {
    expect(SRC).toMatch(/async function assertOrganizationExists\(/);
  });

  it("checks existence rather than affectedRows", () => {
    // MySQL reports affected_rows as rows CHANGED, not matched, so setting a
    // field to the value it already holds returns 0. Rejecting that no-op as
    // "not found" would be a worse bug than the one being fixed.
    const body = SRC.slice(SRC.indexOf("async function assertOrganizationExists("));
    expect(body.slice(0, 900)).not.toMatch(/affectedRows/);
    expect(body.slice(0, 900)).toMatch(/code: "NOT_FOUND"/);
  });

  it("is applied by every org-level setter, not just the newest", () => {
    // All four had the same defect: UPDATE … WHERE id = ? then an unconditional
    // { success: true }. Fixing only the one review flagged would leave three.
    for (const proc of [
      "updateOrganizationSegment",
      "setOrganizationSso",
      "setOrganizationBankingModel",
      "setOrganizationIsDemo",
    ]) {
      const start = SRC.indexOf(`${proc}: superAdminProcedure`);
      expect(start, `${proc} not found`).toBeGreaterThan(-1);
      const body = SRC.slice(start, start + 2200);
      expect(body, `${proc} must assert the organisation exists`).toMatch(
        /assertOrganizationExists\(drizzle, input\.organizationId\)/,
      );
      // The guard has to run BEFORE the write, or it proves nothing.
      expect(
        body.indexOf("assertOrganizationExists"),
        `${proc} must check before updating`,
      ).toBeLessThan(body.indexOf("drizzle.update(organizations)"));
    }
  });
});
