import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { cbnComplianceRouter } from "./routers/cbnCompliance";
import { pocRouter } from "./routers/poc";
import { pocKpiRouter } from "./routers/pocKpi";
import { mobileMoneyRouter } from "./routers/mobileMoney";
import { erpExportRouter } from "./routers/erpExport";
import { registerReconciliationRunner } from "./reconciliationQueue";
import { reconciliationRouter } from "./routers/reconciliation";
import { modulesRouter } from "./routers/modules";
import { woodcoreConnectorRouter } from "./routers/woodcoreConnector";
import { shoplineConnectorRouter } from "./routers/shoplineConnector";
import { lapoRouter } from "./routers/lapo";
import { ugandaRouter } from "./routers/uganda";
import * as ageTracker from "./ageTracker";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { eq, or, desc, asc, sql, isNull, and, like, inArray, gte } from "drizzle-orm";
import { storagePut } from "./storage";
import {
  runMatchingEngine,
  categorizeException,
  getAIAnalysis,
} from "./reconciliationEngine";
import { generateSampleData, type SampleDataConfig } from "./sampleDataGenerator";
import { SUPPORTED_CURRENCIES, RESOLUTION_TEMPLATE_CATEGORIES } from "../drizzle/schema";
import * as crypto from "crypto";
import { trackProgress } from "./jobProgressService";
import { getJobProgress, getAllActiveJobsProgress } from "./jobProgressService";
import {
  calculateNextRun,
  validateScheduleConfig,
  executeScheduledTask,
  startScheduler,
  getFrequencyDescription,
} from "./schedulingEngine";
import {
  sendReconciliationReport,
  checkAndSendAlerts,
} from "./emailReportService";
import { publicApiRouter } from "./publicApiRouter";
import { bucketIngestionRouter } from "./routers/bucketIngestion";
import { emailIngestionRouter } from "./routers/emailIngestion";
import {
  encryptCredential,
  testSftpConnection,
  listSftpFiles,
  downloadAndProcessSftpFile,
  startSftpPolling,
} from "./sftpService";
import { startBucketPolling } from "./bucketIngestionService";
import { startSLAMonitoring } from "./slaMonitoringService";
import { detectAnomalies, type AnomalyDetectionConfig } from "./anomalyDetectionService";
import {
  runFullPOC,
  getLatestRuns,
  getRunExceptions,
  getRunById,
  getWoodcoreStats,
  type ReconciliationConfig,
} from "./woodcore-engine";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { loadExcelJS } from "./exceljsLoader";
import { isEgressAllowed, assertEgressAllowed, describeResidencyPosture } from "./_core/egress";
import { woodcoreQuery, SAVINGS_TXN_TYPE, LOAN_TXN_TYPE } from "./woodcoreDb";
import {
  runM2MMatching,
  diagnoseException,
  generateActionDraft,
  buildMemoryEmbeddingText,
  retrieveSimilarMemories,
  formatMemoryContext,
  type SATransaction,
  type MemoryRecord,
} from "./superAgentEngine";
import { seedDemoData, wipeDemoData } from "./demoSeedEngine";
import {
  prewarmDemoUser,
  isPrewarmComplete,
  getPrewarmUserId,
  getPrewarmOrgId,
  DEMO_PREWARM_OPEN_ID,
} from "./prewarmDemoUser";
import { agentActionDrafts, agentMemory, organizations, users } from "../drizzle/schema";
import { getDb } from "./db";
import { groupMemoryGrowthByMonth, sixMonthsAgoUtc } from "./agentMemoryStats";

// ─── Constants ──────────────────────────────────────────────────────

// Max transactions accepted in a SINGLE upload request (one chunk). The client splits
// large files into chunks of this size and streams them via createBatch + appendBatch,
// so total file size is effectively unbounded while each request stays well under the
// 50 MB Express body limit (~25k rows ≈ 4 MB of JSON).
const MAX_UPLOAD_TRANSACTIONS = 25000;
const MAX_SEARCH_LENGTH = 100;
const MAX_QUERY_LIMIT = 500;
// MAX_NAME_LENGTH now lives in ./routers/shared (imported below) — the
// extracted reconciliation router needs the same bound, and two copies of a
// column limit is how they drift apart.

// Canonical public origin for links embedded in outbound emails and exports sent to
// external recipients (compliance-assessment results, unsubscribe links, CSV report URLs).
// Prefer the configured APP_URL; fall back to the live production domain. The historical
// hardcoded "reconcileai.vip" is NOT the live site, so links built from it are broken for
// recipients. Trailing slash is stripped so callers can append paths safely.
const PUBLIC_APP_ORIGIN = (ENV.appUrl || "https://www.reconcileaiafrica.com").replace(/\/$/, "");
// Host-only form (no scheme) for plain-text references in email footers and notifications.
const PUBLIC_APP_HOST = PUBLIC_APP_ORIGIN.replace(/^https?:\/\//, "");

// Shared shape + validation for uploaded transaction rows, reused by the single-shot
// createBatch path and the chunked appendBatch path.
const uploadTxnSchema = z.object({
  transactionRef: z.string().max(255).optional(),
  externalRef: z.string().max(255).optional(),
  description: z.string().max(1000).optional(),
  amount: z.string().min(1).max(30),
  currency: z.string().length(3).default("NGN"),
  transactionDate: z.string().min(1),
  valueDate: z.string().optional(),
  debitCredit: z.enum(["debit", "credit"]),
  counterparty: z.string().max(255).optional(),
  rawData: z.any().optional(),
});
type UploadTxnInput = z.infer<typeof uploadTxnSchema>;

/**
 * Validate a batch of raw upload rows and shape them for insertion. Pure (no I/O) so it
 * can be called per-chunk. `rowOffset` keeps error row numbers correct across chunks.
 */
function buildValidTransactions(
  rawTxns: UploadTxnInput[],
  owner: { batchId: number; channelId: number; userId: number },
  rowOffset = 0,
) {
  let validRows = 0;
  let invalidRows = 0;
  const validTxns: any[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rawTxns.length; i++) {
    const txn = rawTxns[i];
    const rowNo = rowOffset + i + 1;
    try {
      const amount = parseFloat(txn.amount);
      if (isNaN(amount) || !isFinite(amount)) {
        invalidRows++;
        errors.push(`Row ${rowNo}: Invalid amount '${txn.amount}'`);
        continue;
      }
      if (amount < 0) {
        invalidRows++;
        errors.push(`Row ${rowNo}: Negative amount not allowed`);
        continue;
      }
      if (amount > 999999999999.99) {
        invalidRows++;
        errors.push(`Row ${rowNo}: Amount exceeds maximum`);
        continue;
      }
      const txnDate = new Date(txn.transactionDate);
      if (isNaN(txnDate.getTime())) {
        invalidRows++;
        errors.push(`Row ${rowNo}: Invalid date '${txn.transactionDate}'`);
        continue;
      }
      if (txn.currency && !(SUPPORTED_CURRENCIES as readonly string[]).includes(txn.currency)) {
        invalidRows++;
        errors.push(`Row ${rowNo}: Unsupported currency '${txn.currency}'`);
        continue;
      }
      validTxns.push({
        batchId: owner.batchId,
        channelId: owner.channelId,
        userId: owner.userId,
        transactionRef: txn.transactionRef || null,
        externalRef: txn.externalRef || null,
        description: txn.description || null,
        amount: txn.amount,
        currency: txn.currency,
        transactionDate: txnDate,
        valueDate: txn.valueDate ? new Date(txn.valueDate) : null,
        debitCredit: txn.debitCredit,
        counterparty: txn.counterparty || null,
        rawData: txn.rawData ? JSON.stringify(txn.rawData) : null,
      });
      validRows++;
    } catch {
      invalidRows++;
      errors.push(`Row ${rowNo}: Unexpected parsing error`);
    }
  }

  return { validTxns, validRows, invalidRows, errors };
}

// ─── Shared router building blocks ───────────────────────────────────
// Extracted to server/routers/shared.ts (WS-4 pre-work — first step of the
// routers.ts split; see docs/ROUTERS_SPLIT_PLAN.md). Imported back here so
// the ~hundreds of call sites in this file are untouched; new domain routers
// import from ./routers/shared directly.
import {
  superAdminProcedure,
  adminProcedure,
  assertCanManageUsers,
  guestProtectedProcedure,
  operationsProcedure,
  woodcoreProcedure,
  logAudit,
  getClientInfo,
  sanitizeInput,
  assertChannelBindable,
  cbnProcedure,
  distributorProcedure,
  MAX_NAME_LENGTH,
} from "./routers/shared";

// ─── Webhook Dispatcher ─────────────────────────────────────────────
// WS-4: delivery is tracked + retried via server/webhookDelivery.ts (queue
// abstraction: BullMQ when REDIS_URL is set, in-process otherwise). Kept as a
// local wrapper so the ~15 call sites stay unchanged.

async function dispatchWebhook(event: string, payload: any) {
  const { dispatchWebhookEvent } = await import("./webhookDelivery");
  await dispatchWebhookEvent(event, payload);
}

// ─── Distributor Identity Registry Router ───────────────────────────
const distributorRouter = router({
  list: distributorProcedure
    .input(z.object({
      status: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) return [];
      return db.getDistributors({ organizationId: user.organizationId, ...input });
    }),

  stats: distributorProcedure
    .query(async ({ ctx }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) return { total: 0, active: 0, pendingConfirmation: 0, flagged: 0 };
      return db.getDistributorStats(user.organizationId);
    }),

  create: distributorProcedure
    .input(z.object({
      canonicalName: z.string().min(1),
      registeredBusinessName: z.string().optional(),
      taxId: z.string().optional(),
      primaryBankAccount: z.string().optional(),
      primaryBankName: z.string().optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional(),
      zone: z.string().optional(),
      nameVariants: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) throw new TRPCError({ code: "FORBIDDEN" });
      await db.createDistributor({ ...input, organizationId: user.organizationId, createdBy: user.id });
      return { success: true };
    }),

  update: distributorProcedure
    .input(z.object({
      id: z.number(),
      canonicalName: z.string().optional(),
      registeredBusinessName: z.string().optional(),
      taxId: z.string().optional(),
      primaryBankAccount: z.string().optional(),
      primaryBankName: z.string().optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional(),
      zone: z.string().optional(),
      status: z.enum(["active", "inactive", "pending_confirmation", "flagged"]).optional(),
      nameVariants: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) throw new TRPCError({ code: "FORBIDDEN" });
      const { id, ...data } = input;
      await db.updateDistributor(id, user.organizationId, data);
      return { success: true };
    }),

  confirm: distributorProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) throw new TRPCError({ code: "FORBIDDEN" });
      await db.updateDistributor(input.id, user.organizationId, {
        status: "active",
        confirmedBy: user.id,
        confirmedAt: new Date(),
      });
      return { success: true };
    }),

  addVariant: distributorProcedure
    .input(z.object({ id: z.number(), variant: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.getUserByOpenId(ctx.user.openId);
      if (!user?.organizationId) throw new TRPCError({ code: "FORBIDDEN" });
      await db.addDistributorNameVariant(input.id, user.organizationId, input.variant);
      return { success: true };
    }),
});

// In-memory throttle for self-service magic-link requests, keyed by normalised
// email. Prevents inbox flooding / abuse. Adequate for the single-process pilot
// deployment; move to a shared store (Redis) when scaling horizontally.
const magicLinkRequestCooldown = new Map<string, number>();
const MAGIC_LINK_COOLDOWN_MS = 60_000;
// PCI remediation (WS-2): per-IP companion throttle — 10 link requests per
// 15 minutes per IP, regardless of how many emails are tried.
import { createRateLimiter } from "./rateLimiter";
const magicLinkIpLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

// ─── Router ──────────────────────────────────────────────────────────────


/** The caller's organization, or a hard failure. SFTP config is institutional;
 *  an account with no organization has no business owning a bank feed. */
