import { describe, expect, it, vi, beforeEach } from "vitest";
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

describe("exceptions.moveToReview procedure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should be defined in the router", () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    // Verify the procedure exists and is callable
    expect(typeof caller.exceptions.moveToReview).toBe("function");
  });

  it("should reject calls without authentication", async () => {
    const unauthCtx: TrpcContext = {
      user: null,
      req: {
        headers: {},
        ip: "127.0.0.1",
      } as any,
      res: { clearCookie: vi.fn(), cookie: vi.fn() } as any,
    };
    const caller = appRouter.createCaller(unauthCtx);
    await expect(
      caller.exceptions.moveToReview({ id: 1 })
    ).rejects.toThrow();
  });

  it("should reject invalid input (non-positive id)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.exceptions.moveToReview({ id: -1 })
    ).rejects.toThrow();
  });

  it("should reject notes exceeding 2000 characters", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.exceptions.moveToReview({ id: 1, notes: "x".repeat(2001) })
    ).rejects.toThrow();
  });
});
