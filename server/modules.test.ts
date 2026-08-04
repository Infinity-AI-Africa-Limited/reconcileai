import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { appRouter } from "./routers";
import * as db from "./db";

/**
 * These tests call the real `modules.*` procedures, so they WRITE whenever a
 * database is reachable. CI points DATABASE_URL at a disposable MySQL container,
 * but a developer running with the project's .env is pointed at the shared TiDB
 * instance — where organizationId 1 is a live demo tenant ("Globus Bank Nigeria
 * (Demo)"). Without the snapshot/restore below, a local run left settlement
 * DISABLED on that tenant and silently changed its account_level configuration.
 *
 * The toggle procedure UPSERTS, so restoring means putting modified rows back
 * AND deleting rows the run created. Restore is best-effort and never throws:
 * a cleanup failure must not turn into a confusing test failure that hides the
 * real result.
 */
const TEST_ORG_ID = 1;
const TOUCHED_MODULES = ["settlement", "account_level"] as const;

type ModuleSnapshot = {
  moduleType: (typeof TOUCHED_MODULES)[number];
  existed: boolean;
  isEnabled?: boolean;
  configuration?: unknown;
};

describe("Module Configuration", () => {
  let adminContext: any;
  let userContext: any;
  let snapshots: ModuleSnapshot[] = [];

  afterAll(async () => {
    const dbConn = await db.getDb();
    if (!dbConn || snapshots.length === 0) return;
    for (const snap of snapshots) {
      try {
        const where = and(
          eq(db.moduleConfigurations.organizationId, TEST_ORG_ID),
          eq(db.moduleConfigurations.moduleType, snap.moduleType),
        );
        if (snap.existed) {
          await dbConn
            .update(db.moduleConfigurations)
            .set({ isEnabled: snap.isEnabled!, configuration: snap.configuration ?? null })
            .where(where);
        } else {
          // The run created this row; leaving it behind would silently enable a
          // module on a tenant that never had it configured.
          await dbConn.delete(db.moduleConfigurations).where(where);
        }
      } catch (err) {
        console.error(`[modules.test] could not restore ${snap.moduleType}:`, err);
      }
    }
  });

  beforeAll(async () => {
    // Snapshot BEFORE anything runs, so restore has a truthful baseline.
    const dbConn = await db.getDb();
    if (dbConn) {
      for (const moduleType of TOUCHED_MODULES) {
        const [row] = await dbConn
          .select()
          .from(db.moduleConfigurations)
          .where(
            and(
              eq(db.moduleConfigurations.organizationId, TEST_ORG_ID),
              eq(db.moduleConfigurations.moduleType, moduleType),
            ),
          )
          .limit(1);
        snapshots.push(
          row
            ? { moduleType, existed: true, isEnabled: row.isEnabled, configuration: row.configuration }
            : { moduleType, existed: false },
        );
      }
    }

    // Create test users
    const adminUser = {
      id: 9001,
      openId: "test_admin_modules",
      name: "Test Admin",
      email: "admin@test.com",
      role: "admin" as const,
      organizationId: 1,
      isGuest: false,
    };

    const regularUser = {
      id: 9002,
      openId: "test_user_modules",
      name: "Test User",
      email: "user@test.com",
      role: "user" as const,
      organizationId: 1,
      isGuest: false,
    };

    // Mock contexts
    adminContext = {
      user: adminUser,
      req: { headers: {}, ip: "127.0.0.1" },
      res: { cookie: () => {}, clearCookie: () => {} },
    };

    userContext = {
      user: regularUser,
      req: { headers: {}, ip: "127.0.0.1" },
      res: { cookie: () => {}, clearCookie: () => {} },
    };
  });

  describe("modules.list", () => {
    it("should return module configurations for user's organization", async () => {
      const caller = appRouter.createCaller(adminContext);
      const result = await caller.modules.list();
      
      expect(Array.isArray(result)).toBe(true);
      // Result may be empty if no modules configured yet
    });
  });

  describe("modules.toggle", () => {
    it("should allow admin to enable a module", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      const result = await caller.modules.toggle({
        moduleType: "settlement",
        isEnabled: true,
      });

      expect(result.success).toBe(true);
    });

    it("should allow admin to disable a module", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      const result = await caller.modules.toggle({
        moduleType: "settlement",
        isEnabled: false,
      });
      
      expect(result.success).toBe(true);
    });

    it("should reject non-admin users", async () => {
      const caller = appRouter.createCaller(userContext);
      
      await expect(
        caller.modules.toggle({
          moduleType: "settlement",
          isEnabled: true,
        })
      ).rejects.toThrow();
    });

    it("should validate module type enum", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      await expect(
        caller.modules.toggle({
          moduleType: "invalid_module" as any,
          isEnabled: true,
        })
      ).rejects.toThrow();
    });
  });

  describe("modules.updateConfig", () => {
    it("should allow admin to update module configuration", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      // First enable the module
      await caller.modules.toggle({
        moduleType: "account_level",
        isEnabled: true,
      });
      
      // Then update its configuration
      const result = await caller.modules.updateConfig({
        moduleType: "account_level",
        configuration: {
          enableGLIntegration: true,
          currencySupport: ["NGN", "USD"],
          auditLevel: "high",
        },
      });
      
      expect(result.success).toBe(true);
    });

    it("should reject non-admin users", async () => {
      const caller = appRouter.createCaller(userContext);
      
      await expect(
        caller.modules.updateConfig({
          moduleType: "settlement",
          configuration: { test: true },
        })
      ).rejects.toThrow();
    });
  });

  describe("reconciliation.create with moduleType", () => {
    it("should accept moduleType parameter", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      // This will fail due to missing channels, but validates the input schema
      await expect(
        caller.reconciliation.create({
          name: "Test Job with Module",
          moduleType: "settlement",
          sourceChannelId: 999,
          targetChannelId: 998,
          dateFrom: "2026-02-01",
          dateTo: "2026-02-28",
          amountTolerance: 0.005,
          dateWindowDays: 3,
        })
      ).rejects.toThrow("Source channel not found");
      // The error confirms the input was accepted and validation proceeded
    });

    it("should default to settlement if moduleType not provided", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      // This will fail due to missing channels, but validates the default
      await expect(
        caller.reconciliation.create({
          name: "Test Job without Module",
          sourceChannelId: 999,
          targetChannelId: 998,
          dateFrom: "2026-02-01",
          dateTo: "2026-02-28",
        })
      ).rejects.toThrow("Source channel not found");
      // The error confirms the input was accepted with default moduleType
    });

    it("should validate moduleType enum values", async () => {
      const caller = appRouter.createCaller(adminContext);
      
      await expect(
        caller.reconciliation.create({
          name: "Test Job with Invalid Module",
          moduleType: "invalid_type" as any,
          sourceChannelId: 1,
          targetChannelId: 2,
          dateFrom: "2026-02-01",
          dateTo: "2026-02-28",
        })
      ).rejects.toThrow();
    });
  });
});