function requireOrg(ctx: { user: { organizationId?: number | null } }): number {
  if (!ctx.user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return ctx.user.organizationId;
}

/** Prove the caller's org owns this credential before acting on it. Throws
 *  NOT_FOUND either way, so this cannot be used to enumerate other tenants. */
async function assertOwnsSftpCredential(
  ctx: { user: { organizationId?: number | null } },
  credentialId: number,
): Promise<void> {
  const cred = await db.getSftpCredentialById(credentialId, requireOrg(ctx));
  if (!cred) {
    throw new TRPCError({ code: "NOT_FOUND", message: "SFTP credential not found" });
  }
}

/**
 * Refuse a super-admin organisation mutation that would match no row.
 *
 * All four org-level setters (`updateOrganizationSegment`, `setOrganizationSso`,
 * `setOrganizationBankingModel`, `setOrganizationIsDemo`) ran
 * `UPDATE … WHERE id = ?` and returned `{ success: true }` unconditionally, so a
 * stale, deleted or mistyped id reported success, wrote a misleading audit
 * entry, and changed nothing.
 *
 * That is worst for `setOrganizationIsDemo`, which decides whether a tenant's
 * SLA alerts are suppressed: believing you have silenced or restored alerting
 * when you have not is exactly the failure the isDemo work exists to prevent.
 *
 * Checks EXISTENCE rather than affectedRows deliberately. MySQL reports
 * affected_rows as rows CHANGED, not matched, so setting a field to the value it
 * already holds returns 0 — and rejecting that no-op as "not found" would be a
 * worse bug than the one being fixed.
 */
async function assertOrganizationExists(
  drizzle: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  organizationId: number,
): Promise<void> {
  const { organizations } = await import("../drizzle/schema");
  const [org] = await drizzle
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Organisation ${organizationId} not found` });
  }
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    // Which enterprise SSO providers are configured (drives /login buttons).
    oauthProviders: publicProcedure.query(async () => {
      const { enabledSsoProviders } = await import("./_core/sso");
      return enabledSsoProviders();
    }),
    // The caller's organization segment (financial_services | corporate_b2b |
    // super_admin), or null. Drives segment-aware UI (e.g. hiding card-settlement
    // content for corporate B2B). Cheap, indexed lookup — used sparingly.
    mySegment: protectedProcedure.query(async ({ ctx }) => {
      if (!ctx.user.organizationId) return { segment: null as string | null };
      const drizzle = await getDb();
      if (!drizzle) return { segment: null as string | null };
      const [org] = await drizzle
        .select({ segment: organizations.segment })
        .from(organizations)
        .where(eq(organizations.id, ctx.user.organizationId))
        .limit(1);
      return { segment: org?.segment ?? null };
    }),
    // Self-service passwordless sign-in: emails a single-use magic link to an
    // existing active user. Always returns a generic success so the endpoint
    // never reveals whether an email is registered (no account enumeration).
    requestMagicLink: publicProcedure
      .input(z.object({
        email: z.string().email(),
        origin: z.string().url().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const email = input.email.trim().toLowerCase();
        const now = Date.now();
        const last = magicLinkRequestCooldown.get(email);

        // PCI remediation (WS-2): per-IP throttle on top of the per-email
        // cooldown — an attacker rotating emails can't spam link sends.
        // Response stays generic (no enumeration signal, no throttle signal).
        const { ip: reqIp } = getClientInfo(ctx);
        if (!magicLinkIpLimiter.check(`ip:${reqIp}`).allowed) {
          return { success: true } as const;
        }

        if (!last || now - last > MAGIC_LINK_COOLDOWN_MS) {
          magicLinkRequestCooldown.set(email, now);
          const host = ctx.req.get("host");
          const origin =
            input.origin ||
            (host ? `${ctx.req.protocol}://${host}` : PUBLIC_APP_ORIGIN);
          try {
            const { sendLoginLinkEmail } = await import("./magicLinkService");
            await sendLoginLinkEmail({ email, origin });
          } catch (err) {
            console.error("[auth.requestMagicLink] Failed to send login link:", err);
          }
        }

        return { success: true } as const;
      }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      // Audit: log logout before clearing the cookie
      if (ctx.user) {
        const { ip, ua } = getClientInfo(ctx);
        await logAudit(ctx.user.id, "user_logout", "user_session", undefined, { email: ctx.user.email }, ip, ua);
      }
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    guestLogin: publicProcedure.mutation(async ({ ctx }) => {
      // ── Use the shared pre-warmed demo user so every guest gets instant data ──
      // The prewarmDemoUser service seeds FMCG + FinServ data once at boot time.
      // All guests share the same read-only view of that pre-seeded dataset.
      const sharedUser = await db.getUserByOpenId(DEMO_PREWARM_OPEN_ID);

      if (!sharedUser) {
        // Pre-warm hasn't run yet (e.g. very first cold start before DB is ready).
        // Fall back to creating a per-session guest and seeding in the background.
        const guestOpenId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substring(7);
        // Fallback guests join the guest demo organisation rather than being
        // created org-less. Org-less is a SHARED scope, not a private one —
        // orgFilter(col, null) is `IS NULL`, so every org-less guest read every
        // other one's seeded rows, and they collided on the same unsuffixed demo
        // channel codes. See ensureGuestDemoOrganization.
        const { ensureGuestDemoOrganization } = await import("./prewarmDemoUser");
        const guestOrgId = await ensureGuestDemoOrganization();
        await db.upsertUser({
          openId: guestOpenId,
          name: 'Guest User',
          email: `guest_${Date.now()}@demo.reconcileai.com`,
          role: 'user',
          isGuest: true,
          organizationId: guestOrgId,
        });
        const fallbackUser = await db.getUserByOpenId(guestOpenId);
        if (!fallbackUser) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create guest user' });
        }
        setImmediate(async () => {
          try {
            // Seed ONCE per demo tenant, not once per guest — and once even if
            // several cold-start logins race.
            //
            // Every fallback guest joins the same demo organisation, which is the
            // documented intent ("all guests share the same read-only view of
            // that pre-seeded dataset") and is safe because guests cannot write:
            // guestProtectedProcedure and operationsProcedure both refuse them,
            // and demo.activate is super-admin only.
            //
            // What is NOT safe is seeding per guest into that shared tenant.
            // seedFinServDemoData wipes by userId, so a second guest's seed does
            // not replace the first — it ADDS a full dataset, doubling every
            // figure the demo shows. An inline `if (empty) seed()` was still
            // check-then-act and lost that race at cold start, which is exactly
            // when simultaneous guests are most likely. ensureGuestDemoSeeded
            // collapses concurrent callers onto one in-flight seed.
            const { ensureGuestDemoSeeded } = await import("./prewarmDemoUser");
            await ensureGuestDemoSeeded(fallbackUser.id, fallbackUser.organizationId ?? null);
            console.log(`[guestLogin] Fallback background seed complete for guest user ${fallbackUser.id}`);
          } catch (seedErr) {
            console.error("[guestLogin] Fallback background seed failed:", seedErr);
          }
        });
        const { sdk } = await import("./_core/sdk");
        const fallbackToken = await sdk.createSessionToken(fallbackUser.openId, {
          name: fallbackUser.name || undefined,
          expiresInMs: 24 * 60 * 60 * 1000,
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, fallbackToken, { ...cookieOptions, maxAge: 24 * 60 * 60 * 1000 });
        return { success: true, user: fallbackUser };
      }

      // Happy path: issue a 24-hour session for the shared pre-warmed demo user
      const { sdk } = await import("./_core/sdk");
      const sessionToken = await sdk.createSessionToken(sharedUser.openId, {
        name: sharedUser.name || undefined,
        expiresInMs: 24 * 60 * 60 * 1000,
      });
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 24 * 60 * 60 * 1000 });
      console.log(`[guestLogin] Issued session for shared pre-warmed demo user (id=${sharedUser.id}, prewarmComplete=${isPrewarmComplete()})`);
      return { success: true, user: sharedUser };
    }),
  }),

  // ─── Channels ────────────────────────────────────────────────────

  channels: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      // Super admins (Infinity AI staff) legitimately span tenants — platform
      // overview and the portal switcher both need the full estate. Everyone
      // else sees their own org's channels plus the shared platform rails.
      if (ctx.user.role === "super_admin") return db.getAllChannelsAcrossTenants();
      return db.getChannels(ctx.user.organizationId ?? null);
    }),

    create: adminProcedure
      .input(z.object({
        name: z.string().min(1).max(100),
        code: z.string().min(1).max(50),
        description: z.string().max(500).optional(),
        channelType: z.enum([
          "bank_core", "nibss", "pos", "atm", "mobile_money", "bank_transfer",
          "agent_banking", "fintech_api", "card_payments", "rtgs", "swift",
          "mobile_banking", "ussd", "qr_payment",
        ]).default("bank_transfer"),
        country: z.string().length(3).default("NGA"),
        defaultCurrency: z.string().length(3).default("NGN"),
        matchingConfig: z.record(z.string(), z.any()).optional(),
        fileFormat: z.record(z.string(), z.any()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        // Duplicate check must span ALL tenants: channels.code carries a global
        // UNIQUE constraint, so an org-scoped check would pass here and then
        // fail on insert with a duplicate-key error. Returns a boolean only, so
        // it cannot leak another tenant's channel details.
        const existing = await db.channelCodeExists(input.code);
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: `Channel with code '${input.code}' already exists` });
        }
        await db.createChannel({
          name: input.name,
          code: input.code,
          description: input.description,
          channelType: input.channelType,
          country: input.country,
          defaultCurrency: input.defaultCurrency,
          matchingConfig: input.matchingConfig ? JSON.stringify(input.matchingConfig) : undefined,
          fileFormat: input.fileFormat ? JSON.stringify(input.fileFormat) : undefined,
          isActive: true,
        });
        await logAudit(ctx.user.id, "create_channel", "channel", 0, input, ip, ua);
        return { success: true };
      }),

    update: adminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        matchingConfig: z.record(z.string(), z.any()).optional(),
        fileFormat: z.record(z.string(), z.any()).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateChannel(input.id, requireOrg(ctx), {
          matchingConfig: input.matchingConfig ? JSON.stringify(input.matchingConfig) : undefined,
          fileFormat: input.fileFormat ? JSON.stringify(input.fileFormat) : undefined,
          isActive: input.isActive,
        });
        await logAudit(ctx.user.id, "update_channel", "channel", input.id, input, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Upload & Ingestion ──────────────────────────────────────────

  upload: router({
    createBatch: guestProtectedProcedure
      .input(
        z.object({
          channelCode: z.string().min(1).max(50),
          fileName: z.string().min(1).max(500),
          fileHash: z.string().max(64).optional(),
          // Connector that parsed this file client-side (e.g. nibss_nip, interswitch_settlement, generic).
          format: z.string().max(64).optional(),
          // Full row count of the whole file (may exceed this chunk for chunked uploads).
          totalRows: z.number().int().min(0).optional(),
          // When false, the batch is left "processing" for subsequent appendBatch calls.
          finalize: z.boolean().default(true),
          transactions: z.array(uploadTxnSchema).max(MAX_UPLOAD_TRANSACTIONS, {
            message: `Maximum ${MAX_UPLOAD_TRANSACTIONS} transactions per request`,
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const channel = await db.getChannelByCode(input.channelCode, ctx.user.organizationId ?? null);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Channel '${sanitizeInput(input.channelCode, 50)}' not found` });
        }

        // Idempotency: a previously COMPLETED upload of the same file short-circuits.
        if (input.fileHash) {
          const existing = await db.getUploadBatchByHash(input.fileHash);
          if (existing) {
            return {
              batchId: existing.id,
              validRows: existing.validRows,
              invalidRows: existing.invalidRows,
              totalRows: existing.totalRows,
              deduplicated: true,
            };
          }
        }

        const batchId = await db.createUploadBatch({
          userId: ctx.user.id,
          channelId: channel.id,
          fileName: sanitizeInput(input.fileName, 500),
          fileHash: input.fileHash || null,
          detectedFormat: input.format ? sanitizeInput(input.format, 64) : null,
          totalRows: input.totalRows ?? input.transactions.length,
          validRows: 0,
          invalidRows: 0,
          status: "processing",
        });

        if (!batchId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create upload batch" });
        }

        const { validTxns, validRows, invalidRows, errors } = buildValidTransactions(
          input.transactions,
          { batchId, channelId: channel.id, userId: ctx.user.id },
        );

        if (validTxns.length > 0) {
          await db.insertTransactions(validTxns);
        }
        await db.incrementUploadBatchCounts(batchId, validRows, invalidRows);

        if (input.finalize) {
          await db.updateUploadBatch(batchId, {
            status: validRows > 0 ? "completed" : "failed",
            errorMessage: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
            completedAt: new Date(),
          });

          await logAudit(ctx.user.id, "upload_batch", "upload_batch", batchId, {
            channel: input.channelCode,
            fileName: input.fileName,
            totalRows: input.totalRows ?? input.transactions.length,
            validRows,
            invalidRows,
          }, ip, ua);

          dispatchWebhook("upload.completed", {
            batchId,
            channel: input.channelCode,
            validRows,
            invalidRows,
          });
        }

        return {
          batchId,
          validRows,
          invalidRows,
          totalRows: input.totalRows ?? input.transactions.length,
          errors: errors.slice(0, 20),
          deduplicated: false,
        };
      }),

    // Append a chunk of rows to an in-progress batch (used by chunked large uploads).
    appendBatch: guestProtectedProcedure
      .input(
        z.object({
          batchId: z.number().int().positive(),
          channelCode: z.string().min(1).max(50),
          rowOffset: z.number().int().min(0).default(0),
          transactions: z.array(uploadTxnSchema).max(MAX_UPLOAD_TRANSACTIONS, {
            message: `Maximum ${MAX_UPLOAD_TRANSACTIONS} transactions per request`,
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelByCode(input.channelCode, ctx.user.organizationId ?? null);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Channel '${sanitizeInput(input.channelCode, 50)}' not found` });
        }
        const batch = await db.getUploadBatchById(input.batchId);
        if (!batch) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Upload batch not found" });
        }
        if (batch.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot append to another user's batch" });
        }
        if (batch.status !== "processing") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Batch is already finalized" });
        }

        const { validTxns, validRows, invalidRows, errors } = buildValidTransactions(
          input.transactions,
          { batchId: input.batchId, channelId: channel.id, userId: ctx.user.id },
          input.rowOffset,
        );

        if (validTxns.length > 0) {
          await db.insertTransactions(validTxns);
        }
        await db.incrementUploadBatchCounts(input.batchId, validRows, invalidRows);

        return { batchId: input.batchId, validRows, invalidRows, errors: errors.slice(0, 20) };
      }),

    // Finalize a chunked batch once all chunks are uploaded.
    finalizeBatch: guestProtectedProcedure
      .input(z.object({ batchId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const batch = await db.getUploadBatchById(input.batchId);
        if (!batch) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Upload batch not found" });
        }
        if (batch.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot finalize another user's batch" });
        }

        const validRows = batch.validRows ?? 0;
        const invalidRows = batch.invalidRows ?? 0;

        await db.updateUploadBatch(input.batchId, {
          status: validRows > 0 ? "completed" : "failed",
          completedAt: new Date(),
        });

        const channel = await db.getChannelById(batch.channelId);
        await logAudit(ctx.user.id, "upload_batch", "upload_batch", input.batchId, {
          channel: channel?.code ?? String(batch.channelId),
          fileName: batch.fileName,
          totalRows: batch.totalRows,
          validRows,
          invalidRows,
        }, ip, ua);

        dispatchWebhook("upload.completed", {
          batchId: input.batchId,
          channel: channel?.code ?? String(batch.channelId),
          validRows,
          invalidRows,
        });

        return {
          batchId: input.batchId,
          validRows,
          invalidRows,
          totalRows: batch.totalRows,
          deduplicated: false,
        };
      }),

    history: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getUploadBatches(ctx.user.organizationId ?? null);
    }),
  }),

  // ─── Transactions ────────────────────────────────────────────────

  transactions: router({
    list: protectedProcedure
      .input(
        z.object({
          channelId: z.number().int().positive().optional(),
          status: z.string().max(30).optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          amountMin: z.number().min(0).optional(),
          amountMax: z.number().max(999999999999.99).optional(),
          search: z.string().max(MAX_SEARCH_LENGTH).optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
      )
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        return db.getTransactions({
          organizationId: ctx.user.organizationId ?? null,
          userId: ctx.user.id,
          isAdmin,
          channelId: input.channelId,
          status: input.status,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
          amountMin: input.amountMin,
          amountMax: input.amountMax,
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        });
      }),
  }),

  // ─── Reconciliation ─────────────────────────────────────────────

  reconciliation: reconciliationRouter,

  // ─── Exception Age / Escalation Tracker ──────────────────────────
  ageTracker: router({
    // Ops control-centre summary: aging buckets + ₦ exposure + over-aged tally.
    summary: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const settings = orgId ? await db.getAgingSettings(orgId) : null;
      const slaDays = settings?.slaDays ?? ageTracker.DEFAULT_SLA_DAYS;
      const rows = await db.getOpenExceptionsForAging(ctx.user.organizationId ?? null);
      const now = new Date();
      const items = rows.map((r) => ({
        ageDays: ageTracker.ageDays(r.createdAt, now),
        amount: Math.abs(parseFloat(String(r.amount)) || 0),
      }));
      return ageTracker.computeSummary(items, slaDays);
    }),

    // The aging list, oldest first; optionally only the over-aged items.
    list: protectedProcedure
      .input(z.object({ onlyOverAged: z.boolean().default(false), limit: z.number().int().min(1).max(1000).default(200) }))
      .query(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? 0;
        const settings = orgId ? await db.getAgingSettings(orgId) : null;
        const slaDays = settings?.slaDays ?? ageTracker.DEFAULT_SLA_DAYS;
        const rows = await db.getOpenExceptionsForAging(ctx.user.organizationId ?? null);
        const now = new Date();
        let items = rows.map((r) => {
          const age = ageTracker.ageDays(r.createdAt, now);
          return {
            id: r.id,
            jobId: r.jobId,
            jobName: r.jobName ?? null,
            category: r.category,
            severity: r.severity,
            status: r.status,
            description: r.description,
            assignedTo: r.assignedTo,
            assigneeName: r.assigneeName ?? null,
            reference: r.transactionRef ?? null,
            amount: Math.abs(parseFloat(String(r.amount)) || 0),
            currency: r.currency ?? "NGN", // WS-6
            createdAt: r.createdAt,
            ageDays: age,
            escalationLevel: ageTracker.escalationLevel(age, slaDays),
            overAged: ageTracker.isOverAged(age, slaDays),
          };
        });
        if (input.onlyOverAged) items = items.filter((i) => i.overAged);
        return { slaDays, items: items.slice(0, input.limit) };
      }),

    // Escalate a single over-aged exception (visible workflow action).
    escalate: operationsProcedure
      .input(z.object({ id: z.number().int().positive(), note: z.string().max(2000).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          status: "escalated",
          ...(input.note ? { resolutionNotes: sanitizeInput(input.note, 2000) } : {}),
        });
        await logAudit(ctx.user.id, "escalate_exception", "exception", input.id, { note: input.note }, ip, ua);
        // Flywheel write-path (audit fix): escalations are learnable outcomes.
        if (ctx.user.organizationId) {
          const _orgId = ctx.user.organizationId;
          const _userId = ctx.user.id;
          void import("./exceptionIntelligence").then((ei) =>
            ei.captureExceptionOutcome({
              organizationId: _orgId,
              exceptionId: input.id,
              actorUserId: _userId,
              outcome: "escalated",
              resolutionText: input.note || "Escalated per aging SLA",
            }),
          ).catch(() => {});
        }
        dispatchWebhook("exception.escalated", { exceptionId: input.id });
        return { success: true };
      }),

    // One-click: escalate every over-aged item still open (ops bulk action).
    bulkEscalateOverAged: operationsProcedure.mutation(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const settings = orgId ? await db.getAgingSettings(orgId) : null;
      const slaDays = settings?.slaDays ?? ageTracker.DEFAULT_SLA_DAYS;
      const rows = await db.getOpenExceptionsForAging(ctx.user.organizationId ?? null);
      const now = new Date();
      const overAged = rows.filter(
        (r) => ageTracker.isOverAged(ageTracker.ageDays(r.createdAt, now), slaDays) && r.status !== "escalated",
      );
      await Promise.all(overAged.map((r) => db.updateException(r.id, ctx.user.organizationId ?? null, { status: "escalated" })));
      const { ip, ua } = getClientInfo(ctx);
      await logAudit(ctx.user.id, "bulk_escalate_overaged", "exception", undefined, { count: overAged.length, slaDays }, ip, ua);
      // Flywheel write-path (audit fix): each bulk escalation is a learnable
      // outcome. Fire-and-forget, sequential to avoid hammering the DB.
      if (ctx.user.organizationId && overAged.length > 0) {
        const _orgId = ctx.user.organizationId;
        const _userId = ctx.user.id;
        const _ids = overAged.map((r) => r.id);
        void (async () => {
          try {
            const ei = await import("./exceptionIntelligence");
            for (const id of _ids) {
              await ei.captureExceptionOutcome({
                organizationId: _orgId,
                exceptionId: id,
                actorUserId: _userId,
                outcome: "escalated",
                resolutionText: `Escalated per aging SLA (${slaDays} days)`,
              });
            }
          } catch { /* best-effort */ }
        })();
      }
      return { success: true, count: overAged.length };
    }),

    getSettings: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const settings = orgId ? await db.getAgingSettings(orgId) : null;
      return { slaDays: settings?.slaDays ?? ageTracker.DEFAULT_SLA_DAYS };
    }),

    saveSettings: operationsProcedure
      .input(z.object({ slaDays: z.number().int().min(1).max(365) }))
      .mutation(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? 0;
        if (!orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "No organization context for SLA settings" });
        await db.upsertAgingSettings(orgId, input.slaDays);
        await logAudit(ctx.user.id, "update_aging_sla", "exception_aging_settings", orgId, { slaDays: input.slaDays });
        return { slaDays: input.slaDays };
      }),
  }),

  // ─── Exceptions ──────────────────────────────────────────────────

  exceptions: router({
    list: protectedProcedure
      .input(
        z.object({
          jobId: z.number().int().positive().optional(),
          status: z.string().max(30).optional(),
          category: z.string().max(50).optional(),
          severity: z.string().max(20).optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
      )
      .query(async ({ ctx, input }) => {
        return db.getExceptions({ ...input, organizationId: ctx.user.organizationId ?? null });
      }),

    resolve: operationsProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          status: z.enum(["resolved", "dismissed"]),
          resolutionNotes: z.string().max(2000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          status: input.status,
          resolvedBy: ctx.user.id,
          resolvedAt: new Date(),
          resolutionNotes: input.resolutionNotes ? sanitizeInput(input.resolutionNotes, 2000) : null,
        });
        await logAudit(ctx.user.id, "resolve_exception", "exception", input.id, {
          status: input.status,
          notes: input.resolutionNotes,
        }, ip, ua);

        // Fire-and-forget: capture the resolved exception as a per-institution learning pattern.
        const _resolveOrgId = ctx.user.organizationId;
        const _resolveUserId = ctx.user.id;
        const _resolveInput = input;
        void (async () => {
          try {
            if (!_resolveOrgId) return;
            const drizzle = await getDb();
            if (!drizzle) return;
            const { exceptions: exTbl, transactions: txTbl } = await import("../drizzle/schema");
            const rows = await drizzle
              .select({
                category: exTbl.category,
                description: exTbl.description,
                amount: txTbl.amount,
                counterparty: txTbl.counterparty,
                transactionRef: txTbl.transactionRef,
              })
              .from(exTbl)
              .innerJoin(txTbl, eq(exTbl.transactionId, txTbl.id))
              .where(eq(exTbl.id, _resolveInput.id))
              .limit(1);
            if (!rows.length) return;
            const row = rows[0];
            const amt = parseFloat(String(row.amount)) || 0;
            const amtRange: "0-100k" | "100k-1m" | "1m+" = amt < 100_000 ? "0-100k" : amt < 1_000_000 ? "100k-1m" : "1m+";
            const ei = await import("./exceptionIntelligence");
            const cpType = ei.counterpartyTypeOf(row.counterparty);
            const resolution = _resolveInput.resolutionNotes || "Exception resolved";
            const actionClass = ei.classifyResolutionAction(resolution);
            const outcome: "resolved" | "rejected" = _resolveInput.status === "resolved" ? "resolved" : "rejected";
            await drizzle.insert(agentMemory).values({
              organizationId: _resolveOrgId,
              exceptionId: _resolveInput.id,
              exceptionCategory: row.category,
              transactionRef: row.transactionRef ?? null,
              amountRange: amtRange,
              counterpartyType: cpType,
              deductionType: null,
              resolution,
              outcome,
              reasoning: row.description || "Exception resolved by operations team",
              embeddingText: `category:${row.category} amount:${amtRange} counterparty:${cpType} resolution:${actionClass} outcome:${outcome}`,
              resolvedBy: _resolveUserId,
            });
            // Also feed the anonymized cross-institution pool.
            const sig = ei.deriveSignature({ exceptionCategory: row.category, amount: amt, counterparty: row.counterparty, resolution, outcome });
            await ei.recordLocalSignature(_resolveOrgId, sig);
          } catch { /* pattern capture is best-effort; never fail the primary response */ }
        })();

        dispatchWebhook("exception.resolved", { exceptionId: input.id, status: input.status });
        return { success: true };
      }),

    // Reverts a RESOLVED/DISMISSED exception back to OPEN.
    // Used when the CBS staleness check shows the anomaly was never fixed.
    reopen: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        // Through the org-scoped helper, not an inline drizzle write. The inline
        // form keyed on `input.id` alone, so a caller could reopen another
        // tenant's resolved exception — and reopening also retracts the
        // flywheel record below, meaning it reached into their learning data too.
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          status: "open",
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: input.notes ?? null,
          cbsStillAnomalous: false,
          userKeptResolved: false,
        });
        await logAudit(ctx.user.id, "reopen_exception", "exception", input.id, { notes: input.notes }, ip, ua);

        // Flywheel retraction (audit fix): a reopened resolution was WRONG —
        // remove its agentMemory record and decrement the local signature so
        // failed resolutions stop training the recommendations and inflating
        // the shared pool. Best-effort, never fails the reopen.
        if (ctx.user.organizationId) {
          const _orgId = ctx.user.organizationId;
          void import("./exceptionIntelligence").then((ei) =>
            ei.retractResolutionLearning(_orgId, input.id),
          ).catch(() => {});
        }

        return { success: true };
      }),

    assign: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        assignedTo: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          assignedTo: input.assignedTo,
          assignedAt: new Date(),
          assignedBy: ctx.user.id,
          status: "in_review",
        });
        await logAudit(ctx.user.id, "assign_exception", "exception", input.id, {
          assignedTo: input.assignedTo,
          assignedBy: ctx.user.id,
        }, ip, ua);
        return { success: true };
      }),

    bulkAssign: operationsProcedure
      .input(z.object({
        exceptionIds: z.array(z.number().int().positive()).min(1).max(100),
        assignedTo: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const updatePromises = input.exceptionIds.map(id =>
          db.updateException(id, ctx.user.organizationId ?? null, {
            assignedTo: input.assignedTo,
            assignedAt: new Date(),
            assignedBy: ctx.user.id,
            status: "in_review",
          })
        );
        await Promise.all(updatePromises);
        await logAudit(ctx.user.id, "bulk_assign_exceptions", "exception", undefined, {
          exceptionIds: input.exceptionIds,
          assignedTo: input.assignedTo,
          assignedBy: ctx.user.id,
          count: input.exceptionIds.length,
        }, ip, ua);
        return { success: true, count: input.exceptionIds.length };
      }),

    getTeamMembers: protectedProcedure
      .query(async () => {
        // Get all active users for assignment
        const allUsers = await db.getAllUsers();
        return allUsers.filter(u => u.isActive);
      }),

    getTeamWorkload: protectedProcedure
      .query(async ({ ctx }) => {
        const allUsers = await db.getAllUsers();
        const activeUsers = allUsers.filter(u => u.isActive && !u.isGuest);
        const exceptionsResult = await db.getExceptions({
          organizationId: ctx.user.organizationId ?? null,
          limit: 10000,
        });
        const allExceptions = exceptionsResult.data;
        
        const workloadData = await Promise.all(activeUsers.map(async (user) => {
          const userExceptions = allExceptions.filter((e: any) => e.assignedTo === user.id);
          const currentLoad = userExceptions.filter((e: any) => e.status === 'open' || e.status === 'in_review').length;
          const resolvedExceptions = userExceptions.filter((e: any) => e.status === 'resolved');
          
          // Calculate average resolution time
          let avgResolutionTime = 0;
          if (resolvedExceptions.length > 0) {
            const totalTime = resolvedExceptions.reduce((sum: number, e: any) => {
              if (e.createdAt && e.resolvedAt) {
                return sum + (e.resolvedAt.getTime() - e.createdAt.getTime());
              }
              return sum;
            }, 0);
            avgResolutionTime = totalTime / resolvedExceptions.length / (1000 * 60 * 60); // hours
          }
          
          // Calculate SLA compliance (resolved within 24 hours)
          const slaCompliant = resolvedExceptions.filter((e: any) => {
            if (e.createdAt && e.resolvedAt) {
              const hoursToResolve = (e.resolvedAt.getTime() - e.createdAt.getTime()) / (1000 * 60 * 60);
              return hoursToResolve <= 24;
            }
            return false;
          }).length;
          const slaComplianceRate = resolvedExceptions.length > 0 
            ? (slaCompliant / resolvedExceptions.length) * 100 
            : 100;
          
          return {
            userId: user.id,
            userName: user.name || user.email || 'Unknown',
            currentLoad,
            avgResolutionTime: Math.round(avgResolutionTime * 10) / 10,
            slaComplianceRate: Math.round(slaComplianceRate),
            totalResolved: resolvedExceptions.length,
          };
        }));
        
        return workloadData.sort((a, b) => b.currentLoad - a.currentLoad);
      }),

    escalate: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          status: "escalated",
          resolutionNotes: input.notes ? sanitizeInput(input.notes, 2000) : null,
        });
        await logAudit(ctx.user.id, "escalate_exception", "exception", input.id, {
          notes: input.notes,
        }, ip, ua);

        // Flywheel write-path (audit fix): escalations are learnable outcomes.
        if (ctx.user.organizationId) {
          const _orgId = ctx.user.organizationId;
          const _userId = ctx.user.id;
          void import("./exceptionIntelligence").then((ei) =>
            ei.captureExceptionOutcome({
              organizationId: _orgId,
              exceptionId: input.id,
              actorUserId: _userId,
              outcome: "escalated",
              resolutionText: input.notes || "Escalated to management",
            }),
          ).catch(() => {});
        }

        dispatchWebhook("exception.escalated", { exceptionId: input.id });
        return { success: true };
      }),

    moveToReview: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateException(input.id, ctx.user.organizationId ?? null, {
          status: "in_review",
          assignedTo: ctx.user.id,
          assignedAt: new Date(),
          assignedBy: ctx.user.id,
          resolutionNotes: input.notes ? sanitizeInput(input.notes, 2000) : null,
        });
        await logAudit(ctx.user.id, "move_exception_to_review", "exception", input.id, {
          assignedTo: ctx.user.id,
          notes: input.notes,
        }, ip, ua);
        dispatchWebhook("exception.in_review", { exceptionId: input.id, reviewedBy: ctx.user.id });
        return { success: true };
      }),

    exportXlsx: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive().optional(),
        status: z.string().max(30).optional(),
        severity: z.string().max(20).optional(),
        category: z.string().max(50).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const exceptions = await db.getExceptions({
          organizationId: ctx.user.organizationId ?? null,
          jobId: input.jobId,
          status: input.status,
          severity: input.severity,
          category: input.category,
          limit: 5000,
          offset: 0,
        });

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ReconcileAI";
        workbook.created = new Date();

        const headerStyle = {
          font: { bold: true, color: { argb: "FFFFFFFF" } },
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
          alignment: { horizontal: "left" as const },
        };
        const altRow = {
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } },
        };

        const ws = workbook.addWorksheet("Exceptions");
        ws.columns = [
          { header: "Exception ID", key: "id", width: 14 },
          { header: "Job ID", key: "jobId", width: 12 },
          { header: "Transaction ID", key: "transactionId", width: 16 },
          { header: "Category", key: "category", width: 28 },
          { header: "Severity", key: "severity", width: 12 },
          { header: "Status", key: "status", width: 16 },
          { header: "Description", key: "description", width: 55 },
          { header: "AI Suggestion", key: "aiSuggestion", width: 55 },
          { header: "Resolution Notes", key: "resolutionNotes", width: 45 },
          { header: "Assigned To", key: "assignedTo", width: 16 },
          { header: "Resolved By", key: "resolvedBy", width: 16 },
          { header: "Resolved At", key: "resolvedAt", width: 22 },
          { header: "Created At", key: "createdAt", width: 22 },
        ];
        ws.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        ws.getRow(1).height = 20;
        ws.views = [{ state: "frozen", ySplit: 1 }];
        // Apply number formatting to numeric columns
        ws.getColumn("id").numFmt = "#,##0";
        ws.getColumn("jobId").numFmt = "#,##0";
        (exceptions.data ?? []).forEach((e: any, i: number) => {
          const r = ws.addRow({
            id: e.id,
            jobId: e.jobId ?? "",
            transactionId: e.transactionId ?? "",
            category: e.category ?? "",
            severity: e.severity ?? "",
            status: e.status ?? "",
            description: e.description ?? "",
            aiSuggestion: e.aiSuggestion ?? "",
            resolutionNotes: e.resolutionNotes ?? "",
            assignedTo: e.assignedTo ?? "",
            resolvedBy: e.resolvedBy ?? "",
            resolvedAt: e.resolvedAt ? new Date(e.resolvedAt).toISOString() : "",
            createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : "",
          });
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });
        (ws as any).autoFilter = ws.dimensions;

        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `exceptions-export-${Date.now()}.xlsx`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(buffer),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        await logAudit(ctx.user.id, "export_exceptions_xlsx", "exception", undefined, {
          filters: input, count: exceptions.data?.length ?? 0,
        }, ip, ua);
        return { url, fileName };
      }),

    // Cross-run CBS staleness check for the main reconciliation system.
    //
    // ReconcileAI connects to multiple CBS systems via uploads, SFTP, or API —
    // there is no direct live CBS query. Staleness is detected cross-run:
    // "Was this RESOLVED exception's transactionRef seen again as a new open exception
    // in a more recent job on the same channel?" If yes → the CBS was never fixed.
    checkStaleness: protectedProcedure
      .input(z.object({
        exceptionIds: z.array(z.number().int().positive()).max(200),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const orgId = ctx.user.organizationId;

        const { exceptions: exceptionsTable, transactions: transactionsTable } = await import("../drizzle/schema");

        // Pull the resolved exceptions + their linked transaction refs
        const resolvedRows = await drizzle
          .select({
            exceptionId: exceptionsTable.id,
            resolvedAt: exceptionsTable.resolvedAt,
            transactionId: exceptionsTable.transactionId,
            transactionRef: transactionsTable.transactionRef,
            channelId: transactionsTable.channelId,
          })
          .from(exceptionsTable)
          .innerJoin(transactionsTable, eq(transactionsTable.id, exceptionsTable.transactionId))
          .where(
            and(
              inArray(exceptionsTable.id, input.exceptionIds),
              inArray(exceptionsTable.status, ["resolved", "dismissed"] as any[]),
            )
          );

        if (resolvedRows.length === 0) return { checked: 0, staleCount: 0, results: [] };

        const results: { exceptionId: number; cbsStillAnomalous: boolean; verificationNote: string }[] = [];

        for (const row of resolvedRows) {
          if (!row.transactionRef || !row.resolvedAt) {
            results.push({ exceptionId: row.exceptionId, cbsStillAnomalous: false, verificationNote: "No transaction reference available for cross-run check" });
            continue;
          }

          // Raw SQL avoids drizzle self-join complexity. Finds any open exception
          // for a transaction with the same ref + channel created after resolution.
          const orgFilter = orgId != null ? sql` AND t_new.organizationId = ${orgId}` : sql``;
          const rawResult = await drizzle.execute(sql`
            SELECT e_new.id AS new_exception_id, e_new.jobId AS new_job_id, e_new.createdAt AS new_created_at
            FROM transactions t_new
            JOIN exceptions e_new ON e_new.transactionId = t_new.id
            WHERE t_new.transactionRef = ${row.transactionRef}
              AND t_new.channelId = ${row.channelId}
              AND e_new.status IN ('open', 'in_review', 'escalated')
              AND e_new.createdAt > ${row.resolvedAt}
              ${orgFilter}
            LIMIT 1
          `);

          const reappeared = ((rawResult as unknown as any[][])[0]) as any[];
          const stillAnomalous = reappeared.length > 0;
          const note = stillAnomalous
            ? `Transaction ref "${row.transactionRef}" re-appeared as an open exception in job #${reappeared[0].new_job_id} (${new Date(reappeared[0].new_created_at).toLocaleDateString()}) — corrective action was not applied in the CBS`
            : `No re-occurrence of "${row.transactionRef}" found in subsequent reconciliation runs — CBS appears resolved`;

          await drizzle.update(exceptionsTable)
            .set({ cbsStillAnomalous: stillAnomalous, cbsVerificationNote: note })
            .where(eq(exceptionsTable.id, row.exceptionId));

          results.push({ exceptionId: row.exceptionId, cbsStillAnomalous: stillAnomalous, verificationNote: note });
        }

        return { checked: results.length, staleCount: results.filter((r) => r.cbsStillAnomalous).length, results };
      }),

    // User explicitly keeps the exception RESOLVED despite the CBS re-occurrence.
    //
    // operationsProcedure, matching resolve/reopen/assign/escalate/moveToReview
    // beside it: this overrides a re-detected anomaly and is the same kind of
    // write. It was the one exception mutation on protectedProcedure, so CFO and
    // Compliance — read-only by policy — could suppress a live finding.
    //
    // It also wrote `.where(eq(exceptions.id, input.exceptionId))` on a
    // caller-supplied id with no tenancy predicate, so ANY signed-in user could
    // mark ANY tenant's exception as kept-resolved. db.updateException carries
    // the org filter; the inline drizzle write bypassed it. `checkStaleness`
    // directly above already scoped its own query, which is what made this an
    // outlier rather than a pattern.
    keepResolvedDespiteStaleness: operationsProcedure
      .input(z.object({ exceptionId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        await db.updateException(input.exceptionId, ctx.user.organizationId ?? null, {
          userKeptResolved: true,
        });
        return { success: true, exceptionId: input.exceptionId };
      }),
  }),

  // ─── Resolution Templates ────────────────────────────────────────

  resolutionTemplates: router({
    list: protectedProcedure
      .input(z.object({
        category: z.enum(RESOLUTION_TEMPLATE_CATEGORIES).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const dbConn = await db.getDb();
        if (!dbConn) return [];
        
        // Fetch templates for user's org and global templates (organizationId = null)
        const allTemplates = await dbConn.select()
          .from(db.resolutionTemplates)
          .orderBy(desc(db.resolutionTemplates.isDefault), desc(db.resolutionTemplates.createdAt));
        
        // Filter in memory to include user's org templates and global templates
        const orgFiltered = allTemplates.filter(t => 
          t.organizationId === ctx.user.organizationId || t.organizationId === null
        );

        // If a category is specified, return only templates for that category
        if (input?.category) {
          return orgFiltered.filter(t => t.category === input.category);
        }
        return orgFiltered;
      }),

    create: guestProtectedProcedure
      .input(z.object({
        name: z.string().min(1).max(255),
        category: z.enum(RESOLUTION_TEMPLATE_CATEGORIES),
        templateText: z.string().min(1).max(2000),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const dbConn = await db.getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        
        await dbConn.insert(db.resolutionTemplates).values({
          name: sanitizeInput(input.name, 255),
          category: input.category,
          templateText: sanitizeInput(input.templateText, 2000),
          createdBy: ctx.user.id,
          organizationId: ctx.user.organizationId,
          isDefault: false,
        });
        await logAudit(ctx.user.id, "create_resolution_template", "template", undefined, {
          name: input.name,
          category: input.category,
        }, ip, ua);
        return { success: true };
      }),

    update: guestProtectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255),
        templateText: z.string().min(1).max(2000),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const dbConn = await db.getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        
        await dbConn.update(db.resolutionTemplates)
          .set({
            name: sanitizeInput(input.name, 255),
            templateText: sanitizeInput(input.templateText, 2000),
            updatedAt: new Date(),
          })
          .where(eq(db.resolutionTemplates.id, input.id));
        await logAudit(ctx.user.id, "update_resolution_template", "template", input.id, {
          name: input.name,
        }, ip, ua);
        return { success: true };
      }),

    delete: guestProtectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const dbConn = await db.getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        
        await dbConn.delete(db.resolutionTemplates)
          .where(eq(db.resolutionTemplates.id, input.id));
        await logAudit(ctx.user.id, "delete_resolution_template", "template", input.id, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Module Configurations ───────────────────────────────────────

  modules: modulesRouter,

  // ─── Review Queue (Matches) ──────────────────────────────────────

  review: router({
    pending: protectedProcedure.query(async ({ ctx }) => {
      // The userId/isAdmin pair this used to pass was accepted and ignored —
      // the query filtered on status alone, so every caller saw every tenant's
      // review queue. Scoped by organization now that `matches` carries one,
      // which supersedes the narrowed isAdmin flag from #45: the function no
      // longer takes either argument.
      return db.getPendingReviewMatches(ctx.user.organizationId ?? null);
    }),

    approve: guestProtectedProcedure
      .input(z.object({ matchId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateMatchStatus(input.matchId, ctx.user.organizationId ?? null, "confirmed", ctx.user.id);
        await logAudit(ctx.user.id, "approve_match", "match", input.matchId, {}, ip, ua);
        return { success: true };
      }),

    reject: guestProtectedProcedure
      .input(z.object({ matchId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        await db.updateMatchStatus(input.matchId, ctx.user.organizationId ?? null, "rejected", ctx.user.id);
        await logAudit(ctx.user.id, "reject_match", "match", input.matchId, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── Audit Trail ─────────────────────────────────────────────────

  audit: router({
    list: protectedProcedure
      .input(
        z.object({
          entityType: z.string().max(50).optional(),
          entityId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
      )
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        return db.getAuditLogs({
          ...input,
          organizationId: ctx.user.organizationId ?? null,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),

    // Verify the tamper-evident hash chain for the caller's organization. Returns
    // whether the audit trail is intact and, if not, the first broken sequence.
    verifyChain: protectedProcedure
      .query(async ({ ctx }) => {
        const isAdmin = ctx.user.role === "admin" || ctx.user.role === "super_admin";
        if (!isAdmin) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Audit chain verification is restricted to administrators" });
        }
        const { verifyChain } = await import("./auditChain");
        const rows = await db.getAuditChain(ctx.user.organizationId ?? null);
        const result = verifyChain(rows as any);
        return {
          ...result,
          organizationId: ctx.user.organizationId ?? null,
          verifiedAt: new Date().toISOString(),
        };
      }),

    exportXlsx: protectedProcedure
      .input(z.object({
        entityType: z.string().max(50).optional(),
        action: z.string().max(100).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        limit: z.number().int().min(1).max(10000).default(5000),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const isAdmin = ctx.user.role === "admin";

        // Fetch up to 10K rows for export
        const { data } = await db.getAuditLogs({
          organizationId: ctx.user.organizationId ?? null,
          entityType: input.entityType,
          limit: input.limit,
          userId: isAdmin ? undefined : ctx.user.id,
        });

        // Optional client-side action filter (db layer doesn't support it directly)
        const filtered = input.action
          ? data.filter((e: any) => e.action?.toLowerCase().includes(input.action!.toLowerCase()))
          : data;

        // Optional date range filter
        const dateFiltered = filtered.filter((e: any) => {
          if (!input.dateFrom && !input.dateTo) return true;
          const ts = new Date(e.createdAt).getTime();
          if (input.dateFrom && ts < new Date(input.dateFrom).getTime()) return false;
          if (input.dateTo && ts > new Date(input.dateTo + "T23:59:59Z").getTime()) return false;
          return true;
        });

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ReconcileAI";
        workbook.created = new Date();

        const headerStyle = {
          font: { bold: true, color: { argb: "FFFFFFFF" } },
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
          alignment: { horizontal: "left" as const },
        };
        const altRow = {
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } },
        };

        const ws = workbook.addWorksheet("Audit Trail");
        ws.columns = [
          { header: "ID", key: "id", width: 10 },
          { header: "Timestamp (UTC)", key: "createdAt", width: 24 },
          { header: "User ID", key: "userId", width: 12 },
          { header: "Action", key: "action", width: 36 },
          { header: "Entity Type", key: "entityType", width: 20 },
          { header: "Entity ID", key: "entityId", width: 12 },
          { header: "Details", key: "details", width: 60 },
          { header: "IP Address", key: "ipAddress", width: 18 },
          { header: "User Agent", key: "userAgent", width: 50 },
        ];
        ws.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        ws.getRow(1).height = 20;
        ws.views = [{ state: "frozen", ySplit: 1 }];
        (ws as any).autoFilter = ws.dimensions;

        dateFiltered.forEach((e: any, i: number) => {
          const r = ws.addRow({
            id: e.id,
            createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : "",
            userId: e.userId ?? "",
            action: e.action ?? "",
            entityType: e.entityType ?? "",
            entityId: e.entityId ?? "",
            details: e.details ? JSON.stringify(e.details) : "",
            ipAddress: e.ipAddress ?? "",
            userAgent: e.userAgent ?? "",
          });
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `audit-trail-export-${Date.now()}.xlsx`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(buffer),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        await logAudit(ctx.user.id, "export_audit_trail_xlsx", "audit_log", undefined, {
          rowCount: dateFiltered.length, filters: input,
        }, ip, ua);
        return { url, fileName, rowCount: dateFiltered.length };
      }),
  }),

  // ─── Reports ─────────────────────────────────────────────────────

  reports: router({
    get: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        const reports = await db.getReports(ctx.user.organizationId ?? null);
        const report = reports.find((r) => r.id === input.id);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
        return report;
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getReports(ctx.user.organizationId ?? null);
    }),

    generate: guestProtectedProcedure
      .input(
        z.object({
          jobId: z.number().int().positive(),
          reportType: z.enum(["daily", "weekly", "monthly", "custom"]),
          title: z.string().min(1).max(MAX_NAME_LENGTH),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const job = await db.getReconciliationJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

        const jobMatches = await db.getMatchesByJob(input.jobId);
        const { data: jobExceptions } = await db.getExceptions({
          organizationId: ctx.user.organizationId ?? null,
          jobId: input.jobId,
        });

        const summary = {
          jobName: job.name,
          dateRange: `${job.dateFrom} - ${job.dateTo}`,
          totalSource: job.totalSourceTxns,
          totalTarget: job.totalTargetTxns,
          matched: job.matchedCount,
          exceptions: job.exceptionCount,
          unmatched: job.unmatchedCount,
          matchRate: job.matchRate,
          processingTimeMs: job.processingTimeMs,
          matchBreakdown: {
            exact: jobMatches.filter((m) => m.matchType === "exact").length,
            fuzzy: jobMatches.filter((m) => m.matchType === "fuzzy").length,
            amountTolerance: jobMatches.filter((m) => m.matchType === "amount_tolerance").length,
            dateWindow: jobMatches.filter((m) => m.matchType === "date_window").length,
            aiSuggested: jobMatches.filter((m) => m.matchType === "ai_suggested").length,
            manual: jobMatches.filter((m) => m.matchType === "manual").length,
            reversal: jobMatches.filter((m) => m.matchType === "reversal").length,
          },
          exceptionBreakdown: {
            missingCounterparty: jobExceptions.filter((e) => e.category === "missing_counterparty").length,
            amountMismatch: jobExceptions.filter((e) => e.category === "amount_mismatch").length,
            timingDifference: jobExceptions.filter((e) => e.category === "timing_difference").length,
            duplicate: jobExceptions.filter((e) => e.category === "duplicate_transaction").length,
            unmatched: jobExceptions.filter((e) => e.category === "unmatched").length,
            reversalUnmatched: jobExceptions.filter((e) => e.category === "reversal_unmatched").length,
            currencyMismatch: jobExceptions.filter((e) => e.category === "currency_mismatch").length,
          },
          generatedAt: new Date().toISOString(),
          generatedBy: ctx.user.name || ctx.user.email || "Unknown",
        };

        const reportId = await db.createReport({
          jobId: input.jobId,
          userId: ctx.user.id,
          reportType: input.reportType,
          title: sanitizeInput(input.title, MAX_NAME_LENGTH),
          summary: JSON.stringify(summary),
          format: "pdf",
        });

        await logAudit(ctx.user.id, "generate_report", "report", reportId || undefined, {
          jobId: input.jobId,
          reportType: input.reportType,
        }, ip, ua);

         return { reportId, summary };
      }),

    // ─── Share Report ─────────────────────────────────────────────
    createShareToken: protectedProcedure
      .input(z.object({
        reportId: z.number().int().positive(),
        recipientEmail: z.string().email().optional(),
        recipientName: z.string().max(255).optional(),
        note: z.string().max(1000).optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(), // null = never
      }))
      .mutation(async ({ ctx, input }) => {        const isAdmin = ctx.user.role === "admin";
        const reports = await db.getReports(ctx.user.organizationId ?? null);
        const report = reports.find((r) => r.id === input.reportId);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
        const crypto = await import("crypto");
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = input.expiresInDays
          ? new Date(Date.now() + input.expiresInDays * 86400 * 1000)
          : null;
        const dbConn = await getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { sharedReportTokens } = await import("../drizzle/schema");
        await dbConn.insert(sharedReportTokens).values({
          reportId: input.reportId,
          token,
          createdByUserId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? null,
          recipientEmail: input.recipientEmail ?? null,
          recipientName: input.recipientName ?? null,
          note: input.note ?? null,
          expiresAt: expiresAt ?? undefined,
        });
        return { token };
      }),

    listShareTokens: protectedProcedure
      .input(z.object({ reportId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        const reports = await db.getReports(ctx.user.organizationId ?? null);
        const report = reports.find((r) => r.id === input.reportId);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
        const dbConn = await getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { sharedReportTokens } = await import("../drizzle/schema");
        return dbConn.select().from(sharedReportTokens)
          .where(eq(sharedReportTokens.reportId, input.reportId))
          .orderBy(desc(sharedReportTokens.createdAt));
      }),

    revokeShareToken: protectedProcedure
      .input(z.object({ tokenId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const dbConn = await getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { sharedReportTokens } = await import("../drizzle/schema");
        await dbConn.update(sharedReportTokens)
          .set({ revokedAt: new Date() })
          .where(eq(sharedReportTokens.id, input.tokenId));
        return { ok: true };
      }),

    viewShared: publicProcedure
      .input(z.object({ token: z.string().length(64) }))
      .query(async ({ input }) => {
        const dbConn = await getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { sharedReportTokens, reconciliationReports } = await import("../drizzle/schema");
        const rows = await dbConn.select().from(sharedReportTokens)
          .where(eq(sharedReportTokens.token, input.token))
          .limit(1);
        const shareRow = rows[0];
        if (!shareRow) throw new TRPCError({ code: "NOT_FOUND", message: "Link not found or has been revoked." });
        if (shareRow.revokedAt) throw new TRPCError({ code: "FORBIDDEN", message: "This link has been revoked." });
        if (shareRow.expiresAt && shareRow.expiresAt < new Date()) throw new TRPCError({ code: "FORBIDDEN", message: "This link has expired." });
        // Increment view count
        await dbConn.update(sharedReportTokens)
          .set({ viewCount: shareRow.viewCount + 1, lastViewedAt: new Date() })
          .where(eq(sharedReportTokens.id, shareRow.id));
        const reportRows = await dbConn.select().from(reconciliationReports)
          .where(eq(reconciliationReports.id, shareRow.reportId))
          .limit(1);
        const report = reportRows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found." });
        return {
          report: {
            id: report.id,
            title: report.title,
            reportType: report.reportType,
            format: report.format,
            summary: report.summary,
            createdAt: report.createdAt,
          },
          sharedBy: null, // intentionally omit PII
          expiresAt: shareRow.expiresAt,
        };
      }),
  }),
  // ─── Export ──────────────────────────────────────────────────────

  export: router({
    csv: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive(),
        type: z.enum(["matches", "exceptions", "transactions", "full"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const report = await db.getFullReconciliationReport(input.jobId);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

        let csvContent = "";
        const job = report.job;

        if (input.type === "matches" || input.type === "full") {
          csvContent += "=== MATCHES ===\n";
          csvContent += "Match ID,Source Txn ID,Target Txn ID,Match Type,Confidence,Amount Diff,Date Diff,Reason,Status\n";
          for (const m of report.matches) {
            csvContent += `${m.id},${m.sourceTransactionId},${m.targetTransactionId},${m.matchType},${m.confidenceScore},${m.amountDifference || 0},${m.dateDifference || 0},"${(m.matchReason || "").replace(/"/g, '""')}",${m.status}\n`;
          }
        }

        if (input.type === "exceptions" || input.type === "full") {
          if (csvContent) csvContent += "\n";
          csvContent += "=== EXCEPTIONS ===\n";
          csvContent += "Exception ID,Transaction ID,Category,Severity,Description,Status\n";
          for (const e of report.exceptions) {
            csvContent += `${e.id},${e.transactionId},${e.category},${e.severity},"${(e.description || "").replace(/"/g, '""')}",${e.status}\n`;
          }
        }

        if (input.type === "transactions" || input.type === "full") {
          if (csvContent) csvContent += "\n";
          csvContent += "=== TRANSACTIONS ===\n";
          csvContent += "ID,Reference,External Ref,Amount,Currency,Date,Direction,Counterparty,Status,Channel ID\n";
          for (const t of report.transactions) {
            csvContent += `${t.id},${t.transactionRef || ""},${t.externalRef || ""},${t.amount},${t.currency},${new Date(t.transactionDate).toISOString()},${t.debitCredit},"${(t.counterparty || "").replace(/"/g, '""')}",${t.status},${t.channelId}\n`;
          }
        }

        // Upload CSV to storage
        const fileName = `reconciliation-export-${input.jobId}-${input.type}-${Date.now()}.csv`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(csvContent, "utf-8"),
          "text/csv"
        );

        await logAudit(ctx.user.id, "export_csv", "reconciliation_job", input.jobId, {
          type: input.type,
          fileName,
        }, ip, ua);

        return { url, fileName, rowCount: csvContent.split("\n").length - 1 };
      }),

    xlsx: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive(),
        type: z.enum(["matches", "exceptions", "transactions", "full"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const report = await db.getFullReconciliationReport(input.jobId);
        if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ReconcileAI";
        workbook.created = new Date();

        const headerStyle = {
          font: { bold: true, color: { argb: "FFFFFFFF" } },
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
          alignment: { horizontal: "left" as const },
        };
        const altRow = {
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } },
        };

        // Number format keys: columns whose header contains these keywords get numFmt applied
        const COUNT_KEYS = new Set(["id", "sourceTransactionId", "targetTransactionId", "channelId", "transactionId"]);
        const RATE_KEYS = new Set(["confidenceScore", "matchRate"]);
        const AMOUNT_KEYS = new Set(["amountDifference", "amount"]);
        const addSheet = (name: string, columns: { header: string; key: string; width: number }[], rows: Record<string, unknown>[]) => {
          const ws = workbook.addWorksheet(name);
          ws.columns = columns;
          ws.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); cell.style = headerStyle; });
          rows.forEach((row, i) => {
            const r = ws.addRow(row);
            if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
          });
          ws.getRow(1).height = 20;
          // Apply column-level number formats
          columns.forEach((col) => {
            const k = col.key;
            if (COUNT_KEYS.has(k)) ws.getColumn(k).numFmt = "#,##0";
            else if (RATE_KEYS.has(k)) ws.getColumn(k).numFmt = "0.00";
            else if (AMOUNT_KEYS.has(k)) ws.getColumn(k).numFmt = "#,##0.00";
          });
          // Enable native Excel column filter dropdowns on the header row
          (ws as any).autoFilter = ws.dimensions;
          // Freeze the header row so it stays visible when scrolling
          ws.views = [{ state: "frozen", ySplit: 1 }];
          return ws;
        };

        if (input.type === "matches" || input.type === "full") {
          addSheet("Matches", [
            { header: "Match ID", key: "id", width: 12 },
            { header: "Source Txn ID", key: "sourceTransactionId", width: 16 },
            { header: "Target Txn ID", key: "targetTransactionId", width: 16 },
            { header: "Match Type", key: "matchType", width: 18 },
            { header: "Confidence", key: "confidenceScore", width: 12 },
            { header: "Amount Diff", key: "amountDifference", width: 14 },
            { header: "Date Diff (days)", key: "dateDifference", width: 16 },
            { header: "Reason", key: "matchReason", width: 40 },
            { header: "Status", key: "status", width: 14 },
          ], report.matches.map((m) => ({
            id: m.id,
            sourceTransactionId: m.sourceTransactionId,
            targetTransactionId: m.targetTransactionId,
            matchType: m.matchType,
            confidenceScore: m.confidenceScore,
            amountDifference: m.amountDifference ?? 0,
            dateDifference: m.dateDifference ?? 0,
            matchReason: m.matchReason ?? "",
            status: m.status,
          })));
        }

        if (input.type === "exceptions" || input.type === "full") {
          addSheet("Exceptions", [
            { header: "Exception ID", key: "id", width: 14 },
            { header: "Transaction ID", key: "transactionId", width: 16 },
            { header: "Category", key: "category", width: 24 },
            { header: "Severity", key: "severity", width: 12 },
            { header: "Description", key: "description", width: 50 },
            { header: "AI Suggestion", key: "aiSuggestion", width: 50 },
            { header: "Status", key: "status", width: 14 },
            { header: "Resolution Notes", key: "resolutionNotes", width: 40 },
            { header: "Created At", key: "createdAt", width: 22 },
          ], report.exceptions.map((e: any) => ({
            id: e.id,
            transactionId: e.transactionId,
            category: e.category,
            severity: e.severity,
            description: e.description ?? "",
            aiSuggestion: e.aiSuggestion ?? "",
            status: e.status,
            resolutionNotes: e.resolutionNotes ?? "",
            createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : "",
          })));
        }

        if (input.type === "transactions" || input.type === "full") {
          addSheet("Transactions", [
            { header: "ID", key: "id", width: 10 },
            { header: "Reference", key: "transactionRef", width: 24 },
            { header: "External Ref", key: "externalRef", width: 24 },
            { header: "Amount", key: "amount", width: 16 },
            { header: "Currency", key: "currency", width: 10 },
            { header: "Date", key: "transactionDate", width: 22 },
            { header: "Direction", key: "debitCredit", width: 12 },
            { header: "Counterparty", key: "counterparty", width: 30 },
            { header: "Description", key: "description", width: 40 },
            { header: "Status", key: "status", width: 14 },
            { header: "Channel ID", key: "channelId", width: 12 },
          ], report.transactions.map((t: any) => ({
            id: t.id,
            transactionRef: t.transactionRef ?? "",
            externalRef: t.externalRef ?? "",
            amount: t.amount,
            currency: t.currency,
            transactionDate: new Date(t.transactionDate).toISOString(),
            debitCredit: t.debitCredit,
            counterparty: t.counterparty ?? "",
            description: t.description ?? "",
            status: t.status,
            channelId: t.channelId,
          })));
        }

        // Summary sheet (always included)
        const summaryWs = workbook.addWorksheet("Summary");
        summaryWs.columns = [
          { header: "Field", key: "field", width: 30 },
          { header: "Value", key: "value", width: 40 },
        ];
        summaryWs.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        const job = report.job;
        [
          { field: "Job ID", value: job.id },
          { field: "Job Name", value: job.name },
          { field: "Status", value: job.status },
          { field: "Module Type", value: job.moduleType ?? "" },
          { field: "Total Transactions", value: (job as any).totalTransactions ?? 0 },
          { field: "Matched", value: job.matchedCount ?? 0 },
          { field: "Unmatched", value: job.unmatchedCount ?? 0 },
          { field: "Exceptions", value: job.exceptionCount ?? 0 },
          { field: "Match Rate (%)", value: job.matchRate ?? 0 },
          { field: "Processing Time (ms)", value: job.processingTimeMs ?? 0 },
          { field: "Created At", value: job.createdAt ? new Date(job.createdAt).toISOString() : "" },
          { field: "Completed At", value: job.completedAt ? new Date(job.completedAt).toISOString() : "" },
          { field: "Exported At", value: new Date().toISOString() },
          { field: "Exported By", value: ctx.user.email ?? ctx.user.name ?? "" },
        ].forEach((row, i) => {
          const r = summaryWs.addRow(row);
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `reconciliation-export-${input.jobId}-${input.type}-${Date.now()}.xlsx`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(buffer),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        await logAudit(ctx.user.id, "export_xlsx", "reconciliation_job", input.jobId, {
          type: input.type,
          fileName,
        }, ip, ua);

        return { url, fileName };
      }),

    exportAllXlsx: protectedProcedure
      .input(z.object({
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const allJobs = await db.getReconciliationJobs(ctx.user.organizationId ?? null);

        // Filter by date range and status
        let filtered = allJobs.filter((j: any) => j.status === "completed");
        if (input.dateFrom) {
          const from = new Date(input.dateFrom).getTime();
          filtered = filtered.filter((j: any) => j.completedAt && new Date(j.completedAt).getTime() >= from);
        }
        if (input.dateTo) {
          const to = new Date(input.dateTo).getTime() + 86400000; // inclusive
          filtered = filtered.filter((j: any) => j.completedAt && new Date(j.completedAt).getTime() <= to);
        }
        filtered = filtered.slice(0, input.limit);

        if (filtered.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No completed reconciliation runs found for the selected period" });

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ReconcileAI";
        workbook.created = new Date();

        const headerStyle = {
          font: { bold: true, color: { argb: "FFFFFFFF" } },
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
          alignment: { horizontal: "left" as const },
        };
        const altRow = { fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } } };

        // Sheet 1: Reconciliation Runs Summary
        const runsWs = workbook.addWorksheet("Reconciliation Runs");
        runsWs.columns = [
          { header: "Job ID", key: "id", width: 10 },
          { header: "Job Name", key: "name", width: 36 },
          { header: "Module Type", key: "moduleType", width: 22 },
          { header: "Status", key: "status", width: 14 },
          { header: "Date From", key: "dateFrom", width: 18 },
          { header: "Date To", key: "dateTo", width: 18 },
          { header: "Completed At", key: "completedAt", width: 22 },
          { header: "Total Source Txns", key: "totalSourceTxns", width: 18 },
          { header: "Total Target Txns", key: "totalTargetTxns", width: 18 },
          { header: "Matched", key: "matchedCount", width: 12 },
          { header: "Exceptions", key: "exceptionCount", width: 14 },
          { header: "Unmatched", key: "unmatchedCount", width: 14 },
          { header: "Match Rate (%)", key: "matchRate", width: 16 },
          { header: "Processing Time (ms)", key: "processingTimeMs", width: 20 },
        ];
        runsWs.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        runsWs.getRow(1).height = 20;
        // Number formatting
        runsWs.getColumn("id").numFmt = "#,##0";
        runsWs.getColumn("totalSourceTxns").numFmt = "#,##0";
        runsWs.getColumn("totalTargetTxns").numFmt = "#,##0";
        runsWs.getColumn("matchedCount").numFmt = "#,##0";
        runsWs.getColumn("exceptionCount").numFmt = "#,##0";
        runsWs.getColumn("unmatchedCount").numFmt = "#,##0";
        runsWs.getColumn("processingTimeMs").numFmt = "#,##0";
        filtered.forEach((j: any, i: number) => {
          const r = runsWs.addRow({
            id: j.id,
            name: j.name,
            moduleType: (j.moduleType ?? "").replace(/_/g, " "),
            status: j.status,
            dateFrom: j.dateFrom ? new Date(j.dateFrom).toLocaleDateString("en-NG") : "",
            dateTo: j.dateTo ? new Date(j.dateTo).toLocaleDateString("en-NG") : "",
            completedAt: j.completedAt ? new Date(j.completedAt).toLocaleDateString("en-NG") : "",
            totalSourceTxns: j.totalSourceTxns ?? 0,
            totalTargetTxns: j.totalTargetTxns ?? 0,
            matchedCount: j.matchedCount ?? 0,
            exceptionCount: j.exceptionCount ?? 0,
            unmatchedCount: j.unmatchedCount ?? 0,
            matchRate: j.matchRate != null ? parseFloat(String(j.matchRate)).toFixed(2) : "0.00",
            processingTimeMs: j.processingTimeMs ?? 0,
          });
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });
        (runsWs as any).autoFilter = runsWs.dimensions;
        runsWs.views = [{ state: "frozen", ySplit: 1 }];

        // Sheet 2: Export Metadata
        const metaWs = workbook.addWorksheet("Export Info");
        metaWs.columns = [
          { header: "Field", key: "field", width: 30 },
          { header: "Value", key: "value", width: 40 },
        ];
        metaWs.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        [
          { field: "Exported By", value: ctx.user.email ?? ctx.user.name ?? "" },
          { field: "Exported At", value: new Date().toISOString() },
          { field: "Total Runs Included", value: filtered.length },
          { field: "Date Filter From", value: input.dateFrom ?? "(all)" },
          { field: "Date Filter To", value: input.dateTo ?? "(all)" },
          { field: "Row Limit", value: input.limit },
        ].forEach((row, i) => {
          const r = metaWs.addRow(row);
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });
        metaWs.views = [{ state: "frozen", ySplit: 1 }];

        const buffer = await workbook.xlsx.writeBuffer();
        const dateSuffix = input.dateFrom && input.dateTo
          ? `${input.dateFrom}_to_${input.dateTo}`
          : `all_${new Date().toISOString().slice(0, 10)}`;
        const fileName = `reconciliation-all-runs-${dateSuffix}-${Date.now()}.xlsx`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(buffer),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        await logAudit(ctx.user.id, "export_all_xlsx", "reconciliation_job", undefined, {
          count: filtered.length,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          fileName,
        }, ip, ua);

        return { url, fileName, count: filtered.length };
      }),
  }),

  // ─── Dashboard ───────────────────────────────────────────────────
  dashboard: router({
    stats: protectedProcedure
      .input(z.object({ viewAsOrgId: z.number().int().positive().optional() }).optional())
      .query(async ({ ctx, input }) => {
        // Super admin portal switching: if viewAsOrgId provided, scope to that org.
        // This used to run its own cut-down query that returned two counts and
        // hardcoded every other field to zero, so entering a tenant's portal showed
        // a 0% match rate and no exceptions no matter what that tenant's data said.
        // The scoped stats function answers it properly.
        const orgId =
          input?.viewAsOrgId && ctx.user.role === "super_admin"
            ? input.viewAsOrgId
            : ctx.user.organizationId ?? null;
        return db.getDashboardStats(orgId);
      }),

    // CFO Dashboard Endpoints
    cfoKpis: protectedProcedure.query(async ({ ctx }) => {
      const stats = await db.getDashboardStats(ctx.user.organizationId ?? null);
      if (!stats) {
        return {
          totalTransactions: 0,
          matchRate: 0,
          totalExceptions: 0,
          avgProcessingTime: 0,
        };
      }
      return {
        totalTransactions: stats.transactions.total,
        matchRate: stats.transactions.total > 0
          ? ((stats.transactions.matched / stats.transactions.total) * 100)
          : 0,
        totalExceptions: stats.exceptions.total,
        avgProcessingTime: 0, // Placeholder - would need to be calculated from job data
      };
    }),

    cfoChannelHealth: protectedProcedure
      .input(z.object({
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        channelCodes: z.array(z.string()).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const channels = await db.getChannels(ctx.user.organizationId ?? null);
        const filteredChannels = input?.channelCodes && input.channelCodes.length > 0
          ? channels.filter((c) => input.channelCodes!.includes(c.code))
          : channels;
        const channelStats = await Promise.all(
          filteredChannels.map(async (channel) => {
            const { data: transactions } = await db.getTransactions({
              organizationId: ctx.user.organizationId ?? null,
              channelId: channel.id,
              limit: 10000,
              dateFrom: input?.dateFrom,
              dateTo: input?.dateTo,
            });
            const matched = transactions.filter((t) => t.status === "matched").length;
            const total = transactions.length;
            const matchRate = total > 0 ? (matched / total) * 100 : 0;
            const exceptions = transactions.filter((t) => t.status === "exception").length;

            return {
              channel: channel.name,
              channelCode: channel.code,
              volume: total,
              matchRate: parseFloat(matchRate.toFixed(1)),
              exceptions,
            };
          })
        );
        return channelStats;
      }),

    // CFO Channel 7-day trend (daily match rates per channel)
    cfoChannelTrend: protectedProcedure
      .input(z.object({
        channelCodes: z.array(z.string()).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const channels = await db.getChannels(ctx.user.organizationId ?? null);
        const filteredChannels = input?.channelCodes && input.channelCodes.length > 0
          ? channels.filter((c) => input.channelCodes!.includes(c.code))
          : channels;

        const now = new Date();
        // Build 7 daily buckets (day-6 … day-0)
        const days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(now);
          d.setDate(d.getDate() - (6 - i));
          d.setHours(0, 0, 0, 0);
          return d;
        });

        const result: Record<string, { day: string; matchRate: number }[]> = {};

        await Promise.all(
          filteredChannels.map(async (channel) => {
            const dayRates: { day: string; matchRate: number }[] = [];
            for (let i = 0; i < days.length; i++) {
              const from = days[i];
              const to = new Date(from);
              to.setHours(23, 59, 59, 999);
              const { data: txns } = await db.getTransactions({
                organizationId: ctx.user.organizationId ?? null,
                channelId: channel.id,
                dateFrom: from,
                dateTo: to,
                limit: 5000,
              });
              const total = txns.length;
              const matched = txns.filter((t) => t.status === "matched").length;
              dayRates.push({
                day: from.toISOString().slice(5, 10), // MM-DD
                matchRate: total > 0 ? parseFloat(((matched / total) * 100).toFixed(1)) : 0,
              });
            }
            result[channel.code] = dayRates;
          })
        );

        return result;
      }),

    // Operations Dashboard Endpoints
    operationsQueue: protectedProcedure
      .input(z.object({
        priority: z.enum(["high", "medium", "low", "all"]).default("all"),
        limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(50),
        assignedTo: z.number().int().positive().optional(),
      }))
      .query(async ({ ctx, input }) => {
        let { data: exceptions } = await db.getExceptions({
          organizationId: ctx.user.organizationId ?? null,
          status: "open",
          severity: input.priority !== "all" ? input.priority : undefined,
          limit: input.limit,
        });
        
        // Filter by assignedTo if specified
        if (input.assignedTo !== undefined) {
          exceptions = exceptions.filter((e: any) => e.assignedTo === input.assignedTo);
        }

        // Calculate SLA status for each exception
        const exceptionsWithSla = exceptions.map((e) => {
          const hoursOpen = (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60);
          let slaStatus: "green" | "yellow" | "red";
          if (hoursOpen < 12) {
            slaStatus = "green";
          } else if (hoursOpen < 20) {
            slaStatus = "yellow";
          } else {
            slaStatus = "red";
          }
          return {
            ...e,
            hoursOpen: Math.round(hoursOpen * 10) / 10, // Round to 1 decimal
            slaStatus,
          };
        });

        return {
          total: exceptions.length,
          highPriority: exceptions.filter((e) => e.severity === "high").length,
          mediumPriority: exceptions.filter((e) => e.severity === "medium").length,
          lowPriority: exceptions.filter((e) => e.severity === "low").length,
          overdue: exceptions.filter((e) => {
            const hours = (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60);
            return hours > 24;
          }).length,
          exceptions: exceptionsWithSla,
        };
      }),

    operationsSla: protectedProcedure.query(async ({ ctx }) => {
      const { data: allExceptions } = await db.getExceptions({
        organizationId: ctx.user.organizationId ?? null,
        limit: 1000,
      });
      const resolved = allExceptions.filter((e) => e.status === "resolved");
      const resolvedWithin24h = resolved.filter((e) => {
        if (!e.resolvedAt) return false;
        const hours = (new Date(e.resolvedAt).getTime() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60);
        return hours <= 24;
      });

      const avgResolutionTime = resolved.length > 0
        ? resolved.reduce((sum, e) => {
            if (!e.resolvedAt) return sum;
            return sum + (new Date(e.resolvedAt).getTime() - new Date(e.createdAt).getTime());
          }, 0) / resolved.length / (1000 * 60 * 60) // Convert to hours
        : 0;

      return {
        resolvedWithin24h: resolved.length > 0 ? (resolvedWithin24h.length / resolved.length) * 100 : 0,
        avgResolutionTimeHours: avgResolutionTime,
        backlogSize: allExceptions.filter((e) => e.status === "open").length,
        slaCompliance: resolved.length > 0 && (resolvedWithin24h.length / resolved.length) >= 0.9 ? "On Track" : "At Risk",
      };
    }),

    // Auditor Dashboard Endpoints
    // Examination-facing: reports audit-trail volume and a "compliance rate"
    // framed for a supervisor's examiner, and feeds the CBN pack. Retail
    // merchants answer to card schemes, not an examiner (CLAUDE.md §2A) — the
    // client already hides the Auditor role, this is the rule behind it.
    auditorCompliance: cbnProcedure.query(async ({ ctx }) => {
      const stats = await db.getDashboardStats(ctx.user.organizationId ?? null);
      const { data: auditLogs } = await db.getAuditLogs({
        organizationId: ctx.user.organizationId ?? null,
        limit: 1000,
      });

      return {
        totalReconciliations: stats?.jobs.total || 0,
        completedReconciliations: stats?.jobs.completed || 0,
        auditTrailEntries: auditLogs.length,
        dataIntegrityScore: 98.5, // Placeholder - would be calculated from actual integrity checks
        complianceRate: stats && stats.jobs.total > 0 ? (stats.jobs.completed / stats.jobs.total) * 100 : 0,
      };
    }),

    auditorTrail: cbnProcedure
      .input(z.object({
        entityType: z.string().max(50).optional(),
        limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(100),
      }))
      .query(async ({ ctx, input }) => {
        return db.getAuditLogs({
          organizationId: ctx.user.organizationId ?? null,
          entityType: input.entityType,
          limit: input.limit,
        });
      }),
  }),

  // ─── Sample Data Generator ──────────────────────────────────────

  sampleData: router({
    generate: guestProtectedProcedure
      .input(
        z.object({
          transactionCount: z.number().int().min(10).max(500).default(50),
          matchRate: z.number().min(0).max(100).default(75),
          sourceChannel: z.string().min(1).max(50).default("nibss"),
          targetChannel: z.string().min(1).max(50).default("bank_transfer"),
          dateRangeStart: z.string().min(1),
          dateRangeEnd: z.string().min(1),
          includeAmountMismatches: z.boolean().default(true),
          includeTimingDifferences: z.boolean().default(true),
          includeMissingCounterparties: z.boolean().default(true),
          includeDuplicates: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const result = generateSampleData(input as SampleDataConfig);

        await logAudit(ctx.user.id, "generate_sample_data", "sample_data", undefined, {
          transactionCount: input.transactionCount,
          matchRate: input.matchRate,
          sourceChannel: input.sourceChannel,
          targetChannel: input.targetChannel,
          summary: result.summary,
        }, ip, ua);

        return result;
      }),
  }),

  // ─── Webhooks ───────────────────────────────────────────────────

  webhooks: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getWebhooks(ctx.user.id);
    }),

    create: guestProtectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        url: z.string().url().max(2000),
        events: z.array(z.string().max(50)).min(1).max(20),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const secret = crypto.randomBytes(32).toString("hex");
        const id = await db.createWebhook({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          url: input.url,
          secret,
          events: JSON.stringify(input.events),
          isActive: true,
        });
        await logAudit(ctx.user.id, "create_webhook", "webhook", id || undefined, {
          name: input.name,
          events: input.events,
        }, ip, ua);
        return { id, secret }; // Return secret only on creation
      }),

    delete: guestProtectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const removedWebhook = await db.deleteWebhook(input.id, requireOrg(ctx));
        if (removedWebhook === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
        await logAudit(ctx.user.id, "delete_webhook", "webhook", input.id, {}, ip, ua);
        return { success: true };
      }),

    // WS-4 delivery dashboard: recent tracked deliveries for this org's
    // webhooks, and the reliability figure (≥99.5% success criterion).
    deliveries: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
      .query(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId;
        if (!orgId) return [];
        const { listDeliveries } = await import("./webhookDelivery");
        return listDeliveries(orgId, input?.limit ?? 50);
      }),

    deliveryStats: protectedProcedure
      .input(z.object({ sinceDays: z.number().int().min(1).max(365).default(30) }).optional())
      .query(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId;
        if (!orgId) return { total: 0, delivered: 0, failed: 0, pending: 0, reliability: null };
        const { deliveryStats } = await import("./webhookDelivery");
        return deliveryStats(orgId, input?.sinceDays ?? 30);
      }),
  }),

  // ─── API Keys ───────────────────────────────────────────────────

  apiKeys: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getApiKeys(ctx.user.id);
    }),

    create: guestProtectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        permissions: z.array(z.string().max(50)).min(1).max(20),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const rawKey = `rai_${crypto.randomBytes(32).toString("hex")}`;
        const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
        const keyPrefix = rawKey.substring(0, 12);

        const id = await db.createApiKey({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          keyHash,
          keyPrefix,
          permissions: JSON.stringify(input.permissions),
          isActive: true,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86400000)
            : null,
        });

        await logAudit(ctx.user.id, "create_api_key", "api_key", id || undefined, {
          name: input.name,
          permissions: input.permissions,
        }, ip, ua);

        return { id, key: rawKey, prefix: keyPrefix }; // Return raw key only on creation
      }),

    revoke: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const revokedKey = await db.revokeApiKey(input.id, requireOrg(ctx));
        if (revokedKey === 0) throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
        await logAudit(ctx.user.id, "revoke_api_key", "api_key", input.id, {}, ip, ua);
        return { success: true };
      }),
  }),

  // ─── SFTP Credentials ────────────────────────────────────────────

  // ─── SFTP credential tenancy helpers ──────────────────────────────────────
  // These rows hold BANK CONNECTION SECRETS (host, username, encrypted
  // password/key, remote path). Every accessor was previously keyed on `id`
  // alone, so a caller who could guess a primary key could read, repoint or
  // delete another institution's bank feed — and `delete` was reachable from a
  // guest session. Both helpers below fail closed.
  sftp: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      // Org-scoped: an SFTP feed is institutional config, so a colleague must
      // see it — and the previous userId-only filter left the org boundary
      // entirely unenforced.
      return db.getSftpCredentials(requireOrg(ctx));
    }),

    create: guestProtectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().min(1).max(255),
        password: z.string().max(255).optional(),
        privateKey: z.string().max(10000).optional(),
        remotePath: z.string().min(1).max(500),
        filePattern: z.string().min(1).max(100).default("*.csv"),
        channelId: z.number().int().positive(),
        pollingEnabled: z.boolean().default(false),
        pollingIntervalMinutes: z.number().int().min(5).max(1440).default(60),
        archivePath: z.string().max(500).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);

        if (!input.password && !input.privateKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Either password or private key is required" });
        }

        const organizationId = requireOrg(ctx);
        // The channel decides what this feed's transactions reconcile against,
        // and it arrives from the caller — so ownership is proven before it is
        // stored. Guests never reach here (guestProtectedProcedure rejects
        // them), so requireOrg has already guaranteed a real organization.
        await assertChannelBindable(organizationId, input.channelId);

        const id = await db.createSftpCredential({
          userId: ctx.user.id,
          organizationId,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          host: input.host,
          port: input.port,
          username: input.username,
          passwordEncrypted: input.password ? encryptCredential(input.password) : null,
          privateKeyEncrypted: input.privateKey ? encryptCredential(input.privateKey) : null,
          remotePath: input.remotePath,
          filePattern: input.filePattern,
          channelId: input.channelId,
          pollingEnabled: input.pollingEnabled,
          pollingIntervalMinutes: input.pollingIntervalMinutes,
          archivePath: input.archivePath || null,
          isActive: true,
        });
        
        await logAudit(ctx.user.id, "create_sftp_credential", "sftp_credential", id || undefined, {
          name: input.name,
          host: input.host,
        }, ip, ua);
        
        return { id };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
        host: z.string().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().min(1).max(255).optional(),
        password: z.string().max(255).optional(),
        privateKey: z.string().max(10000).optional(),
        remotePath: z.string().min(1).max(500).optional(),
        filePattern: z.string().min(1).max(100).optional(),
        pollingEnabled: z.boolean().optional(),
        pollingIntervalMinutes: z.number().int().min(5).max(1440).optional(),
        archivePath: z.string().max(500).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const updateData: any = {};
        
        if (input.name) updateData.name = sanitizeInput(input.name, MAX_NAME_LENGTH);
        if (input.host) updateData.host = input.host;
        if (input.port) updateData.port = input.port;
        if (input.username) updateData.username = input.username;
        if (input.password) updateData.passwordEncrypted = encryptCredential(input.password);
        if (input.privateKey) updateData.privateKeyEncrypted = encryptCredential(input.privateKey);
        if (input.remotePath) updateData.remotePath = input.remotePath;
        if (input.filePattern) updateData.filePattern = input.filePattern;
        if (input.pollingEnabled !== undefined) updateData.pollingEnabled = input.pollingEnabled;
        if (input.pollingIntervalMinutes) updateData.pollingIntervalMinutes = input.pollingIntervalMinutes;
        if (input.archivePath !== undefined) updateData.archivePath = input.archivePath || null;
        if (input.isActive !== undefined) updateData.isActive = input.isActive;
        
        const updated = await db.updateSftpCredential(input.id, requireOrg(ctx), updateData);
        if (updated === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "SFTP credential not found" });
        }
        await logAudit(ctx.user.id, "update_sftp_credential", "sftp_credential", input.id, input, ip, ua);
        
        return { success: true };
      }),

    // Was guestProtectedProcedure with an unscoped id: a GUEST session could
    // delete any institution's bank feed by guessing the primary key.
    delete: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const removed = await db.deleteSftpCredential(input.id, requireOrg(ctx));
        if (removed === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "SFTP credential not found" });
        }
        await logAudit(ctx.user.id, "delete_sftp_credential", "sftp_credential", input.id, {}, ip, ua);
        return { success: true };
      }),

    testConnection: adminProcedure
      .input(z.object({
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().min(1).max(255),
        password: z.string().max(255).optional(),
        privateKey: z.string().max(10000).optional(),
      }))
      .mutation(async ({ input }) => {
        return testSftpConnection(input);
      }),

    listFiles: protectedProcedure
      .input(z.object({ credentialId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        // Reaches out to the bank's SFTP host and returns its directory
        // listing — prove ownership first.
        await assertOwnsSftpCredential(ctx, input.credentialId);
        return listSftpFiles(input.credentialId);
      }),

    processFile: adminProcedure
      .input(z.object({
        credentialId: z.number().int().positive(),
        fileName: z.string().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        // Downloads from the bank's SFTP host and INGESTS into that org's
        // channel — the most consequential of the three. Prove ownership first.
        await assertOwnsSftpCredential(ctx, input.credentialId);
        const result = await downloadAndProcessSftpFile(input.credentialId, input.fileName);
        
        await logAudit(ctx.user.id, "process_sftp_file", "sftp_ingestion", input.credentialId, {
          fileName: input.fileName,
          success: result.success,
        }, ip, ua);
        
        return result;
      }),

    logs: protectedProcedure
      .input(z.object({
        credentialId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(50),
        offset: z.number().int().min(0).default(0),
      }))
      .query(async ({ ctx, input }) => {
        // Always org-scoped. Without this the procedure returned EVERY tenant's
        // ingestion history — filenames, remote paths and error text describing
        // other institutions' bank feeds.
        return db.getSftpIngestionLogs({
          credentialId: input.credentialId,
          organizationId: requireOrg(ctx),
          limit: input.limit,
          offset: input.offset,
        });
      }),
  }),

  // ─── Scheduled Tasks ─────────────────────────────────────────────

  schedules: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const tasks = await db.getScheduledTasks(ctx.user.organizationId ?? null);
      return tasks.map((t) => ({
        ...t,
        frequencyDescription: getFrequencyDescription(
          t.frequency, t.scheduledTime, t.scheduledDayOfWeek, t.scheduledDayOfMonth
        ),
      }));
    }),

    get: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(async ({ input }) => {
        const task = await db.getScheduledTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND" });
        const history = await db.getScheduleRunHistoryByTask(input.id, 20);
        return {
          ...task,
          frequencyDescription: getFrequencyDescription(
            task.frequency, task.scheduledTime, task.scheduledDayOfWeek, task.scheduledDayOfMonth
          ),
          history,
        };
      }),

    create: guestProtectedProcedure
      .input(z.object({
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        description: z.string().max(1000).optional(),
        sourceChannelId: z.number().int().positive(),
        targetChannelId: z.number().int().positive(),
        frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
        scheduledTime: z.string().regex(/^\d{2}:\d{2}$/),
        scheduledDayOfWeek: z.number().int().min(0).max(6).optional(),
        scheduledDayOfMonth: z.number().int().min(1).max(31).optional(),
        timezone: z.string().max(64).default("Africa/Lagos"),
        amountTolerance: z.number().min(0).max(0.1).default(0.005),
        dateWindowDays: z.number().int().min(0).max(30).default(3),
        lookbackDays: z.number().int().min(1).max(90).default(1),
        sendEmailReport: z.boolean().default(true),
        emailRecipients: z.array(z.string().email()).max(10).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);

        // Validate channels
        const source = await db.getChannelById(input.sourceChannelId);
        const target = await db.getChannelById(input.targetChannelId);
        if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source channel not found" });
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Target channel not found" });
        if (input.sourceChannelId === input.targetChannelId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Source and target channels must be different" });
        }

        const nextRun = calculateNextRun(input.frequency, input.scheduledTime, {
          scheduledDayOfWeek: input.scheduledDayOfWeek,
          scheduledDayOfMonth: input.scheduledDayOfMonth,
          timezone: input.timezone,
        });

        const id = await db.createScheduledTask({
          userId: ctx.user.id,
          name: sanitizeInput(input.name, MAX_NAME_LENGTH),
          description: input.description ? sanitizeInput(input.description, 1000) : null,
          sourceChannelId: input.sourceChannelId,
          targetChannelId: input.targetChannelId,
          frequency: input.frequency,
          scheduledTime: input.scheduledTime,
          scheduledDayOfWeek: input.scheduledDayOfWeek ?? null,
          scheduledDayOfMonth: input.scheduledDayOfMonth ?? null,
          timezone: input.timezone,
          amountTolerance: String(input.amountTolerance),
          dateWindowDays: input.dateWindowDays,
          lookbackDays: input.lookbackDays,
          sendEmailReport: input.sendEmailReport,
          emailRecipients: input.emailRecipients ? JSON.stringify(input.emailRecipients) : null,
          isActive: true,
          nextRunAt: nextRun,
        });

        await logAudit(ctx.user.id, "create_schedule", "scheduled_task", id || undefined, input, ip, ua);
        return { id, nextRun };
      }),

    // A schedule drives reconciliation runs, which is exactly what
    // operationsProcedure governs — and `runNow` beside it is on the same guard.
    update: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
        description: z.string().max(1000).optional(),
        frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]).optional(),
        scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        scheduledDayOfWeek: z.number().int().min(0).max(6).optional(),
        scheduledDayOfMonth: z.number().int().min(1).max(31).optional(),
        amountTolerance: z.number().min(0).max(0.1).optional(),
        dateWindowDays: z.number().int().min(0).max(30).optional(),
        lookbackDays: z.number().int().min(1).max(90).optional(),
        sendEmailReport: z.boolean().optional(),
        emailRecipients: z.array(z.string().email()).max(10).optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const task = await db.getScheduledTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND" });

        const updateData: any = {};
        if (input.name) updateData.name = sanitizeInput(input.name, MAX_NAME_LENGTH);
        if (input.description !== undefined) updateData.description = input.description ? sanitizeInput(input.description, 1000) : null;
        if (input.frequency) updateData.frequency = input.frequency;
        if (input.scheduledTime) updateData.scheduledTime = input.scheduledTime;
        if (input.scheduledDayOfWeek !== undefined) updateData.scheduledDayOfWeek = input.scheduledDayOfWeek;
        if (input.scheduledDayOfMonth !== undefined) updateData.scheduledDayOfMonth = input.scheduledDayOfMonth;
        if (input.amountTolerance !== undefined) updateData.amountTolerance = String(input.amountTolerance);
        if (input.dateWindowDays !== undefined) updateData.dateWindowDays = input.dateWindowDays;
        if (input.lookbackDays !== undefined) updateData.lookbackDays = input.lookbackDays;
        if (input.sendEmailReport !== undefined) updateData.sendEmailReport = input.sendEmailReport;
        if (input.emailRecipients) updateData.emailRecipients = JSON.stringify(input.emailRecipients);
        if (input.isActive !== undefined) updateData.isActive = input.isActive;

        // Recalculate next run if schedule changed
        const freq = input.frequency || task.frequency;
        const time = input.scheduledTime || task.scheduledTime;
        updateData.nextRunAt = calculateNextRun(freq, time, {
          scheduledDayOfWeek: input.scheduledDayOfWeek ?? task.scheduledDayOfWeek,
          scheduledDayOfMonth: input.scheduledDayOfMonth ?? task.scheduledDayOfMonth,
        });

        const updatedTask = await db.updateScheduledTask(input.id, requireOrg(ctx), updateData);
        if (updatedTask === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled task not found" });
        await logAudit(ctx.user.id, "update_schedule", "scheduled_task", input.id, input, ip, ua);
        return { success: true, nextRun: updateData.nextRunAt };
      }),

    delete: guestProtectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const removedTask = await db.deleteScheduledTask(input.id, requireOrg(ctx));
        if (removedTask === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled task not found" });
        await logAudit(ctx.user.id, "delete_schedule", "scheduled_task", input.id, {}, ip, ua);
        return { success: true };
      }),

    // operationsProcedure and ownership-checked: this STARTS a reconciliation
    // run. It took a caller-supplied task id straight into executeScheduledTask,
    // which resolves it via getScheduledTaskById — no tenancy predicate — so any
    // signed-in user could trigger any other tenant's scheduled run. `delete`
    // directly above already passes requireOrg(ctx); this is the same id, and it
    // needs the same proof of ownership.
    runNow: operationsProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const owned = await db.getScheduledTask(input.id, ctx.user.organizationId ?? null);
        if (!owned) throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled task not found" });
        const result = await executeScheduledTask(input.id);
        await logAudit(ctx.user.id, "manual_run_schedule", "scheduled_task", input.id, result, ip, ua);
        if (!result.success) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
        }
        return { jobId: result.jobId };
      }),

    history: protectedProcedure
      .input(z.object({ taskId: z.number().int().positive() }))
      .query(async ({ input }) => {
        return db.getScheduleRunHistoryByTask(input.taskId, 50);
      }),
  }),

  // ─── Email Preferences ──────────────────────────────────────────────

  emailPreferences: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const prefs = await db.getEmailPreferences(ctx.user.id);
      return prefs || {
        emailEnabled: true,
        defaultRecipients: [],
        includeMatchBreakdown: true,
        includeExceptionDetails: true,
        includeChannelPerformance: true,
        includeTrendAnalysis: false,
        notifyOnCompletion: true,
        notifyOnFailure: true,
        notifyOnHighExceptions: true,
        highExceptionThreshold: 10,
        lowMatchRateThreshold: "80.00",
      };
    }),

    update: protectedProcedure
      .input(z.object({
        emailEnabled: z.boolean().optional(),
        defaultRecipients: z.array(z.string().email()).max(20).optional(),
        includeMatchBreakdown: z.boolean().optional(),
        includeExceptionDetails: z.boolean().optional(),
        includeChannelPerformance: z.boolean().optional(),
        includeTrendAnalysis: z.boolean().optional(),
        notifyOnCompletion: z.boolean().optional(),
        notifyOnFailure: z.boolean().optional(),
        notifyOnHighExceptions: z.boolean().optional(),
        highExceptionThreshold: z.number().int().min(1).max(1000).optional(),
        lowMatchRateThreshold: z.number().min(0).max(100).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const updateData: any = { ...input };
        if (input.defaultRecipients) {
          updateData.defaultRecipients = JSON.stringify(input.defaultRecipients);
        }
        if (input.lowMatchRateThreshold !== undefined) {
          updateData.lowMatchRateThreshold = String(input.lowMatchRateThreshold);
        }
        await db.upsertEmailPreferences(ctx.user.id, updateData);
        await logAudit(ctx.user.id, "update_email_prefs", "email_preferences", undefined, input, ip, ua);
        return { success: true };
      }),

    sendReport: protectedProcedure
      .input(z.object({
        jobId: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const prefs = await db.getEmailPreferences(ctx.user.id);
        const result = await sendReconciliationReport(input.jobId, {
          includeMatchBreakdown: prefs?.includeMatchBreakdown ?? true,
          includeExceptionDetails: prefs?.includeExceptionDetails ?? true,
          includeChannelPerformance: prefs?.includeChannelPerformance ?? true,
          includeTrendAnalysis: prefs?.includeTrendAnalysis ?? false,
        });
        await logAudit(ctx.user.id, "send_email_report", "reconciliation_job", input.jobId, result, ip, ua);
        if (!result.success) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error || "Failed to send report" });
        }
        return result;
      }),
  }),

  // ─── Job Monitoring ─────────────────────────────────────────────────

  monitoring: router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getMonitoringStats(ctx.user.organizationId ?? null);
    }),

    activeJobs: protectedProcedure.query(async () => {
      return getAllActiveJobsProgress();
    }),

    jobProgress: protectedProcedure
      .input(z.object({ jobId: z.number().int().positive() }))
      .query(async ({ input }) => {
        const progress = await getJobProgress(input.jobId);
        if (!progress) throw new TRPCError({ code: "NOT_FOUND" });
        return progress;
      }),

    recentActivity: protectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
      .query(async ({ ctx, input }) => {
        const isAdmin = ctx.user.role === "admin";
        const jobCondition = !isAdmin ? ctx.user.id : undefined;
        // Get recent completed/failed jobs
        const jobs = await db.getReconciliationJobs(ctx.user.organizationId ?? null);
        return jobs.slice(0, input.limit).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          matchRate: j.matchRate,
          matchedCount: j.matchedCount,
          exceptionCount: j.exceptionCount,
          processingTimeMs: j.processingTimeMs,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        }));
      }),
  }),

  // ─── Public API (for external integrations) ─────────────────

  publicApi: publicApiRouter,

  // ─── Anomaly Detection ────────────────────────────────

  anomalies: router({
    detect: protectedProcedure
      .input(z.object({
        transactionIds: z.array(z.number().int().positive()).max(1000),
        config: z.object({
          enableStatistical: z.boolean().optional(),
          enableTimePattern: z.boolean().optional(),
          enableFrequency: z.boolean().optional(),
          enableCounterparty: z.boolean().optional(),
          enableLLM: z.boolean().optional(),
          thresholds: z.object({
            statistical: z.number().min(0).max(1).optional(),
            timePattern: z.number().min(0).max(1).optional(),
            frequency: z.number().min(0).max(1).optional(),
            counterparty: z.number().min(0).max(1).optional(),
            llm: z.number().min(0).max(1).optional(),
            ensemble: z.number().min(0).max(1).optional(),
          }).optional(),
        }).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Ids arrive from the caller, so the lookup is org-scoped.
        const requestedIds = Array.from(new Set(input.transactionIds));
        const transactions = await db.getTransactionsByIds(requestedIds, ctx.user.organizationId ?? null);
        if (transactions.length === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No transactions found" });
        }
        // A bulk action must not quietly analyse a subset. If any requested id
        // resolved to nothing — because it does not exist, or belongs to
        // another tenant — say so rather than returning anomalies computed over
        // whatever happened to match. NOT_FOUND for both cases, so this cannot
        // be used to probe which ids exist elsewhere.
        if (transactions.length !== requestedIds.length) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `${requestedIds.length - transactions.length} of ${requestedIds.length} transactions were not found`,
          });
        }
        
        // Get historical transactions from the same channel
        const historicalResult = await db.getTransactions({
          organizationId: ctx.user.organizationId ?? null,
          channelId: transactions[0].channelId,
          limit: 1000,
        });
        
        const anomalies = await detectAnomalies(
          transactions,
          historicalResult.data,
          input.config as AnomalyDetectionConfig
        );
        
        // Store anomaly scores
        if (anomalies.length > 0) {
          await db.storeAnomalyScores(
            anomalies.map(a => ({
              transactionId: a.transactionId,
              organizationId: ctx.user.organizationId || undefined,
              anomalyScore: String(a.anomalyScore),
              detectionMethod: a.detectionMethod as any,
              detectionReason: a.detectionReason,
              detectionMetadata: a.detectionMetadata,
              isFlagged: true,
              reviewStatus: "pending" as any,
            }))
          );
        }
        
        return { detected: anomalies.length, anomalies };
      }),

    getFlagged: protectedProcedure
      .input(z.object({
        minScore: z.number().min(0).max(1).optional(),
        reviewStatus: z.enum(["pending", "false_positive", "confirmed", "escalated", "resolved"]).optional(),
        limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional(),
        offset: z.number().int().nonnegative().optional(),
      }))
      .query(async ({ ctx, input }) => {
        return db.getFlaggedTransactions({
          organizationId: ctx.user.organizationId || undefined,
          ...input,
        });
      }),

    updateReview: operationsProcedure
      .input(z.object({
        id: z.number().int().positive(),
        reviewStatus: z.enum(["pending", "false_positive", "confirmed", "escalated", "resolved"]),
        reviewNotes: z.string().max(1000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await db.updateAnomalyReview(input.id, requireOrg(ctx), {
          reviewStatus: input.reviewStatus,
          reviewedBy: ctx.user.id,
          reviewNotes: input.reviewNotes,
        });
        
        const { ip, ua } = getClientInfo(ctx);
        await logAudit(ctx.user.id, "update_anomaly_review", "anomaly", input.id, input, ip, ua);
        
        return { success: true };
      }),
  }),

  detectionRules: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getDetectionRules(ctx.user.organizationId ?? null);
    }),

    create: guestProtectedProcedure
      .input(z.object({
        ruleName: z.string().min(1).max(255),
        ruleType: z.enum([
          "amount_outlier",
          "time_pattern",
          "frequency_spike",
          "counterparty_anomaly",
          "description_suspicious",
          "velocity_check",
          "round_amount",
        ]),
        threshold: z.number().min(0),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        ruleConfig: z.record(z.string(), z.any()).optional(),
        description: z.string().max(1000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await db.createDetectionRule({
          organizationId: ctx.user.organizationId || undefined,
          createdBy: ctx.user.id,
          ...input,
          threshold: String(input.threshold),
          ruleConfig: input.ruleConfig ? JSON.stringify(input.ruleConfig) : undefined,
        } as any);
        
        const { ip, ua } = getClientInfo(ctx);
        await logAudit(ctx.user.id, "create_detection_rule", "detection_rule", undefined, input, ip, ua);
        
        return { success: true };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        threshold: z.number().min(0).optional(),
        isEnabled: z.boolean().optional(),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        ruleConfig: z.record(z.string(), z.any()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...updates } = input;
        await db.updateDetectionRule(id, requireOrg(ctx), {
          ...updates,
          threshold: updates.threshold ? String(updates.threshold) : undefined,
          ruleConfig: updates.ruleConfig ? JSON.stringify(updates.ruleConfig) : undefined,
        } as any);
        
        const { ip, ua } = getClientInfo(ctx);
        await logAudit(ctx.user.id, "update_detection_rule", "detection_rule", id, input, ip, ua);
        
        return { success: true };
      }),

    delete: guestProtectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const removedRule = await db.deleteDetectionRule(input.id, requireOrg(ctx));
        if (removedRule === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Detection rule not found" });
        
        const { ip, ua } = getClientInfo(ctx);
        await logAudit(ctx.user.id, "delete_detection_rule", "detection_rule", input.id, {}, ip, ua);
        
        return { success: true };
      }),
  }),

  // ─── Admin ─────────────────────────────────────

  admin: router({
    users: adminProcedure
      .input(z.object({ viewAsOrgId: z.number().int().positive().optional() }).optional())
      .query(async ({ ctx, input }) => {
        if (ctx.user.role === "super_admin") {
          // Portal-view: scope to the viewed org and hide Infinity AI super admins.
          if (input?.viewAsOrgId) return db.getUsersByOrg(input.viewAsOrgId, { excludeSuperAdmins: true });
          // Super-admin home: full cross-tenant list.
          return db.getAllUsers();
        }
        // Org admin: only their own organisation's users, never super admins.
        return ctx.user.organizationId
          ? db.getUsersByOrg(ctx.user.organizationId, { excludeSuperAdmins: true })
          : [];
      }),

    updateRole: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        role: z.enum(["super_admin", "admin", "cfo", "operations", "compliance", "user"]),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        if (input.role === "super_admin" && ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only Infinity AI staff can assign the super admin role." });
        }
        const { ip, ua } = getClientInfo(ctx);
        await db.updateUserRole(input.userId, input.role);
        await logAudit(ctx.user.id, "update_user_role", "user", input.userId, {
          newRole: input.role,
        }, ip, ua);
        return { success: true };
      }),
    bulkUpdateRole: adminProcedure
      .input(z.object({
        userIds: z.array(z.number().int().positive()),
        role: z.enum(["super_admin", "admin", "cfo", "operations", "compliance", "user"]),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, input.userIds);
        if (input.role === "super_admin" && ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only Infinity AI staff can assign the super admin role." });
        }
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        for (const userId of input.userIds) {
          await drizzle.update(users).set({ role: input.role }).where(eq(users.id, userId));
          await logAudit(ctx.user.id, "update_user_role", "user", userId, { newRole: input.role }, ip, ua);
        }
        return { success: true, count: input.userIds.length };
      }),
    bulkToggleActive: adminProcedure
      .input(z.object({
        userIds: z.array(z.number().int().positive()),
        isActive: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, input.userIds);
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const safeIds = input.userIds.filter(id => id !== ctx.user.id);
        for (const userId of safeIds) {
          await drizzle.update(users).set({ isActive: input.isActive }).where(eq(users.id, userId));
          await logAudit(ctx.user.id, input.isActive ? "activate_user" : "deactivate_user", "user", userId, { isActive: input.isActive }, ip, ua);
        }
        return { success: true, count: safeIds.length };
      }),
    bulkUpdateOrganization: adminProcedure
      .input(z.object({
        userIds: z.array(z.number().int().positive()),
        organizationId: z.number().int().positive().nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only Infinity AI staff can move users between organisations." });
        }
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        for (const userId of input.userIds) {
          await drizzle.update(users).set({ organizationId: input.organizationId }).where(eq(users.id, userId));
          await logAudit(ctx.user.id, "update_user_org", "user", userId, { organizationId: input.organizationId }, ip, ua);
        }
        return { success: true, count: input.userIds.length };
      }),
    addUser: adminProcedure
      .input(z.object({
        name: z.string().min(1).max(200),
        email: z.string().email(),
        role: z.enum(["super_admin", "admin", "cfo", "operations", "compliance", "user"]),
        organizationId: z.number().int().positive().nullable().optional(),
        origin: z.string().url().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

        // Role-scoped creation. Super admins (Infinity AI) can create users for ANY
        // organisation and assign any role. Org admins may only create users within
        // their OWN organisation and may not mint super admins.
        let targetRole = input.role;
        let targetOrgId: number | null = input.organizationId ?? null;
        if (ctx.user.role !== "super_admin") {
          if (targetRole === "super_admin") {
            throw new TRPCError({ code: "FORBIDDEN", message: "Only Infinity AI staff can create super admin users." });
          }
          targetOrgId = ctx.user.organizationId ?? null;
        }

        // Check if email already exists
        const existing = await drizzle.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
        if (existing.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "A user with this email already exists." });
        }
        // Create user with a synthetic openId (they will link via OAuth on first login)
        const openId = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const [result] = await drizzle.insert(users).values({
          openId,
          name: input.name,
          email: input.email,
          role: targetRole,
          organizationId: targetOrgId,
          isActive: true,
          loginMethod: "invite",
        });
        const newUserId = (result as any).insertId;
        await logAudit(ctx.user.id, "add_user", "user", newUserId, { email: input.email, role: targetRole, organizationId: targetOrgId }, ip, ua);
        // Send welcome email with magic login link
        if (input.origin) {
          try {
            const { sendWelcomeEmail } = await import("./magicLinkService");
            await sendWelcomeEmail({
              userId: newUserId,
              name: input.name,
              email: input.email,
              role: targetRole,
              origin: input.origin,
            });
          } catch (err) {
            console.error("[addUser] Failed to send welcome email:", err);
          }
        }
        return { success: true, userId: newUserId };
      }),

    resendWelcomeLink: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        origin: z.string().url(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        // Fetch user to get name/email/role
        const userRows = await drizzle.select().from(users).where(eq(users.id, input.userId)).limit(1);
        if (userRows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        const target = userRows[0];
        if (!target.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot resend link to an inactive user" });
        if (!target.email) throw new TRPCError({ code: "BAD_REQUEST", message: "User has no email address" });
        try {
          const { sendWelcomeEmail } = await import("./magicLinkService");
          const { magicLink } = await sendWelcomeEmail({
            userId: target.id,
            name: target.name ?? target.email,
            email: target.email,
            role: target.role,
            origin: input.origin,
          });
          await logAudit(ctx.user.id, "resend_welcome_link", "user", target.id, { email: target.email }, ip, ua);
          return { success: true, magicLink };
        } catch (err: any) {
          console.error("[resendWelcomeLink] Failed:", err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to send welcome link" });
        }
      }),

    toggleActive: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        isActive: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        if (input.userId === ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot deactivate your own account." });
        }
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        await drizzle.update(users).set({ isActive: input.isActive }).where(eq(users.id, input.userId));
        await logAudit(ctx.user.id, input.isActive ? "activate_user" : "deactivate_user", "user", input.userId, {
          isActive: input.isActive,
        }, ip, ua);
        return { success: true };
      }),

    deleteUser: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        if (input.userId === ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account." });
        }
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        // Soft-delete: deactivate and clear PII
        await drizzle.update(users)
          .set({ isActive: false, name: "[Deleted User]", email: null })
          .where(eq(users.id, input.userId));
        await logAudit(ctx.user.id, "delete_user", "user", input.userId, {}, ip, ua);
        return { success: true };
      }),

    updateOrganization: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        organizationId: z.number().int().positive().nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only Infinity AI staff can move users between organisations." });
        }
        const { ip, ua } = getClientInfo(ctx);
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        await drizzle.update(users)
          .set({ organizationId: input.organizationId })
          .where(eq(users.id, input.userId));
        await logAudit(ctx.user.id, "update_user_org", "user", input.userId, {
          organizationId: input.organizationId,
        }, ip, ua);
        return { success: true };
      }),

    organizations: adminProcedure.query(async ({ ctx }) => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      // Super admins see every org (for cross-tenant assignment); org admins only their own.
      if (ctx.user.role === "super_admin") {
        return drizzle.select().from(organizations).orderBy(asc(organizations.name));
      }
      if (!ctx.user.organizationId) return [];
      return drizzle.select().from(organizations).where(eq(organizations.id, ctx.user.organizationId));
    }),
    getUserActivity: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        limit: z.number().int().min(1).max(100).default(50),
      }))
      .query(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        const { data } = await db.getAuditLogs({
          organizationId: ctx.user.organizationId ?? null,
          userId: input.userId,
          limit: input.limit,
        });
        return data;
      }),

    exportUserActivity: adminProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        userName: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageUsers(ctx, [input.userId]);
        const { data } = await db.getAuditLogs({
          organizationId: ctx.user.organizationId ?? null,
          userId: input.userId,
          limit: 500,
        });
        // Build CSV
        const header = ["Timestamp", "Action", "Entity Type", "Entity ID", "Details", "IP Address", "User Agent"];
        const rows = data.map((entry: any) => [
          new Date(entry.createdAt).toISOString(),
          entry.action ?? "",
          entry.entityType ?? "",
          entry.entityId ?? "",
          typeof entry.details === "object" ? JSON.stringify(entry.details) : String(entry.details ?? ""),
          entry.ipAddress ?? "",
          entry.userAgent ?? "",
        ]);
        const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
        const csv = [header, ...rows].map(r => r.map(escape).join(",")).join("\n");
        return { csv, filename: `activity_${input.userName ?? input.userId}_${new Date().toISOString().slice(0, 10)}.csv` };
      }),
  }),

  // ─── Super Admin Router ───────────────────────────────────────────────────
  // Infinity AI staff only — cross-tenant visibility across ALL deployed instances.
  // Hidden from all client-facing portals (FS + B2B).

  superAdmin: router({
    // Get a single org's context (for portal switching)
    getOrgContext: superAdminProcedure
      .input(z.object({ organizationId: z.number().int().positive() }))
      .query(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const [org] = await drizzle.select().from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);
        if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
        // Count users and jobs for this org
        const { users: usersTable, reconciliationJobs } = await import("../drizzle/schema");
        const { count } = await import("drizzle-orm");
        const [userCount] = await drizzle.select({ count: count() }).from(usersTable).where(eq(usersTable.organizationId, input.organizationId));
        const [jobCount] = await drizzle.select({ count: count() }).from(reconciliationJobs).where(eq(reconciliationJobs.organizationId, input.organizationId));
        return {
          id: org.id,
          name: org.name,
          code: org.code,
          segment: org.segment,
          country: org.country,
          baseCurrency: org.baseCurrency,
          isActive: org.isActive,
          userCount: userCount.count,
          jobCount: jobCount.count,
        };
      }),

    // List ALL organisations across all segments
    allOrganizations: superAdminProcedure.query(async () => {
      const drizzle = await getDb();
      if (!drizzle) return [];
      const { organizations } = await import("../drizzle/schema");
      const { asc } = await import("drizzle-orm");
      return drizzle.select().from(organizations).orderBy(asc(organizations.name));
    }),

    // List ALL users across all organisations
    allUsers: superAdminProcedure.query(async () => {
      return db.getAllUsers();
    }),

    // Update an organisation's segment
    updateOrganizationSegment: superAdminProcedure
      .input(z.object({
        organizationId: z.number().int().positive(),
        segment: z.enum(["financial_services", "corporate_b2b", "super_admin", "retail_commerce"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        await assertOrganizationExists(drizzle, input.organizationId);
        await drizzle.update(organizations)
          .set({ segment: input.segment })
          .where(eq(organizations.id, input.organizationId));
        await logAudit(ctx.user.id, "update_org_segment", "organization", input.organizationId, {
          segment: input.segment,
        });
        // Get org name for audit context
        const updatedOrg = await drizzle.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);
        await db.logPlatformEvent({
          actorId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          eventType: "org_segment_updated",
          targetType: "organization",
          targetId: input.organizationId,
          targetName: updatedOrg[0]?.name ?? undefined,
          newValue: input.segment,
        });
        return { success: true };
      }),

    // Enterprise SSO opt-in per organization. Email/magic-link is the default
    // for every client; flip this only when the client requests Google or
    // Microsoft sign-in (their users then get the button on /login).
    setOrganizationSso: superAdminProcedure
      .input(z.object({
        organizationId: z.number().int().positive(),
        ssoProvider: z.enum(["none", "google", "microsoft", "both"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        await assertOrganizationExists(drizzle, input.organizationId);
        await drizzle.update(organizations)
          .set({ ssoProvider: input.ssoProvider })
          .where(eq(organizations.id, input.organizationId));
        await logAudit(ctx.user.id, "update_org_sso", "organization", input.organizationId, {
          ssoProvider: input.ssoProvider,
        });
        await db.logPlatformEvent({
          actorId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          eventType: "org_sso_updated",
          targetType: "organization",
          targetId: input.organizationId,
          newValue: input.ssoProvider,
        });
        return { success: true };
      }),

    /**
     * Mark an institution as operating on non-interest (NIFI) principles.
     *
     * Orthogonal to `segment`: a non-interest bank is still `financial_services`
     * and still runs NIP, POS and cheque clearing. What changes is that the
     * Super Agent applies the NIFI taxonomy across every one of those rails —
     * income may only arise from a real sale, lease or partnership, and
     * investment account holders' funds must stay segregated from shareholders'.
     *
     * Super-admin only, like the SSO opt-in it mirrors, because it changes how
     * the platform characterises the institution to a regulator-facing audience.
     * A tenant should not be able to assert its own licence basis.
     */
    setOrganizationBankingModel: superAdminProcedure
      .input(z.object({
        organizationId: z.number().int().positive(),
        bankingModel: z.enum(["conventional", "non_interest"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        await assertOrganizationExists(drizzle, input.organizationId);
        await drizzle.update(organizations)
          .set({ bankingModel: input.bankingModel })
          .where(eq(organizations.id, input.organizationId));
        await logAudit(ctx.user.id, "update_org_banking_model", "organization", input.organizationId, {
          bankingModel: input.bankingModel,
        });
        await db.logPlatformEvent({
          actorId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          eventType: "org_banking_model_updated",
          targetType: "organization",
          targetId: input.organizationId,
          newValue: input.bankingModel,
        });
        return { success: true };
      }),

    /**
     * Mark an organisation as a demo/sales tenant rather than a real client.
     *
     * Read by anything that must not treat fabricated data as real — today the
     * SLA breach alert, which previously guessed from reconciliation job names
     * and emailed the owner 374 seeded exceptions as genuine breaches.
     *
     * Super-admin only: a tenant must not be able to declare itself a demo and
     * silence its own SLA alerting.
     */
    setOrganizationIsDemo: superAdminProcedure
      .input(z.object({
        organizationId: z.number().int().positive(),
        isDemo: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        await assertOrganizationExists(drizzle, input.organizationId);
        await drizzle.update(organizations)
          .set({ isDemo: input.isDemo })
          .where(eq(organizations.id, input.organizationId));
        await logAudit(ctx.user.id, "update_org_is_demo", "organization", input.organizationId, {
          isDemo: input.isDemo,
        });
        return { success: true };
      }),

    // Create a new organisation (for onboarding a new client instance)
    createOrganization: superAdminProcedure
      .input(z.object({
        name: z.string().min(1).max(255),
        code: z.string().min(1).max(50),
        segment: z.enum(["financial_services", "corporate_b2b", "super_admin", "retail_commerce"]),
        country: z.string().length(3).default("NGA"),
        baseCurrency: z.string().length(3).default("NGN"),
        // Optional custom channel pack added to a DIRECTLY-onboarded client's
        // build. "lapo" provisions the LAPO multi-source integration (connector
        // config + 8 source channels + exception taxonomy). Direct clients that
        // run a proprietary channel estate get it here, NOT via the CBS picker.
        customChannel: z.enum(["none", "lapo", "uganda"]).default("none"),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { organizations } = await import("../drizzle/schema");
        const [result] = await drizzle.insert(organizations).values({
          name: input.name,
          code: input.code.toUpperCase(),
          segment: input.segment,
          country: input.country,
          baseCurrency: input.baseCurrency,
          // Acquisition path stays "direct" — the custom channel is an added
          // capability, not the onboarding channel.
          isActive: true,
        });
        const newOrgId = (result as any).insertId;
        // Tenant baseline: per-tenant encryption key + quotas + default
        // modules — every org creation path provisions the same way.
        try {
          const { provisionTenantBaseline } = await import("./provisioning");
          const baseline = await provisionTenantBaseline(newOrgId);
          if (!baseline.ok) {
            console.error("[createOrganization] tenant baseline partial failure:", JSON.stringify(baseline.steps));
          }
        } catch (err) {
          console.error("[createOrganization] tenant baseline failed:", err);
        }
        // Optional custom channel pack (LAPO). Idempotent; a failure here never
        // aborts org creation — re-run via lapo.provision.
        let customChannelResult: { channels: number; templates: number } | null = null;
        if (input.customChannel === "lapo") {
          try {
            const { provisionLapoForOrg } = await import("./connectors/lapo/etl");
            const r = await provisionLapoForOrg(newOrgId);
            customChannelResult = { channels: r.channelIds.length, templates: r.templates.inserted };
          } catch (err) {
            console.error("[createOrganization] LAPO channel pack failed (re-run lapo.provision):", err);
          }
        } else if (input.customChannel === "uganda") {
          // Uganda market pack: eight rail channels (MTN/Airtel, ABC shared
          // agent rail, UNISS, ACH, cards, trust account) + BoU taxonomy.
          try {
            const { provisionUgandaForOrg } = await import("./connectors/uganda/etl");
            const r = await provisionUgandaForOrg(newOrgId);
            customChannelResult = { channels: r.channelIds.length, templates: r.templates.inserted };
          } catch (err) {
            console.error("[createOrganization] Uganda channel pack failed (re-run uganda.provision):", err);
          }
        }
        // Retail / e-commerce vertical (SHOPLINE): seed the retail exception
        // taxonomy as org resolution templates so the merchant's Super Agent and
        // resolution workflow carry the retail moat from day one. Idempotent;
        // failure never aborts org creation (global defaults still apply).
        if (input.segment === "retail_commerce") {
          try {
            const { seedRetailResolutionTemplates } = await import("./exceptions/retail-commerce");
            await seedRetailResolutionTemplates(newOrgId);
          } catch (err) {
            console.error("[createOrganization] retail template seed failed:", err);
          }
        }
        await logAudit(ctx.user.id, "create_organization", "organization", newOrgId, {
          name: input.name,
          segment: input.segment,
          customChannel: input.customChannel,
        });
        await db.logPlatformEvent({
          actorId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          eventType: "org_created",
          targetType: "organization",
          targetId: newOrgId,
          targetName: input.name,
          newValue: JSON.stringify({ segment: input.segment, country: input.country, currency: input.baseCurrency, customChannel: input.customChannel }),
        });
        return { success: true, organizationId: newOrgId, customChannel: customChannelResult };
      }),

    // Promote a user to super_admin (Infinity AI staff only)
    promoteToSuperAdmin: superAdminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const targetUser = await db.getUserById(input.userId);
        await drizzle.update(users).set({ role: "super_admin" }).where(eq(users.id, input.userId));
        await logAudit(ctx.user.id, "promote_to_super_admin", "user", input.userId, {});
        await db.logPlatformEvent({
          actorId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          eventType: "user_promoted_super_admin",
          targetType: "user",
          targetId: input.userId,
          targetName: targetUser?.name ?? undefined,
          previousValue: targetUser?.role ?? undefined,
          newValue: "super_admin",
        });
        return { success: true };
      }),

    // Get platform audit logs
    auditLogs: superAdminProcedure
      .input(z.object({
        eventType: z.enum(["org_created", "org_segment_updated", "user_role_updated", "user_promoted_super_admin"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }))
      .query(async ({ input }) => {
        return db.getPlatformAuditLogs({
          eventType: input.eventType,
          limit: input.limit,
          offset: input.offset,
        });
      }),
    // Get platform-wide statistics (cross-tenant)
    platformStats: superAdminProcedure.query(async () => {
      const drizzle = await getDb();
      if (!drizzle) return { totalOrgs: 0, totalUsers: 0, totalJobs: 0, segmentBreakdown: {} };
      const { organizations, users, reconciliationJobs } = await import("../drizzle/schema");
      const { count, eq } = await import("drizzle-orm");
      const [orgCount] = await drizzle.select({ count: count() }).from(organizations);
      const [userCount] = await drizzle.select({ count: count() }).from(users);
      const [jobCount] = await drizzle.select({ count: count() }).from(reconciliationJobs);
      // Segment breakdown
      const fsOrgs = await drizzle.select({ count: count() }).from(organizations).where(eq(organizations.segment, "financial_services"));
      const b2bOrgs = await drizzle.select({ count: count() }).from(organizations).where(eq(organizations.segment, "corporate_b2b"));
      const saOrgs = await drizzle.select({ count: count() }).from(organizations).where(eq(organizations.segment, "super_admin"));
      return {
        totalOrgs: orgCount.count,
        totalUsers: userCount.count,
        totalJobs: jobCount.count,
        segmentBreakdown: {
          financial_services: fsOrgs[0].count,
          corporate_b2b: b2bOrgs[0].count,
          super_admin: saOrgs[0].count,
        },
      };
    }),

    // Rich cross-tenant analytics for the Platform Analytics page.
    // All aggregation runs in the DB; small grouped result sets are sorted in JS.
    platformAnalytics: superAdminProcedure.query(async () => {
      const drizzle = await getDb();
      const empty = {
        totals: { orgs: 0, activeOrgs: 0, users: 0, activeUsers: 0, jobs: 0, completedJobs: 0, exceptions: 0, openExceptions: 0 },
        segmentBreakdown: [] as { key: string; value: number }[],
        roleBreakdown: [] as { key: string; value: number }[],
        jobStatusBreakdown: [] as { key: string; value: number }[],
        moduleBreakdown: [] as { key: string; value: number }[],
        volume: { matched: 0, exceptions: 0, unmatched: 0, avgMatchRate: 0 },
        orgGrowth: [] as { month: string; value: number }[],
        jobTrend: [] as { month: string; value: number }[],
        topOrgs: [] as { organizationId: number | null; name: string; segment: string | null; jobs: number; matched: number; exceptions: number }[],
      };
      if (!drizzle) return empty;

      const { organizations, users, reconciliationJobs, exceptions } = await import("../drizzle/schema");
      const { count, eq, sql } = await import("drizzle-orm");

      // ── Headline totals ──
      const [orgsTotal] = await drizzle.select({ c: count() }).from(organizations);
      const [orgsActive] = await drizzle.select({ c: count() }).from(organizations).where(eq(organizations.isActive, true));
      const [usersTotal] = await drizzle.select({ c: count() }).from(users);
      const [usersActive] = await drizzle.select({ c: count() }).from(users).where(eq(users.isActive, true));
      const [jobsTotal] = await drizzle.select({ c: count() }).from(reconciliationJobs);
      const [jobsCompleted] = await drizzle.select({ c: count() }).from(reconciliationJobs).where(eq(reconciliationJobs.status, "completed"));
      const [exTotal] = await drizzle.select({ c: count() }).from(exceptions);
      const [exOpen] = await drizzle.select({ c: count() }).from(exceptions).where(eq(exceptions.status, "open"));

      // ── Categorical breakdowns ──
      const segmentRows = await drizzle.select({ key: organizations.segment, value: count() }).from(organizations).groupBy(organizations.segment);
      const roleRows = await drizzle.select({ key: users.role, value: count() }).from(users).groupBy(users.role);
      const jobStatusRows = await drizzle.select({ key: reconciliationJobs.status, value: count() }).from(reconciliationJobs).groupBy(reconciliationJobs.status);
      const moduleRows = await drizzle.select({ key: reconciliationJobs.moduleType, value: count() }).from(reconciliationJobs).groupBy(reconciliationJobs.moduleType);

      // ── Reconciliation volume ──
      const [vol] = await drizzle.select({
        matched: sql<number>`COALESCE(SUM(${reconciliationJobs.matchedCount}), 0)`,
        exceptions: sql<number>`COALESCE(SUM(${reconciliationJobs.exceptionCount}), 0)`,
        unmatched: sql<number>`COALESCE(SUM(${reconciliationJobs.unmatchedCount}), 0)`,
      }).from(reconciliationJobs);
      const [avgMr] = await drizzle.select({
        avg: sql<number>`COALESCE(AVG(${reconciliationJobs.matchRate}), 0)`,
      }).from(reconciliationJobs).where(eq(reconciliationJobs.status, "completed"));

      // ── Monthly growth trends ──
      const orgGrowthRows = await drizzle
        .select({ month: sql<string>`DATE_FORMAT(${organizations.createdAt}, '%Y-%m')`, value: count() })
        .from(organizations)
        .groupBy(sql`DATE_FORMAT(${organizations.createdAt}, '%Y-%m')`)
        .orderBy(sql`DATE_FORMAT(${organizations.createdAt}, '%Y-%m')`);
      const jobTrendRows = await drizzle
        .select({ month: sql<string>`DATE_FORMAT(${reconciliationJobs.createdAt}, '%Y-%m')`, value: count() })
        .from(reconciliationJobs)
        .groupBy(sql`DATE_FORMAT(${reconciliationJobs.createdAt}, '%Y-%m')`)
        .orderBy(sql`DATE_FORMAT(${reconciliationJobs.createdAt}, '%Y-%m')`);

      // ── Top organisations by reconciliation activity (sorted in JS — small set) ──
      const orgJobRows = await drizzle
        .select({
          organizationId: reconciliationJobs.organizationId,
          jobs: count(),
          matched: sql<number>`COALESCE(SUM(${reconciliationJobs.matchedCount}), 0)`,
          exceptions: sql<number>`COALESCE(SUM(${reconciliationJobs.exceptionCount}), 0)`,
        })
        .from(reconciliationJobs)
        .groupBy(reconciliationJobs.organizationId);
      const orgsAll = await drizzle.select({ id: organizations.id, name: organizations.name, segment: organizations.segment }).from(organizations);
      const orgMap = new Map(orgsAll.map((o) => [o.id, o]));
      const topOrgs = orgJobRows
        .map((r) => {
          const meta = r.organizationId != null ? orgMap.get(r.organizationId) : undefined;
          return {
            organizationId: r.organizationId,
            name: r.organizationId == null ? "Unassigned" : (meta?.name ?? `Org ${r.organizationId}`),
            segment: meta?.segment ?? null,
            jobs: Number(r.jobs),
            matched: Number(r.matched),
            exceptions: Number(r.exceptions),
          };
        })
        .sort((a, b) => b.jobs - a.jobs)
        .slice(0, 8);

      return {
        totals: {
          orgs: orgsTotal.c, activeOrgs: orgsActive.c,
          users: usersTotal.c, activeUsers: usersActive.c,
          jobs: jobsTotal.c, completedJobs: jobsCompleted.c,
          exceptions: exTotal.c, openExceptions: exOpen.c,
        },
        segmentBreakdown: segmentRows.map((r) => ({ key: String(r.key), value: Number(r.value) })),
        roleBreakdown: roleRows.map((r) => ({ key: String(r.key), value: Number(r.value) })),
        jobStatusBreakdown: jobStatusRows.map((r) => ({ key: String(r.key), value: Number(r.value) })),
        moduleBreakdown: moduleRows.map((r) => ({ key: String(r.key), value: Number(r.value) })),
        volume: {
          matched: Number(vol?.matched ?? 0),
          exceptions: Number(vol?.exceptions ?? 0),
          unmatched: Number(vol?.unmatched ?? 0),
          avgMatchRate: Number(avgMr?.avg ?? 0),
        },
        orgGrowth: orgGrowthRows.map((r) => ({ month: r.month, value: Number(r.value) })),
        jobTrend: jobTrendRows.map((r) => ({ month: r.month, value: Number(r.value) })),
        topOrgs,
      };
    }),
  }),

  // ─── Super Agent ─────────────────────────────────────────────────────

  distributor: distributorRouter,
  superAgent: router({
    query: protectedProcedure
      .input(z.object({
        query: z.string().min(1).max(2000),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user.id;
        const orgId = ctx.user.organizationId;

        // Fetch recent exceptions and stats for context
        const [recentExceptions, recentJobsRaw] = await Promise.all([
          db.getExceptions({ organizationId: ctx.user.organizationId ?? null, status: 'open', limit: 20, offset: 0 }),
          db.getReconciliationJobs(ctx.user.organizationId ?? null),
        ]);

        const exceptionSummary = recentExceptions.data.slice(0, 5).map((e: any) => ({
          id: e.id,
          category: e.category,
          severity: e.severity,
          description: e.description?.substring(0, 150),
          amount: e.amount,
          currency: e.currency,
        }));

        const jobStats = recentJobsRaw.slice(0, 3).map((j: any) => ({
          id: j.id,
          status: j.status,
          matchRate: j.matchRate,
          exceptionCount: j.exceptionCount,
          matchedCount: j.matchedCount,
          createdAt: j.createdAt,
        }));

        // Inject per-institution learned patterns as few-shot examples.
        // Selection strategy: pull a candidate pool of the 60 most recent patterns,
        // then rank by relevance to the user's query using token-overlap (Jaccard).
        // Within the same relevance tier, more recent patterns rank higher.
        // This ensures the AI sees the most applicable institutional memory, not
        // just the most recently resolved exceptions.
        const saQueryDrizzle = await getDb();
        const candidatePatterns = saQueryDrizzle && orgId
          ? await saQueryDrizzle.select({
              category: agentMemory.exceptionCategory,
              amountRange: agentMemory.amountRange,
              resolution: agentMemory.resolution,
              outcome: agentMemory.outcome,
              reasoning: agentMemory.reasoning,
              embeddingText: agentMemory.embeddingText,
            })
            .from(agentMemory)
            .where(eq(agentMemory.organizationId, orgId))
            .orderBy(desc(agentMemory.createdAt))
            .limit(60)
          : [];

        // Rank candidates by Jaccard token-overlap against the user's query.
        const queryTokens = new Set(
          input.query.toLowerCase().split(/[\s|:,.()?!]+/).filter((t) => t.length > 2)
        );
        const queryTokensArr = Array.from(queryTokens);
        const rankedPatterns = candidatePatterns
          .map((m, idx) => {
            const memText = `${m.category} ${m.amountRange} ${m.resolution} ${m.reasoning ?? ''}`.toLowerCase();
            const memTokens = new Set(memText.split(/[\s|:,.()?!]+/).filter((t) => t.length > 2));
            const memTokensArr = Array.from(memTokens);
            const intersectionCount = queryTokensArr.filter((t) => memTokens.has(t)).length;
            const unionCount = new Set([...queryTokensArr, ...memTokensArr]).size;
            const similarity = unionCount > 0 ? intersectionCount / unionCount : 0;
            return { m, similarity, idx };
          })
          // Sort by similarity desc, then by original index (recency) asc as tiebreaker.
          .sort((a, b) => b.similarity - a.similarity || a.idx - b.idx)
          .slice(0, 8)
          .map((r) => r.m);

        const fewShotBlock = rankedPatterns.length > 0
          ? `\n\nLearned patterns from your institution's resolved exceptions (${rankedPatterns.length} most relevant examples):\n` +
            rankedPatterns.map(m =>
              `• [${m.category}/${m.amountRange}] Resolution: "${m.resolution}" → ${m.outcome}. Context: ${(m.reasoning ?? "").substring(0, 100)}`
            ).join("\n")
          : "";

        // Taxonomy injection is segment-aware. Retail (SHOPLINE) merchants get
        // the retail exception taxonomy PLUS live exception intelligence — their
        // own past resolutions (intra-org) and the anonymised cross-merchant
        // network (cross-org) — for the categories their question touches. Other
        // segments keep the Nigerian channel taxonomy.
        let orgSegment: string | null = null;
        if (orgId) {
          const segDb = await getDb();
          if (segDb) {
            const [orgRow] = await segDb
              .select({ segment: organizations.segment })
              .from(organizations)
              .where(eq(organizations.id, orgId))
              .limit(1);
            orgSegment = orgRow?.segment ?? null;
          }
        }

        let taxonomyBlock = "";
        if (orgSegment === "retail_commerce") {
          const { retailExceptionsTaxonomyPromptBlock } = await import("./exceptions/retail-commerce");
          const {
            relevantRetailCategoriesForText,
            getRetailExceptionIntelligence,
            retailIntelligencePromptBlock,
          } = await import("./connectors/shopline/retailIntelligence");
          taxonomyBlock = `\n\nRetail / e-commerce settlement exception taxonomy:\n${retailExceptionsTaxonomyPromptBlock()}`;
          if (orgId) {
            const cats = relevantRetailCategoriesForText(input.query);
            for (const cat of cats) {
              const intel = await getRetailExceptionIntelligence(orgId, cat);
              taxonomyBlock += retailIntelligencePromptBlock(intel);
            }
          }
        } else {
          const { nigerianExceptionsTaxonomyPromptBlock, relevantNigerianChannelsForText } =
            await import("./exceptions/seed");
          const taxonomyChannels = relevantNigerianChannelsForText(input.query);
          taxonomyBlock = taxonomyChannels.length > 0
            ? `\n\nCatalogued Nigerian channel exception patterns (relevant to this question):\n${nigerianExceptionsTaxonomyPromptBlock(taxonomyChannels)}`
            : "";
        }

        const systemPrompt = `You are the ReconcileAI Super Agent — an autonomous financial reconciliation intelligence for African FMCG and corporate B2B payment environments.

Your role is to:
1. Diagnose the root cause of reconciliation exceptions with precision
2. Identify patterns across multiple exceptions
3. Propose specific, actionable resolution drafts for human approval
4. Never commit any action without explicit human sign-off (HitL principle)

Current system context:
- Open exceptions: ${recentExceptions.total} total, showing top ${exceptionSummary.length}
- Recent jobs: ${JSON.stringify(jobStats, null, 2)}
- Top exceptions: ${JSON.stringify(exceptionSummary, null, 2)}${fewShotBlock}${taxonomyBlock}

When proposing an action draft, structure your response as JSON with this exact format:
{
  "diagnosis": "Your detailed diagnosis text here",
  "hasActionDraft": true,
  "actionDraft": {
    "type": "journal_entry|vendor_email|credit_note_request|payment_allocation|escalation",
    "title": "Brief title",
    "description": "What this action does",
    "details": { "key": "value pairs of action specifics" },
    "riskLevel": "low|medium|high"
  }
}

If no action draft is needed, respond as JSON:
{
  "diagnosis": "Your analysis text here",
  "hasActionDraft": false
}

Always be specific, reference actual exception IDs and amounts where available, and explain your reasoning in plain language suitable for a finance team member.`;

        const response = await invokeLLM({
          // Agentic: the Super Agent's conversational surface — reasons across
          // the org's exceptions, jobs and history to answer a free-form question.
          modelTier: 'agent',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.query },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'agent_response',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  diagnosis: { type: 'string' },
                  hasActionDraft: { type: 'boolean' },
                  actionDraft: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['journal_entry', 'vendor_email', 'credit_note_request', 'payment_allocation', 'escalation'] },
                      title: { type: 'string' },
                      description: { type: 'string' },
                      details: { type: 'object', additionalProperties: { type: 'string' } },
                      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
                    },
                    required: ['type', 'title', 'description', 'details', 'riskLevel'],
                    additionalProperties: false,
                  },
                },
                required: ['diagnosis', 'hasActionDraft'],
                additionalProperties: false,
              },
            },
          },
        });

        const content = response.choices?.[0]?.message?.content;
        let parsed: any = { diagnosis: 'Analysis complete.', hasActionDraft: false };
        try {
          parsed = JSON.parse(typeof content === 'string' ? content : JSON.stringify(content));
        } catch {
          parsed = { diagnosis: typeof content === 'string' ? content : 'Analysis complete.', hasActionDraft: false };
        }

        // Log to audit trail
        await logAudit(userId, 'super_agent_query', 'super_agent', undefined, {
          query: input.query.substring(0, 200),
          hasActionDraft: parsed.hasActionDraft,
        });

        return {
          diagnosis: parsed.diagnosis,
          actionDraft: parsed.hasActionDraft ? parsed.actionDraft : null,
        };
      }),

    approveAction: operationsProcedure
      .input(z.object({
        actionType: z.enum(['journal_entry', 'vendor_email', 'credit_note_request', 'payment_allocation', 'escalation']),
        details: z.record(z.string(), z.string()),
        approved: z.boolean(),
        modificationNotes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user.id;

        // Log the approval decision to audit trail
        await logAudit(userId, input.approved ? 'super_agent_action_approved' : 'super_agent_action_rejected', 'super_agent', undefined, {
          actionType: input.actionType,
          actionDetails: input.details,
          modificationNotes: input.modificationNotes,
        });

        return {
          success: true,
          message: input.approved
            ? `Action approved and logged. ${input.actionType.replace(/_/g, ' ')} has been committed to the audit trail.`
            : 'Action rejected. Exception returned to review queue.',
        };
      }),

    // ── Layer 3+4: Deep Diagnose + Action Draft Generation ────────────
    diagnose: protectedProcedure
      .input(z.object({
        transactionId: z.number().int().positive(),
        jobId: z.number().int().positive().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user.id;
        const orgId = ctx.user.organizationId ?? 0;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

        // Fetch the transaction
        // Caller-supplied id: scoped, so another tenant's transaction is simply
        // "not found" via the existing guard below.
        const txnRowsArr = await db.getTransactionsByIds([input.transactionId], ctx.user.organizationId ?? null);
        const txnRows = txnRowsArr[0];
        if (!txnRows) throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });

        // The channel this transaction arrived on decides which slice of the
        // Nigerian exception catalogue the agent reasons with. Without it the
        // taxonomy is guessed from the description, which matches nothing on a
        // typical settlement file — see server/exceptions/channelMapping.ts.
        const txnChannel = await db.getChannelById(txnRows.channelId);

        const txn: SATransaction = {
          id: txnRows.id,
          transactionRef: txnRows.transactionRef,
          description: txnRows.description,
          counterparty: txnRows.counterparty,
          amount: txnRows.amount,
          currency: txnRows.currency,
          transactionDate: txnRows.transactionDate,
          channelId: txnRows.channelId,
          channelType: txnChannel?.channelType ?? null,
          debitCredit: txnRows.debitCredit,
          isReversal: txnRows.isReversal,
          originalTransactionRef: txnRows.originalTransactionRef,
        };

        // Fetch recent memory records for context
        const memoryRows = await drizzle
          .select()
          .from(agentMemory)
          .where(eq(agentMemory.organizationId, orgId))
          .orderBy(desc(agentMemory.createdAt))
          .limit(50);

        const memories: MemoryRecord[] = memoryRows.map((m) => ({
          id: m.id,
          exceptionCategory: m.exceptionCategory,
          transactionRef: m.transactionRef || '',
          amountRange: m.amountRange,
          counterpartyType: m.counterpartyType,
          deductionType: m.deductionType,
          resolution: m.resolution,
          outcome: m.outcome,
          reasoning: m.reasoning,
          embeddingText: m.embeddingText,
          createdAt: m.createdAt,
        }));

        // Build memory context for LLM
        const dummyDiagnosis: any = { category: 'unmatched', deductionType: null };
        const similar = retrieveSimilarMemories(txn, dummyDiagnosis, memories, 3);
        const memoryContext = formatMemoryContext(similar);

        // A non-interest institution gets the NIFI taxonomy on top of the
        // channel one — it applies across every rail, so it is read from the
        // organisation rather than from the transaction's channel.
        const diagnosingOrg = ctx.user.organizationId
          ? await db.getOrganizationById(ctx.user.organizationId)
          : null;

        // Run deep diagnosis
        const diagnosis = await diagnoseException(
          txn,
          [], // no target txns needed for standalone diagnosis
          { amountTolerance: 0.015, dateWindowDays: 7 },
          memoryContext,
          diagnosingOrg?.bankingModel ?? null,
        );

        // Generate action draft
        const actionDraft = await generateActionDraft(txn, diagnosis, ctx.user.organizationId?.toString() || 'your company');

        // Persist the draft to DB
        await drizzle.insert(agentActionDrafts).values({
          organizationId: orgId,
          transactionRef: txn.transactionRef,
          actionType: actionDraft.actionType as any,
          subject: actionDraft.subject,
          body: actionDraft.body,
          metadata: actionDraft.metadata,
          status: 'pending_approval',
          diagnosisCategory: diagnosis.category,
          diagnosisConfidence: diagnosis.confidence,
          shortfallAmount: diagnosis.shortfall?.toString(),
          currency: txn.currency,
          createdByAgent: 1,
        });

        await logAudit(userId, 'super_agent_diagnose', 'transaction', input.transactionId, {
          category: diagnosis.category,
          confidence: diagnosis.confidence,
          actionType: actionDraft.actionType,
        });

        return { diagnosis, actionDraft, memoriesUsed: similar.length };
      }),

    // ── Layer 4: Get pending action drafts ────────────────────────────
    getDrafts: protectedProcedure
      .input(z.object({
        status: z.enum(['pending_approval', 'approved', 'rejected', 'executed', 'modified']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user.organizationId ?? 0;
        const drizzle = await getDb();
        if (!drizzle) return { drafts: [], total: 0 };

        const conditions = [eq(agentActionDrafts.organizationId, orgId)];
        if (input.status) conditions.push(eq(agentActionDrafts.status, input.status));

        const rows = await drizzle
          .select()
          .from(agentActionDrafts)
          .where(and(...conditions))
          .orderBy(desc(agentActionDrafts.createdAt))
          .limit(input.limit)
          .offset(input.offset);

        return { drafts: rows, total: rows.length };
      }),

    // ── Layer 4: Approve or reject a draft ────────────────────────────
    resolveDraft: operationsProcedure
      .input(z.object({
        draftId: z.number().int().positive(),
        decision: z.enum(['approved', 'rejected', 'modified']),
        modifiedBody: z.string().optional(),
        rejectionReason: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user.id;
        const orgId = ctx.user.organizationId ?? 0;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

        const updateData: any = {
          status: input.decision,
          updatedAt: new Date(),
        };

        if (input.decision === 'approved' || input.decision === 'modified') {
          updateData.approvedBy = userId;
          updateData.approvedAt = new Date();
          if (input.modifiedBody) updateData.body = input.modifiedBody;
        } else {
          updateData.rejectedBy = userId;
          updateData.rejectedAt = new Date();
          if (input.rejectionReason) updateData.rejectionReason = input.rejectionReason;
        }

        await drizzle
          .update(agentActionDrafts)
          .set(updateData)
          .where(and(eq(agentActionDrafts.id, input.draftId), eq(agentActionDrafts.organizationId, orgId)));

        await logAudit(userId, `super_agent_draft_${input.decision}`, 'agent_action_draft', input.draftId, {
          decision: input.decision,
          rejectionReason: input.rejectionReason,
        });

        return { success: true, message: `Draft ${input.decision}.` };
      }),

    // ── Layer 5: Add a resolved case to semantic memory ───────────────
    addMemory: operationsProcedure
      .input(z.object({
        exceptionId: z.number().int().positive().optional(),
        exceptionCategory: z.string(),
        transactionRef: z.string().optional(),
        amountRange: z.enum(['0-100k', '100k-1m', '1m+']),
        // counterpartyType is optional; when omitted the server derives it from the
        // linked exception's transaction record so the flywheel is always accurate.
        counterpartyType: z.string().optional(),
        deductionType: z.string().optional(),
        resolution: z.string(),
        outcome: z.enum(['resolved', 'escalated', 'rejected']),
        reasoning: z.string(),
        embeddingText: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user.id;
        const orgId = ctx.user.organizationId ?? 0;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });

        // Derive the counterparty type from the linked exception's transaction when
        // the caller does not supply it, so we never fall back to a hardcoded value.
        let resolvedCounterpartyType = input.counterpartyType ?? null;
        if (!resolvedCounterpartyType && input.exceptionId) {
          try {
            const { exceptions: exTbl, transactions: txTbl } = await import("../drizzle/schema");
            const cpRows = await drizzle
              .select({ counterparty: txTbl.counterparty })
              .from(exTbl)
              .innerJoin(txTbl, eq(exTbl.transactionId, txTbl.id))
              .where(eq(exTbl.id, input.exceptionId))
              .limit(1);
            if (cpRows.length) {
              const ei = await import("./exceptionIntelligence");
              resolvedCounterpartyType = ei.counterpartyTypeOf(cpRows[0].counterparty);
            }
          } catch { /* non-fatal: fall through to 'unknown' */ }
        }
        if (!resolvedCounterpartyType) resolvedCounterpartyType = 'unknown';

        await drizzle.insert(agentMemory).values({
          organizationId: orgId,
          exceptionId: input.exceptionId,
          exceptionCategory: input.exceptionCategory,
          transactionRef: input.transactionRef,
          amountRange: input.amountRange,
          counterpartyType: resolvedCounterpartyType,
          deductionType: input.deductionType,
          resolution: input.resolution,
          outcome: input.outcome,
          reasoning: input.reasoning,
          embeddingText: input.embeddingText,
          resolvedBy: userId,
        });

        // Exception Intelligence: record the anonymized pattern signature (coarse
        // categorical tuple only — never the transaction). Powers the network
        // effect; sharing/consumption are gated by per-org settings + residency.
        try {
          const ei = await import("./exceptionIntelligence");
          const sig = ei.deriveSignature({
            exceptionCategory: input.exceptionCategory,
            amount: input.amountRange === "1m+" ? 1_000_000 : input.amountRange === "100k-1m" ? 100_000 : 0,
            counterpartyType: resolvedCounterpartyType,
            deductionType: input.deductionType ?? null,
            resolution: input.resolution,
            outcome: input.outcome,
          });
          // amountRange is already bucketed; trust it over the synthetic amount.
          sig.amountBucket = input.amountRange;
          sig.signatureHash = ei.signatureHashOf(sig);
          await ei.recordLocalSignature(orgId, sig);
        } catch (err) {
          console.error("[ExceptionIntelligence] signature record failed (non-fatal):", err);
        }

        await logAudit(userId, 'super_agent_memory_added', 'agent_memory', undefined, {
          category: input.exceptionCategory,
          outcome: input.outcome,
        });

        return { success: true };
      }),

    // ── Layer 5: Retrieve similar past cases ──────────────────────────
    getSimilarCases: protectedProcedure
      .input(z.object({
        embeddingText: z.string(),
        topK: z.number().int().min(1).max(10).default(3),
        // Explicit category avoids fragile regex parsing of the embedding text.
        // Callers should pass the exception's category directly; falls back to
        // parsing the embedding text only when omitted for backwards compatibility.
        exceptionCategory: z.string().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user.organizationId ?? 0;
        const drizzle = await getDb();
        if (!drizzle) return { cases: [] };

        const memoryRows = await drizzle
          .select()
          .from(agentMemory)
          .where(eq(agentMemory.organizationId, orgId))
          .orderBy(desc(agentMemory.createdAt))
          .limit(200);

        const memories: MemoryRecord[] = memoryRows.map((m) => ({
          id: m.id,
          exceptionCategory: m.exceptionCategory,
          transactionRef: m.transactionRef || '',
          amountRange: m.amountRange,
          counterpartyType: m.counterpartyType,
          deductionType: m.deductionType,
          resolution: m.resolution,
          outcome: m.outcome,
          reasoning: m.reasoning,
          embeddingText: m.embeddingText,
          createdAt: m.createdAt,
        }));

        // Use a dummy txn/diagnosis for the similarity search
        const dummyTxn: SATransaction = { id: 0, transactionRef: null, description: null, counterparty: null, amount: 0, currency: 'NGN', transactionDate: new Date(), channelId: 0, debitCredit: 'credit' };
        const dummyDiag: any = { category: 'unmatched', deductionType: null };

        // Override the embedding text for search
        const queryTokens = new Set(input.embeddingText.toLowerCase().split(/[\s|:]+/).filter((t) => t.length > 2));
        const queryTokensArr = Array.from(queryTokens);

        const scored = memories.map((mem) => {
          const memTokens = new Set(mem.embeddingText.toLowerCase().split(/[\s|:]+/).filter((t) => t.length > 2));
          const memTokensArr = Array.from(memTokens);
          const intersectionArr = queryTokensArr.filter((t) => memTokens.has(t));
          const unionArr = Array.from(new Set(queryTokensArr.concat(memTokensArr)));
          const similarity = unionArr.length > 0 ? intersectionArr.length / unionArr.length : 0;
          return { memory: mem, similarity };
        });

        const results = scored
          .filter((s) => s.similarity > 0.15)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, input.topK);

        // Exception Intelligence: augment with cross-institution recommendations
        // from the shared pool (k-anonymized, non-personal).
        // Prefer the explicit exceptionCategory input; fall back to parsing the
        // embedding text's `category:<x>` token for backwards compatibility.
        let sharedRecommendations: Array<{ resolutionActionClass: string; outcome: string; contributorCount: number; observationCount: number }> = [];
        try {
          let resolvedCategory: string | null = input.exceptionCategory ?? null;
          if (!resolvedCategory) {
            const catMatch = input.embeddingText.match(/category:([a-z0-9_]+)/i);
            resolvedCategory = catMatch ? catMatch[1] : null;
          }
          if (resolvedCategory) {
            const ei = await import("./exceptionIntelligence");
            sharedRecommendations = await ei.getSharedRecommendations(orgId, resolvedCategory);
          }
        } catch (err) {
          console.error("[ExceptionIntelligence] shared recommendation lookup failed (non-fatal):", err);
        }

        return { cases: results, sharedRecommendations };
      }),
  }),

  // ─── Documentation ────────────────────────────────────────────────────

  demo: router({
    status: protectedProcedure
      .query(async ({ ctx }) => {
        const drizzle = await getDb();
        if (!drizzle) return { active: false, jobId: null, exceptionCount: 0, transactionCount: 0, distributorCount: 0, memoryCount: 0, segment: "both" as "fmcg" | "finserv" | "both" };
        const { reconciliationJobs: rj, transactions: txns, distributors: dist, agentMemory: am } = await import("../drizzle/schema");

        // For guests using the shared pre-warmed demo user, read data from that user's account.
        // This ensures demo.status returns active:true immediately without waiting for seeding.
        const isSharedDemoUser = ctx.user.openId === DEMO_PREWARM_OPEN_ID;
        const targetUserId = isSharedDemoUser ? (getPrewarmUserId() ?? ctx.user.id) : ctx.user.id;
        const targetOrgId = isSharedDemoUser ? (getPrewarmOrgId() ?? ctx.user.organizationId ?? 0) : (ctx.user.organizationId ?? 0);

        const demoJobs = await drizzle.select().from(rj).where(eq(rj.userId, targetUserId));
        const allDemoJobs = demoJobs.filter(j => j.name?.includes("Demo"));
        const activeDemoJob = allDemoJobs[0];
        if (!activeDemoJob) return { active: false, jobId: null, exceptionCount: 0, transactionCount: 0, distributorCount: 0, memoryCount: 0, segment: "both" as "fmcg" | "finserv" | "both" };
        const allBatches = await drizzle.select().from(await import("../drizzle/schema").then(s => s.uploadBatches)).where(eq(await import("../drizzle/schema").then(s => s.uploadBatches).then(t => t.userId), targetUserId));
        const demoBatches = allBatches.filter((b: { fileName?: string }) => b.fileName?.includes("Demo"));
        const demoBatchIds = demoBatches.map((b: { id: number }) => b.id);
        let transactionCount = 0;
        for (const batchId of demoBatchIds) {
          const txnRows = await drizzle.select().from(txns).where(eq(txns.batchId, batchId));
          transactionCount += txnRows.length;
        }
        const distRows = await drizzle.select().from(dist).where(eq(dist.organizationId, targetOrgId));
        const demoDistributors = distRows.filter((d: { notes?: string | null }) => d.notes?.includes("DEMO DATA"));
        const memRows = await drizzle.select().from(am).where(eq(am.organizationId, targetOrgId));
        const seedMemory = memRows.filter((m: { exceptionId?: number | null }) => !m.exceptionId);
        const hasFmcg = allDemoJobs.some(j => !j.name?.includes("FinServ") && !j.name?.includes("LapoMFB"));
        const hasFinServ = allDemoJobs.some(j => j.name?.includes("FinServ") || j.name?.includes("LapoMFB"));
        const segment = (hasFmcg && hasFinServ) ? "both" : hasFinServ ? "finserv" : "fmcg";
        const totalExceptions = allDemoJobs.reduce((sum, j) => sum + (j.exceptionCount ?? 0), 0);
        return {
          active: true,
          jobId: activeDemoJob.id,
          exceptionCount: totalExceptions,
          transactionCount,
          distributorCount: demoDistributors.length,
          memoryCount: seedMemory.length,
          segment: segment as "fmcg" | "finserv" | "both",
        };
      }),

    // Seeding and wiping fabricated data is an Infinity AI SALES action, and it
    // writes into the CALLER'S OWN organization. As protectedProcedure, any
    // signed-in user at any tenant could seed 60 fabricated transactions, 6
    // exceptions, 15 distributors and 12 agent-memory records into their live
    // tenant — and the sidebar rendered a "Demo Mode: OFF" button that did it in
    // one click, for everyone. On a reconciliation platform that is data
    // corruption, not a cosmetic issue.
    //
    // The guest demo flow is unaffected: guests are seeded server-side by
    // prewarmDemoUser at deploy time and by the guest-login path in auth, never
    // by this procedure. `status` below stays open because guests poll it and it
    // only reads.
    activate: superAdminProcedure
      .input(z.object({ segment: z.enum(["fmcg", "finserv"]).default("fmcg") }))
      .mutation(async ({ ctx, input }) => {
        if (input.segment === "finserv") {
          const { seedFinServDemoData } = await import("./demoSeedFinServ");
          const result = await seedFinServDemoData(ctx.user.id, ctx.user.organizationId ?? null, "both");
          const { ip, ua } = getClientInfo(ctx);
          await logAudit(ctx.user.id, "activate_finserv_operational_demo", "reconciliation_job", result.jobId, {
            segment: "finserv",
            transactionLegs: result.totalTransactions,
            matchedPairs: result.matchedCount,
            exceptionCases: result.exceptionCount,
            reviewQueueOpenToday: result.reviewQueueOpenToday,
          }, ip, ua);
          return { success: true, ...result };
        }
        const result = await seedDemoData(ctx.user.id, ctx.user.organizationId ?? null);
        return { success: true, ...result };
      }),
    deactivate: superAdminProcedure
      .mutation(async ({ ctx }) => {
        await wipeDemoData(ctx.user.id, ctx.user.organizationId ?? null);
        const { wipeFinServDemoData } = await import("./demoSeedFinServ");
        await wipeFinServDemoData(ctx.user.id, ctx.user.organizationId ?? null);
        return { success: true };
      }),
    // Mints a 7-day token granting access to the creating org's data. Part of the
    // same sales tool, and staff-only for the same reason.
    createGuestLink: superAdminProcedure
      .input(z.object({ label: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { guestTokens } = await import("../drizzle/schema");
        const crypto = await import("crypto");
        const token = crypto.randomBytes(24).toString("hex"); // 48-char hex token
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await drizzle.insert(guestTokens).values({
          token,
          createdBy: ctx.user.id,
          organizationId: ctx.user.organizationId ?? null,
          label: input.label ?? "Demo Link",
          expiresAt,
          viewCount: 0,
          isActive: true,
        });
        const origin = process.env.VITE_APP_ID ? `https://${process.env.VITE_APP_ID}.manus.space` : "";
        return { success: true, token, expiresAt, url: `${origin}/demo/${token}` };
      }),
    validateGuestToken: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) return { valid: false, reason: "Database unavailable" };
        const { guestTokens } = await import("../drizzle/schema");
        const rows = await drizzle.select().from(guestTokens).where(eq(guestTokens.token, input.token)).limit(1);
        if (!rows[0]) return { valid: false, reason: "Token not found" };
        const gt = rows[0];
        if (!gt.isActive) return { valid: false, reason: "Token has been revoked" };
        if (new Date(gt.expiresAt) < new Date()) return { valid: false, reason: "Token has expired" };
        // Increment view count
        await drizzle.update(guestTokens).set({ viewCount: (gt.viewCount ?? 0) + 1 }).where(eq(guestTokens.token, input.token));
        return { valid: true, label: gt.label, expiresAt: gt.expiresAt, organizationId: gt.organizationId };
      }),
    listGuestLinks: protectedProcedure
      .query(async ({ ctx }) => {
        const drizzle = await getDb();
        if (!drizzle) return [];
        const { guestTokens } = await import("../drizzle/schema");
        return drizzle.select().from(guestTokens).where(eq(guestTokens.createdBy, ctx.user.id));
      }),
    revokeGuestLink: protectedProcedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { guestTokens } = await import("../drizzle/schema");
        await drizzle.update(guestTokens).set({ isActive: false }).where(and(eq(guestTokens.token, input.token), eq(guestTokens.createdBy, ctx.user.id)));
        return { success: true };
      }),
  }),
  leads: router({
    requestDemo: publicProcedure
      .input(z.object({
        companyName: z.string().min(2),
        contactEmail: z.string().email(),
        monthlyPaymentVolume: z.string().optional(),
        message: z.string().optional(),
        source: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { demoRequests } = await import("../drizzle/schema");
        await drizzle.insert(demoRequests).values({
          companyName: input.companyName,
          contactEmail: input.contactEmail,
          monthlyPaymentVolume: input.monthlyPaymentVolume ?? null,
          message: input.message ?? null,
          source: input.source ?? "corporate_b2b_landing",
          status: "new",
        });
        // Notify owner
        try {
          const { notifyOwner } = await import("./_core/notification");
          await notifyOwner({
            title: `New Demo Request: ${input.companyName}`,
            content: `Company: ${input.companyName}\nEmail: ${input.contactEmail}\nMonthly Volume: ${input.monthlyPaymentVolume ?? "Not specified"}\nMessage: ${input.message ?? "None"}\nSource: ${input.source ?? "corporate_b2b_landing"}`,
          });
        } catch (_) { /* non-fatal */ }
        return { success: true };
      }),
  }),

  docs: router({
    download: publicProcedure
      .input(z.object({
        filename: z.enum([
          "ReconcileAI_Quick_Start.md",
          "ReconcileAI_User_Guide.md",
          "ReconcileAI_Admin_Guide.md",
          "ReconcileAI_Quick_Start.docx",
          "ReconcileAI_User_Guide.docx",
          "ReconcileAI_Admin_Guide.docx",
        ]),
      }))
      .query(async ({ input }) => {
        // Guides ship inside the repo (docs/guides/) so documentation cannot
        // drift from the deployed code or depend on an external host.
        const { readFile } = await import("fs/promises");
        const { join } = await import("path");
        const CDN_BASE = "https://files.manuscdn.com/reconcileai/docs";
        const isDocx = input.filename.endsWith(".docx");
        const contentType = isDocx
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/markdown";
        const url = `${CDN_BASE}/${input.filename}`;
        if (isDocx) {
          // For .docx files, return the CDN URL; the client fetches the binary directly.
          return {
            filename: input.filename,
            content: url,
            contentType,
            url,
          };
        }
        try {
          const content = await readFile(join(process.cwd(), "docs", "guides", input.filename), "utf-8");
          return {
            filename: input.filename,
            content,
            contentType,
            url,
          };
        } catch {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Documentation file not found: ${input.filename}`,
          });
        }
      }),
  }),

  // ─── Woodcore POC Procedures ─────────────────────────────────────────
  woodcore: router({
    // Get dataset stats
    stats: woodcoreProcedure.query(async () => {
      return getWoodcoreStats();
    }),

    // List reconcilable products (have a GL mapping + transactions) for the run picker.
    // Used by the live POC so the engine targets a real product instead of a hardcoded id.
    listProducts: woodcoreProcedure
      .input(z.object({ type: z.enum(["SAVINGS", "LOAN"]) }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { sql } = await import("drizzle-orm");
        const q = input.type === "LOAN"
          ? sql`
              SELECT p.id AS id, p.name AS name, COUNT(DISTINCT lt.id) AS txn_count
              FROM wc_m_product_loan p
              JOIN wc_acc_product_mapping m ON m.product_id = p.id AND m.product_type = 1
              LEFT JOIN wc_m_loan l ON l.product_id = p.id
              LEFT JOIN wc_m_loan_transaction lt ON lt.loan_id = l.id
              GROUP BY p.id, p.name
              HAVING COUNT(DISTINCT lt.id) > 0
              ORDER BY txn_count DESC
              LIMIT 100`
          : sql`
              SELECT p.id AS id, p.name AS name, COUNT(DISTINCT st.id) AS txn_count
              FROM wc_m_savings_product p
              JOIN wc_acc_product_mapping m ON m.product_id = p.id AND m.product_type = 2
              LEFT JOIN wc_m_savings_account a ON a.product_id = p.id
              LEFT JOIN wc_m_savings_account_transaction st ON st.savings_account_id = a.id
              GROUP BY p.id, p.name
              HAVING COUNT(DISTINCT st.id) > 0
              ORDER BY txn_count DESC
              LIMIT 100`;
        const r = await db2.execute(q);
        const rows = (r as any)[0] as Array<{ id: number; name: string; txn_count: number }>;
        return rows.map((x) => ({ id: Number(x.id), name: String(x.name), txnCount: Number(x.txn_count) }));
      }),

    // Get all reconciliation runs
    getRuns: woodcoreProcedure.query(async () => {
      return getLatestRuns(20);
    }),

    // Get a specific run
    getRun: woodcoreProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        return getRunById(input.runId);
      }),

    // Get exceptions for a run
    getExceptions: woodcoreProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        return getRunExceptions(input.runId);
      }),

    // Run the full POC (all 3 layers)
    runPOC: woodcoreProcedure
      .input(z.object({
        productId: z.number().default(2),
        productType: z.enum(["SAVINGS", "LOAN"]).default("SAVINGS"),
        currencyCode: z.string().default("NGN"),
        periodStart: z.string().default("2025-04-01"),
        periodEnd: z.string().default("2025-07-31"),
        varianceThreshold: z.number().default(1.0),
      }))
      .mutation(async ({ input }) => {
        const config: ReconciliationConfig = {
          productId: input.productId,
          productType: input.productType,
          currencyCode: input.currencyCode,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          varianceThreshold: input.varianceThreshold,
        };
        return runFullPOC(config);
      }),

    // Update exception review status
    updateExceptionStatus: woodcoreProcedure
      .input(z.object({
        exceptionId: z.number(),
        reviewStatus: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "ESCALATED"]),
        reviewedBy: z.string().optional(),
        reviewNote: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_exceptions } = await import("../drizzle/woodcore_schema");
        await db2.update(wc_exceptions)
          .set({
            reviewStatus: input.reviewStatus,
            reviewedBy: input.reviewedBy ?? "Reviewer",
            reviewedAt: new Date(),
            reviewNote: input.reviewNote ?? null,
          })
          .where(eq(wc_exceptions.id, input.exceptionId));
        return { success: true, exceptionId: input.exceptionId, reviewStatus: input.reviewStatus };
      }),

    // Compare two runs side by side
    compareRuns: woodcoreProcedure
      .input(z.object({
        runIdA: z.number(),
        runIdB: z.number(),
      }))
      .query(async ({ input }) => {
        const runA = await getRunById(input.runIdA);
        const runB = await getRunById(input.runIdB);
        const exceptionsA = await getRunExceptions(input.runIdA);
        const exceptionsB = await getRunExceptions(input.runIdB);
        return { runA, runB, exceptionsA, exceptionsB };
      }),

    // Bulk acknowledge all OPEN exceptions for a run
    bulkAcknowledge: woodcoreProcedure
      .input(z.object({
        runId: z.number(),
        reviewedBy: z.string().default("Reviewer"),
        reviewNote: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_exceptions } = await import("../drizzle/woodcore_schema");
        const result = await db2.update(wc_exceptions)
          .set({
            reviewStatus: "ACKNOWLEDGED",
            reviewedBy: input.reviewedBy,
            reviewedAt: new Date(),
            reviewNote: input.reviewNote ?? "Bulk acknowledged",
          })
          .where(
            and(
              eq(wc_exceptions.reconciliationRunId, input.runId),
              eq(wc_exceptions.reviewStatus, "OPEN"),
            )
          );
        return { success: true, updatedCount: result[0]?.affectedRows ?? 0 };
      }),

    // Create a shareable read-only token for a run's Layer 3 report
    createShareToken: woodcoreProcedure
      .input(z.object({
        runId: z.number(),
        createdBy: z.string().optional(),
        expiresInDays: z.number().default(30),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_share_tokens } = await import("../drizzle/woodcore_schema");
        const crypto = await import("crypto");
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + input.expiresInDays);
        await db2.insert(wc_share_tokens).values({
          token,
          reconciliationRunId: input.runId,
          createdBy: input.createdBy ?? "ReconcileAI User",
          expiresAt,
          createdAt: new Date(),
        });
        return { token, expiresAt };
      }),

    // Get a shared run report by token (public, no auth required)
    getSharedReport: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_share_tokens } = await import("../drizzle/woodcore_schema");
        const rows = await db2.select().from(wc_share_tokens)
          .where(eq(wc_share_tokens.token, input.token))
          .limit(1);
        if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired share link" });
        const shareRow = rows[0];
        if (shareRow.expiresAt && new Date(shareRow.expiresAt) < new Date()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This share link has expired" });
        }
        const run = await getRunById(shareRow.reconciliationRunId);
        const allExceptions = await getRunExceptions(shareRow.reconciliationRunId);
        // Separate raw GL exceptions from layer3 AI results (same table, different view)
        const exceptions = allExceptions.map((e: any) => ({
          glEntryId: e.glEntryId,
          glEntryAmount: e.glEntryAmount,
          glEntryType: e.glEntryType,
          glEntryDate: e.glEntryDate,
          exceptionCategory: e.exceptionCategory,
          manualEntryFlag: e.manualEntryFlag,
          refNum: e.refNum,
          linkedSavingsTxnId: e.linkedSavingsTxnId,
          productMatch: e.productMatch,
          description: e.description,
        }));
        const layer3Results = allExceptions
          .filter((e: any) => e.layer3Processed === 1 || e.layer3Processed === true)
          .map((e: any) => ({
            exceptionId: e.id,
            priorityLevel: e.priorityLevel ?? "LOW",
            agentClassification: e.agentClassification ?? "UNCLASSIFIED",
            agentExplanation: e.agentExplanation ?? "",
            recommendedAction: e.recommendedAction ?? "",
            agentConfidence: e.agentConfidence ?? 0,
            reviewStatus: e.reviewStatus ?? "OPEN",
            reviewNote: e.reviewNote ?? null,
            reviewedBy: e.reviewedBy ?? null,
            reviewedAt: e.reviewedAt ?? null,
          }));
        return { run, exceptions, layer3Results, sharedBy: shareRow.createdBy, expiresAt: shareRow.expiresAt };
      }),

    // ─── LIVE DATA: Direct queries against Woodcore test tenant ──────────────
    liveStats: woodcoreProcedure.query(async () => {
      // Run all count queries in parallel for speed
      const [glRow, savingsRow, archiveRow, loanRow, acctRow, loanAcctRow] = await Promise.all([
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM acc_gl_journal_entry WHERE reversed = 0"),
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM m_savings_account_transaction WHERE is_reversed = 0"),
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM m_savings_account_transaction_archive"),
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM m_loan_transaction WHERE is_reversed = 0"),
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM m_savings_account"),
        woodcoreQuery<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM m_loan"),
      ]);
      return {
        glEntries: Number(glRow[0]?.cnt ?? 0),
        // Full savings = active table UNION archive table
        savingsTransactions: Number(savingsRow[0]?.cnt ?? 0) + Number(archiveRow[0]?.cnt ?? 0),
        savingsAccounts: Number(acctRow[0]?.cnt ?? 0),
        loanAccounts: Number(loanAcctRow[0]?.cnt ?? 0),
        loanTransactions: Number(loanRow[0]?.cnt ?? 0),
        dataSource: "live" as const,
        asOf: new Date().toISOString(),
      };
    }),

    liveGlReconciliation: woodcoreProcedure
      .input(z.object({
        days: z.number().min(1).max(90).default(7),
        currency: z.string().default("NGN"),
      }))
      .query(async ({ input }) => {
        const rows = await woodcoreQuery<{
          entry_date: string;
          total_debits: string;
          total_credits: string;
          variance: string;
          debit_count: number;
          credit_count: number;
        }>(
          `SELECT
            entry_date,
            SUM(CASE WHEN type_enum = 1 THEN amount ELSE 0 END) AS total_debits,
            SUM(CASE WHEN type_enum = 2 THEN amount ELSE 0 END) AS total_credits,
            SUM(CASE WHEN type_enum = 1 THEN amount ELSE 0 END) - SUM(CASE WHEN type_enum = 2 THEN amount ELSE 0 END) AS variance,
            COUNT(CASE WHEN type_enum = 1 THEN 1 END) AS debit_count,
            COUNT(CASE WHEN type_enum = 2 THEN 1 END) AS credit_count
          FROM acc_gl_journal_entry
          WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND reversed = 0
            AND currency_code = ?
          GROUP BY entry_date
          ORDER BY entry_date DESC`,
          [input.days, input.currency]
        );
        return rows.map(r => ({
          date: r.entry_date,
          totalDebits: parseFloat(r.total_debits ?? "0"),
          totalCredits: parseFloat(r.total_credits ?? "0"),
          variance: parseFloat(r.variance ?? "0"),
          debitCount: Number(r.debit_count),
          creditCount: Number(r.credit_count),
          status: Math.abs(parseFloat(r.variance ?? "0")) < 0.01 ? "BALANCED" : "VARIANCE",
        }));
      }),

    liveSavingsReconciliation: woodcoreProcedure
      .input(z.object({ days: z.number().min(1).max(90).default(30) }))
      .query(async ({ input }) => {
        // UNION active + archive tables for full savings transaction history
        const rows = await woodcoreQuery<{
          txn_date: string;
          savings_txns: number;
          gl_linked_savings: number;
          unmatched_savings: number;
          savings_total: string;
          gl_debit_total: string;
        }>(
          `SELECT
            DATE(sat.transaction_date) AS txn_date,
            COUNT(DISTINCT sat.id) AS savings_txns,
            COUNT(DISTINCT gl.savings_transaction_id) AS gl_linked_savings,
            COUNT(DISTINCT sat.id) - COUNT(DISTINCT gl.savings_transaction_id) AS unmatched_savings,
            SUM(sat.amount) AS savings_total,
            SUM(CASE WHEN gl.type_enum = 1 THEN gl.amount ELSE 0 END) AS gl_debit_total
          FROM (
            SELECT id, savings_account_id, transaction_date, amount, is_reversed
            FROM m_savings_account_transaction
            WHERE is_reversed = 0
              AND transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            UNION ALL
            SELECT id, savings_account_id, transaction_date, amount, is_reversed
            FROM m_savings_account_transaction_archive
            WHERE is_reversed = 0
              AND transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          ) sat
          LEFT JOIN acc_gl_journal_entry gl ON gl.savings_transaction_id = sat.id AND gl.reversed = 0
          GROUP BY DATE(sat.transaction_date)
          ORDER BY txn_date DESC
          LIMIT 30`,
          [input.days, input.days]
        );
        return rows.map(r => ({
          date: r.txn_date,
          savingsTxns: Number(r.savings_txns),
          glLinked: Number(r.gl_linked_savings),
          unmatched: Number(r.unmatched_savings),
          savingsTotal: parseFloat(r.savings_total ?? "0"),
          glDebitTotal: parseFloat(r.gl_debit_total ?? "0"),
          matchRate: r.savings_txns > 0 ? (Number(r.gl_linked_savings) / Number(r.savings_txns)) * 100 : 100,
        }));
      }),

    liveLoanReconciliation: woodcoreProcedure
      .input(z.object({ days: z.number().min(1).max(90).default(30) }))
      .query(async ({ input }) => {
        const rows = await woodcoreQuery<{
          txn_date: string;
          loan_txns: number;
          gl_linked_loans: number;
          unmatched_loans: number;
          loan_total: string;
          gl_debit_total: string;
        }>(
          `SELECT
            DATE(lt.transaction_date) AS txn_date,
            COUNT(DISTINCT lt.id) AS loan_txns,
            COUNT(DISTINCT gl.loan_transaction_id) AS gl_linked_loans,
            COUNT(DISTINCT lt.id) - COUNT(DISTINCT gl.loan_transaction_id) AS unmatched_loans,
            SUM(lt.amount) AS loan_total,
            SUM(CASE WHEN gl.type_enum = 1 THEN gl.amount ELSE 0 END) AS gl_debit_total
          FROM m_loan_transaction lt
          LEFT JOIN acc_gl_journal_entry gl ON gl.loan_transaction_id = lt.id AND gl.reversed = 0
          WHERE lt.is_reversed = 0
            AND lt.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          GROUP BY DATE(lt.transaction_date)
          ORDER BY txn_date DESC
          LIMIT 30`,
          [input.days]
        );
        return rows.map(r => ({
          date: r.txn_date,
          loanTxns: Number(r.loan_txns),
          glLinked: Number(r.gl_linked_loans),
          unmatched: Number(r.unmatched_loans),
          loanTotal: parseFloat(r.loan_total ?? "0"),
          glDebitTotal: parseFloat(r.gl_debit_total ?? "0"),
          matchRate: r.loan_txns > 0 ? (Number(r.gl_linked_loans) / Number(r.loan_txns)) * 100 : 100,
        }));
      }),

    // Full savings transactions: UNION of active + archive tables
    liveSavingsTxns: woodcoreProcedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20), offset: z.number().default(0) }))
      .query(async ({ input }) => {
        const rows = await woodcoreQuery<{
          id: number;
          savings_account_id: number;
          transaction_type_enum: number;
          transaction_date: string;
          amount: string;
          running_balance_derived: string;
          source: string;
        }>(
          `SELECT id, savings_account_id, transaction_type_enum, transaction_date, amount,
                  running_balance_derived, 'active' AS source
           FROM m_savings_account_transaction
           WHERE is_reversed = 0
           UNION ALL
           SELECT id, savings_account_id, transaction_type_enum, transaction_date, amount,
                  running_balance_derived, 'archive' AS source
           FROM m_savings_account_transaction_archive
           WHERE is_reversed = 0
           ORDER BY transaction_date DESC, id DESC
           LIMIT ? OFFSET ?`,
          [input.limit, input.offset]
        );
        return rows.map(r => ({
          id: Number(r.id),
          accountId: Number(r.savings_account_id),
          type: SAVINGS_TXN_TYPE[Number(r.transaction_type_enum)] ?? `Type ${r.transaction_type_enum}`,
          date: r.transaction_date,
          amount: parseFloat(r.amount ?? "0"),
          runningBalance: parseFloat(r.running_balance_derived ?? "0"),
          source: r.source as "active" | "archive",
        }));
      }),

    liveLoanTxns: woodcoreProcedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20), offset: z.number().default(0) }))
      .query(async ({ input }) => {
        const rows = await woodcoreQuery<{
          id: number;
          loan_id: number;
          transaction_type_enum: number;
          transaction_date: string;
          amount: string;
          is_reversed: number;
        }>(
          `SELECT id, loan_id, transaction_type_enum, transaction_date, amount, is_reversed
           FROM m_loan_transaction
           WHERE is_reversed = 0
           ORDER BY transaction_date DESC, id DESC
           LIMIT ? OFFSET ?`,
          [input.limit, input.offset]
        );
        return rows.map(r => ({
          id: Number(r.id),
          loanId: Number(r.loan_id),
          type: LOAN_TXN_TYPE[Number(r.transaction_type_enum)] ?? `Type ${r.transaction_type_enum}`,
          date: r.transaction_date,
          amount: parseFloat(r.amount ?? "0"),
        }));
      }),

    // Check CBS staleness for all RESOLVED/ACKNOWLEDGED exceptions in a run.
    // For each exception, re-queries the Fineract data to see if the underlying
    // anomaly still exists — i.e., the user marked it RESOLVED but never fixed the CBS.
    verifyResolvedExceptions: woodcoreProcedure
      .input(z.object({ runId: z.number() }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_exceptions } = await import("../drizzle/woodcore_schema");
        const { checkExceptionStaleness } = await import("./woodcore-engine");
        const { and: _and, inArray } = await import("drizzle-orm");

        const resolved = await db2.select().from(wc_exceptions)
          .where(
            _and(
              eq(wc_exceptions.reconciliationRunId, input.runId),
              inArray(wc_exceptions.reviewStatus, ["RESOLVED", "ACKNOWLEDGED"]),
            )
          );

        if (resolved.length === 0) return { checked: 0, staleCount: 0, results: [] };

        const results: { exceptionId: number; cbsStillAnomalous: boolean; verificationNote: string }[] = [];
        const now = new Date();

        for (const exc of resolved) {
          try {
            const check = await checkExceptionStaleness({
              glEntryId: exc.glEntryId,
              exceptionCategory: exc.exceptionCategory,
              linkedSavingsTxnId: exc.linkedSavingsTxnId ?? null,
              productMatch: exc.productMatch ?? null,
            });
            await db2.update(wc_exceptions)
              .set({
                cbsVerifiedAt: now,
                cbsStillAnomalous: check.cbsStillAnomalous ? 1 : 0,
                cbsVerificationNote: check.verificationNote.slice(0, 300),
              })
              .where(eq(wc_exceptions.id, exc.id));
            results.push({ exceptionId: exc.id, ...check });
          } catch {
            // Non-fatal: if CBS is unreachable, skip this exception
          }
        }

        return {
          checked: results.length,
          staleCount: results.filter((r) => r.cbsStillAnomalous).length,
          results,
        };
      }),

    // User chose to keep the exception RESOLVED despite the CBS still showing the anomaly.
    // Sets userKeptResolved = 1 so the mismatch banner is suppressed.
    keepResolvedDespiteStaleness: woodcoreProcedure
      .input(z.object({ exceptionId: z.number() }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        const { wc_exceptions } = await import("../drizzle/woodcore_schema");
        await db2.update(wc_exceptions)
          .set({ userKeptResolved: 1 })
          .where(eq(wc_exceptions.id, input.exceptionId));
        return { success: true, exceptionId: input.exceptionId };
      }),
  }),
  // ─── Compliance (NDPA/NDPR — NDA Clause 11, 7, 12) ───────────────────
  compliance: router({
    // Get compliance settings for the current org
    getSettings: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? null;
      const drizzle = await getDb();
      if (!drizzle) return null;
      const { complianceSettings } = await import("../drizzle/schema");
      const rows = await drizzle.select().from(complianceSettings)
        .where(orgId ? eq(complianceSettings.organizationId, orgId) : isNull(complianceSettings.organizationId))
        .limit(1);
      return rows[0] ?? null;
    }),

    // Upsert compliance settings
    saveSettings: protectedProcedure
      .input(z.object({
        dpoName: z.string().optional(),
        dpoEmail: z.string().email().optional(),
        dpoPhone: z.string().optional(),
        retentionPeriodDays: z.number().min(1).max(3650).optional(),
        autoDeleteEnabled: z.boolean().optional(),
        ndpaCompliant: z.boolean().optional(),
        ndprCompliant: z.boolean().optional(),
        ropaCompleted: z.boolean().optional(),
        breachNotificationEmail: z.string().email().optional(),
        ndprRegistrationNumber: z.string().max(100).optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? null;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceSettings } = await import("../drizzle/schema");
        const existing = await drizzle.select({ id: complianceSettings.id }).from(complianceSettings)
          .where(orgId ? eq(complianceSettings.organizationId, orgId) : isNull(complianceSettings.organizationId))
          .limit(1);
        if (existing.length > 0) {
          await drizzle.update(complianceSettings).set({ ...input, updatedAt: new Date() })
            .where(eq(complianceSettings.id, existing[0].id));
        } else {
          await drizzle.insert(complianceSettings).values({ ...input, organizationId: orgId });
        }
        return { success: true };
      }),

    // Request data deletion (Clause 7)
    //
    // This procedure issues a CERTIFICATE asserting NDPA-compliant destruction,
    // so its output is a legal artefact, not a status message. Three defects
    // made that assertion untrue and are fixed here:
    //
    //  1. `specific_channel` and `specific_job` were accepted by the input enum
    //     and implemented NOWHERE — no branch matched them. A request for either
    //     deleted nothing, was marked "completed", and still returned a
    //     certificate. They are removed rather than implemented: nothing in the
    //     client ever sent them, and per-scope destruction is deliberate work
    //     deserving its own design rather than a branch bolted on beside a
    //     certificate generator. (The DB column keeps its wider enum; migrations
    //     are append-only and no existing row needs rewriting.)
    //  2. `recordsDeleted` counted the org's transactions BEFORE deleting and
    //     ignored every other table, so the figure on the certificate bore no
    //     necessary relation to what was removed. It is now the sum of rows
    //     actually affected.
    //  3. Every delete was wrapped in `.catch(() => {})`, so a total failure
    //     still produced "completed" plus a certificate. A failure now marks the
    //     request `failed` and issues NO certificate.
    requestDeletion: protectedProcedure
      .input(z.object({
        scope: z.enum(["all_transactions", "all_data"]),
        notes: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? null;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { dataDeletionRequests, transactions, uploadBatches, reconciliationJobs, matches, exceptions } = await import("../drizzle/schema");

        const [req] = await drizzle.insert(dataDeletionRequests).values({
          organizationId: orgId,
          requestedByUserId: ctx.user.id,
          scope: input.scope,
          status: "in_progress",
          notes: input.notes,
        }).$returningId();

        const txWhereClause = orgId ? eq(transactions.organizationId, orgId) : isNull(transactions.organizationId);
        const jobWhereClause = orgId ? eq(reconciliationJobs.organizationId, orgId) : isNull(reconciliationJobs.organizationId);

        // Counted per table so the certificate can itemise what went, rather
        // than quote a single number nobody can reconcile against anything.
        const deleted = { matches: 0, exceptions: 0, transactions: 0, uploadBatches: 0, reconciliationJobs: 0 };

        try {
          const orgJobIds = await drizzle.select({ id: reconciliationJobs.id }).from(reconciliationJobs).where(jobWhereClause);
          for (const { id: jid } of orgJobIds) {
            const [m] = await drizzle.delete(matches).where(eq(matches.jobId, jid));
            deleted.matches += m.affectedRows ?? 0;
            const [e] = await drizzle.delete(exceptions).where(eq(exceptions.jobId, jid));
            deleted.exceptions += e.affectedRows ?? 0;
          }

          const [t] = await drizzle.delete(transactions).where(txWhereClause);
          deleted.transactions += t.affectedRows ?? 0;

          if (input.scope === "all_data") {
            const [b] = await drizzle.delete(uploadBatches)
              .where(orgId ? eq(uploadBatches.organizationId, orgId) : isNull(uploadBatches.organizationId));
            deleted.uploadBatches += b.affectedRows ?? 0;
            const [j] = await drizzle.delete(reconciliationJobs).where(jobWhereClause);
            deleted.reconciliationJobs += j.affectedRows ?? 0;
          }
        } catch (err) {
          // No certificate on a failed or partial run. A document asserting
          // destruction that did not complete is worse than an error, because
          // it is the artefact a regulator or counterparty relies on.
          const message = err instanceof Error ? err.message : String(err);
          await drizzle.update(dataDeletionRequests).set({
            status: "failed",
            notes: [input.notes, `Deletion failed: ${message}`].filter(Boolean).join(" | ").slice(0, 2000),
          }).where(eq(dataDeletionRequests.id, req.id)).catch(() => {});
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Deletion did not complete; no certificate was issued. The request is recorded as failed.',
          });
        }

        const recordsDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
        const scopeDescription = input.scope === "all_data"
          ? "all reconciliation data (transactions, upload batches, reconciliation jobs, matches and exceptions)"
          : "all transactions, together with their matches and exceptions";

        const certText = `DATA DELETION CERTIFICATE\n\nIssued by: ReconcileAI (Infinity AI Africa Limited)\nDate: ${new Date().toISOString()}\nOrganisation ID: ${orgId ?? "N/A"}\nScope: ${input.scope} — ${scopeDescription}\nRequested by user ID: ${ctx.user.id}\n\nRecords deleted: ${recordsDeleted}\n  Transactions: ${deleted.transactions}\n  Matches: ${deleted.matches}\n  Exceptions: ${deleted.exceptions}\n  Upload batches: ${deleted.uploadBatches}\n  Reconciliation jobs: ${deleted.reconciliationJobs}\n\nThis certifies that the data described above has been permanently deleted from the ReconcileAI platform in accordance with the data return/destruction obligations under the applicable Non-Disclosure Agreement and the Nigeria Data Protection Act 2023 (NDPA). The counts above are the rows actually removed by this request.\n\nCertificate ID: CERT-${req.id}-${Date.now()}`;

        await drizzle.update(dataDeletionRequests).set({
          status: "completed",
          completedAt: new Date(),
          recordsDeleted,
          certificateText: certText,
        }).where(eq(dataDeletionRequests.id, req.id));
        return { success: true, certificateText: certText, recordsDeleted, breakdown: deleted, requestId: req.id };
      }),

    // List deletion requests
    listDeletionRequests: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? null;
      const drizzle = await getDb();
      if (!drizzle) return [];
      const { dataDeletionRequests } = await import("../drizzle/schema");
      return drizzle.select().from(dataDeletionRequests)
        .where(orgId ? eq(dataDeletionRequests.organizationId, orgId) : isNull(dataDeletionRequests.organizationId))
        .orderBy(desc(dataDeletionRequests.requestedAt))
        .limit(50);
    }),

    // Report a security incident (Clause 12)
    reportIncident: protectedProcedure
      .input(z.object({
        incidentType: z.enum(["unauthorised_access", "data_breach", "unauthorised_disclosure", "system_compromise", "other"]),
        severity: z.enum(["low", "medium", "high", "critical"]),
        description: z.string().min(10),
        affectedDataTypes: z.array(z.string()).optional(),
        estimatedRecordsAffected: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? null;
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { securityIncidents } = await import("../drizzle/schema");
        const [inc] = await drizzle.insert(securityIncidents).values({
          organizationId: orgId,
          reportedByUserId: ctx.user.id,
          ...input,
        }).$returningId();
        // Notify the platform owner immediately (Clause 12 — immediate notification)
        const { notifyOwner } = await import("./_core/notification");
        await notifyOwner({
          title: `\uD83D\uDEA8 Security Incident Reported [${input.severity.toUpperCase()}]`,
          content: `Type: ${input.incidentType}\nSeverity: ${input.severity}\nDescription: ${input.description}\nReported by user ID: ${ctx.user.id}\nOrg ID: ${orgId ?? "N/A"}\nTimestamp: ${new Date().toISOString()}`,
        }).catch(() => {});
        return { success: true, incidentId: inc.id };
      }),

    // List incidents
    listIncidents: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? null;
      const drizzle = await getDb();
      if (!drizzle) return [];
      const { securityIncidents } = await import("../drizzle/schema");
      return drizzle.select().from(securityIncidents)
        .where(orgId ? eq(securityIncidents.organizationId, orgId) : isNull(securityIncidents.organizationId))
        .orderBy(desc(securityIncidents.reportedAt))
        .limit(100);
    }),
  }),

  // ─── Compliance Readiness Assessment (Public) ─────────────────────
  assessment: router({
    // Submit a completed assessment and get back a token + score
    submit: publicProcedure
      .input(z.object({
        answers: z.array(z.object({
          questionId: z.string(),
          answer: z.union([z.string(), z.number(), z.array(z.string())]),
          score: z.number().min(0).max(5),
        })),
        respondentName: z.string().optional(),
        respondentEmail: z.string().email().optional(),
        respondentRole: z.string().optional(),
        institutionName: z.string().optional(),
        institutionType: z.enum(["commercial_bank", "microfinance_bank", "fintech", "payment_processor", "corporate_b2b", "other"]).optional(),
        consentToContact: z.boolean().default(false),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");

        // ── Scoring ──────────────────────────────────────────────────
        // 5 categories, each with up to 5 questions worth 0–5 pts each
        // Max raw = 25 per category. Normalise to 0–100 overall.
        const categories = {
          reconciliation: ["q1","q2","q3","q4","q5"],
          exception: ["q6","q7","q8","q9","q10"],
          reporting: ["q11","q12","q13","q14","q15"],
          regulatory: ["q16","q17","q18","q19","q20"],
          technology: ["q21","q22","q23","q24","q25"],
        };
        const answerMap = new Map(input.answers.map(a => [a.questionId, a.score]));
        const categoryScores: Record<string, number> = {};
        let totalRaw = 0;
        let totalMax = 0;
        for (const [cat, qids] of Object.entries(categories)) {
          const catRaw = qids.reduce((sum, qid) => sum + (answerMap.get(qid) ?? 0), 0);
          const catMax = qids.length * 5;
          categoryScores[cat] = Math.round((catRaw / catMax) * 100);
          totalRaw += catRaw;
          totalMax += catMax;
        }
        const overallScore = Math.round((totalRaw / totalMax) * 100);
        const riskLevel = overallScore >= 80 ? "low" : overallScore >= 60 ? "medium" : overallScore >= 40 ? "high" : "critical";

        // ── AI Narrative ─────────────────────────────────────────────
        let aiNarrative: string | null = null;
        try {
          const { invokeLLM } = await import("./_core/llm");
          const weakCategories = Object.entries(categoryScores)
            .filter(([, s]) => s < 60)
            .map(([cat]) => cat)
            .join(", ");
          const llmResp = await invokeLLM({
            messages: [
              { role: "system", content: "You are a CBN compliance expert writing concise, actionable risk assessments for Nigerian financial institutions. Write in second person. Be direct and specific. Maximum 120 words." },
              { role: "user", content: `Institution type: ${input.institutionType ?? "financial institution"}. Overall compliance score: ${overallScore}/100. Risk level: ${riskLevel}. Weak categories: ${weakCategories || "none"}. Category scores: ${JSON.stringify(categoryScores)}. Write a 2-sentence personalised risk narrative that names the specific risks and the most important first action to take.` },
            ],
          });
          const rawContent = llmResp?.choices?.[0]?.message?.content;
          aiNarrative = typeof rawContent === 'string' ? rawContent : null;
        } catch {}

        // ── Persist ───────────────────────────────────────────────────
        const token = crypto.randomBytes(24).toString("hex");
        await drizzle.insert(complianceAssessments).values({
          token,
          answers: input.answers,
          respondentName: input.respondentName,
          respondentEmail: input.respondentEmail,
          respondentRole: input.respondentRole,
          institutionName: input.institutionName,
          institutionType: input.institutionType,
          consentToContact: input.consentToContact,
          overallScore,
          riskLevel,
          categoryScores,
          aiNarrative,
          userId: ctx.user?.id ?? null,
        });

        // Notify owner of new assessment lead
        if (input.respondentEmail) {
          const { notifyOwner } = await import("./_core/notification");
          notifyOwner({
            title: `📋 New Compliance Assessment — ${input.institutionName ?? "Anonymous"} [${riskLevel.toUpperCase()}]`,
            content: `Score: ${overallScore}/100\nRisk: ${riskLevel}\nType: ${input.institutionType ?? "N/A"}\nName: ${input.respondentName ?? "N/A"}\nEmail: ${input.respondentEmail}\nConsent: ${input.consentToContact}`,
          }).catch(() => {});
        }

        // Send follow-up email to respondent when they have consented to contact
        if (input.consentToContact && input.respondentEmail) {
          const resultUrl = `${PUBLIC_APP_ORIGIN}/compliance-assessment/result/${token}`;
          const riskLevelLabel = riskLevel === "critical" ? "Critical Risk" : riskLevel === "high" ? "High Risk" : riskLevel === "medium" ? "Medium Risk" : "Low Risk";
          const firstName = input.respondentName?.split(" ")[0] ?? "there";
          const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;">
        <!-- Header -->
        <tr><td style="background:#1B365D;padding:28px 32px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">ReconcileAI</p>
          <p style="margin:4px 0 0;color:#a0aec0;font-size:13px;">CBN Compliance Readiness Assessment</p>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:16px;color:#1B365D;font-weight:600;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#4a5568;line-height:1.6;">Thank you for completing the ReconcileAI CBN Compliance Readiness Assessment. Your results are ready.</p>
          <!-- Score block -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;margin:0 0 24px;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:12px;color:#8c757d;text-transform:uppercase;letter-spacing:0.5px;">Your Compliance Score</p>
              <p style="margin:0;font-size:36px;font-weight:800;color:#1B365D;">${overallScore}<span style="font-size:18px;font-weight:400;color:#8c757d;"> / 100</span></p>
              <p style="margin:8px 0 0;font-size:13px;font-weight:600;color:${riskLevel === 'low' ? '#059669' : riskLevel === 'medium' ? '#d97706' : '#dc2626'};">● ${riskLevelLabel}</p>
            </td></tr>
          </table>
          ${aiNarrative ? `<p style="margin:0 0 24px;font-size:14px;color:#4a5568;line-height:1.6;font-style:italic;border-left:3px solid #F47458;padding-left:16px;">${aiNarrative}</p>` : ""}
          <p style="margin:0 0 24px;font-size:14px;color:#4a5568;line-height:1.6;">Your full report includes a breakdown of scores across all 5 compliance dimensions and a prioritised list of the 3 most important actions to take before your next CBN examination.</p>
          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td style="background:#F47458;border-radius:8px;">
              <a href="${resultUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">View Your Full Report →</a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:14px;color:#4a5568;line-height:1.6;">If you'd like to see how ReconcileAI can help you close these compliance gaps — from automated reconciliation to CBN-ready audit trails — we'd be happy to walkBook a 20-Minute Demo →</a></td></tr></table><p style="margin:0;font-size:14px;color:#4a5568;line-height:1.6;"><a href="https://calendly.com/richard-infinityaiafrica/30min" style="color:#F47458;font-weight:600;text-decoration:none;">Book a Demo →</a></p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#8c757d;">ReconcileAI by Infinity AI Africa Limited · Lagos, Nigeria</p>
          <p style="margin:4px 0 0;font-size:12px;color:#8c757d;">You're receiving this because you consented to be contacted when you submitted the assessment.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#b0b0b0;">To opt out of future emails, <a href="${PUBLIC_APP_ORIGIN}/compliance-assessment/unsubscribe/${token}" style="color:#b0b0b0;text-decoration:underline;">click here to unsubscribe</a>. This is required under Nigeria's NDPR.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

          try {
            const emailPayload = {
              to: input.respondentEmail,
              subject: `Your CBN Compliance Score: ${overallScore}/100 — ${riskLevelLabel}`,
              html: emailHtml,
              text: `Hi ${firstName},\n\nThank you for completing the ReconcileAI CBN Compliance Readiness Assessment.\n\nYour Score: ${overallScore}/100 (${riskLevelLabel})\n\n${aiNarrative ?? ""}\n\nView your full report: ${resultUrl}\n\nIf you'd like to see how ReconcileAI can help close these compliance gaps, book a demo here: https://calendly.com/richard-infinityaiafrica/30min\n\n— ReconcileAI by Infinity AI Africa Limited`,

            };
            // Data residency: legacy Forge email relay is external egress; blocked on-premise.
            assertEgressAllowed(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, "outbound email");
            const emailRes = await fetch(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.BUILT_IN_FORGE_API_KEY}`,
              },
              body: JSON.stringify(emailPayload),
            });
            if (emailRes.ok) {
              // Mark follow-up email as sent
              await drizzle.update(complianceAssessments)
                .set({ followUpEmailSent: true })
                .where(eq(complianceAssessments.token, token));
            }
          } catch {
            // Non-fatal: email failure should not block the response
          }
        }

        return { token, overallScore, riskLevel, categoryScores, aiNarrative };
      }),

    // Retrieve a completed assessment by token (public — no auth required)
    getByToken: publicProcedure
      .input(z.object({ token: z.string().length(48) }))
      .query(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const rows = await drizzle.select().from(complianceAssessments)
          .where(eq(complianceAssessments.token, input.token))
          .limit(1);
        if (!rows.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assessment not found' });
        return rows[0];
      }),

    // Admin: send a personalised demo invitation email to a specific respondent
    sendDemoInvite: superAdminProcedure
      .input(z.object({ token: z.string().length(48) }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const rows = await drizzle.select().from(complianceAssessments)
          .where(eq(complianceAssessments.token, input.token))
          .limit(1);
        if (!rows.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assessment not found' });
        const assessment = rows[0];
        if (!assessment.respondentEmail) throw new TRPCError({ code: 'BAD_REQUEST', message: 'No email address on record for this respondent' });

        const resultUrl = `${PUBLIC_APP_ORIGIN}/compliance-assessment/result/${assessment.token}`;
        const firstName = assessment.respondentName?.split(" ")[0] ?? "there";
        const riskLevelLabel = assessment.riskLevel === "critical" ? "Critical Risk" : assessment.riskLevel === "high" ? "High Risk" : assessment.riskLevel === "medium" ? "Medium Risk" : "Low Risk";
        const overallScore = assessment.overallScore;
        const institutionName = assessment.institutionName ?? "your institution";

        const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;">
        <tr><td style="background:#1B365D;padding:28px 32px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">ReconcileAI</p>
          <p style="margin:4px 0 0;color:#a0aec0;font-size:13px;">AI-Powered Financial Reconciliation for African Banks &amp; Fintechs</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:16px;color:#1B365D;font-weight:600;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#4a5568;line-height:1.6;">Thank you for completing the ReconcileAI CBN Compliance Readiness Assessment. Your score of <strong>${overallScore}/100 (${riskLevelLabel})</strong> tells us a lot about where ${institutionName} stands today — and where the biggest opportunities for improvement are.</p>
          <p style="margin:0 0 24px;font-size:14px;color:#4a5568;line-height:1.6;">We'd love to show you exactly how ReconcileAI closes those gaps. In a focused 20-minute demo, we'll walk through:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            ${[
              ["⚡", "Automated reconciliation", "Cut your daily close from hours to under 10 minutes across NIBSS, Interswitch, card schemes, and your CBS."],
              ["🎯", "AI exception classification", "Every mismatch is automatically categorised by severity, with a suggested resolution — no more manual triage."],
              ["📋", "CBN-ready audit trail", "Every matching decision and manual intervention is logged with timestamp and user — audit-ready on demand."],
            ].map(([icon, title, desc]) => `
            <tr><td style="padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:8px;">
              <p style="margin:0;font-size:14px;font-weight:600;color:#1B365D;">${icon} ${title}</p>
              <p style="margin:4px 0 0;font-size:13px;color:#4a5568;">${desc}</p>
            </td></tr><tr><td style="height:8px;"></td></tr>`).join("")}
          </table>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr><td style="background:#1B365D;border-radius:8px;">
              <a href="${resultUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">View Your Full Report →</a>
            </td></tr>
          </table>
          <p style="margin:0 0 16px;font-size:14px;color:#4a5568;line-height:1.6;">Once you've reviewed your report, we'd love to walk you through exactly how ReconcileAI closes each gap in a focused 20-minute demo:</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td style="background:#F47458;border-radius:8px;">
              <a href="https://calendly.com/richard-infinityaiafrica/30min" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">📅 Book a Free 30-Minute Demo →</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#8c757d;">ReconcileAI by Infinity AI Africa Limited · Lagos, Nigeria</p>
          <p style="margin:4px 0 0;font-size:12px;color:#8c757d;">You're receiving this because you completed a compliance assessment at ${PUBLIC_APP_HOST}.</p>
          <p style="margin:8px 0 0;font-size:12px;color:#8c757d;">Ready to book? Pick a time directly: <a href="https://calendly.com/richard-infinityaiafrica/30min" style="color:#F47458;text-decoration:underline;font-weight:600;">calendly.com/richard-infinityaiafrica/30min</a></p>
          <p style="margin:8px 0 0;font-size:11px;color:#b0b0b0;">To opt out of future emails, <a href="${PUBLIC_APP_ORIGIN}/compliance-assessment/unsubscribe/${assessment.token}" style="color:#b0b0b0;text-decoration:underline;">click here to unsubscribe</a>. This is required under Nigeria's NDPR.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

        try {
          // Data residency: legacy Forge email relay is external egress; blocked on-premise.
          assertEgressAllowed(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, "outbound email");
          const emailRes = await fetch(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.BUILT_IN_FORGE_API_KEY}`,
            },
            body: JSON.stringify({
              to: assessment.respondentEmail,
              subject: `${firstName}, see how ReconcileAI closes your compliance gaps — 20-min demo`,
              html: emailHtml,
              text: `Hi ${firstName},\n\nThank you for completing the ReconcileAI CBN Compliance Readiness Assessment.\n\nYour score: ${overallScore}/100 (${riskLevelLabel})\n\nWe'd love to show you how ReconcileAI closes those gaps in a focused 20-minute demo.\n\nBook a demo: https://calendly.com/richard-infinityaiafrica/30min\n\nView your report: ${resultUrl}\n\n— ReconcileAI by Infinity AI Africa Limited`,
            }),
          });
          if (!emailRes.ok) throw new Error(`Email API returned ${emailRes.status}`);
          await drizzle.update(complianceAssessments)
            .set({ demoInviteSent: true })
            .where(eq(complianceAssessments.token, input.token));
          return { success: true };
        } catch (err) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to send demo invite email' });
        }
      }),

    // Admin: list all assessments (protected, admin only)
    listAll: superAdminProcedure
      .input(z.object({
        page: z.number().min(1).default(1),
        pageSize: z.number().min(1).max(100).default(20),
        riskLevel: z.enum(["critical", "high", "medium", "low"]).optional(),
        search: z.string().optional(),
        emailOptedOut: z.boolean().optional(),
        consentOnly: z.boolean().optional(),
        notContacted: z.boolean().optional(),
        hasNotes: z.boolean().optional(),
      }))
      .query(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const offset = (input.page - 1) * input.pageSize;
        const conditions = [];
        if (input.riskLevel) conditions.push(eq(complianceAssessments.riskLevel, input.riskLevel));
        if (input.emailOptedOut !== undefined) conditions.push(eq(complianceAssessments.emailOptedOut, input.emailOptedOut));
        if (input.consentOnly) conditions.push(eq(complianceAssessments.consentToContact, true));
        if (input.notContacted) conditions.push(eq(complianceAssessments.markedContacted, false));
        if (input.hasNotes) conditions.push(and(sql`${complianceAssessments.adminNotes} IS NOT NULL`, sql`${complianceAssessments.adminNotes} != ''`));
        if (input.search) {
          const q = `%${input.search}%`;
          conditions.push(
            or(
              like(complianceAssessments.institutionName, q),
              like(complianceAssessments.respondentName, q),
              like(complianceAssessments.respondentEmail, q),
            )
          );
        }
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
        const rows = await drizzle.select({
          id: complianceAssessments.id,
          token: complianceAssessments.token,
          institutionName: complianceAssessments.institutionName,
          institutionType: complianceAssessments.institutionType,
          respondentName: complianceAssessments.respondentName,
          respondentEmail: complianceAssessments.respondentEmail,
          respondentRole: complianceAssessments.respondentRole,
          overallScore: complianceAssessments.overallScore,
          riskLevel: complianceAssessments.riskLevel,
          categoryScores: complianceAssessments.categoryScores,
          consentToContact: complianceAssessments.consentToContact,
          followUpEmailSent: complianceAssessments.followUpEmailSent,
          demoInviteSent: complianceAssessments.demoInviteSent,
          emailOptedOut: complianceAssessments.emailOptedOut,
          markedContacted: complianceAssessments.markedContacted,
          adminNotes: complianceAssessments.adminNotes,
          lastContactedAt: complianceAssessments.lastContactedAt,
          followUpDueAt: complianceAssessments.followUpDueAt,
          pipelineStage: complianceAssessments.pipelineStage,
          createdAt: complianceAssessments.createdAt,
        }).from(complianceAssessments)
          .where(whereClause)
          .orderBy(desc(complianceAssessments.createdAt))
          .limit(input.pageSize)
          .offset(offset);
        const [{ count }] = await drizzle.select({ count: sql`count(*)` }).from(complianceAssessments).where(whereClause);
        return { rows, total: Number(count), page: input.page, pageSize: input.pageSize };
      }),


    exportCsv: superAdminProcedure
      .input(z.object({
        riskLevel: z.enum(["critical", "high", "medium", "low"]).optional(),
        emailOptedOut: z.boolean().optional(),
        consentOnly: z.boolean().optional(),
        search: z.string().optional(),
      }))
      .query(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const conditions = [];
        if (input.riskLevel) conditions.push(eq(complianceAssessments.riskLevel, input.riskLevel));
        if (input.emailOptedOut !== undefined) conditions.push(eq(complianceAssessments.emailOptedOut, input.emailOptedOut));
        if (input.consentOnly) conditions.push(eq(complianceAssessments.consentToContact, true));
        if (input.search) {
          const q = `%${input.search}%`;
          conditions.push(or(
            like(complianceAssessments.institutionName, q),
            like(complianceAssessments.respondentName, q),
            like(complianceAssessments.respondentEmail, q),
          ));
        }
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
        const rows = await drizzle.select({
          institutionName: complianceAssessments.institutionName,
          institutionType: complianceAssessments.institutionType,
          respondentName: complianceAssessments.respondentName,
          respondentEmail: complianceAssessments.respondentEmail,
          respondentRole: complianceAssessments.respondentRole,
          overallScore: complianceAssessments.overallScore,
          riskLevel: complianceAssessments.riskLevel,
          consentToContact: complianceAssessments.consentToContact,
          followUpEmailSent: complianceAssessments.followUpEmailSent,
          demoInviteSent: complianceAssessments.demoInviteSent,
          emailOptedOut: complianceAssessments.emailOptedOut,
          createdAt: complianceAssessments.createdAt,
          token: complianceAssessments.token,
        }).from(complianceAssessments)
          .where(whereClause)
          .orderBy(desc(complianceAssessments.createdAt))
          .limit(5000);
        // Build CSV
        const headers = ["Institution Name","Institution Type","Respondent Name","Respondent Email","Respondent Role","Overall Score","Risk Level","Consent to Contact","Follow-up Email Sent","Demo Invite Sent","Email Opted Out","Submitted Date","Report URL"];
        const INST_TYPE_LABELS: Record<string, string> = {
          commercial_bank: "Commercial Bank", microfinance_bank: "Microfinance Bank",
          fintech: "Fintech", payment_processor: "Payment Processor",
          corporate_b2b: "Corporate B2B", other: "Other",
        };
        const escape = (v: unknown) => {
          const s = v == null ? "" : String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csvRows = rows.map(r => [
          escape(r.institutionName ?? "Anonymous"),
          escape(INST_TYPE_LABELS[r.institutionType ?? ""] ?? r.institutionType ?? ""),
          escape(r.respondentName ?? ""),
          escape(r.respondentEmail ?? ""),
          escape(r.respondentRole ?? ""),
          escape(r.overallScore ?? ""),
          escape(r.riskLevel ?? ""),
          escape(r.consentToContact ? "Yes" : "No"),
          escape(r.followUpEmailSent ? "Yes" : "No"),
          escape(r.demoInviteSent ? "Yes" : "No"),
          escape(r.emailOptedOut ? "Yes" : "No"),
          escape(r.createdAt ? new Date(r.createdAt).toISOString().split("T")[0] : ""),
          escape(r.token ? `${PUBLIC_APP_ORIGIN}/compliance-assessment/result/${r.token}` : ""),
        ].join(","));
        const csv = [headers.join(","), ...csvRows].join("\n");
        return { csv, count: rows.length };
      }),
    // Admin: bulk send demo invites to all consented + not yet invited respondents
    bulkSendDemoInvites: superAdminProcedure
      .mutation(async ({ ctx }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        // Fetch all eligible: consented, has email, not yet invited, not opted out
        const eligible = await drizzle.select({
          token: complianceAssessments.token,
          respondentName: complianceAssessments.respondentName,
          respondentEmail: complianceAssessments.respondentEmail,
          overallScore: complianceAssessments.overallScore,
          riskLevel: complianceAssessments.riskLevel,
          institutionName: complianceAssessments.institutionName,
        }).from(complianceAssessments)
          .where(and(
            eq(complianceAssessments.consentToContact, true),
            eq(complianceAssessments.demoInviteSent, false),
            eq(complianceAssessments.emailOptedOut, false),
            sql`${complianceAssessments.respondentEmail} IS NOT NULL`,
          ))
          .orderBy(desc(complianceAssessments.createdAt))
          .limit(500);
        if (eligible.length === 0) return { sent: 0, failed: 0 };
        let sent = 0;
        let failed = 0;
        for (const assessment of eligible) {
          const resultUrl = `${PUBLIC_APP_ORIGIN}/compliance-assessment/result/${assessment.token}`;
          const firstName = assessment.respondentName?.split(" ")[0] ?? "there";
          const riskLevelLabel = assessment.riskLevel === "critical" ? "Critical Risk" : assessment.riskLevel === "high" ? "High Risk" : assessment.riskLevel === "medium" ? "Medium Risk" : "Low Risk";
          const overallScore = assessment.overallScore;
          const institutionName = assessment.institutionName ?? "your institution";
          const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;"><tr><td style="background:#1B365D;padding:28px 32px;"><p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">ReconcileAI</p><p style="margin:4px 0 0;color:#a0aec0;font-size:13px;">AI-Powered Financial Reconciliation for African Banks &amp; Fintechs</p></td></tr><tr><td style="padding:32px;"><p style="margin:0 0 16px;font-size:16px;color:#1B365D;font-weight:600;">Hi ${firstName},</p><p style="margin:0 0 16px;font-size:14px;color:#4a5568;line-height:1.6;">Thank you for completing the ReconcileAI CBN Compliance Readiness Assessment. Your score of <strong>${overallScore}/100 (${riskLevelLabel})</strong> tells us a lot about where ${institutionName} stands today.</p><p style="margin:0 0 24px;font-size:14px;color:#4a5568;line-height:1.6;">We'd love to show you exactly how ReconcileAI closes those gaps in a focused 30-minute demo.</p><table cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr><td style="background:#1B365D;border-radius:8px;"><a href="${resultUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">View Your Full Report →</a></td></tr></table><table cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr><td style="background:#F47458;border-radius:8px;"><a href="https://calendly.com/richard-infinityaiafrica/30min" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">📅 Book a Free 30-Minute Demo →</a></td></tr></table></td></tr><tr><td style="padding:20px 32px;border-top:1px solid #f0f0f0;"><p style="margin:0;font-size:12px;color:#8c757d;">ReconcileAI by Infinity AI Africa Limited · Lagos, Nigeria</p><p style="margin:8px 0 0;font-size:12px;color:#8c757d;">Ready to book? Pick a time directly: <a href="https://calendly.com/richard-infinityaiafrica/30min" style="color:#F47458;text-decoration:underline;font-weight:600;">calendly.com/richard-infinityaiafrica/30min</a></p><p style="margin:8px 0 0;font-size:11px;color:#b0b0b0;">To opt out of future emails, <a href="${PUBLIC_APP_ORIGIN}/compliance-assessment/unsubscribe/${assessment.token}" style="color:#b0b0b0;text-decoration:underline;">click here to unsubscribe</a>. This is required under Nigeria's NDPR.</p></td></tr></table></td></tr></table></body></html>`;
          try {
            // Data residency: legacy Forge email relay is external egress; blocked on-premise.
            assertEgressAllowed(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, "outbound email");
            const emailRes = await fetch(`${process.env.BUILT_IN_FORGE_API_URL}/email/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.BUILT_IN_FORGE_API_KEY}` },
              body: JSON.stringify({
                to: assessment.respondentEmail,
                subject: `${firstName}, see how ReconcileAI closes your compliance gaps — 20-min demo`,
                html: emailHtml,
                text: `Hi ${firstName},\n\nThank you for completing the ReconcileAI CBN Compliance Readiness Assessment.\n\nYour score: ${overallScore}/100 (${riskLevelLabel})\n\nBook a demo: https://calendly.com/richard-infinityaiafrica/30min\nView your report: ${resultUrl}\n\n— ReconcileAI by Infinity AI Africa Limited`,
              }),
            });
            if (!emailRes.ok) throw new Error(`Email API returned ${emailRes.status}`);
            await drizzle.update(complianceAssessments).set({ demoInviteSent: true }).where(eq(complianceAssessments.token, assessment.token));
            sent++;
          } catch {
            failed++;
          }
        }
        return { sent, failed };
      }),

    // Admin: toggle markedContacted flag on a single assessment
    markContacted: superAdminProcedure
      .input(z.object({ token: z.string().length(48), contacted: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const now = new Date();
        await drizzle.update(complianceAssessments)
          .set({
            markedContacted: input.contacted,
            lastContactedAt: input.contacted ? now : null,
          })
          .where(eq(complianceAssessments.token, input.token));
        return { success: true, contacted: input.contacted, lastContactedAt: input.contacted ? now : null };
      }),

    // Admin: update free-text notes/memo for a single assessment
    updateNotes: superAdminProcedure
      .input(z.object({ token: z.string().length(48), notes: z.string().max(2000) }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        await drizzle.update(complianceAssessments)
          .set({ adminNotes: input.notes || null })
          .where(eq(complianceAssessments.token, input.token));
        return { success: true };
      }),

    // Admin: set or clear the follow-up due date for a single assessment
    setFollowUpDue: superAdminProcedure
      .input(z.object({ token: z.string().length(48), dueAt: z.date().nullable() }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        await drizzle.update(complianceAssessments)
          .set({ followUpDueAt: input.dueAt })
          .where(eq(complianceAssessments.token, input.token));
        return { success: true, dueAt: input.dueAt };
      }),

    // Admin: update the pipeline stage for a single assessment
    setPipelineStage: superAdminProcedure
      .input(z.object({
        token: z.string().length(48),
        stage: z.enum(["new", "contacted", "demo_booked", "proposal_sent", "closed_won", "closed_lost"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        await drizzle.update(complianceAssessments)
          .set({ pipelineStage: input.stage })
          .where(eq(complianceAssessments.token, input.token));
        return { success: true, stage: input.stage };
      }),

    // Admin: count eligible for bulk demo invite (consented, has email, not yet invited, not opted out)
    countBulkEligible: superAdminProcedure
      .query(async ({ ctx }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const [{ count }] = await drizzle.select({ count: sql`count(*)` })
          .from(complianceAssessments)
          .where(and(
            eq(complianceAssessments.consentToContact, true),
            eq(complianceAssessments.demoInviteSent, false),
            eq(complianceAssessments.emailOptedOut, false),
            sql`${complianceAssessments.respondentEmail} IS NOT NULL`,
          ));
        return { count: Number(count) };
      }),

    unsubscribe: publicProcedure
      .input(z.object({ token: z.string().length(48) }))
      .mutation(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database unavailable' });
        const { complianceAssessments } = await import("../drizzle/schema");
        const rows = await drizzle.select({ id: complianceAssessments.id, emailOptedOut: complianceAssessments.emailOptedOut })
          .from(complianceAssessments)
          .where(eq(complianceAssessments.token, input.token))
          .limit(1);
        if (!rows.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assessment not found' });
        await drizzle.update(complianceAssessments)
          .set({ emailOptedOut: true })
          .where(eq(complianceAssessments.token, input.token));
        return { success: true, message: 'You have been unsubscribed from all ReconcileAI assessment emails.' };
      }),
  }),
  cbnCompliance: cbnComplianceRouter,
  poc: pocRouter,
  pocKpi: pocKpiRouter,
  mobileMoney: mobileMoneyRouter,
  erpExport: erpExportRouter,
  woodcoreConnector: woodcoreConnectorRouter,
  // Same router, CBS-neutral name — the connector engine now serves WoodCore,
  // T24, Mambu, FLEXCUBE and LAPO. Prefer `cbsConnector` in new client code.
  cbsConnector: woodcoreConnectorRouter,
  shoplineConnector: shoplineConnectorRouter,
  bucketIngestion: bucketIngestionRouter,
  emailIngestion: emailIngestionRouter,
  // LAPO MFB multi-source channel integration (ETL, completeness, taxonomy)
  lapo: lapoRouter,
  uganda: ugandaRouter,
  roadmap: router({
    // Public: submit an access request
    requestAccess: publicProcedure
      .input(z.object({
        name: z.string().min(1),
        email: z.string().email(),
        company: z.string().optional(),
        reason: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });
        const { roadmapAccessRequests } = await import('../drizzle/schema');
        // Check for duplicate pending/approved request
        const existing = await drizzle.select().from(roadmapAccessRequests)
          .where(eq(roadmapAccessRequests.email, input.email.toLowerCase().trim()))
          .limit(1);
        if (existing.length > 0 && existing[0].status === 'approved') {
          return { status: 'already_approved', token: existing[0].accessToken };
        }
        if (existing.length > 0 && existing[0].status === 'pending') {
          return { status: 'already_pending' };
        }
        await drizzle.insert(roadmapAccessRequests).values({
          name: input.name.trim(),
          email: input.email.toLowerCase().trim(),
          company: input.company?.trim() || null,
          reason: input.reason?.trim() || null,
          status: 'pending',
        });
        // Notify owner
        const { notifyOwner } = await import('./_core/notification');
        await notifyOwner({
          title: `New Roadmap Access Request — ${input.name}`,
          content: `**${input.name}** (${input.email}) from **${input.company || 'unknown company'}** has requested access to the ReconcileAI GTM Roadmap.\n\nReason: ${input.reason || 'Not provided'}\n\nApprove or reject at ${PUBLIC_APP_HOST}/admin/roadmap-access`,
        }).catch(() => undefined);
        return { status: 'pending' };
      }),

    // Public: verify an access token and return the roadmap URL
    verifyToken: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });
        const { roadmapAccessRequests } = await import('../drizzle/schema');
        const rows = await drizzle.select().from(roadmapAccessRequests)
          .where(eq(roadmapAccessRequests.accessToken, input.token))
          .limit(1);
        if (!rows.length || rows[0].status !== 'approved') {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or expired access token' });
        }
        const req = rows[0];
        if (req.tokenExpiresAt && req.tokenExpiresAt < new Date()) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Access token has expired' });
        }
        return { valid: true, name: req.name, roadmapKey: 'roadmap_92b329c1.html' };
      }),

    // Super Admin (Infinity AI staff): list all GTM roadmap access requests.
    // This is a global, platform-internal table — org admins must not see it.
    listRequests: superAdminProcedure
      .input(z.object({ status: z.enum(['pending','approved','rejected','all']).default('all') }))
      .query(async ({ input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });
        const { roadmapAccessRequests } = await import('../drizzle/schema');
        const { desc } = await import('drizzle-orm');
        let query = drizzle.select().from(roadmapAccessRequests).orderBy(desc(roadmapAccessRequests.createdAt));
        if (input.status !== 'all') {
          return (await query).filter(r => r.status === input.status);
        }
        return query;
      }),

    // Super Admin (Infinity AI staff): approve or reject a request.
    updateStatus: superAdminProcedure
      .input(z.object({
        id: z.number(),
        action: z.enum(['approve','reject']),
        expiryDays: z.number().int().positive().default(30),
      }))
      .mutation(async ({ ctx, input }) => {
        const drizzle = await getDb();
        if (!drizzle) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });
        const { roadmapAccessRequests } = await import('../drizzle/schema');
        const { randomBytes } = await import('crypto');
        const rows = await drizzle.select().from(roadmapAccessRequests)
          .where(eq(roadmapAccessRequests.id, input.id)).limit(1);
        if (!rows.length) throw new TRPCError({ code: 'NOT_FOUND' });
        const req = rows[0];
        if (input.action === 'approve') {
          const token = randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000);
          await drizzle.update(roadmapAccessRequests)
            .set({ status: 'approved', accessToken: token, tokenExpiresAt: expiresAt, approvedAt: new Date(), approvedByUserId: ctx.user.id })
            .where(eq(roadmapAccessRequests.id, input.id));
          // Notify the requester via owner notification (owner can then email them)
          const origin = (ENV.appUrl || "https://www.reconcileaiafrica.com").replace(/\/$/, "");
          const { notifyOwner } = await import('./_core/notification');
          await notifyOwner({
            title: `Roadmap Access Approved — ${req.name}`,
            content: `Send this link to **${req.name}** (${req.email}):\n\n${origin}/roadmap?token=${token}\n\nExpires: ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
          }).catch(() => undefined);
          return { status: 'approved', token, expiresAt };
        } else {
          await drizzle.update(roadmapAccessRequests)
            .set({ status: 'rejected' })
            .where(eq(roadmapAccessRequests.id, input.id));
          return { status: 'rejected' };
        }
      }),
  }),

  // ─── Exception Intelligence Layer ──────────────────────────────────
  exceptionIntelligence: router({
    // Per-org settings + transparency: what is shared and the current posture.
    getSettings: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const ei = await import("./exceptionIntelligence");
      const settings = await ei.getSettings(orgId);
      return {
        shareEnabled: settings?.shareEnabled ?? false,
        consumeEnabled: settings?.consumeEnabled ?? false,
        lastSharedAt: settings?.lastSharedAt ?? null,
        lastConsumedAt: settings?.lastConsumedAt ?? null,
        kAnonymityThreshold: ei.K_ANON_THRESHOLD,
        sharedFields: ei.ALLOWED_SIGNATURE_KEYS,
        endpointConfigured: !!process.env.EXCEPTION_INTEL_ENDPOINT,
      };
    }),

    updateSettings: adminProcedure
      .input(z.object({ shareEnabled: z.boolean().optional(), consumeEnabled: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        const orgId = ctx.user.organizationId ?? 0;
        const ei = await import("./exceptionIntelligence");
        const updated = await ei.updateSettings(orgId, input);
        await logAudit(ctx.user.id, "exception_intelligence_settings_updated", "exception_intelligence", orgId, input);
        return { shareEnabled: updated?.shareEnabled ?? false, consumeEnabled: updated?.consumeEnabled ?? false };
      }),

    // Local contribution stats (what this org has observed).
    status: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const drizzle = await getDb();
      if (!drizzle) return { localSignatures: 0, localObservations: 0, sharedPatternsAvailable: 0 };
      const { exceptionPatternSignatures: eps, sharedExceptionPatterns: sep } = await import("../drizzle/schema");
      const ei = await import("./exceptionIntelligence");
      const [local] = await drizzle
        .select({ sigs: sql<number>`count(*)`, obs: sql<number>`coalesce(sum(${eps.observationCount}),0)` })
        .from(eps)
        .where(eq(eps.organizationId, orgId));
      const [shared] = await drizzle
        .select({ n: sql<number>`count(*)` })
        .from(sep)
        .where(sql`${sep.contributorCount} >= ${ei.K_ANON_THRESHOLD}`);
      return {
        localSignatures: Number(local?.sigs || 0),
        localObservations: Number(local?.obs || 0),
        sharedPatternsAvailable: Number(shared?.n || 0),
      };
    }),

    // Admin: rebuild the shared pool aggregate (cloud) and/or push to the pool (on-prem).
    sync: adminProcedure.mutation(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const ei = await import("./exceptionIntelligence");
      const aggregated = await ei.aggregateSharedPatterns();
      const pushed = await ei.syncToPool(orgId);
      await logAudit(ctx.user.id, "exception_intelligence_sync", "exception_intelligence", orgId, { aggregated, pushed });
      return { aggregatedPatterns: aggregated.patterns, pushed };
    }),

    // Internal KPI (gap-closure plan WS-5): cross-tenant view of the
    // intelligence network — contributing orgs, pool depth, k-anonymity
    // coverage, and the "% of recommendations informed by cross-institution
    // patterns" rate. Aggregates only; restricted to Infinity AI staff.
    networkStats: superAdminProcedure.query(async () => {
      const ei = await import("./exceptionIntelligence");
      return ei.getNetworkStats();
    }),

    // ── Regulator engagement asset (CBN strategy) ────────────────────────────
    // Packages the k-anonymous industry exception-pattern pool into a signed,
    // regulator-consumable dataset — the concrete artifact behind the CBN
    // engagement play: contributing anonymised, consented industry data the CBN
    // can use to improve its reconciliation compliance guidance. Contains ONLY
    // the categorical pattern tuples already cleared for sharing (k ≥ threshold,
    // PII-scrubbed by construction); the Ed25519 signature gives the recipient
    // provenance + integrity. Infinity AI staff only.
    regulatorReport: superAdminProcedure.mutation(async ({ ctx }) => {
      const drizzle = await getDb();
      if (!drizzle) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { sharedExceptionPatterns: sep, exceptionIntelligenceSettings: eis } = await import("../drizzle/schema");
      const ei = await import("./exceptionIntelligence");
      const { signReport } = await import("./signing");

      const patterns = await drizzle
        .select({
          exceptionCategory: sep.exceptionCategory,
          amountBucket: sep.amountBucket,
          counterpartyType: sep.counterpartyType,
          deductionType: sep.deductionType,
          resolutionActionClass: sep.resolutionActionClass,
          outcome: sep.outcome,
          contributorCount: sep.contributorCount,
          observationCount: sep.observationCount,
        })
        .from(sep)
        .where(sql`${sep.contributorCount} >= ${ei.K_ANON_THRESHOLD}`)
        .orderBy(desc(sep.observationCount));

      const [participation] = await drizzle
        .select({ n: sql<number>`count(*)` })
        .from(eis)
        .where(eq(eis.shareEnabled, true));

      const methodology = {
        title: "ReconcileAI Industry Exception Pattern Report",
        preparedFor: "Central Bank of Nigeria — Payments Policy Department",
        generatedAt: new Date().toISOString(),
        contributingInstitutions: Number(participation?.n || 0),
        kAnonymityThreshold: ei.K_ANON_THRESHOLD,
        patternCount: patterns.length,
        fieldsShared: ei.ALLOWED_SIGNATURE_KEYS,
        privacyStatement:
          "Each row is a coarse categorical pattern (exception category, amount bucket, counterparty type, " +
          "deduction type, resolution action class, outcome) independently observed by at least " +
          `${ei.K_ANON_THRESHOLD} consenting institutions (k-anonymity). No transaction data, amounts, ` +
          "references, account numbers, names, or free text are included; every value passes a runtime " +
          "PII-scrub allowlist before leaving a contributing deployment. Institutions opt in explicitly " +
          "and are identified only by stable pseudonyms that never leave the pool.",
      };

      const sig = signReport({ methodology, patterns });
      await logAudit(ctx.user.id, "regulator_report_generated", "exception_intelligence", undefined, {
        patternCount: patterns.length,
        contributingInstitutions: methodology.contributingInstitutions,
      });

      return {
        methodology,
        patterns,
        signature: {
          contentHash: sig.contentHash,
          signature: sig.signature,
          signingKeyFingerprint: sig.signingKeyFingerprint,
          signedAt: sig.signedAt.toISOString(),
          algorithm: "Ed25519",
        },
      };
    }),

    // Per-institution learning flywheel stats: patterns captured by this org over time.
    // Powers the "value grows with every job" narrative in the UI.
    flywheelStats: protectedProcedure.query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId ?? 0;
      const drizzle = await getDb();
      if (!drizzle) return { totalPatterns: 0, categoryCoverage: [] as { category: string; count: number }[], monthlyGrowth: [] as { month: string; count: number }[] };

      const [totalRow] = await drizzle
        .select({ count: sql<number>`count(*)` })
        .from(agentMemory)
        .where(eq(agentMemory.organizationId, orgId));

      const categoryRows = await drizzle
        .select({ category: agentMemory.exceptionCategory, count: sql<number>`count(*)` })
        .from(agentMemory)
        .where(eq(agentMemory.organizationId, orgId))
        .groupBy(agentMemory.exceptionCategory)
        .orderBy(desc(sql<number>`count(*)`));

      const memoryTimestampRows = await drizzle
        .select({ createdAt: agentMemory.createdAt })
        .from(agentMemory)
        .where(and(
          eq(agentMemory.organizationId, orgId),
          gte(agentMemory.createdAt, sixMonthsAgoUtc()),
        ))
        .orderBy(asc(agentMemory.createdAt));

      return {
        totalPatterns: Number(totalRow?.count || 0),
        categoryCoverage: categoryRows.map(r => ({ category: r.category, count: Number(r.count) })),
        monthlyGrowth: groupMemoryGrowthByMonth(memoryTimestampRows),
      };
    }),
  }),

  // ─── CFO Report Schedule + Alerts ──────────────────────────────────
  cfoReports: router({
    // Get current schedule settings
    getSchedule: protectedProcedure.query(async ({ ctx }) => {
      const schedule = await db.getCfoReportSchedule(ctx.user.id);
      return schedule;
    }),

    // Upsert schedule (recipients, period, cron)
    saveSchedule: protectedProcedure
      .input(z.object({
        recipients: z.array(z.string().email()).min(1).max(20),
        reportPeriod: z.enum(["7d", "30d", "mtd", "quarterly", "last_quarter"]).default("7d"),
        isActive: z.boolean().default(true),
      }))
      .mutation(async ({ ctx, input }) => {
        const schedule = await db.upsertCfoReportSchedule(ctx.user.id, {
          recipients: input.recipients,
          reportPeriod: input.reportPeriod,
          isActive: input.isActive,
        });
        return schedule;
      }),

    // Send report now (manual trigger)
    sendNow: protectedProcedure
      .input(z.object({ period: z.enum(["7d", "30d", "mtd", "quarterly", "last_quarter"]).default("7d") }))
      .mutation(async ({ ctx, input }) => {
        const { sendWeeklyChannelReport } = await import("./cfoReportService");
        return sendWeeklyChannelReport(ctx.user.id, input.period);
      }),

    // Export CSV (returns CSV string)
    exportCsv: protectedProcedure
      .input(z.object({
        period: z.enum(["7d", "30d", "mtd", "all", "quarterly", "last_quarter"]).default("7d"),
        channelCodes: z.array(z.string()).optional(),
      }))
      .query(async ({ ctx, input }) => {
        const { buildChannelMetrics, buildCsvContent } = await import("./cfoReportService");
        const rows = await buildChannelMetrics(ctx.user.organizationId ?? null, input.period, input.channelCodes);
        const csv = buildCsvContent(rows, input.period);
        return { csv, rowCount: rows.length };
      }),

    // Export XLSX (returns S3 URL)
    exportXlsx: protectedProcedure
      .input(z.object({
        period: z.enum(["7d", "30d", "mtd", "all", "quarterly", "last_quarter"]).default("7d"),
        channelCodes: z.array(z.string()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { ip, ua } = getClientInfo(ctx);
        const { buildChannelMetrics } = await import("./cfoReportService");
        const rows = await buildChannelMetrics(ctx.user.organizationId ?? null, input.period, input.channelCodes);

        const ExcelJS = await loadExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "ReconcileAI";
        workbook.created = new Date();

        const headerStyle = {
          font: { bold: true, color: { argb: "FFFFFFFF" } },
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1B365D" } },
          alignment: { horizontal: "left" as const },
        };
        const altRow = {
          fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF8F9FA" } },
        };
        const periodLabels: Record<string, string> = {
          "7d": "Last 7 Days", "30d": "Last 30 Days", "mtd": "Month to Date", "all": "All Time",
        };

        // Channel Metrics sheet
        const ws = workbook.addWorksheet("Channel Metrics");
        ws.columns = [
          { header: "Channel", key: "channel", width: 28 },
          { header: "Channel Code", key: "channelCode", width: 18 },
          { header: "Total Volume", key: "volume", width: 16 },
          { header: "Matched", key: "matched", width: 14 },
          { header: "Exceptions", key: "exceptions", width: 14 },
          { header: "Match Rate (%)", key: "matchRate", width: 16 },
        ];
        ws.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        ws.getRow(1).height = 20;
        // Number formatting for CFO channel metrics
        ws.getColumn("volume").numFmt = "#,##0";
        ws.getColumn("matched").numFmt = "#,##0";
        ws.getColumn("exceptions").numFmt = "#,##0";
        ws.getColumn("matchRate").numFmt = "0.00";
        rows.forEach((row, i) => {
          const r = ws.addRow({
            channel: row.channel,
            channelCode: row.channelCode,
            volume: row.volume,
            matched: row.matched,
            exceptions: row.exceptions,
            matchRate: row.matchRate,
          });
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });
        (ws as any).autoFilter = ws.dimensions;
        ws.views = [{ state: "frozen", ySplit: 1 }];

        // Summary sheet
        const summaryWs = workbook.addWorksheet("Summary");
        summaryWs.columns = [
          { header: "Field", key: "field", width: 28 },
          { header: "Value", key: "value", width: 32 },
        ];
        summaryWs.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
        summaryWs.getRow(1).height = 20;
        const totalVolume = rows.reduce((s, r) => s + r.volume, 0);
        const totalMatched = rows.reduce((s, r) => s + r.matched, 0);
        const totalExceptions = rows.reduce((s, r) => s + r.exceptions, 0);
        const avgMatchRate = rows.length > 0 ? (rows.reduce((s, r) => s + r.matchRate, 0) / rows.length).toFixed(1) : "0.0";
        [
          { field: "Report Period", value: periodLabels[input.period] ?? input.period },
          { field: "Channels Included", value: rows.length },
          { field: "Total Transaction Volume", value: totalVolume },
          { field: "Total Matched", value: totalMatched },
          { field: "Total Exceptions", value: totalExceptions },
          { field: "Average Match Rate (%)", value: avgMatchRate },
          { field: "Exported At", value: new Date().toISOString() },
          { field: "Exported By", value: ctx.user.email ?? ctx.user.name ?? "" },
        ].forEach((row, i) => {
          const r = summaryWs.addRow(row);
          if (i % 2 === 1) r.eachCell((cell) => { cell.style = altRow; });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `cfo-channel-metrics-${input.period}-${Date.now()}.xlsx`;
        const { url } = await storagePut(
          `exports/${ctx.user.id}/${fileName}`,
          Buffer.from(buffer),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        await logAudit(ctx.user.id, "export_cfo_report_xlsx", "cfo_report", undefined, {
          period: input.period, rowCount: rows.length,
        }, ip, ua);
        return { url, fileName };
      }),

    // Get channel alert settings
    getAlertSettings: protectedProcedure.query(async ({ ctx }) => {
      return db.getChannelAlertSettings(ctx.user.id);
    }),

    // Upsert a single channel alert threshold
    saveAlertSetting: protectedProcedure
      .input(z.object({
        channelCode: z.string(),
        threshold: z.number().min(0).max(100),
        alertEnabled: z.boolean().default(true),
      }))
      .mutation(async ({ ctx, input }) => {
        await db.upsertChannelAlertSetting(ctx.user.id, input.channelCode, {
          threshold: input.threshold,
          alertEnabled: input.alertEnabled,
        });
        return { ok: true };
      }),

    // Run threshold breach check now
    checkBreaches: protectedProcedure.mutation(async ({ ctx }) => {
      const { checkChannelThresholdBreaches } = await import("./cfoReportService");
      return checkChannelThresholdBreaches(ctx.user.id);
    }),

    // Channel 30-day drill-down
    channelDrillDown: protectedProcedure
      .input(z.object({ channelCode: z.string() }))
      .query(async ({ ctx, input }) => {
        const { getChannelDrillDown } = await import("./cfoReportService");
        return getChannelDrillDown(ctx.user.organizationId ?? null, input.channelCode);
      }),
  }),
});
export type AppRouter = typeof appRouter;

// ─── Background Reconciliation Runner ────────────────────────────────

/**
 * Deferred AI analysis pass — runs OUT of the reconciliation hot path.
 * Re-queries the job's high/critical exceptions whose aiAnalysis is still null,
 * generates a Claude narrative for each, and persists it. Restartable: safe to
 * re-run since it only touches exceptions that still lack analysis.
 */
async function runDeferredAiAnalysis(jobId: number): Promise<void> {
  const pending = await db.getJobExceptionsNeedingAi(jobId);
  if (pending.length === 0) return;

  const txnIds = pending
    .map((e) => e.transactionId)
    .filter((id): id is number => id != null);
  // Unscoped by design: these ids come from this job's OWN exceptions, derived
  // server-side moments ago — never from request input. See the function's
  // comment for why an org predicate here would risk dropping rows.
  const txns = await db.getTransactionsByIdsUnscoped(txnIds);
  const txnById = new Map(txns.map((t) => [t.id, t]));

  // Cross-institution intelligence read-path (gap-closure plan WS-5): fold
  // anonymised, k-anonymous network patterns into each diagnosis. Gated by the
  // org's reciprocal opt-in inside getSharedRecommendations, which also records
  // the consume request/hit that powers the "recommendations informed by
  // cross-institution patterns %" metric. Cached per category per job.
  const job = await db.getReconciliationJob(jobId);
  const orgId = job?.organizationId ?? null;
  const ei = orgId != null ? await import("./exceptionIntelligence") : null;
  const learning = orgId != null ? await import("./institutionalLearning") : null;
  const networkGuidanceByCategory = new Map<string, string>();
  async function networkGuidanceFor(category: string): Promise<string> {
    if (orgId == null || !ei || !learning) return "";
    const cached = networkGuidanceByCategory.get(category);
    if (cached !== undefined) return cached;
    let guidance = "";
    try {
      const recs = await ei.getSharedRecommendations(orgId, category);
      guidance = learning.formatNetworkGuidance(recs);
    } catch (err) {
      console.error(`[AI pass] network lookup for "${category}" failed (non-fatal):`, err);
    }
    networkGuidanceByCategory.set(category, guidance);
    return guidance;
  }

  for (const exc of pending) {
    const txn = exc.transactionId != null ? txnById.get(exc.transactionId) : undefined;
    if (!txn) continue;
    try {
      const networkGuidance = await networkGuidanceFor(exc.category);
      const analysis = await getAIAnalysis(
        { category: exc.category, description: exc.description ?? "" },
        txn as any,
        networkGuidance ? { networkGuidance } : undefined
      );
      // Background pass — no request context. The tenant is the job's own.
      await db.updateException(exc.id, orgId, { aiAnalysis: analysis });
    } catch (err) {
      console.error(`[AI pass] exception ${exc.id} failed:`, err);
    }
  }
}

async function runReconciliation(
  jobId: number,
  sourceChannelId: number,
  targetChannelId: number,
  dateFrom: Date,
  dateTo: Date,
  config: { amountTolerance: number; dateWindowDays: number },
  userId: number
) {
  const startTime = Date.now();
  try {
    await db.updateReconciliationJob(jobId, { status: "running", startedAt: new Date() });
    await trackProgress(jobId, "queued", { message: "Job queued for processing" });

    // The owning tenant for every match and exception this run produces. Read
    // once from the job rather than threaded through the signature, so the
    // rows can never disagree with their parent. Null for legacy/orgless jobs.
    const runOrganizationId = (await db.getReconciliationJob(jobId))?.organizationId ?? null;

    await trackProgress(jobId, "loading_data", { message: "Loading transaction data from channels" });
    const sourceTxns = await db.getTransactionsForReconciliation(sourceChannelId, dateFrom, dateTo);
    const targetTxns = await db.getTransactionsForReconciliation(targetChannelId, dateFrom, dateTo);

    await db.updateReconciliationJob(jobId, {
      totalSourceTxns: sourceTxns.length,
      totalTargetTxns: targetTxns.length,
    });

    await trackProgress(jobId, "pass1_exact_match", {
      message: `Processing ${sourceTxns.length} source and ${targetTxns.length} target transactions`,
      totalCount: sourceTxns.length + targetTxns.length,
    });
    // excludeFeeNoise: set aside general bank fees/charges/levies so they don't
    // skew matching or inflate exceptions. Card-settlement fees (interchange,
    // scheme, MDR…) are guarded in the engine and stay in the reconciliation.
    const result = runMatchingEngine(sourceTxns, targetTxns, { ...config, excludeFeeNoise: true });
    if (result.excluded.length > 0) {
      await db.updateReconciliationJob(jobId, {
        excludedCount: result.excluded.length,
        excludedItems: result.excluded,
      });
    }
    await trackProgress(jobId, "pass3_tolerance_match", {
      message: `Matching complete: ${result.matches.length} matches found`,
      processedCount: result.matches.length,
      totalCount: sourceTxns.length,
    });

    // ── Persist matches (batched) ─────────────────────────────────────
    await trackProgress(jobId, "duplicate_detection", {
      message: `Recording ${result.matches.length} matches and ${result.duplicates.length} duplicate groups`,
    });

    // High-confidence (>=85) matches auto-confirm; the rest go to manual review. Note:
    // transactions.matchId (a denormalized, unread column) is no longer populated here —
    // the `matches` table is the source of truth for source/target linkage. That lets us
    // set transaction statuses with two bulk IN(...) updates instead of ~3 round-trips
    // per match (the old per-row path was O(n) DB calls and unusable at 500k).
    const matchRows = result.matches.map((m) => ({
      jobId,
      organizationId: runOrganizationId,
      sourceTransactionId: m.sourceId,
      targetTransactionId: m.targetId,
      matchType: m.matchType,
      confidenceScore: String(m.confidenceScore),
      amountDifference: String(m.amountDifference),
      dateDifference: Math.round(m.dateDifference),
      matchReason: m.matchReason,
      status: m.confidenceScore >= 85 ? ("confirmed" as const) : ("pending_review" as const),
    }));
    await db.insertMatchesBatch(matchRows);

    const confirmedTxnIds: number[] = [];
    const reviewTxnIds: number[] = [];
    let matchedCount = 0;
    for (const m of result.matches) {
      if (m.confidenceScore >= 85) {
        confirmedTxnIds.push(m.sourceId, m.targetId);
        matchedCount++;
      } else {
        reviewTxnIds.push(m.sourceId, m.targetId);
      }
    }
    await db.updateTransactionStatusBulk(confirmedTxnIds, "matched");
    await db.updateTransactionStatusBulk(reviewTxnIds, "exception");

    // ── Persist exceptions (batched) ──────────────────────────────────
    await trackProgress(jobId, "exception_categorization", {
      message: `Categorizing ${result.unmatchedSource.length + result.unmatchedTarget.length} unmatched transactions`,
      totalCount: result.unmatchedSource.length + result.unmatchedTarget.length,
    });
    let exceptionCount = 0;
    const allUnmatched = [...result.unmatchedSource, ...result.unmatchedTarget];
    // Unscoped by design: these ids are the matching engine's own output over
    // transactions loaded from this job's channels. Scoping to the job's org
    // could drop rows whose organizationId is NULL (legacy), and every dropped
    // row is an exception that never gets persisted.
    const unmatchedTxns = await db.getTransactionsByIdsUnscoped(allUnmatched);

    // AI narrative is deferred to a background pass (runDeferredAiAnalysis) that runs
    // AFTER the job completes — keeps LLM latency out of the hot path.
    const exceptionRows = unmatchedTxns.map((txn) => {
      const info = categorizeException(txn, targetTxns, config);
      return {
        jobId,
        organizationId: runOrganizationId,
        transactionId: txn.id,
        category: info.category,
        severity: info.severity,
        currency: txn.currency, // WS-6: exception carries its own currency
        description: info.description,
        suggestedResolution: info.suggestedResolution,
        aiAnalysis: null,
        status: "open" as const,
      };
    });
    await db.insertExceptionsBatch(exceptionRows);
    await db.updateTransactionStatusBulk(unmatchedTxns.map((t) => t.id), "exception");
    exceptionCount += exceptionRows.length;

    // Exceptions for detected duplicates (batched).
    const txnCurrencyById = new Map(unmatchedTxns.map((t) => [t.id, t.currency]));
    for (const t of [...sourceTxns, ...targetTxns]) {
      if (!txnCurrencyById.has(t.id)) txnCurrencyById.set(t.id, t.currency);
    }
    const duplicateRows = result.duplicates.flatMap((dupGroup) =>
      dupGroup.transactionIds.map((txnId) => ({
        jobId,
        organizationId: runOrganizationId,
        transactionId: txnId,
        category: "duplicate_transaction" as const,
        severity: "medium" as const,
        currency: txnCurrencyById.get(txnId) ?? "NGN",
        description: dupGroup.reason,
        suggestedResolution: "Review and remove duplicate transactions. Verify with the source system whether these are genuine separate transactions or data entry errors.",
        status: "open" as const,
      }))
    );
    await db.insertExceptionsBatch(duplicateRows);
    exceptionCount += duplicateRows.length;

    await trackProgress(jobId, "finalizing", { message: "Finalizing reconciliation results" });
    const totalTxns = sourceTxns.length + targetTxns.length;
    const matchRate = totalTxns > 0 ? ((matchedCount * 2) / totalTxns * 100) : 0;
    const processingTimeMs = Date.now() - startTime;

    // WS-6: record the job's dominant transaction currency (minority-currency
    // legs surface as currency_mismatch / fx_rate_variance exceptions).
    const currencyCounts = new Map<string, number>();
    for (const t of [...sourceTxns, ...targetTxns]) {
      currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
    }
    let dominantCurrency = "NGN";
    let dominantCount = -1;
    for (const [ccy, count] of Array.from(currencyCounts.entries())) {
      if (count > dominantCount) { dominantCurrency = ccy; dominantCount = count; }
    }

    await db.updateReconciliationJob(jobId, {
      status: "completed",
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: String(Math.round(matchRate * 100) / 100),
      processingTimeMs,
      currency: dominantCurrency,
      completedAt: new Date(),
    });

    await logAudit(userId, "complete_reconciliation", "reconciliation_job", jobId, {
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: `${matchRate.toFixed(2)}%`,
      processingTimeMs,
      engineStats: result.stats,
    });

    await trackProgress(jobId, "completed", {
      message: `Completed: ${matchedCount} matched, ${exceptionCount} exceptions, ${matchRate.toFixed(1)}% match rate`,
      processedCount: matchedCount,
      totalCount: totalTxns,
    });

    // Invalidate this tenant's dashboard stats cache so their next load is fresh.
    // Scoped to the run's own organization — the unscoped version dropped every
    // other tenant's row too.
    db.invalidateDashboardStatsCache(runOrganizationId).catch(() => {});

    // Dispatch webhooks (WS-4 event set)
    dispatchWebhook("reconciliation.completed", {
      jobId,
      matchedCount,
      exceptionCount,
      unmatchedCount: allUnmatched.length,
      matchRate: Math.round(matchRate * 100) / 100,
      processingTimeMs,
    });
    // exception.created: one event per job with the batch summary — per-row
    // events would fan a 5,000-exception run into 5,000 HTTP calls.
    if (exceptionCount > 0) {
      dispatchWebhook("exception.created", {
        jobId,
        count: exceptionCount,
        currency: dominantCurrency,
      });
    }
    // kpi.threshold.breached: the auto-match floor (85%) is the first wired
    // threshold; others follow as their computations move server-side.
    if (totalTxns > 0 && matchRate < 85) {
      dispatchWebhook("kpi.threshold.breached", {
        jobId,
        metric: "autoMatchRate",
        value: Math.round(matchRate * 100) / 100,
        floor: 85,
      });
    }

    // Send email alerts based on user preferences
    checkAndSendAlerts(jobId, userId).catch((err) =>
      console.error("[EmailReport] Alert check failed:", err)
    );

    // Deferred AI analysis — fire-and-forget so the job is already "completed".
    // High/critical exceptions get their Claude narrative filled in shortly after,
    // keeping LLM latency entirely out of the reconciliation hot path.
    runDeferredAiAnalysis(jobId).catch((err) =>
      console.error("[AI pass] deferred analysis failed:", err)
    );

  } catch (error) {
    console.error("[Reconciliation] Job failed:", error);
    await db.updateReconciliationJob(jobId, {
      status: "failed",
      completedAt: new Date(),
    });

    await trackProgress(jobId, "failed", { message: `Failed: ${String(error)}` });
    dispatchWebhook("reconciliation.failed", { jobId, error: String(error) });
  }
}

// ─── Start Services on Server Boot ──────────────────────────────────
// Check for due tasks every 60 seconds
startScheduler(60000);
// Start SFTP polling service
startSftpPolling();
// Start object-storage (S3/R2/MinIO) drop polling — the same ingestion core,
// for banks and couriers who deliver to a bucket rather than an SFTP host.
startBucketPolling();
// Start SLA monitoring service (check every 60 minutes)
startSLAMonitoring(60);
// Pre-warm the shared demo user so the first guest gets instant data
// Runs asynchronously — does not block server startup
setImmediate(() => {
  prewarmDemoUser().catch((err) =>
    console.error("[Boot] prewarmDemoUser failed:", err)
  );
});

// Register the reconciliation runner with the durable queue (see
// server/reconciliationQueue.ts). Done at module load so enqueued jobs can
// execute; the function stays in this file until split-plan item 12 extracts it.
registerReconciliationRunner(runReconciliation);
