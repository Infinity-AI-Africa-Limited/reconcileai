/**
 * SHOPLINE Billing Webhook & Subscription Management Tests
 *
 * Tests for PR #4: billing webhook handler, subscription state management,
 * and billing topic routing through the main webhook dispatcher.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { processBillingWebhook, hasActiveSubscription, getStoreSubscription, isSyncBlockedBySubscription } from "./connectors/shopline/billingWebhook";
import { SHOPLINE_BILLING_WEBHOOK_TOPICS, TIER_1_SUBSCRIPTION_BANDS, SHOPLINE_WEBHOOK_TOPICS } from "../shared/shoplineConstants";

// ─── Constants validation ─────────────────────────────────────────────────────

describe("SHOPLINE Billing Constants (confirmed portal settings)", () => {
  it("defines the 3 REAL appsubscription topics (not the invented app_plan/* names)", () => {
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toHaveLength(3);
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("appsubscription/create");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("appsubscription/paid");
    expect(SHOPLINE_BILLING_WEBHOOK_TOPICS).toContain("appsubscription/expiration");
    // Regression guard: these never existed on SHOPLINE and matched nothing.
    for (const bogus of [
      "app_plan/activated",
      "app_plan/expired",
      "billing_attempts/succeed",
      "billing_attempts/fail",
      "app/installation_status_changed",
    ]) {
      expect(SHOPLINE_BILLING_WEBHOOK_TOPICS as readonly string[]).not.toContain(bogus);
    }
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

  it("plan limits (orders/stores) match the portal model exactly", () => {
    const byKey = Object.fromEntries(TIER_1_SUBSCRIPTION_BANDS.map((b) => [b.spuKey, b]));
    // [maxOrders, maxStores]
    expect([byKey.starter.maxOrders, byKey.starter.maxStores]).toEqual([500, 1]);
    expect([byKey.growth.maxOrders, byKey.growth.maxStores]).toEqual([2_000, 3]);
    expect([byKey.professional.maxOrders, byKey.professional.maxStores]).toEqual([10_000, 5]);
    expect([byKey.enterprise.maxOrders, byKey.enterprise.maxStores]).toEqual([50_000, 10]);
    expect(byKey.enterprise_plus.maxOrders).toBe(Infinity);
    expect(byKey.enterprise_plus.maxStores).toBe(Infinity);
  });

  it("annual prices are 10× monthly per the portal model", () => {
    for (const band of TIER_1_SUBSCRIPTION_BANDS) {
      expect(band.annualPriceUsd).toBe(band.monthlyPriceUsd * 10);
    }
  });

  it("getShoplinePlanLimits resolves by spuKey and fails open for unknown plans", async () => {
    const { getShoplinePlanLimits } = await import("../shared/shoplineConstants");
    expect(getShoplinePlanLimits("professional")).toEqual({ maxOrders: 10_000, maxStores: 5 });
    // Unknown/absent plan → most generous, so webhook lag never throttles.
    expect(getShoplinePlanLimits("mystery")).toEqual({ maxOrders: Infinity, maxStores: Infinity });
    expect(getShoplinePlanLimits(null)).toEqual({ maxOrders: Infinity, maxStores: Infinity });
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

  it("routes appsubscription/create with the real subPackage payload", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "appsubscription/create", {
        appkey: "k",
        handle: "acme",
        subId: "6578332207010012345",
        subPackage: {
          spuKey: "starter",
          trial: true,
          autoRenewStatus: true,
          startAt: 1756977716000,
          endAt: 1757239200000,
          period: 1,
          periodType: "MONTH",
          gracePeriod: 2,
          gracePeriodUnit: "DAY",
        },
      }),
    ).resolves.not.toThrow();
  });

  it("routes appsubscription/paid", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "appsubscription/paid", {
        appkey: "k",
        bizOrderNo: "PAY20240726123456",
        handle: "acme",
        status: 200,
        subId: "6578332207010012345",
        subTime: 1722000000000,
      }),
    ).resolves.not.toThrow();
  });

  it("routes appsubscription/expiration", async () => {
    await expect(
      processBillingWebhook(mockDb as any, 1, 1, "appsubscription/expiration", {
        appkey: "k",
        handle: "acme",
        subId: "6578332207010012345",
        expireType: 0,
      }),
    ).resolves.not.toThrow();
  });

  it("ignores the retired app_plan/* topics as unknown", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processBillingWebhook(mockDb as any, 1, 1, "app_plan/activated", {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown billing topic"));
    consoleSpy.mockRestore();
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

// ─── Sync gate semantics (isSyncBlockedBySubscription) — grace-aware ─────────

describe("isSyncBlockedBySubscription — grace-aware gating", () => {
  const mkDb = (rows: unknown[]) => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  });
  const future = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const past = () => new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

  it("does NOT block when there is no subscription row (fresh/pre-billing store)", async () => {
    const r = await isSyncBlockedBySubscription(mkDb([]) as any, 1);
    expect(r.blocked).toBe(false);
  });

  it.each(["trialing", "active"])("does NOT block a %s subscription", async (status) => {
    const r = await isSyncBlockedBySubscription(mkDb([{ status, graceEndsAt: null }]) as any, 1);
    expect(r.blocked).toBe(false);
  });

  it.each(["past_due", "expired"])(
    "does NOT block a %s subscription while still within the grace window",
    async (status) => {
      const r = await isSyncBlockedBySubscription(mkDb([{ status, graceEndsAt: future() }]) as any, 1);
      expect(r.blocked).toBe(false);
      expect(r.inGrace).toBe(true);
    },
  );

  it.each(["past_due", "expired"])(
    "BLOCKS a %s subscription once the grace window has elapsed",
    async (status) => {
      const r = await isSyncBlockedBySubscription(mkDb([{ status, graceEndsAt: past() }]) as any, 1);
      expect(r.blocked).toBe(true);
      expect(r.inGrace).toBe(false);
    },
  );

  it("treats a missing graceEndsAt as still-in-grace (fail-open, no instant cut-off)", async () => {
    const r = await isSyncBlockedBySubscription(mkDb([{ status: "past_due", graceEndsAt: null }]) as any, 1);
    expect(r.blocked).toBe(false);
  });

  it("blocks a cancelled (uninstalled) subscription immediately, ignoring grace", async () => {
    const r = await isSyncBlockedBySubscription(mkDb([{ status: "cancelled", graceEndsAt: future() }]) as any, 1);
    expect(r.blocked).toBe(true);
    expect(r.status).toBe("cancelled");
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

// ─── Real appsubscription/* payload handling ─────────────────────────────────

import {
  handleSubscriptionCreate,
  handleSubscriptionExpiration,
  handleSubscriptionPaid,
} from "./connectors/shopline/billingWebhook";
import {
  SHOPLINE_BILLING_EXPIRE_TYPE,
  SHOPLINE_BILLING_PAID_STATUS,
  TIER_1_GRACE_PERIOD_DAYS,
} from "../shared/shoplineConstants";

/** Mock db capturing the last .set() payload from update/insert chains. */
function mkWriteDb(existingRows: unknown[] = []) {
  const captured: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(existingRows),
    update: vi.fn(() => chain),
    set: vi.fn((v: Record<string, unknown>) => {
      captured.push(v);
      return chain;
    }),
    insert: vi.fn(() => chain),
    values: vi.fn((v: Record<string, unknown>) => {
      captured.push(v);
      return chain;
    }),
  });
  return { db: chain as never, captured };
}

