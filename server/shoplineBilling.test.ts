/**
 * SHOPLINE Billing Webhook & Subscription Management Tests
 *
 * Tests for PR #4: billing webhook handler, subscription state management,
 * and billing topic routing through the main webhook dispatcher.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { processBillingWebhook, hasActiveSubscription, getStoreSubscription } from "./connectors/shopline/billingWebhook";
import { SHOPLINE_BILLING_WEBHOOK_TOPICS, TIER_1_SUBSCRIPTION_BANDS, SHOPLINE_WEBHOOK_TOPICS } from "../shared/shoplineConstants";

// ─── Constants validation ─────────────────────────────────────────────────────

describe("SHOPLINE Billing Constants (confirmed portal settings)", () => {
  it("defines 5 billing/lifecycle webhook topics matching portal", () => {
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toHaveLength(5);
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("app_plan/activated");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("app_plan/expired");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("billing_attempts/succeed");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("billing_attempts/fail");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("app/installation_status_changed");
  });

  it("subscription bands match confirmed portal pricing (7-day trial)", () => {
    expect(TIER_1_SUBSCRIPTION_BANDS).toHaveLength(5);

    const starter = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === "starter");
    expect(starter).toBeDefined();
    expect(starter!.monthlyPriceUsd).toBe(29);

    const growth = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === "growth");
    expect(growth).toBeDefined();
    expect(growth!.monthlyPriceUsd).toBe(79);

    const professional = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === "professional");
    expect(professional).toBeDefined();
    expect(professional!.monthlyPriceUsd).toBe(149);

    const scale = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === "enterprise");
    expect(scale).toBeDefined();
    expect(scale!.monthlyPriceUsd).toBe(299);

    const enterprise = TIER_1_SUBSCRIPTION_BANDS.find((b) => b.spuKey === "enterprise_plus");
    expect(enterprise).toBeDefined();
    expect(enterprise!.monthlyPriceUsd).toBe(499);
  });

  it("all bands have maxOrders defined", () => {
    for (const band of TIER_1_SUBSCRIPTION_BANDS) {
      expect(band.maxOrders).toBeGreaterThan(0);
    }
  });
});

// ─── Billing webhook dispatcher ───────────────────────────────────────────────

describe("processBillingWebhook dispatcher", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue([{ insertId: 1 }]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chain mocks
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.insert.mockReturnThis();
    mockDb.values.mockResolvedValue([{ insertId: 1 }]);
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
  });

  it("handles app_plan/activated with correct payload shape", async () => {
    const payload = {
      plan_key: "starter",
      plan_name: "Starter",
      price: "29.00",
      currency: "USD",
      billing_cycle: "monthly",
      activated_at: "2026-07-19T10:00:00Z",
      trial_ends_at: "2026-07-26T10:00:00Z",
    };

    // Should not throw
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "app_plan/activated", payload),
    ).resolves.not.toThrow();
  });

  it("handles app_plan/expired", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "app_plan/expired", {
        plan_key: "starter",
        expired_at: "2026-08-19T10:00:00Z",
      }),
    ).resolves.not.toThrow();
  });

  it("handles billing_attempts/succeed", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "billing_attempts/succeed", {
        plan_key: "growth",
        amount: "79.00",
        currency: "USD",
        paid_at: "2026-08-19T10:00:00Z",
      }),
    ).resolves.not.toThrow();
  });

  it("handles billing_attempts/fail", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "billing_attempts/fail", {
        plan_key: "growth",
        amount: "79.00",
        currency: "USD",
        failed_at: "2026-08-19T10:00:00Z",
        reason: "insufficient_funds",
      }),
    ).resolves.not.toThrow();
  });

  it("handles app/installation_status_changed", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "app/installation_status_changed", {
        status: "uninstalled",
        uninstalled_at: "2026-08-19T10:00:00Z",
      }),
    ).resolves.not.toThrow();
  });

  it("logs warning for unknown billing topic", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processBillingWebhook(mockDb as any, 1, 1, "unknown/topic", {});
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown billing topic"),
    );
    consoleSpy.mockRestore();
  });
});

// ─── Subscription query helpers ───────────────────────────────────────────────

describe("Subscription query helpers", () => {
  it("hasActiveSubscription returns false when no subscription exists", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const result = await hasActiveSubscription(mockDb as any, 999);
    expect(result).toBe(false);
  });

  it("hasActiveSubscription returns true for active status", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ status: "active", planKey: "starter" }]),
    };
    const result = await hasActiveSubscription(mockDb as any, 1);
    expect(result).toBe(true);
  });

  it("hasActiveSubscription returns true for trialing status", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ status: "trialing", planKey: "growth" }]),
    };
    const result = await hasActiveSubscription(mockDb as any, 1);
    expect(result).toBe(true);
  });

  it("hasActiveSubscription returns false for expired status", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ status: "expired", planKey: "starter" }]),
    };
    const result = await hasActiveSubscription(mockDb as any, 1);
    expect(result).toBe(false);
  });

  it("getStoreSubscription returns null when no subscription", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const result = await getStoreSubscription(mockDb as any, 999);
    expect(result).toBeNull();
  });

  it("getStoreSubscription returns subscription when exists", async () => {
    const sub = { id: 1, slStoreId: 1, planKey: "growth", status: "active" };
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([sub]),
    };
    const result = await getStoreSubscription(mockDb as any, 1);
    expect(result).toEqual(sub);
  });
});

// ─── Webhook topic routing integration ────────────────────────────────────────

describe("Webhook topic routing (billing topics through main dispatcher)", () => {
  it("SHOPLINE_BILLING_WEBHOOK_TOPICS are all valid strings", () => {
    for (const topic of SHOPLINE_BILLING_WEBHOOK_TOPICS) {
      expect(typeof topic).toBe("string");
      expect(topic.length).toBeGreaterThan(0);
      expect(topic).toMatch(/^[a-z_/]+$/);
    }
  });

  it("billing topics do not overlap with reconciliation topics", () => {
    for (const billingTopic of SHOPLINE_BILLING_WEBHOOK_TOPICS) {
      expect(SHOPLINE_WEBHOOK_TOPICS).not.toContain(billingTopic);
    }
  });
});
