/**
 * Uganda market pack — tRPC router (validation gap G1).
 *
 * Org-scoped operations for the Ugandan rails: source catalogue, per-rail
 * file ingestion (SFTP drop / manual / UAT replay), the daily completeness
 * watchdog, and idempotent provisioning. Mirrors the LAPO router; works
 * identically on SaaS and on-premise (Uganda's DP&P Act 2019 expects
 * on-prem, which the egress guard enforces).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { UGANDA_SOURCE_KEYS, UGANDA_SOURCES } from "@shared/ugandaSources";
import { resolveOrgScope } from "../_core/tenancy";
import { protectedProcedure, router } from "../_core/trpc";
import {
  checkUgandaDailyCompleteness,
  ingestUgandaFile,
  provisionUgandaForOrg,
} from "../connectors/uganda/etl";
import { UGANDA_EXCEPTIONS } from "../exceptions/uganda";

const sourceKeySchema = z.enum([
  "cbs_ledger", "mtn_momo", "airtel_money", "abc_agent_rail",
  "uniss_rtgs", "ach_eft", "card_switch", "trust_account",
  "digital_lending", "bill_utility", "aggregator_switch",
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

export const ugandaRouter = router({
  /** The Ugandan rail map — MTN/Airtel, ABC shared agent rail, UNISS, ACH, cards, trust account. */
  listSources: protectedProcedure.query(() =>
    UGANDA_SOURCE_KEYS.map((key) => {
      const s = UGANDA_SOURCES[key];
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

  /** The Uganda exception taxonomy (BoU framework) — categories + SLAs. */
  listExceptionCategories: protectedProcedure.query(() =>
    UGANDA_EXCEPTIONS.map(({ key, label, severity, slaHours, sources, regulatoryContext }) => ({
      key, label, severity, slaHours, sources, regulatoryContext,
    })),
  ),

  /** Per-rail batch-file ingestion with zero-data-loss accounting. */
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
      return ingestUgandaFile(orgId, input.sourceKey, input.csvContent, input.fileName ?? "manual-upload.csv");
    }),

  /** Which expected daily rail batches arrived for a date? */
  dailyCompleteness: protectedProcedure
    .input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      organizationId: z.number().int().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const orgId = resolveOrgScope(ctx.user, input.organizationId);
      return checkUgandaDailyCompleteness(orgId, input.date);
    }),

  /**
   * Provision (or repair) the Uganda channel pack: eight rail channels with
   * timing-aware matching config + the BoU-framework taxonomy as resolution
   * templates. Idempotent; also runs when a super admin adds Uganda to a
   * client's build during DIRECT onboarding (custom channel selector).
   */
  provision: superAdminProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      return provisionUgandaForOrg(input.organizationId);
    }),
});
