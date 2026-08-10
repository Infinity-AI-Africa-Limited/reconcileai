/**
 * Module configuration domain router (routers.ts split — docs/ROUTERS_SPLIT_PLAN.md).
 *
 * Which of the two reconciliation modules (CLAUDE.md §9) a tenant has switched
 * on, plus the super-admin per-institution overrides. Moved out of
 * server/routers.ts verbatim; building blocks come from ./shared, matching
 * every other domain router.
 *
 * Three surfaces decide whether a module is usable, and they must agree:
 *
 *   list        — what the tenant is OFFERED. Scoped to the vertical here.
 *   toggle /
 *   updateConfig— whether it may be ENABLED (assertModuleAvailable).
 *   reconciliation.create / createMultiChannel — whether it may be RUN, in
 *                 ./reconciliation.ts, guarded by the same helper.
 *
 * `list` is scoped because provisioning only runs once. A tenant created before
 * the scope rule kept its account_level row — both SHOPLINE merchants in
 * production still have one, enabled — and an org retyped to retail afterwards
 * (superAdmin.updateOrganizationSegment) was never re-provisioned at all.
 * Neither is reachable by a one-off backfill, and the second can happen again
 * tomorrow, so the READ is scoped and the stored row simply goes inert.
 *
 * The rule itself lives in shared/moduleScope — one definition, so the three
 * surfaces above cannot drift into disagreeing.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { scopeModuleRows } from "@shared/moduleScope";
import { router, protectedProcedure } from "../_core/trpc";
import {
  adminProcedure,
  superAdminProcedure,
  assertModuleAvailable,
  logAudit,
  getClientInfo,
} from "./shared";
import { organizations } from "../../drizzle/schema";
import * as db from "../db";

export const modulesRouter = router({
  // Scoped to the vertical, not just the tenant — see the header. Listing a
  // module as available that toggle and both job-creation paths refuse was the
  // last place the three surfaces disagreed.
  list: protectedProcedure.query(async ({ ctx }) => {
    const dbConn = await db.getDb();
    if (!dbConn) return [];

    const configs = await dbConn.select()
      .from(db.moduleConfigurations)
      .where(eq(db.moduleConfigurations.organizationId, ctx.user.organizationId || 0));
    if (!ctx.user.organizationId) return configs;
    const [org] = await dbConn
      .select({ segment: organizations.segment })
      .from(organizations)
      .where(eq(organizations.id, ctx.user.organizationId))
      .limit(1);
    return scopeModuleRows(configs, org?.segment);
  }),

  toggle: adminProcedure
    .input(z.object({
      moduleType: z.enum(["settlement", "account_level"]),
      isEnabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      const dbConn = await db.getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      await assertModuleAvailable(ctx, input.moduleType);

      const existing = await dbConn.select()
        .from(db.moduleConfigurations)
        .where(
          and(
            eq(db.moduleConfigurations.organizationId, ctx.user.organizationId || 0),
            eq(db.moduleConfigurations.moduleType, input.moduleType)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        await dbConn.update(db.moduleConfigurations)
          .set({ isEnabled: input.isEnabled, updatedAt: new Date() })
          .where(eq(db.moduleConfigurations.id, existing[0].id));
      } else {
        await dbConn.insert(db.moduleConfigurations).values({
          organizationId: ctx.user.organizationId || 0,
          moduleType: input.moduleType,
          isEnabled: input.isEnabled,
        });
      }

      await logAudit(ctx.user.id, "toggle_module", "module_configuration", undefined, {
        moduleType: input.moduleType,
        isEnabled: input.isEnabled,
      }, ip, ua);
      return { success: true };
    }),

  updateConfig: adminProcedure
    .input(z.object({
      moduleType: z.enum(["settlement", "account_level"]),
      configuration: z.record(z.string(), z.any()),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      const dbConn = await db.getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      await assertModuleAvailable(ctx, input.moduleType);

      await dbConn.update(db.moduleConfigurations)
        .set({ configuration: input.configuration, updatedAt: new Date() })
        .where(
          and(
            eq(db.moduleConfigurations.organizationId, ctx.user.organizationId || 0),
            eq(db.moduleConfigurations.moduleType, input.moduleType)
          )
        );

      await logAudit(ctx.user.id, "update_module_config", "module_configuration", undefined, {
        moduleType: input.moduleType,
      }, ip, ua);
      return { success: true };
    }),

  // Super admin: list all orgs with their module override states
  listOrgOverrides: superAdminProcedure
    .input(z.object({ organizationId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const dbConn = await db.getDb();
      if (!dbConn) return [];
      const { moduleOverrides } = await import("../../drizzle/schema");
      let query = dbConn.select({
        id: moduleOverrides.id,
        organizationId: moduleOverrides.organizationId,
        orgName: organizations.name,
        moduleType: moduleOverrides.moduleType,
        isEnabled: moduleOverrides.isEnabled,
        reason: moduleOverrides.reason,
        setByUserId: moduleOverrides.setByUserId,
        updatedAt: moduleOverrides.updatedAt,
      })
      .from(moduleOverrides)
      .leftJoin(organizations, eq(moduleOverrides.organizationId, organizations.id));
      if (input?.organizationId) {
        return (await query).filter(r => r.organizationId === input.organizationId);
      }
      return query;
    }),

  // Super admin: set or clear a per-institution module override
  setOrgModuleOverride: superAdminProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      moduleType: z.enum(["settlement", "account_level"]),
      isEnabled: z.boolean(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      const dbConn = await db.getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { moduleOverrides } = await import("../../drizzle/schema");
      const existing = await dbConn.select().from(moduleOverrides)
        .where(and(
          eq(moduleOverrides.organizationId, input.organizationId),
          eq(moduleOverrides.moduleType, input.moduleType)
        )).limit(1);
      if (existing.length > 0) {
        await dbConn.update(moduleOverrides)
          .set({ isEnabled: input.isEnabled, reason: input.reason ?? null, setByUserId: ctx.user.id, updatedAt: new Date() })
          .where(eq(moduleOverrides.id, existing[0].id));
      } else {
        await dbConn.insert(moduleOverrides).values({
          organizationId: input.organizationId,
          moduleType: input.moduleType,
          isEnabled: input.isEnabled,
          reason: input.reason ?? null,
          setByUserId: ctx.user.id,
        });
      }
      await logAudit(ctx.user.id, "set_org_module_override", "module_override", input.organizationId, {
        moduleType: input.moduleType,
        isEnabled: input.isEnabled,
        reason: input.reason,
      }, ip, ua);
      return { success: true };
    }),

  // Super admin: remove a per-institution override (revert to org's own setting)
  clearOrgModuleOverride: superAdminProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      moduleType: z.enum(["settlement", "account_level"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ip, ua } = getClientInfo(ctx);
      const dbConn = await db.getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { moduleOverrides } = await import("../../drizzle/schema");
      await dbConn.delete(moduleOverrides)
        .where(and(
          eq(moduleOverrides.organizationId, input.organizationId),
          eq(moduleOverrides.moduleType, input.moduleType)
        ));
      await logAudit(ctx.user.id, "clear_org_module_override", "module_override", input.organizationId, {
        moduleType: input.moduleType,
      }, ip, ua);
      return { success: true };
    }),
});