describe("appsubscription/create — real payload shape", () => {
  it("reads spuKey/trial out of subPackage (not spu_key at top level)", async () => {
    const { db, captured } = mkWriteDb([]);
    await handleSubscriptionCreate(db, 1, 10, {
      appkey: "k",
      handle: "acme",
      subId: "SUB-1",
      subPackage: {
        spuKey: "professional",
        trial: false,
        startAt: 1756977716000,
        endAt: 1757239200000,
        periodType: "MONTH",
      },
    });
    const row = captured.at(-1)!;
    expect(row.planId).toBe("professional");
    expect(row.status).toBe("active");
    expect(row.shoplineSubscriptionId).toBe("SUB-1");
    // SHOPLINE's own period bounds are used
    expect((row.currentPeriodStart as Date).getTime()).toBe(1756977716000);
    expect((row.currentPeriodEnd as Date).getTime()).toBe(1757239200000);
  });

  it("marks a trial subscription as trialing", async () => {
    const { db, captured } = mkWriteDb([]);
    await handleSubscriptionCreate(db, 1, 10, {
      handle: "acme",
      subId: "SUB-2",
      subPackage: { spuKey: "starter", trial: true },
    });
    expect(captured.at(-1)!.status).toBe("trialing");
  });
});

describe("appsubscription/paid — status drives outcome", () => {
  it("status 200 activates and clears the grace buffer", async () => {
    const { db, captured } = mkWriteDb([{ failedBillingAttempts: 2, status: "past_due" }]);
    await handleSubscriptionPaid(db, 1, 10, {
      handle: "acme",
      status: SHOPLINE_BILLING_PAID_STATUS.SUCCESS,
      subTime: Date.now(),
    });
    const row = captured.at(-1)!;
    expect(row.status).toBe("active");
    expect(row.graceEndsAt).toBeNull();
    expect(row.failedBillingAttempts).toBe(0);
  });

  it("status 300 cancels the subscription", async () => {
    const { db, captured } = mkWriteDb([{}]);
    await handleSubscriptionPaid(db, 1, 10, {
      handle: "acme",
      status: SHOPLINE_BILLING_PAID_STATUS.CANCELLED,
    });
    expect(captured.at(-1)!.status).toBe("cancelled");
  });

  it("status 400 counts a failure; 3rd failure sets past_due + starts grace", async () => {
    const { db, captured } = mkWriteDb([{ failedBillingAttempts: 2, status: "active", graceEndsAt: null }]);
    await handleSubscriptionPaid(db, 1, 10, {
      handle: "acme",
      status: SHOPLINE_BILLING_PAID_STATUS.FAILED,
    });
    const row = captured.at(-1)!;
    expect(row.failedBillingAttempts).toBe(3);
    expect(row.status).toBe("past_due");
    expect(row.graceEndsAt).toBeInstanceOf(Date);
  });

  it("an early failure does not yet flip status or start grace", async () => {
    const { db, captured } = mkWriteDb([{ failedBillingAttempts: 0, status: "active", graceEndsAt: null }]);
    await handleSubscriptionPaid(db, 1, 10, { handle: "acme", status: 400 });
    const row = captured.at(-1)!;
    expect(row.failedBillingAttempts).toBe(1);
    expect(row.status).toBe("active");
    expect(row.graceEndsAt).toBeNull();
  });
});

