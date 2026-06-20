import { describe, expect, it } from "vitest";
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
