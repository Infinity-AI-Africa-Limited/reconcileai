import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    organizationId: null,
    isActive: true,
    isGuest: false,
  };
  const ctx: TrpcContext = {
    user,
    req: {
      headers: { "x-forwarded-for": "127.0.0.1", "user-agent": "vitest" },
      ip: "127.0.0.1",
    } as any,
    res: { clearCookie: vi.fn(), cookie: vi.fn() } as any,
  };
  return { ctx };
}

describe("resolutionTemplates.list procedure", () => {
  it("should be defined in the router", () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    expect(typeof caller.resolutionTemplates.list).toBe("function");
  });

  it("should accept no input (returns all templates for org)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    // Should not throw; returns an array
    const result = await caller.resolutionTemplates.list(undefined);
    expect(Array.isArray(result)).toBe(true);
  });

  it("should accept a valid category filter", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.resolutionTemplates.list({ category: "amount_mismatch" });
    expect(Array.isArray(result)).toBe(true);
    // All returned templates must match the requested category
    result.forEach((t: any) => {
      expect(t.category).toBe("amount_mismatch");
    });
  });

  it("should accept all valid category values", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const categories = [
      "unmatched",
      "missing_counterparty",
      "amount_mismatch",
      "timing_difference",
      "duplicate_transaction",
      "reversal_unmatched",
      "currency_mismatch",
      "format_error",
    ] as const;
    for (const category of categories) {
      const result = await caller.resolutionTemplates.list({ category });
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it("should reject an invalid category value", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.resolutionTemplates.list({ category: "invalid_category" as any })
    ).rejects.toThrow();
  });

  it("should reject unauthenticated requests", async () => {
    const unauthCtx: TrpcContext = {
      user: null,
      req: { headers: {}, ip: "127.0.0.1" } as any,
      res: { clearCookie: vi.fn(), cookie: vi.fn() } as any,
    };
    const caller = appRouter.createCaller(unauthCtx);
    await expect(caller.resolutionTemplates.list(undefined)).rejects.toThrow();
  });
});
