/**
 * Tests for the template auto-filter preference behaviour.
 *
 * The filter preference is stored in localStorage under the key
 * "reconcileai_template_autofilter". These tests verify the backend
 * resolutionTemplates.list procedure correctly handles the category
 * filter being present, absent, or explicitly cleared (undefined input).
 */
import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(orgId: number | null = null): { ctx: TrpcContext } {
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
    organizationId: orgId,
    isActive: true,
    isGuest: false,
  };
  const ctx: TrpcContext = {
    user,
    req: { headers: { "x-forwarded-for": "127.0.0.1", "user-agent": "vitest" }, ip: "127.0.0.1" } as any,
    res: { clearCookie: vi.fn(), cookie: vi.fn() } as any,
  };
  return { ctx };
}

describe("Template auto-filter — resolutionTemplates.list category behaviour", () => {
  it("returns all org templates when no category is passed (filter cleared / disabled)", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const allTemplates = await caller.resolutionTemplates.list(undefined);
    expect(Array.isArray(allTemplates)).toBe(true);
  });

  it("returns only amount_mismatch templates when filter is ON and category is amount_mismatch", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const filtered = await caller.resolutionTemplates.list({ category: "amount_mismatch" });
    expect(Array.isArray(filtered)).toBe(true);
    filtered.forEach((t: any) => expect(t.category).toBe("amount_mismatch"));
  });

  it("returns only missing_counterparty templates when filter is ON and category is missing_counterparty", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const filtered = await caller.resolutionTemplates.list({ category: "missing_counterparty" });
    expect(Array.isArray(filtered)).toBe(true);
    filtered.forEach((t: any) => expect(t.category).toBe("missing_counterparty"));
  });

  it("returns only timing_difference templates when filter is ON and category is timing_difference", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const filtered = await caller.resolutionTemplates.list({ category: "timing_difference" });
    expect(Array.isArray(filtered)).toBe(true);
    filtered.forEach((t: any) => expect(t.category).toBe("timing_difference"));
  });

  it("filtered result is a subset of the unfiltered result", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const all = await caller.resolutionTemplates.list(undefined);
    const filtered = await caller.resolutionTemplates.list({ category: "unmatched" });
    // Every filtered template must appear in the full list
    const allIds = new Set(all.map((t: any) => t.id));
    filtered.forEach((t: any) => expect(allIds.has(t.id)).toBe(true));
  });

  it("passing an empty object (no category key) returns all templates", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.resolutionTemplates.list({});
    expect(Array.isArray(result)).toBe(true);
  });
});
