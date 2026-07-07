/**
 * LAPO MFB custom channel integration — tRPC router.
 *
 * Org-scoped operations for the LAPO multi-source ETL: source catalogue,
 * file/event ingestion (UAT + manual drops; production realtime rides the
 * HMAC webhook, production batches ride SFTP polling), the daily
 * completeness watchdog, and idempotent provisioning. Works identically on
 * SaaS and on-premise deployments.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { LAPO_SOURCE_KEYS, LAPO_SOURCES } from "@shared/lapoSources";
import { resolveOrgScope } from "../_core/tenancy";
import { protectedProcedure, router } from "../_core/trpc";
import {
  checkDailyCompleteness,
  ingestLapoEvents,
  ingestLapoFile,
  provisionLapoChannels,
} from "../connectors/lapo/etl";
import {
  LAPO_EXCEPTION_CATEGORIES,
  seedLapoResolutionTemplates,
} from "../connectors/lapo/exceptions";

const sourceKeySchema = z.enum([
  "cbs_ledger", "mobile_banking", "ussd", "agent_banking",
  "nibss_nip", "cards_interswitch", "cards_upsl", "cards_etranzact",
]);

const adminProcedure = protectedProcedure.use(async (opts) => {
  const role = opts.ctx.user.role ?? "";
  if (role !== "admin" && role !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return opts.next();
});

const superAdminProcedure = protectedProcedure.use(async (opts) => {
  if ((opts.ctx.user.role ?? "") !== "super_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required" });
  }
  return opts.next();
});

export const lapoRouter = router({
  /** The full source-system map (deliverable 1) for dashboards and UAT docs. */
  listSources: protectedProcedure.query(() =>
    LAPO_SOURCE_KEYS.map((key) => {
      const s = LAPO_SOURCES[key];
      return {
        key: s.key,
        label: s.label,
        systemDescription: s.systemDescription,
        channelType: s.channelType,
        transport: s.transport,
        expectedDailyFile: s.expectedDailyFile,
        settlementLagDays: s.settlementLagDays,
        matching: s.matching,
        formatId: s.format.id,
        signature: s.format.signature,
        regulatoryNote: s.regulatoryNote,
      };
    }),
  ),

  /** The LAPO exception taxonomy (deliverable 4) — categories + SLAs. */
  listExceptionCategories: protectedProcedure.query(() =>
    LAPO_EXCEPTION_CATEGORIES.map(({ key, label, severity, slaHours, sources, regulatoryContext }) => ({
      key, label, severity, slaHours, sources, regulatoryContext,
    })),
  ),

  /** Batch-file ingestion (SFTP drop / manual upload / UAT replay). */
  ingestFile: adminProcedure
    .input(z.object({
      sourceKey: sourceKeySchema,
      csvContent: z.string().min(10).max(30 * 1024 * 1024),
      fileName: z.string().max(300).optional(),
      organizationId: z.number().int().positive().optional(), // super admins only
    }))
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgScope(ctx.user, input.organizationId);
      const { checkTenantRate } = await import("../_core/rateLimit");
      const rate = await checkTenantRate(orgId, "csv_import");
      if (!rate.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Import rate limit — retry in ${rate.retryAfterSec}s` });
      }
      return ingestLapoFile(orgId, input.sourceKey, input.csvContent, input.fileName ?? "manual-upload.csv");
    }),

  /** Realtime-style event ingestion (UAT/manual; production uses the webhook). */
  ingestEvents: adminProcedure
    .input(z.object({
      sourceKey: sourceKeySchema,
      events: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
      organizationId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const orgId = resolveOrgScope(ctx.user, input.organizationId);
      return ingestLapoEvents(orgId, input.sourceKey, input.events);
    }),

  /** Zero-data-loss watchdog: which expected daily batches arrived for a date? */
  dailyCompleteness: protectedProcedure
    .input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      organizationId: z.number().int().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgScope(ctx.user, input.organizationId);
      return checkDailyCompleteness(orgId, input.date);
    }),

  /**
   * Provision (or repair) the LAPO channel pack for an org: eight source
   * channels with timing-aware matching config + the exception taxonomy as
   * resolution templates. Idempotent; also runs automatically when an org is
   * onboarded through the "LAPO MFB (multi-source)" option in New Organisation.
   */
  provision: superAdminProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const channelIds = await provisionLapoChannels(input.organizationId);
      const templates = await seedLapoResolutionTemplates(input.organizationId);
      return { channelIds, templates };
    }),
});