describe("appsubscription/expiration — expireType semantics", () => {
  it.each([
    ["upgrade", SHOPLINE_BILLING_EXPIRE_TYPE.UPGRADE],
    ["next cycle activated", SHOPLINE_BILLING_EXPIRE_TYPE.NEXT_CYCLE_ACTIVATED],
  ])("does NOT expire access on a %s (it's a continuation)", async (_label, expireType) => {
    const { db, captured } = mkWriteDb([{}]);
    await handleSubscriptionExpiration(db, 1, 10, { handle: "acme", expireType });
    expect(captured).toHaveLength(0); // no write at all
  });

  it("expires and starts the grace buffer on a termination", async () => {
    const { db, captured } = mkWriteDb([{ graceEndsAt: null }]);
    await handleSubscriptionExpiration(db, 1, 10, {
      handle: "acme",
      expireType: SHOPLINE_BILLING_EXPIRE_TYPE.TERMINATED,
    });
    const row = captured.at(-1)!;
    expect(row.status).toBe("expired");
    const grace = row.graceEndsAt as Date;
    const days = Math.round((grace.getTime() - Date.now()) / (24 * 3600 * 1000));
    expect(days).toBe(TIER_1_GRACE_PERIOD_DAYS);
  });

  it("honours a platform-provided gracePeriod from subPackage", async () => {
    const { db, captured } = mkWriteDb([{ graceEndsAt: null }]);
    await handleSubscriptionExpiration(db, 1, 10, {
      handle: "acme",
      expireType: SHOPLINE_BILLING_EXPIRE_TYPE.MANUAL_CANCEL,
      subPackage: { gracePeriod: 2, gracePeriodUnit: "DAY" },
    });
    const grace = captured.at(-1)!.graceEndsAt as Date;
    const days = Math.round((grace.getTime() - Date.now()) / (24 * 3600 * 1000));
    expect(days).toBe(2); // platform value wins over our 7-day default
  });

  it("a grace-period expiry ends the buffer immediately", async () => {
    const { db, captured } = mkWriteDb([{ graceEndsAt: null }]);
    await handleSubscriptionExpiration(db, 1, 10, {
      handle: "acme",
      expireType: SHOPLINE_BILLING_EXPIRE_TYPE.GRACE_PERIOD,
    });
    const grace = captured.at(-1)!.graceEndsAt as Date;
    expect(grace.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
